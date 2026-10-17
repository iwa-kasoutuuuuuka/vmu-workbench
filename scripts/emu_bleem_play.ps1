# 自動プレイ無しの bleem2 (scripts/build-bleem2-noauto.sh でビルド) を VMU イメージ付きで起動し、手で遊ぶ。
# ウィンドウを閉じると、ゲームが書き込んだ後の VMU イメージを -Out に保存する
# (状態を変えた前後のセーブを node cli.js diff で比べて、構造を調べる用)。
#
#   powershell -File scripts/emu_bleem_play.ps1 -Image my.bin [-Out after.bin]
#
# 操作 (Flycast の既定キー): 十字キー = 矢印, Start = Enter, ○ = C, × = X, △ = D, □ = S
param(
    [Parameter(Mandatory = $true)][string]$Image,
    [string]$Out = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$emu = Join-Path $root ".emu"
$flycast = Join-Path $emu "flycast.exe"
$cdi = Join-Path $emu "bleem2-noauto\build\bleem2_noauto.cdi"
$vmuFile = Join-Path $emu "data\vmu_save_A1.bin"
if (-not (Test-Path $flycast)) { Write-Host ".emu/ がありません。先に npm run verify:emu を実行してください"; exit 1 }
if (-not (Test-Path $cdi)) { Write-Host "CDI がありません。先に scripts/build-bleem2-noauto.sh を実行してください"; exit 1 }
if ($Out -eq "") { $Out = Join-Path $emu "out\play_after.bin" }

Get-Process flycast -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $flycast } | Stop-Process -Force
Start-Sleep -Milliseconds 300
Copy-Item $Image $vmuFile -Force
Write-Host "Flycast を起動します。遊び終わったらウィンドウを閉じてください (セーブはゲーム内で行ってから)。"
$p = Start-Process -FilePath $flycast -ArgumentList "`"$cdi`"" -WorkingDirectory $emu -PassThru
$p.WaitForExit()
Start-Sleep -Milliseconds 500
Copy-Item $vmuFile $Out -Force
Write-Host "終了後の VMU イメージ: $Out"
& node (Join-Path $root "cli.js") check $Out
