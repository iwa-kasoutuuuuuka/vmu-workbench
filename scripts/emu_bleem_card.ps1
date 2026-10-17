# bleem2 (Dreamcast 上の PS1 エミュレーター) に VMU イメージを読ませ、PS1 ゲームの反応を画面で確認する。
# 改造した PS1 セーブ (BLEEMMC) をゲームが受理するかの検証用。
#
#   powershell -File scripts/emu_bleem_card.ps1 -Image my.bin -Tag modded [-Seconds 40]
#
# 結果: .emu/out/bleem_<Tag>/shot_NNN_w*.png (2 秒毎の画面とシリアル窓), bleemlog.txt (bleem2 のログ)
# 前提: npm run verify:emu を一度実行して .emu/ (Flycast と BIOS) が用意されていること。
# D:\DC 側は bleem2 の CDI と画面キャプチャスクリプトを読むだけで、何も書き換えない。
param(
    [Parameter(Mandatory = $true)][string]$Image,
    [string]$Tag = "run",
    [int]$Seconds = 40,
    [int]$StartAt = 0,          # この秒数が経つまで撮影しない (長時間実行の後半だけ見たいとき)
    [int]$Interval = 2,
    [string]$KeyAt = "",        # 指定秒にキーを送る。例 "105:DOWN,130:ENTER" (Flycast を前面に出して送る)
    [string]$SendKeys = "",     # 既定は scripts/send_keys.ps1 (前面化を確認してから送る)
    [string]$Cdi = "D:\DC\bleem2-memcard\build\bleem2.cdi",
    [string]$Capture = "D:\DC\bleem2\scripts\capture_flycast.ps1"
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
if ($SendKeys -eq "") { $SendKeys = Join-Path $PSScriptRoot "send_keys.ps1" }
$emu = Join-Path $root ".emu"
$flycast = Join-Path $emu "flycast.exe"
$vmuFile = Join-Path $emu "data\vmu_save_A1.bin"
$out = Join-Path $emu "out\bleem_$Tag"
if (-not (Test-Path $flycast)) { Write-Host ".emu/ がありません。先に npm run verify:emu を実行してください"; exit 1 }
if (-not (Test-Path $Cdi)) { Write-Host "CDI がありません: $Cdi"; exit 1 }

New-Item -ItemType Directory -Force $out | Out-Null
Remove-Item "$out\*" -Force -ErrorAction SilentlyContinue
Copy-Item $Image $vmuFile -Force
Copy-Item $Image (Join-Path $out "before.bin") -Force

function Stop-OurFlycast {
    Get-Process flycast -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $flycast } |
        Stop-Process -Force -ErrorAction SilentlyContinue
}
Stop-OurFlycast
Start-Sleep -Milliseconds 300

$keyPlan = @()
foreach ($item in ($KeyAt -split ',' | Where-Object { $_ -match '^\s*\d+\s*:' })) {
    $sec, $keys = $item -split ':', 2
    $keyPlan += [pscustomobject]@{ At = [int]$sec; Keys = $keys.Trim(); Sent = $false }
}

$p = Start-Process -FilePath $flycast -ArgumentList "`"$Cdi`"" -WorkingDirectory $emu -PassThru
$ErrorActionPreference = "Continue"
$t0 = Get-Date
$n = 0
while (((Get-Date) - $t0).TotalSeconds -lt $Seconds) {
    Start-Sleep -Seconds $Interval
    if ($p.HasExited) { Write-Host "Flycast が途中で終了しました"; break }
    $elapsed = ((Get-Date) - $t0).TotalSeconds
    foreach ($k in $keyPlan) {
        if (-not $k.Sent -and $elapsed -ge $k.At) {
            $k.Sent = $true
            Write-Host ("{0:N0} 秒: キー {1} を送信" -f $elapsed, $k.Keys)
            $r = & powershell -NoProfile -ExecutionPolicy Bypass -File $SendKeys -Keys $k.Keys -HoldMs 300 -FlycastPid $p.Id
            if ($LASTEXITCODE -ne 0) { Write-Host "  キーがゲームに届いていない可能性: $r" }
        }
    }
    if ($elapsed -lt $StartAt) { continue }
    $n++
    $cap = Start-Process -FilePath "powershell" -PassThru -WindowStyle Hidden -ArgumentList (
        "-NoProfile -ExecutionPolicy Bypass -File `"{0}`" `"{1}\shot_{2:D3}`" -FlycastPid {3}" -f $Capture, $out, $n, $p.Id)
    if (-not $cap.WaitForExit(20000)) { $cap.Kill() }
}
Stop-OurFlycast
Start-Sleep -Milliseconds 500
Copy-Item $vmuFile (Join-Path $out "after.bin") -Force
& node (Join-Path $root "cli.js") cat (Join-Path $out "after.bin") BLEEMLOG 2>$null | Out-File -Encoding utf8 (Join-Path $out "bleemlog.txt")
Write-Host "画面: $out"
Get-Content (Join-Path $out "bleemlog.txt") -ErrorAction SilentlyContinue | Select-String "MEMCARD" | ForEach-Object { $_.Line.Trim([char]0) }
