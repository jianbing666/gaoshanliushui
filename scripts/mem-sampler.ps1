# 整应用内存采样器 (P3 口径)
#
# 用途
#   以固定间隔采样"应用进程树"的两种内存口径, 每行输出一个 JSON 样本:
#     - wsMB   : 进程树工作集合计 (Win32_PerfFormattedData_PerfProc_Process.WorkingSet)
#     - privMB : 进程树私有工作集合计 (WorkingSetPrivate, 即任务管理器"内存"列口径)
#   进程树 = 根进程 + 按 ParentProcessId 递归收集的全部后代 (WebView2 的
#   browser/renderer/gpu/utility 子进程都算在内)。
#
# 为什么两种口径都要
#   历史文档里的 290~370MB 是任务管理器读数(私有工作集); 进程树工作集会把
#   Chromium 共享 DLL/代码页重复计入, 数值明显更大。两者不可混用, 因此双写。
#
# 用法 (通常由 scripts/perf-runtime.mjs 自动拉起, 也可手动):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/mem-sampler.ps1
#     -RootPid 12345 -IntervalMs 300 -Out C:/Temp/mem.jsonl
#
# 说明
#   - 只读, 不修改被采样进程。
#   - 单次采样的瓶颈是 WMI 查询(约 0.6~1s), 所以实际采样周期会大于 IntervalMs;
#     进程树每 5 个样本刷新一次(WebView2 子进程在启动后基本稳定), 以降低开销。
#   - 文件为 UTF-8 无 BOM, 每行一个 JSON, 便于调用方流式读取。
param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [int]$IntervalMs = 300,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'SilentlyContinue'
$enc = New-Object System.Text.UTF8Encoding($false)

$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}
if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }

function Get-TreePids([int]$root) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
  $byParent = @{}
  foreach ($p in $all) {
    $pp = [int]$p.ParentProcessId
    if (-not $byParent.ContainsKey($pp)) { $byParent[$pp] = New-Object System.Collections.ArrayList }
    [void]$byParent[$pp].Add([int]$p.ProcessId)
  }
  $pids = New-Object System.Collections.Generic.List[int]
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($root)
  while ($queue.Count -gt 0) {
    $cur = [int]$queue.Dequeue()
    $pids.Add($cur)
    if ($byParent.ContainsKey($cur)) {
      foreach ($kid in $byParent[$cur]) { $queue.Enqueue($kid) }
    }
  }
  return $pids
}

$treePids = @(Get-TreePids $RootPid)
$tick = 0

while ($true) {
  if (($tick % 5) -eq 0) {
    $treePids = @(Get-TreePids $RootPid)
  }
  $tick++

  $set = @{}
  foreach ($p in $treePids) { $set[[int]$p] = $true }

  $ws = [int64]0
  $priv = [int64]0
  $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Property IDProcess, WorkingSet, WorkingSetPrivate
  foreach ($row in $perf) {
    if ($null -eq $row.IDProcess) { continue }
    if ($set.ContainsKey([int]$row.IDProcess)) {
      $ws += [int64]$row.WorkingSet
      $priv += [int64]$row.WorkingSetPrivate
    }
  }

  $nl = [string][char]10
  $sample = [ordered]@{
    t      = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    root   = $RootPid
    count  = $treePids.Count
    wsMB   = [math]::Round($ws / 1MB, 2)
    privMB = [math]::Round($priv / 1MB, 2)
  }
  [System.IO.File]::AppendAllText($Out, (($sample | ConvertTo-Json -Compress) + $nl), $enc)
  Start-Sleep -Milliseconds $IntervalMs
}
