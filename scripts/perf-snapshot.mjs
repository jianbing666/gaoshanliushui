#!/usr/bin/env node
/**
 * 性能数据快照 (自动化采集)
 *
 * 采集范围 (全部为只读, 不触发构建, 可在受限沙箱下运行):
 *   1. 前端产物 dist/  —— 文件数、原始/ Gzip / Brotli 体积、按扩展名汇总、体积 Top N
 *   2. Rust 产物       —— release 二进制、NSIS 安装包体积
 *   3. 依赖规模        —— npm 生产/开发依赖数、Cargo 依赖包数
 *   4. 源码规模        —— 前端/后端文件数与行数、测试文件数
 *
 * 输出: markdown/性能/性能数据快照.json 与 性能数据快照.md
 *
 * 用法: node scripts/perf-snapshot.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative, extname, basename } from 'node:path'
import { gzipSync, brotliCompressSync } from 'node:zlib'

const ROOT = process.cwd()
const DIST = join(ROOT, 'dist')
const OUT_DIR = join(ROOT, 'markdown', '性能')

function walk(dir) {
  const result = []
  if (!existsSync(dir)) return result
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) result.push(...walk(full))
    else if (stat.isFile()) result.push(full)
  }
  return result
}

function kb(bytes) {
  return Math.round((bytes / 1024) * 100) / 100
}

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 100) / 100
}

// ========== 1. 前端产物 ==========
const distFiles = walk(DIST)
const files = distFiles.map((full) => {
  const buffer = readFileSync(full)
  return {
    path: relative(ROOT, full).replace(/\\/g, '/'),
    ext: extname(full).toLowerCase() || '(none)',
    bytes: buffer.length,
    gzipBytes: gzipSync(buffer).length,
    brotliBytes: brotliCompressSync(buffer).length,
  }
})

const total = (key) => files.reduce((sum, file) => sum + file[key], 0)
const byExt = {}
for (const file of files) {
  const bucket = (byExt[file.ext] ??= { count: 0, bytes: 0, gzipBytes: 0, brotliBytes: 0 })
  bucket.count += 1
  bucket.bytes += file.bytes
  bucket.gzipBytes += file.gzipBytes
  bucket.brotliBytes += file.brotliBytes
}

const frontend = {
  exists: files.length > 0,
  fileCount: files.length,
  totalBytes: total('bytes'),
  totalGzipBytes: total('gzipBytes'),
  totalBrotliBytes: total('brotliBytes'),
  byExt: Object.entries(byExt)
    .map(([ext, value]) => ({ ext, ...value }))
    .sort((a, b) => b.bytes - a.bytes),
  top: [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 12),
}

// ========== 2. Rust 产物 ==========
const releaseDir = join(ROOT, 'src-tauri', 'target', 'release')
const binaryPath = join(releaseDir, 'gaoshanliushui.exe')
const nsisDir = join(releaseDir, 'bundle', 'nsis')
const installerCandidates = existsSync(nsisDir)
  ? readdirSync(nsisDir).filter((name) => name.toLowerCase().endsWith('.exe'))
  : []
const installerPaths = installerCandidates
  .map((name) => join(nsisDir, name))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

const rust = {
  binaryBytes: existsSync(binaryPath) ? statSync(binaryPath).size : null,
  binaryMtime: existsSync(binaryPath) ? statSync(binaryPath).mtime.toISOString() : null,
  installerBytes: installerPaths.length > 0 ? statSync(installerPaths[0]).size : null,
  installerPath:
    installerPaths.length > 0 ? relative(ROOT, installerPaths[0]).replace(/\\/g, '/') : null,
  installerMtime:
    installerPaths.length > 0 ? statSync(installerPaths[0]).mtime.toISOString() : null,
  allInstallers: installerPaths.map((full) => ({
    name: basename(full),
    bytes: statSync(full).size,
    mtime: statSync(full).mtime.toISOString(),
  })),
}

// ========== 3. 依赖规模 ==========
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const pkg = readJson(join(ROOT, 'package.json'))
const cargoLock = existsSync(join(ROOT, 'src-tauri', 'Cargo.lock'))
  ? readFileSync(join(ROOT, 'src-tauri', 'Cargo.lock'), 'utf8')
  : ''
const cargoPackages = (cargoLock.match(/^\[\[package\]\]/gm) ?? []).length

const dependencies = {
  npmProd: Object.keys(pkg?.dependencies ?? {}).length,
  npmDev: Object.keys(pkg?.devDependencies ?? {}).length,
  cargoPackages,
}

// ========== 4. 源码规模 ==========
function countSource(dir, extensions) {
  const hits = walk(dir).filter((full) => extensions.includes(extname(full)))
  let lines = 0
  for (const full of hits) lines += readFileSync(full, 'utf8').split(/\r?\n/).length
  return { files: hits.length, lines }
}

const frontendSource = countSource(join(ROOT, 'src'), ['.ts', '.tsx', '.vue', '.css'])
const backendSource = countSource(join(ROOT, 'src-tauri', 'src'), ['.rs'])
const testFiles = walk(join(ROOT, 'src')).filter((full) => /\.test\.(ts|tsx)$/.test(full)).length

const source = {
  frontendFiles: frontendSource.files,
  frontendLines: frontendSource.lines,
  backendFiles: backendSource.files,
  backendLines: backendSource.lines,
  testFiles,
}

const snapshot = {
  generatedAt: new Date().toISOString(),
  version: pkg?.version ?? null,
  frontend,
  rust,
  dependencies,
  source,
}

// ========== 输出 ==========
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, '性能数据快照.json'), JSON.stringify(snapshot, null, 2), 'utf8')

const md = []
md.push('# 性能数据快照')
md.push('')
md.push(`> 自动生成, 请勿手改。生成时间: ${snapshot.generatedAt}`)
md.push('')
md.push('## 一、前端产物 (dist/)')
md.push('')
if (frontend.exists) {
  md.push('| 指标 | 原始 | Gzip | Brotli |')
  md.push('| --- | ---: | ---: | ---: |')
  md.push(
    `| 总计 (${frontend.fileCount} 个文件) | ${kb(frontend.totalBytes)} KB | ${kb(frontend.totalGzipBytes)} KB | ${kb(frontend.totalBrotliBytes)} KB |`
  )
  md.push('')
  md.push('| 类型 | 文件数 | 原始 | Gzip | Brotli |')
  md.push('| --- | ---: | ---: | ---: | ---: |')
  for (const item of frontend.byExt) {
    md.push(
      `| ${item.ext} | ${item.count} | ${kb(item.bytes)} KB | ${kb(item.gzipBytes)} KB | ${kb(item.brotliBytes)} KB |`
    )
  }
  md.push('')
  md.push('| 最大文件 | 原始 | Gzip |')
  md.push('| --- | ---: | ---: |')
  for (const file of frontend.top.slice(0, 8)) {
    md.push(`| ${file.path} | ${kb(file.bytes)} KB | ${kb(file.gzipBytes)} KB |`)
  }
} else {
  md.push('> 未找到 dist/ 产物, 请先执行 `npm run build`。')
}
md.push('')
md.push('## 二、Rust 产物')
md.push('')
md.push('| 产物 | 体积 | 构建时间 |')
md.push('| --- | ---: | --- |')
md.push(
  `| release 二进制 | ${rust.binaryBytes === null ? '-' : mb(rust.binaryBytes) + ' MB'} | ${rust.binaryMtime ?? '-'} |`
)
md.push(
  `| NSIS 安装包 | ${rust.installerBytes === null ? '-' : mb(rust.installerBytes) + ' MB'} | ${rust.installerMtime ?? '-'} |`
)
md.push('')
md.push('## 三、依赖与源码规模')
md.push('')
md.push('| 指标 | 数值 |')
md.push('| --- | ---: |')
md.push(`| npm 生产依赖 | ${dependencies.npmProd} |`)
md.push(`| npm 开发依赖 | ${dependencies.npmDev} |`)
md.push(`| Cargo 依赖包 | ${dependencies.cargoPackages} |`)
md.push(`| 前端源文件 | ${source.frontendFiles} |`)
md.push(`| 前端源码行数 | ${source.frontendLines} |`)
md.push(`| Rust 源文件 | ${source.backendFiles} |`)
md.push(`| Rust 源码行数 | ${source.backendLines} |`)
md.push(`| 单元测试文件 | ${source.testFiles} |`)
md.push('')

writeFileSync(join(OUT_DIR, '性能数据快照.md'), md.join('\n'), 'utf8')

console.log('性能数据快照已生成:')
console.log('  markdown/性能/性能数据快照.json')
console.log('  markdown/性能/性能数据快照.md')
console.log(
  `前端 dist: ${frontend.fileCount} 文件, 原始 ${kb(frontend.totalBytes)} KB, gzip ${kb(frontend.totalGzipBytes)} KB, brotli ${kb(frontend.totalBrotliBytes)} KB`
)
console.log(
  `Rust 二进制: ${rust.binaryBytes === null ? '-' : mb(rust.binaryBytes) + ' MB'}, NSIS: ${rust.installerBytes === null ? '-' : mb(rust.installerBytes) + ' MB'}`
)
