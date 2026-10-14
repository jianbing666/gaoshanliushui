/**
 * SFC 编译冒烟检查（不依赖 esbuild）
 *
 * 背景：本仓库的 `npm run build` / `npm test` 走 vite，而 vite 通过 esbuild 子进程
 * 转译 TS。在受限沙箱（无法创建命名管道）里 esbuild 会以 `spawn EPERM` 失败，
 * 于是最常用的两条校验命令都不可用。此脚本直接用 @vue/compiler-sfc 编译
 * `src/**\/*.vue`，覆盖 <script setup> / <template> / <style> 三个块，
 * 在这些环境里充当"改完能编译"的最小判据。
 *
 * 用法:
 *   node scripts/check-sfc.mjs            # 检查 src 下全部 .vue
 *   node scripts/check-sfc.mjs src/App.vue ...   # 只检查指定文件
 *
 * 注意：它不是 vue-tsc 的替代品（类型检查仍应跑 `npm run typecheck`），
 * 也不产出 bundle，只回答"这些 SFC 能不能编译"。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse, compileScript, compileTemplate, compileStyle } from '@vue/compiler-sfc'

const ROOT = process.cwd()

function collectVueFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'target') continue
      out.push(...collectVueFiles(full))
    } else if (entry.name.endsWith('.vue')) {
      out.push(relative(ROOT, full).replace(/\\/g, '/'))
    }
  }
  return out
}

const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : collectVueFiles('src')

let failed = 0
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const id = file.replace(/[^a-z0-9]/gi, '_')
  const { descriptor, errors } = parse(source, { filename: file })

  const problems = errors.map((e) => `parse: ${e.message}`)
  if (problems.length === 0) {
    try {
      if (descriptor.scriptSetup || descriptor.script) {
        compileScript(descriptor, { id })
      }
      if (descriptor.template) {
        const r = compileTemplate({
          source: descriptor.template.content,
          filename: file,
          id,
          scoped: descriptor.styles.some((s) => s.scoped),
        })
        for (const e of r.errors) problems.push(`template: ${e.message ?? e}`)
      }
      for (const style of descriptor.styles) {
        const r = compileStyle({
          source: style.content,
          filename: file,
          id,
          scoped: style.scoped,
        })
        for (const e of r.errors) problems.push(`style: ${e.message ?? e}`)
      }
    } catch (e) {
      problems.push(`throw: ${e.message}`)
    }
  }

  if (problems.length) {
    failed++
    console.error(`FAIL ${file}`)
    for (const p of problems) console.error('   ', p)
  }
}

console.log(
  failed === 0
    ? `${files.length} 个 SFC 全部编译通过。`
    : `${files.length} 个 SFC 中有 ${failed} 个失败。`
)
process.exit(failed === 0 ? 0 : 1)
