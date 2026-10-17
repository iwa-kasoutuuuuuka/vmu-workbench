# Flycast で VMU イメージの動作検証を行う。
#
#   自動検証: powershell -File scripts/emu_verify.ps1 [-Image test.bin]
#     1. (-Image 省略時) テスト用イメージを生成
#     2. 専用の Flycast 環境 (.emu/) の VMU A1 にイメージを配置
#     3. vmucheck.cdi (KOS製検証ROM) を起動 → Dreamcast の VMU ドライバで全ファイルを読み、結果を VMU に書く
#     4. Flycast を終了し、scripts/verify-emu.js で DC_VMU のパーサ結果と突き合わせ
#
#   目視確認: powershell -File scripts/emu_verify.ps1 -Image my.bin -Manual
#     ディスク無しで Flycast を起動 (Dreamcast BIOS のメモリーカード画面でファイル・アイコンを確認)。
#     終了後の VMU イメージを .emu/out/after_manual.bin に保存。
#
# Flycast と BIOS は D:\DC\flycast-memcard を元に .emu/ へコピーする (-FlycastSrc で変更可)。
# BIOS は著作物のため .emu/ は .gitignore 済み。再配布しないこと。
param(
    [string]$Image = "",
    [switch]$Manual,
    [int]$Timeout = 90,
    [string]$FlycastSrc = "D:\DC\flycast-memcard"
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$emu = Join-Path $root ".emu"
$data = Join-Path $emu "data"
$outDir = Join-Path $emu "out"
$flycast = Join-Path $emu "flycast.exe"
$vmuFile = Join-Path $data "vmu_save_A1.bin"
$cdi = Join-Path $root "emu\vmucheck\vmucheck.cdi"

# ---- 専用 Flycast 環境の準備 ----
New-Item -ItemType Directory -Force $data, $outDir | Out-Null
if (-not (Test-Path $flycast)) { Copy-Item (Join-Path $FlycastSrc "flycast.exe") $flycast }
foreach ($f in "dc_boot.bin", "dc_flash.bin", "dc_nvmem.bin") {
    if (-not (Test-Path (Join-Path $data $f))) { Copy-Item (Join-Path $FlycastSrc "data\$f") $data }
}
$cfg = Get-Content (Join-Path $FlycastSrc "emu.cfg")
$cfg = $cfg -replace '^Dreamcast\.BiosPath = .*', "Dreamcast.BiosPath = $data" `
            -replace '^Dreamcast\.VMUPath = .*', "Dreamcast.VMUPath = $data" `
            -replace '^Dreamcast\.ContentPath = .*', "Dreamcast.ContentPath = $root\emu\vmucheck" `
            -replace '^PerGameVmu = .*', 'PerGameVmu = no' `
            -replace '^DiscordPresence = .*', 'DiscordPresence = no' `
            -replace '^UploadCrashLogs = .*', 'UploadCrashLogs = no' `
            -replace '^FetchBoxart = .*', 'FetchBoxart = no'
Set-Content (Join-Path $emu "emu.cfg") $cfg

# ---- 検証用イメージ ----
$before = Join-Path $outDir "before.bin"
if ($Image -eq "") {
    $real = Join-Path $FlycastSrc "data\vmu_save_A1.bin"
    & node (Join-Path $root "scripts\make-test-image.js") $before $(if (Test-Path $real) { $real })
    if ($LASTEXITCODE -ne 0) { exit 1 }
} else {
    Copy-Item $Image $before -Force
}
Copy-Item $before $vmuFile -Force

function Stop-OurFlycast {
    Get-Process flycast -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $flycast } |
        Stop-Process -Force -ErrorAction SilentlyContinue
}
Stop-OurFlycast
Start-Sleep -Milliseconds 300

if ($Manual) {
    Write-Host "Flycast を起動します。BIOS のファイル画面で確認し、終わったらウィンドウを閉じてください。"
    $p = Start-Process -FilePath $flycast -WorkingDirectory $emu -PassThru
    $p.WaitForExit()
    Copy-Item $vmuFile (Join-Path $outDir "after_manual.bin") -Force
    Write-Host "終了後のイメージ: $outDir\after_manual.bin"
    & node (Join-Path $root "cli.js") check (Join-Path $outDir "after_manual.bin")
    exit $LASTEXITCODE
}

# ---- 自動検証 ----
if (-not (Test-Path $cdi)) {
    Write-Host "vmucheck.cdi がありません。先にビルドしてください (README 参照)。"
    exit 1
}
$p = Start-Process -FilePath $flycast -ArgumentList "`"$cdi`"" -WorkingDirectory $emu -PassThru
$ErrorActionPreference = "Continue"  # レポート待ちの間、node の stderr を致命扱いしない
$t0 = Get-Date
$done = $false
while (((Get-Date) - $t0).TotalSeconds -lt $Timeout) {
    Start-Sleep -Seconds 2
    if ($p.HasExited) { Write-Host "Flycast が途中で終了しました"; break }
    # Flycast は VMU 書き込みをファイルへ即時反映する。END 行を含むレポートが出来たら完了
    $done = [bool](& node (Join-Path $root "cli.js") cat $vmuFile VMUCHECK 2>$null | Select-String -Quiet "^END")
    if ($done) { break }
}
Start-Sleep -Seconds 1
Stop-OurFlycast
Start-Sleep -Milliseconds 500
$after = Join-Path $outDir "after.bin"
Copy-Item $vmuFile $after -Force
if (-not $done) { Write-Host "タイムアウト ($Timeout 秒) — 結果が書き込まれませんでした" }
& node (Join-Path $root "scripts\verify-emu.js") $before $after
exit $LASTEXITCODE
