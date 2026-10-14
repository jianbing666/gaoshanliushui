/**
 * 环境诊断：为什么 vite / vitest 在本沙箱里报 `spawn EPERM`？
 *
 * 结论先行（跑一次即可复核）：
 *   Windows 上 Node 的 child_process 用"命名管道"实现 stdio 管道，
 *   而当前沙箱禁止创建命名管道 —— 于是 `stdio: 'pipe'` 一律 EPERM，
 *   而 `stdio: 'inherit'` / `'ignore'` 正常。
 *   esbuild 的 JS 接口（vite/vitest 都要用）固定以管道方式启动它自己的
 *   esbuild.exe 服务进程，所以整条 vite 链路必然失败；esbuild.exe 本身没问题。
 *
 * 用法: node scripts/diagnose-spawn.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const ESBUILD = 'node_modules/@esbuild/win32-x64/esbuild.exe'

if (!existsSync(ESBUILD)) {
  console.error(`找不到 esbuild 二进制: ${ESBUILD}`)
  process.exit(2)
}

console.log(`node        = ${process.version}`)
console.log(`esbuild.exe = ${ESBUILD}`)
console.log('')

function probe(label, cmd, args, opts) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, opts)
    } catch (e) {
      console.log(`${label.padEnd(40)} THROW code=${e.code}`)
      return resolve()
    }
    let out = ''
    if (child.stdout) child.stdout.on('data', (d) => (out += d))
    let settled = false
    const done = (msg) => {
      if (settled) return
      settled = true
      console.log(`${label.padEnd(40)} ${msg}`)
      resolve()
    }
    child.on('error', (e) =>
      done(`ERROR code=${e.code} errno=${e.errno} syscall=${e.syscall}`)
    )
    child.on('close', (c) =>
      done(`OK exit=${c} stdout=${JSON.stringify(out.trim().slice(0, 24))}`)
    )
    setTimeout(() => done('TIMEOUT'), 15000)
  })
}

await probe('esbuild   stdio:pipe', ESBUILD, ['--version'], {
  stdio: ['pipe', 'pipe', 'pipe'],
})
await probe('esbuild   stdio:inherit', ESBUILD, ['--version'], { stdio: 'inherit' })
await probe('esbuild   stdio:ignore', ESBUILD, ['--version'], { stdio: 'ignore' })
await probe('esbuild   stdio:[ignore,pipe,pipe]', ESBUILD, ['--version'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
await probe('node      stdio:pipe', process.execPath, ['-e', 'console.log(1)'], {
  stdio: ['pipe', 'pipe', 'pipe'],
})
await probe('node      stdio:inherit', process.execPath, ['-e', '0'], {
  stdio: 'inherit',
})

const r = spawnSync(ESBUILD, ['--version'], { encoding: 'utf8' })
console.log(
  `${'spawnSync esbuild'.padEnd(40)} status=${r.status} err=${
    r.error ? r.error.code : 'none'
  } out=${JSON.stringify((r.stdout || '').trim())}`
)
