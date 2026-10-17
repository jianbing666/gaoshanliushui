#!/usr/bin/env node
/**
 * 体积预算门禁 (P3)
 *
 * 把"主入口 Gzip / JS 合计 Gzip / dist 合计 Gzip / 二进制 / 安装包"与
 * scripts/perf-budgets.json 中的预算对比, 任一超标即非零退出, 供 CI 使用。
 *
 * 口径与 scripts/perf-snapshot.mjs 保持一致:
 *   - Gzip 压缩等级使用 Node zlib 默认值, 与 snapshot / 构建日志口径同源
 *   - "主入口" = dist/index.html 里 <script src> 引用的那个 bundling 入口 chunk
 *   - 二进制 / 安装包不存在时只警告不失败 (CI 的前端 job 不构建 Rust 产物)
 *
 * 用法
 *   node scripts/perf-gate.mjs [--budget path/to/perf-budgets.json]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname, basename } from 'node:path'
import { gzipSync } from 'node:zlib'

const ROOT = process.cwd()
const DIST = join(ROOT, 'dist')
const args = process.argv.slice(2)
const budgetPath = args.includes('--budget')
  ? args[args.indexOf('--budget') + 1]
  : join(ROOT, 'scripts', 'perf-budgets.json')

function kb(bytes) {
  return Math.round((bytes / 1024) * 100) / 100
}

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 100) / 100
}

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

if (!existsSync(budgetPath)) {
  console.error('找不到预算文件:', budgetPath)
  process.exit(1)
}
if (!existsSync(DIST)) {
  console.error('找不到 dist/ 产物, 请先执行构建 (npm run build 或 npx vite build)')
  process.exit(1)
}

const budgets = JSON.parse(readFileSync(budgetPath, 'utf8'))
const files = walk(DIST).map((full) => {
  const buffer = readFileSync(full)
  return {
    path: relative(ROOT, full).replace(/\\/g, '/'),
    ext: extname(full).toLowerCase(),
    bytes: buffer.length,
    gzipBytes: gzipSync(buffer).length,
  }
})

// 主入口: index.html 中的 <script src="...">
const indexHtml = readFileSync(join(DIST, 'index.html'), 'utf8')
const scriptMatch = indexHtml.match(/<script[^>]+src="\/([^"]+\.js)"/)
if (!scriptMatch) {
  console.error('index.html 中找不到主入口 <script src>, 无法判定主入口体积')
  process.exit(1)
}
const mainPath = 'dist/' + scriptMatch[1]
const mainFile = files.find((file) => file.path === mainPath)
if (!mainFile) {
  console.error('主入口文件不在 dist 中:', mainPath)
  process.exit(1)
}

const jsFiles = files.filter((file) => file.ext === '.js')
const jsTotalGzip = jsFiles.reduce((sum, file) => sum + file.gzipBytes, 0)
const distTotalGzip = files.reduce((sum, file) => sum + file.gzipBytes, 0)

const binaryPath = join(ROOT, 'src-tauri', 'target', 'release', 'gaoshanliushui.exe')
const nsisDir = join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
const installers = existsSync(nsisDir)
  ? readdirSync(nsisDir)
      .filter((name) => name.toLowerCase().endsWith('.exe'))
      .map((name) => join(nsisDir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  : []

const binaryMb = existsSync(binaryPath) ? mb(statSync(binaryPath).size) : null
const installerMb = installers.length > 0 ? mb(statSync(installers[0]).size) : null

const checks = [
  {
    key: 'mainEntryGzipKB',
    label: '主入口 Gzip',
    actual: kb(mainFile.gzipBytes),
    unit: 'KB',
    detail: basename(mainFile.path),
  },
  {
    key: 'jsTotalGzipKB',
    label: 'JS 合计 Gzip',
    actual: kb(jsTotalGzip),
    unit: 'KB',
    detail: jsFiles.length + ' 个 js 文件',
  },
  {
    key: 'distTotalGzipKB',
    label: 'dist 合计 Gzip',
    actual: kb(distTotalGzip),
    unit: 'KB',
    detail: files.length + ' 个文件',
  },
  {
    key: 'binaryMB',
    label: 'release 二进制',
    actual: binaryMb,
    unit: 'MB',
    optional: true,
    detail: existsSync(binaryPath) ? basename(binaryPath) : '未构建',
  },
  {
    key: 'installerMB',
    label: 'NSIS 安装包',
    actual: installerMb,
    unit: 'MB',
    optional: true,
    detail: installers.length > 0 ? basename(installers[0]) : '未构建',
  },
]

let failed = false
const rows = []
for (const check of checks) {
  const limit = budgets[check.key]
  if (check.actual === null) {
    rows.push([check.label, '-', limit + ' ' + check.unit, '跳过(产物不存在)'])
    continue
  }
  if (typeof limit !== 'number') {
    console.error('预算文件缺少键:', check.key)
    process.exit(1)
  }
  const ok = check.actual <= limit
  if (!ok) failed = true
  rows.push([
    check.label,
    check.actual + ' ' + check.unit,
    limit + ' ' + check.unit,
    ok ? 'PASS' : 'FAIL',
  ])
}

console.log('体积预算门禁 (' + relative(ROOT, budgetPath).replace(/\\/g, '/') + ')')
console.log('')
const widths = [18, 16, 16, 20]
for (const row of rows) {
  console.log(row.map((cell, i) => String(cell).padEnd(widths[i])).join(''))
}
for (const check of checks) {
  if (check.detail) console.log('  ' + check.label + ': ' + check.detail)
}

if (failed) {
  console.error('')
  console.error('体积回归: 有指标超出预算。若确属预期增长, 在预算文件中上调并说明理由。')
  process.exit(1)
}
console.log('')
console.log('全部体积指标在预算内。')
