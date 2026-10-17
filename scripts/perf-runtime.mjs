#!/usr/bin/env node
/**
 * 运行期性能测量 (P3)
 *
 * 目的
 *   把"整应用内存"与"滚动帧率 / LRU 切回"固化成一条可复现的命令, 避免每次手搓脚本。
 *
 * 口径
 *   内存: 进程树(应用根进程 + 按 ParentProcessId 递归的全部 WebView2 后代)的两种读数,
 *         由 scripts/mem-sampler.ps1 每 300ms 采样:
 *           wsMB   = 工作集合计 (Win32_PerfFormattedData_PerfProc_Process.WorkingSet)
 *           privMB = 私有工作集合计 (WorkingSetPrivate, 任务管理器"内存"列口径)
 *   帧率: 应用内置性能记录器 (window.__perf) 的 requestAnimationFrame 帧间隔统计。
 *   切歌: 记录器捕获的 perf:load-start -> perf:playback-started 端到端延迟。
 *
 * 场景 (group=mem)
 *   1. idle     : 启动后静置, 取基线
 *   2. playing  : 播放一首并稳定 3s 后, 稳态 12s
 *   3. switch   : 顺序连切 10 首(间隔 3.3s), 取切歌峰值与延迟
 *   4. scroll   : 拟真滚动(每帧 ~60px, 全列表 3 遍) 17s
 *   5. extreme  : 极端滚动(每帧跳 1/8 屏) 8s, 仅作压力参考
 *
 * 场景 (group=lru)
 *   1. short-return : A->B->A, 3 首容量内切回, 预期命中
 *   2. long-return  : A->B->C->D->A, 跨 3 首以上切回, 预期未命中(需重新解码)
 *
 * 用法
 *   node scripts/perf-runtime.mjs --group all
 *   node scripts/perf-runtime.mjs --group mem --port 9223
 *   node scripts/perf-runtime.mjs --group lru --out markdown/性能/记录/xxx.json
 *
 * 前置
 *   - 必须存在 release 构建: src-tauri/target/release/gaoshanliushui.exe
 *   - 测量期间不要跑其他重负载任务(编译/测试), 否则内存与帧率都会失真
 *   - 需要完整权限启动 GUI (受限沙箱下 WebView2 会因命名管道被拒而白屏)
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = process.cwd()
const EXE = resolve(ROOT, 'src-tauri', 'target', 'release', 'gaoshanliushui.exe')
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe'
const TASKLIST = 'C:\\Windows\\System32\\tasklist.exe'

function parseArgs(argv) {
  const out = { group: 'all', port: 9222, intervalMs: 300 }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--group') out.group = argv[++i]
    else if (key === '--port') out.port = Number(argv[++i])
    else if (key === '--out') out.out = argv[++i]
    else if (key === '--interval') out.intervalMs = Number(argv[++i])
  }
  out.out = out.out ?? 'markdown/性能/记录/2026-10-17-整应用口径-01.json'
  return out
}

const opts = parseArgs(process.argv.slice(2))
const OUT_PATH = resolve(ROOT, opts.out)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function log(...parts) {
  console.log('[perf-runtime]', ...parts)
}

function fail(message) {
  console.error('[perf-runtime] 失败:', message)
  process.exitCode = 1
  throw new Error(message)
}

// ========== 进程管理 ==========

function listAppPids() {
  const result = spawnSync(
    TASKLIST,
    ['/FI', 'IMAGENAME eq gaoshanliushui.exe', '/FO', 'CSV', '/NH'],
    {
      encoding: 'utf8',
    }
  )
  const pids = []
  for (const line of (result.stdout ?? '').split(/\r?\n/)) {
    const match = line.match(/^"gaoshanliushui\.exe","(\d+)"/i)
    if (match) pids.push(Number(match[1]))
  }
  return pids
}

function ensureSingleInstance() {
  let pids = listAppPids()
  if (pids.length === 0) return
  log('检测到已有应用实例, 先结束:', pids.join(', '))
  spawnSync(TASKKILL, ['/IM', 'gaoshanliushui.exe', '/T', '/F'], { encoding: 'utf8' })
  // 等待进程真正消失: 单实例插件下, 旧实例未退干净会让新实例直接退出,
  // 后续采样会挂在一个已死 pid 上(样本 count=1、ws=0)。
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    spawnSync(POWERSHELL, ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 300'], {
      encoding: 'utf8',
    })
    pids = listAppPids()
    if (pids.length === 0) return
  }
  fail('旧实例 8s 内没有退出: ' + pids.join(', '))
}

function launchApp() {
  if (!existsSync(EXE)) fail('找不到 release 可执行文件: ' + EXE)
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      '--remote-debugging-port=' + opts.port + ' --remote-allow-origins=*',
  }
  const child = spawn(EXE, [], { env, detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  log('已启动应用, spawn pid =', child.pid)
  return child.pid
}

/**
 * 校准真实应用 pid。
 *
 * spawn() 返回的是 CreateProcess 的 pid; 若单实例插件把新进程立刻打发掉, 应用
 * 实际还活在另一个 pid 上。这里以 tasklist 为准, 并要求只剩一个实例。
 */
function resolveAppPid(spawnPid) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const pids = listAppPids()
    if (pids.length > 0 && pids.includes(spawnPid)) return spawnPid
    if (pids.length > 0 && !pids.includes(spawnPid)) {
      log('警告: spawn pid', spawnPid, '已不在运行列表, 改用现存实例', pids.join(', '))
      return pids[0]
    }
    spawnSync(POWERSHELL, ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 300'], {
      encoding: 'utf8',
    })
  }
  fail('启动后 5s 内没有找到应用进程')
}

function killApp(pid) {
  if (!pid) return
  spawnSync(TASKKILL, ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
}

// ========== CDP ==========

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { resolve: res, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else res(message.result)
      }
    })
  }

  static async connect(port) {
    const deadline = Date.now() + 30000
    let target = null
    while (Date.now() < deadline) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json/list')
        const targets = await response.json()
        target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
        if (target) break
      } catch {
        /* 端口还没起来 */
      }
      await sleep(300)
    }
    if (!target) fail('30s 内没有等到 CDP 页面目标 (端口 ' + port + ')')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
    })
    log('CDP 已连接:', target.url)
    const cdp = new Cdp(ws)
    await cdp.send('Runtime.enable')
    return cdp
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error('页面执行异常: ' + detail)
    }
    return result.result.value
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

async function waitForAppReady(cdp) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const state = await cdp
      .eval(
        "(()=>{const app=document.getElementById('app');const pinia=app&&app.__vue_app__&&app.__vue_app__.config.globalProperties.$pinia;const lib=pinia&&pinia.state.value.library;return {ready:!!(pinia&&lib),songs:lib&&lib.playlist?lib.playlist.length:0,rows:document.querySelectorAll('.virtual-song-list__row').length}})()"
      )
      .catch(() => null)
    if (state && state.ready && state.songs > 20 && state.rows > 3) {
      log('应用已就绪: 曲库', state.songs, '首, 可见行', state.rows, '条')
      return state
    }
    await sleep(400)
  }
  fail('30s 内应用未就绪(曲库为空或列表未渲染)')
}

/**
 * 记录实际窗口尺寸。
 *
 * 内存/帧率都随渲染面积变化, 历史报告只写"默认窗口"无法复核; 这里把 CSS 像素、
 * devicePixelRatio 与屏幕分辨率一起落盘, 复测有差异时先对齐这一项。
 */
async function getWindowInfo(cdp) {
  return cdp.eval(
    "(()=>({width:window.innerWidth,height:window.innerHeight,dpr:window.devicePixelRatio,screen:screen.width+'x'+screen.height}))()"
  )
}

// ========== 采样器 ==========

async function startSampler(rootPid, file) {
  const proc = spawn(
    POWERSHELL,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      resolve(ROOT, 'scripts', 'mem-sampler.ps1'),
      '-RootPid',
      String(rootPid),
      '-IntervalMs',
      String(opts.intervalMs),
      '-Out',
      file,
    ],
    { stdio: 'ignore', windowsHide: true }
  )
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    await sleep(400)
    try {
      if (statSync(file).size > 0) return proc
    } catch {
      /* 文件还没生成 */
    }
  }
  fail('内存采样器 20s 内没有产出样本')
}

function stopSampler(proc) {
  if (!proc) return
  spawnSync(TASKKILL, ['/PID', String(proc.pid), '/T', '/F'], { encoding: 'utf8' })
}

function readSamples(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((sample) => sample && typeof sample.t === 'number' && sample.count > 0)
}

function windowStats(samples, from, to) {
  if (samples.length === 0) return null
  const inWindow = samples.filter((sample) => sample.t >= from && sample.t <= to)
  if (inWindow.length === 0) return null
  const peakWs = Math.max(...inWindow.map((sample) => sample.wsMB))
  const peakPriv = Math.max(...inWindow.map((sample) => sample.privMB))
  const first = inWindow[0]
  const last = inWindow[inWindow.length - 1]
  return {
    samples: inWindow.length,
    start: { wsMB: first.wsMB, privMB: first.privMB },
    end: { wsMB: last.wsMB, privMB: last.privMB },
    peak: { wsMB: peakWs, privMB: peakPriv },
    delta: { wsMB: round(peakWs - first.wsMB), privMB: round(peakPriv - first.privMB) },
  }
}

function round(value) {
  return Math.round(value * 100) / 100
}

// ========== 页面侧脚本 ==========

async function ensureRecorder(cdp) {
  const ok = await cdp.eval(
    "(async()=>{try{localStorage.setItem('gaoshanliushui:perf-hotkey','1')}catch(e){};if(!window.__perf){window.dispatchEvent(new KeyboardEvent('keydown',{ctrlKey:true,shiftKey:true,code:'F12'}));await new Promise(r=>setTimeout(r,1200))}return !!window.__perf})()"
  )
  if (!ok) fail('性能记录器未能加载')
}

async function recorderStart(cdp, scenario, notes = '') {
  await cdp.eval(
    'window.__perf.start(' + JSON.stringify(scenario) + ',' + JSON.stringify(notes) + ')'
  )
}

async function recorderStop(cdp) {
  return cdp.eval('window.__perf.stop()')
}

async function setLoopMode(cdp, mode) {
  await cdp.eval(
    "(()=>{const app=document.getElementById('app');const pinia=app.__vue_app__.config.globalProperties.$pinia;const st=pinia.state.value;st.audio.loopMode=" +
      JSON.stringify(mode) +
      ';return st.audio.loopMode})()'
  )
}

async function playByIndex(cdp, index) {
  await cdp.eval(
    "(()=>{const app=document.getElementById('app');const pinia=app.__vue_app__.config.globalProperties.$pinia;const audio=pinia._s.get('audio');audio.playByIndex(" +
      index +
      ');return true})()'
  )
}

async function waitForPlaying(cdp, index, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await cdp.eval(
      "(()=>{const app=document.getElementById('app');const pinia=app.__vue_app__.config.globalProperties.$pinia;const st=pinia.state.value;return {index:st.library.currentIndex,playing:st.audio.isPlaying,switching:st.audio.isSwitchingSong}})()"
    )
    if (state.index === index && state.playing && !state.switching) return true
    await sleep(100)
  }
  return false
}

async function getPlaybackState(cdp) {
  return cdp.eval(
    "(()=>{const app=document.getElementById('app');const pinia=app.__vue_app__.config.globalProperties.$pinia;const st=pinia.state.value;return {index:st.library.currentIndex,playing:st.audio.isPlaying,switching:st.audio.isSwitchingSong,pending:st.audio.pendingPlay,time:st.audio.currentTime,duration:st.audio.duration,title:st.library.currentSong&&st.library.currentSong.title}})()"
  )
}

/**
 * 让指定索引的歌曲进入播放态。
 *
 * 为什么不是只调用 playByIndex: playByIndex 只负责"选中", 真正的 auto-play 依赖
 * 切歌前的播放意图(waitForPlaying 前若本来没在播, 加载完成后只会暂停在其中)。
 * 另外当前索引与目标一致时 playByIndex 不会触发 watch, 因此这里显式补一次 play()。
 */
async function startPlayback(cdp, index, timeoutMs = 15000) {
  const state = await getPlaybackState(cdp)
  if (state.index !== index) {
    await playByIndex(cdp, index)
    await sleep(300)
  }
  await cdp.eval(
    "(()=>{const app=document.getElementById('app');const pinia=app.__vue_app__.config.globalProperties.$pinia;const audio=pinia._s.get('audio');audio.play();return true})()"
  )
  return waitForPlaying(cdp, index, timeoutMs)
}

async function realScroll(cdp, durationMs) {
  await cdp.eval(
    '(async()=>{const list=document.querySelector(".virtual-song-list");if(!list)throw new Error("no list");const max=list.scrollHeight-list.clientHeight;const started=performance.now();let dir=1;let pos=0;await new Promise((done)=>{function frame(){const elapsed=performance.now()-started;if(elapsed>=(' +
      durationMs +
      ')){done();return}pos+=60*dir;if(pos>=max){pos=max;dir=-1}else if(pos<=0){pos=0;dir=1}list.scrollTop=pos;requestAnimationFrame(frame)}requestAnimationFrame(frame)});return {max,scrollTop:list.scrollTop}})()'
  )
}

async function extremeScroll(cdp, durationMs) {
  await cdp.eval(
    '(async()=>{const list=document.querySelector(".virtual-song-list");if(!list)throw new Error("no list");const max=list.scrollHeight-list.clientHeight;const started=performance.now();await new Promise((done)=>{function frame(){const elapsed=performance.now()-started;if(elapsed>=(' +
      durationMs +
      ')){done();return}list.scrollTop=(elapsed/70)%2===0?max:0;requestAnimationFrame(frame)}requestAnimationFrame(frame)});return {max}})()'
  )
}

// ========== 内存场景 ==========

async function runMemCoreGroup(cdp, appPid) {
  const memFile = join(tmpdir(), 'perf-mem-core-' + Date.now() + '.jsonl')
  const sampler = await startSampler(appPid, memFile)
  log('内存采样器已启动:', memFile)
  const windows = {}
  try {
    log('等待应用稳定 (后台缩略图补齐/懒加载) 8s …')
    await sleep(8000)

    // 1. idle
    let from = Date.now()
    await sleep(12000)
    windows.idle = { from, to: Date.now() }

    // 2. playing 稳态
    if (!(await startPlayback(cdp, 0))) log('警告: 首次播放未在 15s 内进入播放态')
    else log('已进入播放态, 等待 3s 稳定后开始采样')
    await sleep(3000)
    from = Date.now()
    await sleep(12000)
    windows.playing = { from, to: Date.now() }

    // 3. 连切 10 首
    await ensureRecorder(cdp)
    await recorderStart(cdp, 'switch-mem', 'P3 整应用内存: 顺序连切 10 首')
    from = Date.now()
    const switchLog = []
    for (let i = 1; i <= 10; i++) {
      await playByIndex(cdp, i)
      const ok = await waitForPlaying(cdp, i, 6000)
      switchLog.push({ index: i, ok })
      await sleep(2400)
    }
    windows.switch = { from, to: Date.now() }
    const switchRecord = await recorderStop(cdp)

    const samples = readSamples(memFile)
    log('内存样本数:', samples.length)
    return {
      generatedAt: new Date().toISOString(),
      window: await getWindowInfo(cdp),
      caliber: {
        wsMB: '进程树工作集合计 (Win32_PerfFormattedData_PerfProc_Process.WorkingSet)',
        privMB: '进程树私有工作集合计 (WorkingSetPrivate, 任务管理器"内存"列口径)',
        tree: '应用根进程 + 按 ParentProcessId 递归的全部后代 (含 WebView2 browser/renderer/gpu/utility)',
        samplerIntervalMs: opts.intervalMs,
        note: '单次采样受 WMI 查询耗时限制, 实际间隔约 1s',
      },
      windows: Object.fromEntries(
        Object.entries(windows).map(([name, range]) => [
          name,
          windowStats(samples, range.from, range.to),
        ])
      ),
      samples,
      switch: switchRecord
        ? {
            log: switchLog,
            latencyMs: switchRecord.switches.map((item) => item.latencyMs),
            segments: switchRecord.switches.map((item) => item.segments ?? null),
            segmentSummary: switchRecord.segmentSummary ?? null,
            fps: switchRecord.frames,
          }
        : null,
    }
  } finally {
    stopSampler(sampler)
  }
}

async function runMemScrollGroup(cdp, appPid) {
  const memFile = join(tmpdir(), 'perf-mem-scroll-' + Date.now() + '.jsonl')
  const sampler = await startSampler(appPid, memFile)
  log('内存采样器已启动:', memFile)
  const windows = {}
  try {
    log('等待应用稳定 (后台缩略图补齐/懒加载) 8s …')
    await sleep(8000)
    // 滚动前基线: 不播放, 保证滚动峰值从干净状态起算
    let from = Date.now()
    await sleep(5000)
    windows.idle = { from, to: Date.now() }

    await ensureRecorder(cdp)
    await recorderStart(cdp, 'scroll-realistic', 'P3 滚动: 拟真滚动(每帧约 60px, 全列表 3 遍)')
    from = Date.now()
    await realScroll(cdp, 17000)
    windows.scroll = { from, to: Date.now() }
    const scrollRecord = await recorderStop(cdp)

    // 滚动结束后回落
    await sleep(1000)
    from = Date.now()
    await sleep(4000)
    windows.settled = { from, to: Date.now() }

    await recorderStart(cdp, 'scroll-extreme', 'P3 滚动: 极端滚动(每帧跳半屏)')
    from = Date.now()
    await extremeScroll(cdp, 8000)
    windows.extreme = { from, to: Date.now() }
    const extremeRecord = await recorderStop(cdp)

    const samples = readSamples(memFile)
    log('内存样本数:', samples.length)
    return {
      generatedAt: new Date().toISOString(),
      window: await getWindowInfo(cdp),
      caliber: '与 core 相同; 本组从启动后的干净状态起算滚动峰值',
      windows: Object.fromEntries(
        Object.entries(windows).map(([name, range]) => [
          name,
          windowStats(samples, range.from, range.to),
        ])
      ),
      samples,
      scroll: {
        realistic: scrollRecord
          ? {
              fps: scrollRecord.frames,
              longTasks: scrollRecord.longTasks.length,
              heapPeakMb: scrollRecord.memory.peakUsedHeapMb,
            }
          : null,
        extreme: extremeRecord
          ? {
              fps: extremeRecord.frames,
              longTasks: extremeRecord.longTasks.length,
              heapPeakMb: extremeRecord.memory.peakUsedHeapMb,
            }
          : null,
      },
    }
  } finally {
    stopSampler(sampler)
  }
}

// ========== LRU 场景 ==========

async function runLruGroup(cdp) {
  await setLoopMode(cdp, 'list')
  await ensureRecorder(cdp)
  const playlistLength = await cdp.eval(
    "(()=>{const app=document.getElementById('app');const pinia=app.__vue_app__.config.globalProperties.$pinia;return pinia.state.value.library.playlist.length})()"
  )

  const scenarios = []
  const currentIndex = (await getPlaybackState(cdp)).index
  // 选一段与当前索引不重叠的区段, 避免 playByIndex 命中"同一个索引"而不触发换歌
  let base = playlistLength > 80 ? 20 : 5
  if (currentIndex >= base - 1 && currentIndex <= base + 20) base = 60
  log('当前索引', currentIndex, '| LRU 测试区段起始', base)

  // 先进入播放态(automation 环境下 autoplay-policy 已关闭, 无需真实手势)
  const started = await startPlayback(cdp, currentIndex >= 0 ? currentIndex : base)
  if (!started) log('警告: 初始播放未进入播放态')
  await sleep(800)

  async function runScenario(name, note, indices) {
    log('LRU 场景:', name, indices.join(' -> '))
    await recorderStart(cdp, name, note)
    for (const index of indices) {
      await playByIndex(cdp, index)
      const ok = await waitForPlaying(cdp, index, 12000)
      await sleep(3200) // 等预解码(播放后 600ms 触发)完成
      if (!ok) log('  警告: 切到索引', index, '未在 12s 内进入播放态')
    }
    const record = await recorderStop(cdp)
    scenarios.push({
      name,
      indices,
      switches: record.switches.map((item) => ({
        songId: item.songId,
        latencyMs: item.latencyMs,
        segments: item.segments ?? null,
      })),
      segmentSummary: record.segmentSummary ?? null,
      fps: record.frames,
    })
    await sleep(1200)
  }

  // 3 首容量内切回: A->B->A
  await runScenario('short-return', 'LRU: 3 首容量内切回 A->B->A', [base, base + 1, base])
  // 跨 3 首以上切回: A->B->C->D->A (当前曲目 pin + 3 条容量, A 应已被淘汰)
  await runScenario('long-return', 'LRU: 跨 4 首切回 A->B->C->D->A', [
    base + 10,
    base + 11,
    base + 12,
    base + 13,
    base + 10,
  ])

  return {
    generatedAt: new Date().toISOString(),
    window: await getWindowInfo(cdp),
    group: 'lru',
    loopMode: 'list',
    cacheLimitEntries: 3,
    scenarios,
  }
}

// ========== 主流程 ==========

async function withApp(run) {
  ensureSingleInstance()
  const spawnPid = launchApp()
  const appPid = resolveAppPid(spawnPid)
  if (appPid !== spawnPid) log('实际应用 pid =', appPid)
  const cdp = await Cdp.connect(opts.port)
  try {
    await waitForAppReady(cdp)
    return await run(cdp, appPid)
  } finally {
    cdp.close()
    killApp(appPid)
    await sleep(1500)
  }
}

async function main() {
  if (!existsSync(dirname(OUT_PATH))) mkdirSync(dirname(OUT_PATH), { recursive: true })
  const groups = opts.group === 'all' ? ['mem', 'lru'] : [opts.group]
  const results = {}
  for (const group of groups) {
    log('==== 开始 ' + group + ' 组 ====')
    if (group === 'mem') {
      const core = await withApp((cdp, appPid) => runMemCoreGroup(cdp, appPid))
      log('---- 核心场景完成, 换新实例测滚动 ----')
      const scroll = await withApp((cdp, appPid) => runMemScrollGroup(cdp, appPid))
      results.mem = { core, scroll }
    } else if (group === 'lru') {
      results.lru = await withApp((cdp) => runLruGroup(cdp))
    } else {
      fail('未知 group: ' + group)
    }
    log('==== ' + group + ' 组完成 ====')
    await sleep(2000)
  }

  const output = {
    generatedAt: new Date().toISOString(),
    executable: EXE,
    executableMtime: existsSync(EXE) ? statSync(EXE).mtime.toISOString() : null,
    window: '各分组记录实际窗口尺寸(见 results.*.window)',
    results,
  }
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), 'utf8')
  log('原始数据已写入:', OUT_PATH)

  // 控制台摘要
  if (results.mem) {
    for (const [sessionName, session] of Object.entries(results.mem)) {
      log('--- ' + sessionName + ' ---')
      for (const [name, stats] of Object.entries(session.windows)) {
        if (!stats) continue
        log(
          name.padEnd(8),
          '峰值 ws=' + stats.peak.wsMB + 'MB priv=' + stats.peak.privMB + 'MB',
          '增量 ws=+' + stats.delta.wsMB + 'MB priv=+' + stats.delta.privMB + 'MB'
        )
      }
      if (session.switch) {
        log(
          '切歌延迟(ms):',
          session.switch.latencyMs.join(', '),
          '| 中位',
          median(session.switch.latencyMs)
        )
      }
      if (session.scroll) {
        log('拟真滚动:', JSON.stringify(session.scroll.realistic?.fps))
        log('极端滚动:', JSON.stringify(session.scroll.extreme?.fps))
      }
    }
  }
  if (results.lru) {
    for (const scenario of results.lru.scenarios) {
      log(scenario.name, ':', scenario.switches.map((item) => item.latencyMs + 'ms').join(', '))
    }
  }
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
