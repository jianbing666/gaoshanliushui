param([Parameter(Mandatory=$true)][int]$ProcId)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinFg {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr Best = IntPtr.Zero;
  public static int BestArea = 0;
  public static bool Collect(IntPtr h, IntPtr lp) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    if (pid == (uint)lp.ToInt32()) {
      RECT r; GetWindowRect(h, out r);
      int area = (r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > BestArea) { BestArea = area; Best = h; }
    }
    return true;
  }
  public static IntPtr Find(int pid) { Best = IntPtr.Zero; BestArea = 0; EnumWindows(Collect, new IntPtr(pid)); return Best; }
}
'@
$h = [WinFg]::Find($ProcId)
if ($h -eq [IntPtr]::Zero) { 'no-window'; exit 0 }
[void][WinFg]::ShowWindow($h, 9)
[void][WinFg]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 600
$rect = New-Object WinFg+RECT
[void][WinFg]::GetWindowRect($h, [ref]$rect)
'visible=' + [WinFg]::IsWindowVisible($h) + ' size=' + ($rect.Right - $rect.Left) + 'x' + ($rect.Bottom - $rect.Top)
