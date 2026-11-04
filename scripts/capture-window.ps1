# Save the largest visible window of one process to a PNG with PrintWindow (the window is not brought to the front).
# Usage: powershell -File capture-window.ps1 -ProcessId <pid> -Out <file.png>
param([Parameter(Mandatory)] [int]$ProcessId, [Parameter(Mandatory)] [string]$Out)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class CapWin {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
    public static List<IntPtr> Find(uint pid) {
        var list = new List<IntPtr>();
        EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }
}
"@
$best = [IntPtr]::Zero; $bestArea = 0
foreach ($h in [CapWin]::Find([uint32]$ProcessId)) {
    $cls = New-Object System.Text.StringBuilder 64
    [CapWin]::GetClassName($h, $cls, 64) | Out-Null
    if ($cls.ToString() -eq 'ConsoleWindowClass') { continue }
    $r = New-Object CapWin+RECT
    [CapWin]::GetClientRect($h, [ref]$r) | Out-Null
    $area = ($r.R - $r.L) * ($r.B - $r.T)
    if ($area -gt $bestArea) { $best = $h; $bestArea = $area; $w = $r.R - $r.L; $hh = $r.B - $r.T }
}
if ($best -eq [IntPtr]::Zero) { Write-Host "no window for process $ProcessId"; exit 1 }
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
[CapWin]::PrintWindow($best, $dc, 3) | Out-Null   # PW_CLIENTONLY | PW_RENDERFULLCONTENT
$g.ReleaseHdc($dc)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host "saved $Out"
