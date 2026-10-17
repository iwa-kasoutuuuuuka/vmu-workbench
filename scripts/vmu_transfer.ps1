# 実機 VMU ⇔ PC のイメージ転送 ROM (emu/vmutransfer) をビルド・検証する。
#
#   書き戻し用 ROM を作る:  powershell -File scripts/vmu_transfer.ps1 -Restore my.bin   (.dcm も可)
#     my.bin を ROM に埋め込んだ emu/vmutransfer/vmutransfer.cdi を作る。実機で起動して Y → START で A1 に書き戻す。
#   取り出し用 ROM を作る:  powershell -File scripts/vmu_transfer.ps1
#     dcload-ip / dcload-serial で起動すると A で A1 を /pc/vmu_dump.bin に保存できる
#     (例: dc-tool-ip -t <DCのIP> -c <保存先フォルダ> -x emu/vmutransfer/vmutransfer.elf)。
#   Flycast で自動検証:      powershell -File scripts/vmu_transfer.ps1 -Test
#     A1 = テスト用イメージ、A2 = 空の VMU で起動し、「A1 → A2 の丸ごとコピー」と「埋め込んだイメージを A1 に書き戻す」
#     を自動実行させて、両方がバイト単位で一致するか scripts/verify-transfer.js で確かめる。
#
# Flycast と BIOS は emu_verify.ps1 と同じく D:\DC\flycast-memcard から .emu/ へコピーして使う (D:\DC 側は書き換えない)。
param(
    [string]$Restore = "",
    [switch]$Test,
    [int]$Timeout = 120,
    [string]$FlycastSrc = "D:\DC\flycast-memcard"
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$romDir = Join-Path $root "emu\vmutransfer"
$romdisk = Join-Path $romDir "romdisk"
$cdi = Join-Path $romDir "vmutransfer.cdi"
$cli = Join-Path $root "cli.js"
$emu = Join-Path $root ".emu"
$outDir = Join-Path $emu "out\transfer"
New-Item -ItemType Directory -Force $romdisk, $outDir | Out-Null

function Build-Rom {
    $bash = "C:\msys64\usr\bin\bash.exe"
    & $bash -lc "export MSYSTEM=MINGW64 TMP=/tmp TEMP=/tmp LANG=C; cd /d/DC_VMU/emu/vmutransfer && source /d/DC/KallistiOS/environ.sh && make cdi" | Out-Host
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $cdi)) { throw "ROM のビルドに失敗しました" }
}

# romdisk の中身を入れ替える
Get-ChildItem $romdisk -Exclude ".gitignore" | Remove-Item -Force

if (-not $Test) {
    if ($Restore -ne "") {
        & node $cli convert $Restore (Join-Path $romdisk "restore.bin")
        if ($LASTEXITCODE -ne 0) { exit 1 }
        & node $cli check (Join-Path $romdisk "restore.bin")
    }
    Build-Rom
    Write-Host ""
    Write-Host "作成: $cdi"
    if ($Restore -ne "") { Write-Host "実機で起動 → Y → START で A1 の VMU を $Restore の内容に置き換えます (元に戻せません)。" }
    Write-Host "A: A1 → PC (/pc/vmu_dump.bin、dcload 接続時のみ)   X: A1 → A2 コピー   Y: 書き戻し"
    Write-Host "注意: 実機での動作は未確認です (Flycast でのみ検証済み)。大事なセーブは先に別の VMU にコピーしてください。"
    exit 0
}

# ---- Flycast で自動検証 ----
$orig = Join-Path $outDir "orig_a1.bin"
$restoreImg = Join-Path $outDir "restore.bin"
& node (Join-Path $root "scripts\make-test-image.js") $orig | Out-Host
if ($LASTEXITCODE -ne 0) { exit 1 }
# 書き戻すイメージ: デモのミニゲーム (ブロック 0〜) + データファイル。元の A1 とは中身が全く違う
$game = Join-Path $outDir "hello.vms"
Remove-Item $restoreImg -ErrorAction SilentlyContinue
& node $cli asm (Join-Path $root "examples\hello-vmu.s") $game | Out-Null
& node $cli format $restoreImg | Out-Null
& node $cli import $restoreImg $game HELLO --game | Out-Null
& node $cli import $restoreImg (Join-Path $root "README.md") README | Out-Null
if ($LASTEXITCODE -ne 0) { exit 1 }
Copy-Item $restoreImg (Join-Path $romdisk "restore.bin")
Set-Content -NoNewline -Encoding ascii (Join-Path $romdisk "auto") "copy restore"
Build-Rom
Get-ChildItem $romdisk -Exclude ".gitignore" | Remove-Item -Force

# 専用 Flycast 環境 (emu_verify.ps1 と同じ設定)
$data = Join-Path $emu "data"
$flycast = Join-Path $emu "flycast.exe"
New-Item -ItemType Directory -Force $data | Out-Null
if (-not (Test-Path $flycast)) { Copy-Item (Join-Path $FlycastSrc "flycast.exe") $flycast }
foreach ($f in "dc_boot.bin", "dc_flash.bin", "dc_nvmem.bin") {
    if (-not (Test-Path (Join-Path $data $f))) { Copy-Item (Join-Path $FlycastSrc "data\$f") $data }
}
$cfg = Get-Content (Join-Path $FlycastSrc "emu.cfg")
$cfg = $cfg -replace '^Dreamcast\.BiosPath = .*', "Dreamcast.BiosPath = $data" `
            -replace '^Dreamcast\.VMUPath = .*', "Dreamcast.VMUPath = $data" `
            -replace '^PerGameVmu = .*', 'PerGameVmu = no' `
            -replace '^DiscordPresence = .*', 'DiscordPresence = no' `
            -replace '^UploadCrashLogs = .*', 'UploadCrashLogs = no' `
            -replace '^FetchBoxart = .*', 'FetchBoxart = no'
Set-Content (Join-Path $emu "emu.cfg") $cfg

$a1 = Join-Path $data "vmu_save_A1.bin"
$a2 = Join-Path $data "vmu_save_A2.bin"
$a2Backup = Join-Path $outDir "a2_before_test.bin"
if (Test-Path $a2) { Copy-Item $a2 $a2Backup -Force }
Copy-Item $orig $a1 -Force
Remove-Item $a2 -ErrorAction SilentlyContinue
& node $cli format $a2 | Out-Null

function Stop-OurFlycast {
    Get-Process flycast -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $flycast } |
        Stop-Process -Force -ErrorAction SilentlyContinue
}
Stop-OurFlycast
Start-Sleep -Milliseconds 300
$p = Start-Process -FilePath $flycast -ArgumentList "`"$cdi`"" -WorkingDirectory $emu -PassThru
$ErrorActionPreference = "Continue"
$verify = Join-Path $root "scripts\verify-transfer.js"
$t0 = Get-Date
$done = $false
while (((Get-Date) - $t0).TotalSeconds -lt $Timeout) {
    Start-Sleep -Seconds 2
    if ($p.HasExited) { Write-Host "Flycast が途中で終了しました"; break }
    & node $verify $orig $a2 $restoreImg $a1 --quiet
    if ($LASTEXITCODE -eq 0) { $done = $true; break }
}
Start-Sleep -Seconds 2
Stop-OurFlycast
Start-Sleep -Milliseconds 500
Copy-Item $a1 (Join-Path $outDir "after_a1.bin") -Force
Copy-Item $a2 (Join-Path $outDir "after_a2.bin") -Force
if (-not $done) { Write-Host "タイムアウト ($Timeout 秒) — 一致しませんでした" }
& node $verify $orig (Join-Path $outDir "after_a2.bin") $restoreImg (Join-Path $outDir "after_a1.bin")
exit $LASTEXITCODE
