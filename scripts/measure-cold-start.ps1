<#
  冷启动耗时自动测量 (Cold Start Benchmark)

  用途
    "手动掐表测启动"误差大且无法复现。本脚本自动重复启动应用, 记录
    "进程创建 -> 主窗口出现且可响应" 的耗时, 逐次落盘为 JSONL, 并汇总统计。

  口径说明
    - 第 1 次启动记为"首次启动(Cold)" —— 这才是通常说的冷启动; 之后各次记为
      "热启动(Warm)", 因为 WebView2 运行时与系统文件缓存已被预热, 会明显更快。
      两者必须分开报告, 不可混成一个中位数。
    - 测的是"进程启动到主窗口句柄出现且可响应", 早于首屏渲染完成;
      应用内更细的 JS 启动时序由内置性能记录器 (Ctrl+Shift+F12) 采集。
    - 每次运行结束会关闭进程, 避免单实例插件把后续启动变成"聚焦已有窗口"。

  前置条件
    测量前必须确认没有正在运行的应用实例。若已有实例, 单实例插件会让新进程
    在约 100ms 内直接退出, 样本整批无效 (判据: 样本极小且 ready=false)。

  用法
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\measure-cold-start.ps1 `
      -Exe "src-tauri\target\release\gaoshanliushui.exe" -Runs 6

  注意: 启动 GUI (WebView2) 需要完全权限; 受限沙箱下会因命名管道被拒而白屏。
#>
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$Runs = 6,
  [int]$TimeoutMs = 30000,
  [string]$Out = 'markdown\性能\冷启动记录.jsonl',
  [string]$SummaryOut = 'markdown\性能\冷启动记录.md'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Exe)) {
  throw "找不到可执行文件: $Exe"
}
$exePath = (Resolve-Path -LiteralPath $Exe).Path

$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}
if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }

function Stop-AppProcess($proc) {
  try {
    $proc.Refresh()
    if ($proc.HasExited) { return }
    $null = $proc.CloseMainWindow()
    if (-not $proc.WaitForExit(5000)) {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 500
    }
  } catch {
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
}

function Get-Stats($values) {
  $sorted = @($values | Sort-Object)
  $count = $sorted.Count
  if ($count -eq 0) { return $null }
  $median = if ($count % 2 -eq 1) { $sorted[[int][Math]::Floor($count / 2)] } else { [Math]::Round((($sorted[$count / 2 - 1] + $sorted[$count / 2]) / 2), 1) }
  $p95Index = [int][Math]::Ceiling($count * 0.95) - 1
  if ($p95Index -lt 0) { $p95Index = 0 }
  return [ordered]@{
    n      = $count
    min    = $sorted[0]
    median = $median
    p95    = $sorted[$p95Index]
    max    = $sorted[$count - 1]
    mean   = [Math]::Round(($values | Measure-Object -Average).Average, 1)
  }
}

Write-Output "冷启动测量: $exePath"
Write-Output ("共 {0} 次 (第 1 次为冷启动, 其余为热启动), 单次超时 {1}ms" -f $Runs, $TimeoutMs)

$coldMs = $null
$coldReady = $null
$warm = @()
for ($i = 1; $i -le $Runs; $i++) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $proc = Start-Process -FilePath $exePath -PassThru
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  $ready = $false
  while ($true) {
    Start-Sleep -Milliseconds 25
    try { $proc.Refresh() } catch { break }
    if ($proc.HasExited) { break }
    if ($proc.MainWindowHandle -ne [IntPtr]::Zero -and $proc.Responding) { $ready = $true; break }
    if ([DateTime]::UtcNow -gt $deadline) { break }
  }
  $sw.Stop()
  $ms = [Math]::Round($sw.Elapsed.TotalMilliseconds, 1)

  Stop-AppProcess $proc
  Start-Sleep -Seconds 2

  $kind = if ($i -eq 1) { 'cold' } else { 'warm' }
  $record = [ordered]@{
    index   = $i
    kind    = $kind
    ms      = $ms
    ready   = $ready
    endedAt = (Get-Date).ToString('o')
    exe     = $exePath
  }
  ($record | ConvertTo-Json -Compress) | Out-File -FilePath $Out -Append -Encoding UTF8

  if ($kind -eq 'cold') {
    $coldMs = $ms
    $coldReady = $ready
    Write-Output ("[{0}/{1}] 冷启动: {2} ms (ready={3})" -f $i, $Runs, $ms, $ready)
  } else {
    $warm += $ms
    Write-Output ("[{0}/{1}] 热启动: {2} ms (ready={3})" -f $i, $Runs, $ms, $ready)
  }
}

if ($coldMs -eq $null) {
  Write-Output '没有采集到冷启动样本。'
  exit 1
}

# 无效样本判据: 冷启动样本始终没等到主窗口 (通常是已存在实例导致新进程秒退)
$suspicious = (-not $coldReady)
if ($suspicious) {
  Write-Output '警告: 冷启动样本未检测到主窗口句柄, 疑似存在正在运行的应用实例导致秒退, 数据无效。'
}

$warmStats = Get-Stats $warm

$lines = @()
$lines += '# 冷启动测量记录'
$lines += ''
$lines += ('> 自动生成, 请勿手改。生成时间: ' + (Get-Date).ToString('o'))
$lines += ''
$lines += ('- 可执行文件: ' + $exePath)
$lines += ('- 冷启动样本: 1 次; 热启动样本: ' + $warm.Count + ' 次')
$lines += ''
$lines += '| 指标 | 耗时(ms) |'
$lines += '| --- | ---: |'
$lines += ('| 冷启动(首次) | ' + $coldMs + ' |')
if ($warmStats) {
  $lines += ('| 热启动 中位数 | ' + $warmStats.median + ' |')
  $lines += ('| 热启动 P95 | ' + $warmStats.p95 + ' |')
  $lines += ('| 热启动 最小 / 最大 | ' + $warmStats.min + ' / ' + $warmStats.max + ' |')
  $lines += ('| 热启动 平均 | ' + $warmStats.mean + ' |')
}
$lines += ''
if ($warmStats) {
  $lines += ('原始热启动样本: ' + ($warm -join ', ') + ' ms')
}
$lines += ''
$lines += '> 口径: “进程创建 → 主窗口句柄出现且可响应”, 早于首屏渲染; 冷启动为进程/运行时首次加载, 热启动为随后的重复启动。'
$lines += ''
$lines -join "`n" | Out-File -FilePath $SummaryOut -Encoding UTF8

Write-Output ''
if ($warmStats) {
  Write-Output ("冷启动: {0} ms | 热启动中位数: {1} ms | 热启动P95: {2} ms" -f $coldMs, $warmStats.median, $warmStats.p95)
} else {
  Write-Output ("冷启动: {0} ms" -f $coldMs)
}
Write-Output ("已写入: $Out")
Write-Output ("已写入: $SummaryOut")
