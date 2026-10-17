<#
  冷启动耗时自动测量 (Cold Start Benchmark)

  用途
    "手动掐表测启动"误差大且无法复现。本脚本自动重复启动应用, 记录
    "进程创建 -> 主窗口出现且可响应" 的耗时, 逐次落盘为 JSONL, 并汇总统计。

  口径说明
    - 测的是"进程启动到主窗口可用", 不包含首次渲染完成的全部时间;
      应用内更细的 JS 启动时序由内置性能记录器 (Ctrl+Shift+F12) 采集。
    - 每次运行结束会关闭进程, 避免单实例插件把后续启动变成"聚焦已有窗口"。
    - 默认先跑 1 次预热 (不计入统计), 再跑 N 次正式测量。

  用法
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\measure-cold-start.ps1 `
      -Exe "src-tauri\target\release\gaoshanliushui.exe" -Runs 5

  注意: 启动 GUI (WebView2) 需要完全权限; 受限沙箱下会因命名管道被拒而白屏。
#>
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$Runs = 5,
  [int]$WarmupRuns = 1,
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

Write-Output "冷启动测量: $exePath"
Write-Output ("预热 {0} 次, 正式 {1} 次, 单次超时 {2}ms" -f $WarmupRuns, $Runs, $TimeoutMs)

$records = @()
$totalRuns = $WarmupRuns + $Runs
for ($i = 1; $i -le $totalRuns; $i++) {
  $isWarmup = ($i -le $WarmupRuns)
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

  $label = if ($isWarmup) { 'warmup' } else { 'measured' }
  $record = [ordered]@{
    index   = $i
    kind    = $label
    ms      = $ms
    ready   = $ready
    endedAt = (Get-Date).ToString('o')
    exe     = $exePath
  }
  ($record | ConvertTo-Json -Compress) | Out-File -FilePath $Out -Append -Encoding UTF8
  if ($isWarmup) {
    Write-Output ("[{0}/{1}] 预热: {2} ms (ready={3})" -f $i, $totalRuns, $ms, $ready)
  } else {
    $records += $ms
    Write-Output ("[{0}/{1}] 正式: {2} ms (ready={3})" -f $i, $totalRuns, $ms, $ready)
  }
}

if ($records.Count -eq 0) {
  Write-Output '没有采集到正式样本。'
  exit 1
}

$sorted = $records | Sort-Object
$count = $sorted.Count
$median = if ($count % 2 -eq 1) { $sorted[[int][Math]::Floor($count / 2)] } else { [Math]::Round((($sorted[$count / 2 - 1] + $sorted[$count / 2]) / 2), 1) }
$p95Index = [int][Math]::Ceiling($count * 0.95) - 1
if ($p95Index -lt 0) { $p95Index = 0 }
$summary = [ordered]@{
  generatedAt = (Get-Date).ToString('o')
  exe         = $exePath
  runs        = $count
  min         = $sorted[0]
  median      = $median
  p95         = $sorted[$p95Index]
  max         = $sorted[$count - 1]
  mean        = [Math]::Round(($records | Measure-Object -Average).Average, 1)
  samples     = $records
}

$lines = @()
$lines += '# 冷启动测量记录'
$lines += ''
$lines += ('> 自动生成, 请勿手改。生成时间: ' + $summary.generatedAt)
$lines += ''
$lines += ('- 可执行文件: ' + $summary.exe)
$lines += ('- 样本数: ' + $summary.runs)
$lines += ''
$lines += '| 指标 | 耗时(ms) |'
$lines += '| --- | ---: |'
$lines += ('| 最小 | ' + $summary.min + ' |')
$lines += ('| 中位数 | ' + $summary.median + ' |')
$lines += ('| P95 | ' + $summary.p95 + ' |')
$lines += ('| 最大 | ' + $summary.max + ' |')
$lines += ('| 平均 | ' + $summary.mean + ' |')
$lines += ''
$lines += ('原始样本: ' + ($records -join ', ') + ' ms')
$lines += ''
$lines -join "`n" | Out-File -FilePath $SummaryOut -Encoding UTF8

Write-Output ''
Write-Output ("中位数: {0} ms | P95: {1} ms | 最小: {2} ms | 最大: {3} ms" -f $summary.median, $summary.p95, $summary.min, $summary.max)
Write-Output ("已写入: $Out")
Write-Output ("已写入: $SummaryOut")
