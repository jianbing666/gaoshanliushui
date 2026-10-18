#!/usr/bin/env node
/**
 * 下载并准备内置 ffmpeg sidecar
 *
 * 背景: ffmpeg 二进制约 100MB, 放进 git 会让仓库体积失控, 因此改为构建时按需下载。
 * 需要 ffmpeg 的功能有两个: B 站音乐下载(转 mp3) 与响度均衡(EBU R128 loudnorm)。
 *
 * 行为:
 *   1. 目标文件已存在且 sha256 匹配 -> 直接返回(构建/开发每次多花约 0.2s 校验)
 *   2. 否则从官方源下载 zip(gyan.dev 主源, GitHub release 备用), 解压并放到
 *      src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe
 *   3. 下载的 zip 缓存在 src-tauri/binaries/.cache 下, 重复构建无需重新下载
 *
 * 用法:
 *   node scripts/fetch-ffmpeg.mjs          # 需要时下载
 *   node scripts/fetch-ffmpeg.mjs --check  # 只校验, 缺失/不匹配时非零退出(CI 用)
 *   node scripts/fetch-ffmpeg.mjs --force  # 忽略缓存与现有文件, 强制重新下载
 *
 * 为什么固定版本 + 固定 sha256:
 *   ffmpeg 不同构建的行为(编码器/滤镜)可能不同, 固定版本才能保证下载/响度功能可复现;
 *   校验 sha256 可以防止镜像被替换、下载被截断或解压出错误文件。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BIN_DIR = join(ROOT, 'src-tauri', 'binaries')
const TARGET = join(BIN_DIR, 'ffmpeg-x86_64-pc-windows-msvc.exe')
const CACHE_DIR = join(BIN_DIR, '.cache')
const EXTRACT_DIR = join(CACHE_DIR, 'extract')

const FFMPEG_VERSION = '8.1.2'
const ZIP_NAME = 'ffmpeg-' + FFMPEG_VERSION + '-essentials_build.zip'
const ZIP_PATH = join(CACHE_DIR, ZIP_NAME)
const DOWNLOAD_URLS = [
  'https://www.gyan.dev/ffmpeg/builds/packages/' + ZIP_NAME,
  'https://github.com/GyanD/codexffmpeg/releases/download/' + FFMPEG_VERSION + '/' + ZIP_NAME,
]
/** 解压后 ffmpeg.exe 的 sha256(版本+构建方式变化时必须同步更新) */
const EXE_SHA256 = '1326dde4c84ff1f96fe6b8916c5bed29e163e9b5dccf995f6f3db069d143ec5e'

const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')
const force = args.has('--force')

function log(message) {
  console.log('[ffmpeg] ' + message)
}

function fail(message) {
  console.error('[ffmpeg] 失败: ' + message)
  process.exit(1)
}

function formatBytes(bytes) {
  const mb = bytes / 1024 / 1024
  return mb >= 1 ? mb.toFixed(1) + 'MB' : Math.round(bytes / 1024) + 'KB'
}

async function sha256File(path) {
  const hash = createHash('sha256')
  const fh = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await fh.close()
  }
  return hash.digest('hex')
}

async function download(url, dest) {
  log('下载 ' + url)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error('HTTP ' + response.status)
  const total = Number(response.headers.get('content-length') ?? 0)
  const reader = response.body.getReader()
  const tmp = dest + '.part'
  const fh = await open(tmp, 'w')
  let received = 0
  let lastLogAt = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await fh.write(value)
      received += value.byteLength
      const now = Date.now()
      if (now - lastLogAt > 500) {
        lastLogAt = now
        const progress = total ? ' / ' + formatBytes(total) : ''
        process.stdout.write('\r[ffmpeg] 已下载 ' + formatBytes(received) + progress + '   ')
      }
    }
  } finally {
    await fh.close()
  }
  process.stdout.write('\n')
  if (total > 0 && received !== total) throw new Error('下载不完整: ' + received + '/' + total)
  await rename(tmp, dest)
  log('压缩包已保存: ' + dest + '(' + formatBytes(received) + ')')
}

function extractZip(zipPath, dest) {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  if (process.platform === 'win32') {
    // Windows 10 1803+ 自带 bsdtar, 支持 zip 且比 Expand-Archive 快很多
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const bsdtar = join(systemRoot, 'System32', 'tar.exe')
    if (existsSync(bsdtar)) {
      const result = spawnSync(bsdtar, ['-xf', zipPath, '-C', dest], { stdio: 'inherit' })
      if (result.status === 0) return
      log('bsdtar 解压失败, 回退到 Expand-Archive')
    }
    const ps = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Expand-Archive -LiteralPath '" + zipPath + "' -DestinationPath '" + dest + "' -Force",
      ],
      { stdio: 'inherit' }
    )
    if (ps.status !== 0) throw new Error('解压失败(Expand-Archive)')
    return
  }
  const unzip = spawnSync('unzip', ['-o', zipPath, '-d', dest], { stdio: 'inherit' })
  if (unzip.status !== 0) throw new Error('解压失败(需要 unzip)')
}

/** 在解压目录里找到 ffmpeg 可执行文件 */
function findFfmpeg(root) {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const info = statSync(path)
      if (info.isDirectory()) stack.push(path)
      else if (name.toLowerCase() === 'ffmpeg.exe' || name === 'ffmpeg') return path
    }
  }
  return null
}

async function main() {
  if (process.platform !== 'win32') {
    fail('当前只支持 Windows(项目打包目标为 NSIS); 其他平台请自行准备 ffmpeg 并放到 ' + TARGET)
  }

  mkdirSync(BIN_DIR, { recursive: true })
  mkdirSync(CACHE_DIR, { recursive: true })

  if (existsSync(TARGET) && !force) {
    const actual = await sha256File(TARGET)
    if (actual === EXE_SHA256) {
      log('已就绪(sha256 校验通过): ' + TARGET)
      return
    }
    log('现有文件 sha256 与预期不符, 准备重新获取')
    log('  期望: ' + EXE_SHA256)
    log('  实际: ' + actual)
  } else if (existsSync(TARGET)) {
    log('--force: 忽略现有文件')
  }

  if (checkOnly) {
    fail('缺少可用的 ffmpeg sidecar: ' + TARGET + '(运行 npm run ffmpeg:fetch 获取)')
  }

  if (!existsSync(ZIP_PATH) || force) {
    let lastError = null
    for (const url of DOWNLOAD_URLS) {
      try {
        await download(url, ZIP_PATH)
        lastError = null
        break
      } catch (error) {
        lastError = error
        log('该源失败(' + String(error.message ?? error) + '), 尝试下一个')
      }
    }
    if (lastError) fail('所有下载源均失败: ' + String(lastError.message ?? lastError))
  } else {
    log('复用缓存压缩包: ' + ZIP_PATH)
  }

  log('解压…')
  extractZip(ZIP_PATH, EXTRACT_DIR)
  const source = findFfmpeg(EXTRACT_DIR)
  if (!source) fail('解压结果里找不到 ffmpeg 可执行文件')

  // 先删后写: Windows 上正在运行的旧文件可能被占用, 提前给出清晰错误
  if (existsSync(TARGET)) {
    try {
      await rm(TARGET, { force: true })
    } catch (error) {
      fail('无法覆盖现有 ffmpeg(可能正被应用占用): ' + String(error.message ?? error))
    }
  }
  await import('node:fs/promises').then((fs) => fs.copyFile(source, TARGET))
  const info = await stat(TARGET)
  const actual = await sha256File(TARGET)
  if (actual !== EXE_SHA256) {
    await rm(TARGET, { force: true })
    fail('下载的 ffmpeg 校验失败, 已删除: 期望 ' + EXE_SHA256 + ', 实际 ' + actual)
  }
  rmSync(EXTRACT_DIR, { recursive: true, force: true })
  log('完成: ' + TARGET + '(' + formatBytes(info.size) + ', sha256 校验通过)')
}

main().catch((error) => {
  fail(String(error?.message ?? error))
})
