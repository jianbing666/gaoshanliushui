/**
 * 运行期性能记录工具 (Perf Recorder)
 *
 * 目的
 *   手动实测 (掐表、看任务管理器) 误差大、不可复现、无法回溯。
 *   本工具在应用内自动采集可量化的运行期指标, 并把"人工操作"转成带时间戳的标记,
 *   最终导出结构化 JSON + Markdown, 让每一次手测都有据可查。
 *
 * 自动采集
 *   - JS 启动时序: navigationStart → DOMContentLoaded / load / app-ready
 *   - 帧率: requestAnimationFrame 帧间隔 → 平均 FPS / P50 / P95 / 最大帧耗时 / 卡顿帧
 *   - 长任务: PerformanceObserver('longtask') → 次数、总时长、最长
 *   - JS 堆: performance.memory 周期采样 → 起止值、峰值、增量
 *   - 切歌延迟: 监听 audioStore 派发的 perf:load-start / perf:playback-started
 *
 * 人工标记
 *   - mark(name): 记录"开始滚动""打开设置"等动作的时间点 (相对记录起点)
 *   - notes: 停止时可写备注, 与数据一起保存
 *
 * 使用
 *   - 快捷键 Ctrl+Shift+F12 打开/关闭面板 (生产构建同样可用, 默认隐藏)
 *   - 控制台可用 window.__perf 直接调用 start/mark/stop/exportJson/exportMarkdown
 *   - 导出: 弹出保存对话框, 经 Rust write_text_file 落盘; 浏览器环境退化为下载
 */

const RECORDS_KEY = 'gaoshanliushui:perf-records'
const MAX_RECORDS = 50
const PANEL_ID = 'perf-recorder-panel'
const HOTKEY_ENABLED_KEY = 'gaoshanliushui:perf-hotkey'

export interface FrameStats {
  sampleCount: number
  durationMs: number
  fpsAvg: number
  frameP50Ms: number
  frameP95Ms: number
  frameMaxMs: number
  jankCount: number
}

export interface MemorySample {
  atMs: number
  usedHeapMb: number
  totalHeapMb: number
  limitMb: number
}

export interface PerfMark {
  name: string
  atMs: number
}

export interface PerfSwitch {
  songId?: string
  latencyMs: number
}

export interface PerfRecord {
  id: string
  scenario: string
  notes: string
  startedAt: string
  endedAt: string
  durationMs: number
  frames: FrameStats
  longTasks: { atMs: number; durationMs: number }[]
  memory: {
    supported: boolean
    samples: MemorySample[]
    startUsedHeapMb: number
    endUsedHeapMb: number
    peakUsedHeapMb: number
    deltaUsedHeapMb: number
  }
  switches: PerfSwitch[]
  marks: PerfMark[]
}

interface NavigationTiming {
  domContentLoadedMs: number | null
  loadEventMs: number | null
  responseEndMs: number | null
}

interface HeapReading {
  usedHeapMb: number
  totalHeapMb: number
  limitMb: number
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * (sorted.length - 1)))
  )
  return sorted[index]
}

function readHeap(): HeapReading | null {
  const memory = (
    performance as unknown as {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
    }
  ).memory
  if (!memory) return null
  return {
    usedHeapMb: round(memory.usedJSHeapSize / 1024 / 1024),
    totalHeapMb: round(memory.totalJSHeapSize / 1024 / 1024),
    limitMb: round(memory.jsHeapSizeLimit / 1024 / 1024),
  }
}

class PerfRecorder {
  private records: PerfRecord[] = []
  private recording = false
  private scenario = '未命名场景'
  private notes = ''
  private startedAt = 0
  private frameTimes: number[] = []
  private rafId: number | null = null
  private lastFrameAt = 0
  private longTasks: { atMs: number; durationMs: number }[] = []
  private longTaskObserver: PerformanceObserver | null = null
  private memoryTimer: number | null = null
  private memorySamples: MemorySample[] = []
  private marks: PerfMark[] = []
  private switchStarts = new Map<string, number>()
  private switches: PerfSwitch[] = []
  private bootAt = 0
  private appReadyAt: number | null = null
  private panel: HTMLDivElement | null = null
  private liveTimer: number | null = null

  constructor() {
    this.records = this.load()
    this.captureNavigation()
    // 记录器按需加载: 若主入口已记录启动/就绪时刻, 直接采用, 避免把它算晚
    const globals = window as unknown as { __bootAt?: number; __appReadyAt?: number }
    this.bootAt = typeof globals.__bootAt === 'number' ? globals.__bootAt : performance.now()
    if (typeof globals.__appReadyAt === 'number') this.appReadyAt = globals.__appReadyAt
    window.addEventListener('perf:app-ready', this.onAppReady)
    window.addEventListener('perf:load-start', this.onLoadStart as EventListener)
    window.addEventListener('perf:playback-started', this.onPlaybackStarted as EventListener)
  }

  private onAppReady = () => {
    if (this.appReadyAt === null) this.appReadyAt = performance.now()
  }

  private onLoadStart = (event: CustomEvent<{ songId?: string }>) => {
    if (!this.recording) return
    const songId = event.detail?.songId
    if (songId) this.switchStarts.set(songId, performance.now())
  }

  private onPlaybackStarted = (event: CustomEvent<{ songId?: string }>) => {
    if (!this.recording) return
    const songId = event.detail?.songId
    if (!songId) return
    const startedAt = this.switchStarts.get(songId)
    if (startedAt === undefined) return
    this.switchStarts.delete(songId)
    this.switches.push({ songId, latencyMs: round(performance.now() - startedAt) })
  }

  private navigation: NavigationTiming = {
    domContentLoadedMs: null,
    loadEventMs: null,
    responseEndMs: null,
  }

  private captureNavigation() {
    const entry = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined
    if (!entry) return
    this.navigation = {
      domContentLoadedMs: round(entry.domContentLoadedEventEnd),
      loadEventMs: round(entry.loadEventEnd),
      responseEndMs: round(entry.responseEnd),
    }
  }

  // ========== 记录控制 ==========

  start(scenario?: string, notes = ''): void {
    if (this.recording) this.stop()
    if (scenario) this.scenario = scenario
    this.notes = notes
    this.recording = true
    this.startedAt = performance.now()
    this.frameTimes = []
    this.longTasks = []
    this.memorySamples = []
    this.marks = []
    this.switches = []
    this.switchStarts.clear()
    this.lastFrameAt = 0
    const initialHeap = readHeap()
    if (initialHeap) this.memorySamples.push({ atMs: 0, ...initialHeap })
    this.startFrameLoop()
    this.startLongTaskObserver()
    this.startMemorySampler()
    this.updatePanel()
  }

  mark(name: string): void {
    if (!this.recording) return
    this.marks.push({ name, atMs: round(performance.now() - this.startedAt) })
    this.updatePanel()
  }

  stop(notes?: string): PerfRecord | null {
    if (!this.recording) return null
    if (notes !== undefined) this.notes = notes
    const durationMs = performance.now() - this.startedAt
    const finalHeap = readHeap()
    if (finalHeap) this.memorySamples.push({ atMs: round(durationMs), ...finalHeap })
    this.stopFrameLoop()
    this.stopLongTaskObserver()
    this.stopMemorySampler()
    this.recording = false

    const sorted = [...this.frameTimes].sort((a, b) => a - b)
    const mean =
      this.frameTimes.length > 0
        ? this.frameTimes.reduce((sum, v) => sum + v, 0) / this.frameTimes.length
        : 0
    const frames: FrameStats = {
      sampleCount: this.frameTimes.length,
      durationMs: round(durationMs),
      fpsAvg: mean > 0 ? round(1000 / mean) : 0,
      frameP50Ms: round(percentile(sorted, 50)),
      frameP95Ms: round(percentile(sorted, 95)),
      frameMaxMs: round(sorted.length > 0 ? sorted[sorted.length - 1] : 0),
      jankCount: this.frameTimes.filter((value) => value > 50).length,
    }

    const usedValues = this.memorySamples.map((sample) => sample.usedHeapMb)
    const startUsed = usedValues.length > 0 ? usedValues[0] : 0
    const endUsed = usedValues.length > 0 ? usedValues[usedValues.length - 1] : 0
    const record: PerfRecord = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      scenario: this.scenario,
      notes: this.notes,
      startedAt: new Date(Date.now() - durationMs).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: round(durationMs),
      frames,
      longTasks: [...this.longTasks],
      memory: {
        supported: usedValues.length > 0,
        samples: [...this.memorySamples],
        startUsedHeapMb: startUsed,
        endUsedHeapMb: endUsed,
        peakUsedHeapMb: usedValues.length > 0 ? Math.max(...usedValues) : 0,
        deltaUsedHeapMb: round(endUsed - startUsed),
      },
      switches: [...this.switches],
      marks: [...this.marks],
    }

    this.records.unshift(record)
    if (this.records.length > MAX_RECORDS) this.records.length = MAX_RECORDS
    this.persist()
    this.updatePanel()
    return record
  }

  clear(): void {
    this.records = []
    this.persist()
    this.updatePanel()
  }

  getRecords(): PerfRecord[] {
    return this.records
  }

  isRecording(): boolean {
    return this.recording
  }

  // ========== 帧率 / 长任务 / 内存 ==========

  private startFrameLoop() {
    const loop = () => {
      const now = performance.now()
      if (this.lastFrameAt > 0) this.frameTimes.push(now - this.lastFrameAt)
      this.lastFrameAt = now
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)
  }

  private stopFrameLoop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  private startLongTaskObserver() {
    if (typeof PerformanceObserver === 'undefined') return
    try {
      this.longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longTasks.push({
            atMs: round(entry.startTime - this.startedAt),
            durationMs: round(entry.duration),
          })
        }
      })
      this.longTaskObserver.observe({ entryTypes: ['longtask'] })
    } catch {
      this.longTaskObserver = null
    }
  }

  private stopLongTaskObserver() {
    this.longTaskObserver?.disconnect()
    this.longTaskObserver = null
  }

  private startMemorySampler() {
    this.stopMemorySampler()
    this.memoryTimer = window.setInterval(() => {
      const heap = readHeap()
      if (!heap) return
      this.memorySamples.push({ atMs: round(performance.now() - this.startedAt), ...heap })
      this.updatePanel()
    }, 1000)
  }

  private stopMemorySampler() {
    if (this.memoryTimer !== null) {
      clearInterval(this.memoryTimer)
      this.memoryTimer = null
    }
  }

  getLiveStats(): {
    fps: number
    heapMb: number | null
    longTasks: number
    switches: number
    recording: boolean
  } {
    const recent = this.frameTimes.slice(-60)
    const mean = recent.length > 0 ? recent.reduce((sum, v) => sum + v, 0) / recent.length : 0
    return {
      fps: mean > 0 ? round(1000 / mean, 1) : 0,
      heapMb:
        this.memorySamples.length > 0
          ? this.memorySamples[this.memorySamples.length - 1].usedHeapMb
          : null,
      longTasks: this.longTasks.length,
      switches: this.switches.length,
      recording: this.recording,
    }
  }

  // ========== 导出 ==========

  buildEnvelope() {
    const heapLimit = this.memorySamples.length > 0 ? this.memorySamples[0].limitMb : null
    return {
      meta: {
        app: '高山流水',
        exportedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency ?? null,
        deviceMemoryGb: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null,
        jsHeapLimitMb: heapLimit,
        timeOrigin: round(performance.timeOrigin),
        startup: {
          appReadyMs: this.appReadyAt === null ? null : round(this.appReadyAt),
          bootToReadyMs: this.appReadyAt === null ? null : round(this.appReadyAt - this.bootAt),
          domContentLoadedMs: this.navigation.domContentLoadedMs,
          loadEventMs: this.navigation.loadEventMs,
          responseEndMs: this.navigation.responseEndMs,
        },
      },
      records: this.records,
    }
  }

  exportJson(): string {
    return JSON.stringify(this.buildEnvelope(), null, 2)
  }

  exportMarkdown(): string {
    const envelope = this.buildEnvelope()
    const lines: string[] = []
    lines.push('# 运行期性能记录')
    lines.push('')
    lines.push(`- 导出时间: ${envelope.meta.exportedAt}`)
    lines.push(`- 应用: ${envelope.meta.app}`)
    lines.push(
      `- 启动: app-ready ${envelope.meta.startup.appReadyMs ?? '-'} ms (其中 JS 启动 ${envelope.meta.startup.bootToReadyMs ?? '-'} ms), DOMContentLoaded ${envelope.meta.startup.domContentLoadedMs ?? '-'} ms, load ${envelope.meta.startup.loadEventMs ?? '-'} ms`
    )
    lines.push(
      `- 环境: ${envelope.meta.hardwareConcurrency ?? '-'} 逻辑核 / ${envelope.meta.deviceMemoryGb ?? '-'} GB 内存 / JS 堆上限 ${envelope.meta.jsHeapLimitMb ?? '-'} MB`
    )
    lines.push('')
    if (this.records.length === 0) {
      lines.push('> 暂无记录。')
      return lines.join('\n')
    }
    lines.push('## 汇总')
    lines.push('')
    lines.push(
      '| 场景 | 时长(s) | 平均FPS | P95帧(ms) | 最大帧(ms) | 卡顿帧 | 长任务 | 堆增量(MB) | 切歌次数 |'
    )
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for (const record of this.records) {
      lines.push(
        `| ${record.scenario} | ${(record.durationMs / 1000).toFixed(1)} | ${record.frames.fpsAvg} | ${record.frames.frameP95Ms} | ${record.frames.frameMaxMs} | ${record.frames.jankCount} | ${record.longTasks.length} | ${record.memory.deltaUsedHeapMb} | ${record.switches.length} |`
      )
    }
    for (const record of this.records) {
      lines.push('')
      lines.push(`## ${record.scenario}`)
      lines.push('')
      lines.push(
        `- 起止: ${record.startedAt} → ${record.endedAt} (时长 ${(record.durationMs / 1000).toFixed(1)}s)`
      )
      if (record.notes) lines.push(`- 备注: ${record.notes}`)
      lines.push(
        `- 帧: 样本 ${record.frames.sampleCount}, 平均 ${record.frames.fpsAvg} FPS, P50 ${record.frames.frameP50Ms}ms, P95 ${record.frames.frameP95Ms}ms, 最大 ${record.frames.frameMaxMs}ms, 卡顿(>50ms) ${record.frames.jankCount}`
      )
      lines.push(
        `- 长任务: ${record.longTasks.length} 次, 累计 ${round(record.longTasks.reduce((sum, task) => sum + task.durationMs, 0))}ms`
      )
      lines.push(
        `- JS 堆: 起 ${record.memory.startUsedHeapMb}MB → 止 ${record.memory.endUsedHeapMb}MB (峰值 ${record.memory.peakUsedHeapMb}MB, 增量 ${record.memory.deltaUsedHeapMb}MB)`
      )
      if (record.switches.length > 0) {
        lines.push(
          `- 切歌延迟(ms): ${record.switches.map((item) => `${item.songId ?? 'n/a'}=${item.latencyMs}`).join(', ')}`
        )
      }
      if (record.marks.length > 0) {
        lines.push(
          `- 人工标记: ${record.marks.map((mark) => `${mark.name}@${mark.atMs}ms`).join(', ')}`
        )
      }
    }
    lines.push('')
    return lines.join('\n')
  }

  async save(defaultName: string, content: string): Promise<boolean> {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const { invoke } = await import('@tauri-apps/api/core')
      const path = await save({
        defaultPath: defaultName,
        filters: [
          {
            name: defaultName.endsWith('.json') ? 'JSON' : 'Markdown',
            extensions: [defaultName.endsWith('.json') ? 'json' : 'md'],
          },
        ],
      })
      if (!path) return false
      await invoke('write_text_file', { path, content })
      return true
    } catch {
      this.download(defaultName, content)
      return false
    }
  }

  private download(name: string, content: string) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    URL.revokeObjectURL(url)
  }

  // ========== 持久化 ==========

  private load(): PerfRecord[] {
    try {
      const raw = localStorage.getItem(RECORDS_KEY)
      return raw ? (JSON.parse(raw) as PerfRecord[]) : []
    } catch {
      return []
    }
  }

  private persist() {
    try {
      localStorage.setItem(RECORDS_KEY, JSON.stringify(this.records))
    } catch {
      // 存储配额不足时忽略
    }
  }

  // ========== 面板 ==========

  togglePanel(force?: boolean) {
    const shouldShow = force ?? this.panel === null
    if (shouldShow && this.panel === null) {
      this.createPanel()
      try {
        localStorage.setItem(HOTKEY_ENABLED_KEY, '1')
      } catch {
        // ignore
      }
    } else if (!shouldShow && this.panel) {
      this.destroyPanel()
      try {
        localStorage.setItem(HOTKEY_ENABLED_KEY, '0')
      } catch {
        // ignore
      }
    }
  }

  private createPanel() {
    const panel = document.createElement('div')
    panel.id = PANEL_ID
    panel.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483000',
      'width:360px',
      'max-height:70vh',
      'overflow:auto',
      'background:rgba(17,17,17,0.94)',
      'color:#e5e5e5',
      'border:1px solid #3f3f46',
      'border-radius:10px',
      'font:12px/1.5 ui-monospace,Consolas,monospace',
      'padding:10px',
      'box-shadow:0 8px 28px rgba(0,0,0,0.45)',
    ].join(';')
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <strong style="font-size:13px">性能记录器</strong>
        <button data-act="close" style="background:none;border:none;color:#a1a1aa;cursor:pointer">✕</button>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:6px">
        <input data-field="scenario" placeholder="场景名" style="flex:1;background:#27272a;border:1px solid #3f3f46;border-radius:6px;color:#e5e5e5;padding:4px 6px" />
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">
        <button data-act="start">开始</button>
        <button data-act="mark">标记</button>
        <button data-act="stop">停止</button>
        <button data-act="json">导出JSON</button>
        <button data-act="md">导出MD</button>
        <button data-act="copy">复制</button>
        <button data-act="clear">清空</button>
      </div>
      <div data-field="live" style="margin-bottom:6px;color:#a1a1aa"></div>
      <div data-field="list"></div>
    `
    for (const button of Array.from(panel.querySelectorAll('button'))) {
      button.style.cssText =
        'background:#27272a;border:1px solid #3f3f46;border-radius:6px;color:#e5e5e5;padding:3px 8px;cursor:pointer'
    }
    panel.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      const act = target.getAttribute('data-act')
      if (!act) return
      void this.handleAction(act, panel)
    })
    document.body.appendChild(panel)
    this.panel = panel
    const scenarioInput = panel.querySelector('[data-field="scenario"]') as HTMLInputElement | null
    if (scenarioInput) scenarioInput.value = this.scenario
    this.updatePanel()
    this.liveTimer = window.setInterval(() => this.updatePanel(), 500)
  }

  private async handleAction(act: string, panel: HTMLDivElement) {
    const scenarioInput = panel.querySelector('[data-field="scenario"]') as HTMLInputElement | null
    switch (act) {
      case 'close':
        this.togglePanel(false)
        break
      case 'start':
        this.start(scenarioInput?.value || '未命名场景')
        break
      case 'mark': {
        const name = window.prompt('标记名称', '标记')
        if (name) this.mark(name)
        break
      }
      case 'stop': {
        const notes = window.prompt('本次记录备注 (可留空)', '') ?? ''
        this.stop(notes)
        break
      }
      case 'json':
        await this.save(`perf-records-${Date.now()}.json`, this.exportJson())
        break
      case 'md':
        await this.save(`perf-records-${Date.now()}.md`, this.exportMarkdown())
        break
      case 'copy':
        try {
          await navigator.clipboard.writeText(this.exportJson())
          window.alert('已复制 JSON 到剪贴板')
        } catch {
          window.alert('复制失败, 请改用导出')
        }
        break
      case 'clear':
        if (window.confirm('清空全部性能记录?')) this.clear()
        break
    }
  }

  private updatePanel() {
    if (!this.panel) return
    const live = this.panel.querySelector('[data-field="live"]')
    if (live) {
      const stats = this.getLiveStats()
      live.textContent = `${stats.recording ? '● 记录中' : '○ 空闲'} | ${stats.fps} FPS | 堆 ${stats.heapMb ?? '-'} MB | 长任务 ${stats.longTasks} | 切歌 ${stats.switches} | 记录 ${this.records.length}`
    }
    const list = this.panel.querySelector('[data-field="list"]')
    if (list) {
      if (this.records.length === 0) {
        list.textContent = '暂无记录'
      } else {
        list.innerHTML = this.records
          .slice(0, 8)
          .map(
            (record) =>
              `<div style="border-top:1px solid #27272a;padding:4px 0">${record.scenario} · ${(record.durationMs / 1000).toFixed(1)}s · ${record.frames.fpsAvg} FPS · 堆Δ${record.memory.deltaUsedHeapMb}MB · 长任务${record.longTasks.length}</div>`
          )
          .join('')
      }
    }
  }

  private destroyPanel() {
    if (this.liveTimer !== null) {
      clearInterval(this.liveTimer)
      this.liveTimer = null
    }
    this.panel?.remove()
    this.panel = null
  }
}

let instance: PerfRecorder | null = null

/** 初始化 (幂等); 返回单例, 便于控制台/自动化调用 */
export function initPerfRecorder(): PerfRecorder {
  if (!instance) {
    instance = new PerfRecorder()
    ;(window as unknown as Record<string, unknown>).__perf = instance
  }
  return instance
}
