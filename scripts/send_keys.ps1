# Flycast のゲームウィンドウ ("Flycast - <タイトル>") を前面に出してキーを押す。
# D:\DC\bleem2\scripts\send_keys.ps1 と同じ使い方だが、前面化に失敗したらキーを送らずに終了する
# (元のスクリプトは SetForegroundWindow の結果を見ないため、他のアプリを使っている間は
#  キーが別のウィンドウに入り、ゲームが固まったように見える)。
#
#   powershell -File scripts/send_keys.ps1 -Keys "RIGHT" [-HoldMs 400] [-FlycastPid N]
#   終了コード: 0 = 送信した / 1 = Flycast が見つからない / 2 = 前面にできず送らなかった
#
# 既定のキー割り当て: 十字 = 矢印, Start = ENTER, × = X, ○ = C, △ = D, □ = S
param([string]$Keys = "ENTER", [int]$HoldMs = 500, [int]$Repeat = 1, [int]$GapMs = 400, [int]$FlycastPid = 0, [switch]$Chord)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DcvKey {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
    public static string Title(IntPtr h) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); return sb.ToString(); }
    public static IntPtr FindGame(uint pid) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
            if (p == pid && IsWindowVisible(h) && Title(h).StartsWith("Flycast - ")) { found = h; return false; } return true; }, IntPtr.Zero);
        return found;
    }
    /* 前面化。通常の SetForegroundWindow が拒否されたら、前面ウィンドウの入力スレッドに一時的に接続して再試行 */
    public static bool Focus(IntPtr h) {
        if (IsIconic(h)) ShowWindow(h, 9);
        if (SetForegroundWindow(h) && GetForegroundWindow() == h) return true;
        uint pid;
        uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        uint me = GetCurrentThreadId();
        bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
        BringWindowToTop(h);
        SetForegroundWindow(h);
        if (attached) AttachThreadInput(me, fgThread, false);
        return GetForegroundWindow() == h;
    }
}
"@
$vkmap = @{ "ENTER"=0x0D; "SPACE"=0x20; "UP"=0x26; "DOWN"=0x28; "LEFT"=0x25; "RIGHT"=0x27;
            "X"=0x58; "C"=0x43; "S"=0x53; "D"=0x44; "Z"=0x5A; "A"=0x41; "Q"=0x51; "E"=0x45; "F1"=0x70;
            "F"=0x46; "V"=0x56; "W"=0x57; "R"=0x52; "B"=0x42 }

if ($FlycastPid -gt 0) { $p = Get-Process -Id $FlycastPid -ErrorAction SilentlyContinue } else { $p = Get-Process flycast -ErrorAction SilentlyContinue | Select-Object -First 1 }
if (-not $p) { Write-Host "no flycast"; exit 1 }
$target = [DcvKey]::FindGame([uint32]$p.Id)
if ($target -eq [IntPtr]::Zero) { Write-Host "game window not found"; exit 1 }

function Ensure-Focus {
    for ($try = 1; $try -le 5; $try++) {
        if ([DcvKey]::Focus($target)) { Start-Sleep -Milliseconds 150; return $true }
        Start-Sleep -Milliseconds 300
    }
    return $false
}
if (-not (Ensure-Focus)) {
    $fg = [DcvKey]::Title([DcvKey]::GetForegroundWindow())
    Write-Host "NOT SENT [$Keys]: could not bring Flycast to the front (foreground: '$fg')"
    exit 2
}

function Key($k, [bool]$down) {
    $vk = [byte]$vkmap[$k]
    $scan = [byte]([DcvKey]::MapVirtualKey($vk, 0))
    $flags = 0
    if ($k -in "UP", "DOWN", "LEFT", "RIGHT") { $flags = 1 }   # KEYEVENTF_EXTENDEDKEY
    if (-not $down) { $flags = $flags -bor 2 }                  # KEYEVENTF_KEYUP
    [DcvKey]::keybd_event($vk, $scan, $flags, [UIntPtr]::Zero)
}

$list = $Keys.Split(",") | ForEach-Object { $_.Trim().ToUpper() }
foreach ($k in $list) { if (-not $vkmap.ContainsKey($k)) { Write-Host "unknown key $k"; exit 1 } }
$lost = $false
for ($i = 0; $i -lt $Repeat; $i++) {
    if ($Chord) {
        foreach ($k in $list) { Key $k $true; Start-Sleep -Milliseconds 60 }
        Start-Sleep -Milliseconds $HoldMs
        if ([DcvKey]::GetForegroundWindow() -ne $target) { $lost = $true }
        foreach ($k in $list) { Key $k $false }
    } else {
        foreach ($k in $list) {
            if (-not (Ensure-Focus)) { Write-Host "NOT SENT [$k]: Flycast lost focus"; exit 2 }
            Key $k $true
            Start-Sleep -Milliseconds $HoldMs
            if ([DcvKey]::GetForegroundWindow() -ne $target) { $lost = $true }
            Key $k $false        # 離すのは必ず送る (押しっぱなしを残さない)
            Start-Sleep -Milliseconds $GapMs
        }
    }
}
if ($lost) { Write-Host "WARNING [$Keys]: focus moved away while the key was held (the game may not have seen it)"; exit 2 }
Write-Host "pressed [$Keys] x$Repeat (hold $HoldMs ms) on '$([DcvKey]::Title($target))'"
