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
#     2 回目は A1 = 書き戻すイメージを 3 ブロックだけ変えたもの、A2 = A1 と同じ中身で起動し、
#     コピーが 0 ブロック、書き戻しが違う 3 ブロックだけを書くことを確かめる (書き込みは違うブロックだけ)。
#     .emu の emu.cfg と A1 / A2 は検証の前に控えて、終わったら元に戻す。
#
# Flycast と BIOS は -FlycastSrc (既定 H:\DC\flycast-memcard) から .emu/ へコピーして使う (コピー元は書き換えない)。
# ビルドは DreamSDK のシェルで KallistiOS の environ.sh (-KosEnviron) を読み込んで make する。
param(
    [string]$Restore = "",
    [switch]$Test,
    [int]$Timeout = 120,
    [string]$FlycastSrc = "H:\DC\flycast-memcard",
    [string]$KosEnviron = "/h/DC/KallistiOS/environ.sh"
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
    # DreamSDK のシェル (MSYS2) で KallistiOS の環境を読み込んで make する
    $bash = "C:\DreamSDK\usr\bin\bash.exe"
    $posixDir = "/" + $romDir.Substring(0, 1).ToLower() + ($romDir.Substring(2) -replace '\\', '/')
    & $bash --login -c "export MSYSTEM=MINGW64 LANG=C; source $KosEnviron >/dev/null && cd '$posixDir' && make cdi" | Out-Host
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
    Write-Host "dcload-ip での吸い出し・書き戻しは実機で確認済み (2026-11)。大事なセーブは先に別の VMU にもコピーしておいてください。"
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
try { Build-Rom }
finally { Get-ChildItem $romdisk -Exclude ".gitignore" | Remove-Item -Force }   # ビルドに失敗しても auto を残さない
# テスト用の ROM は起動するとすぐに A1・A2 を書き換えるので、実機で使う場所 (emu/vmutransfer) には残さない
$testCdi = Join-Path $outDir "vmutransfer_test.cdi"
Move-Item $cdi $testCdi -Force
foreach ($f in "vmutransfer.elf", "romdisk.img", "romdisk.o") { Remove-Item (Join-Path $romDir $f) -ErrorAction SilentlyContinue }
$cdi = $testCdi

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
$a1 = Join-Path $data "vmu_save_A1.bin"
$a2 = Join-Path $data "vmu_save_A2.bin"
# .emu は他の作業フォルダと共用のことがあるので、設定と VMU を控えておき最後に戻す
$cfgPath = Join-Path $emu "emu.cfg"
$saved = @{}
foreach ($f in $cfgPath, $a1, $a2) {
    if (Test-Path $f) { $saved[$f] = Join-Path $outDir ((Split-Path $f -Leaf) + ".before_test"); Copy-Item $f $saved[$f] -Force }
}
Set-Content $cfgPath $cfg

function Stop-OurFlycast {
    Get-Process flycast -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $flycast } |
        Stop-Process -Force -ErrorAction SilentlyContinue
}
# Flycast が VMU ファイルを開いたままにしているか。Flycast は削除の共有を許さずに開くので、削除権限だけで開こうとすると失敗する
function Test-Held([string]$path) {
    try {
        $fs = New-Object IO.FileStream($path, [IO.FileMode]::Open, [Security.AccessControl.FileSystemRights]::Delete,
                                       ([IO.FileShare]"ReadWrite, Delete"), 4096, [IO.FileOptions]::None)
        $fs.Close()
        return $false
    } catch { return $true }
}
# Flycast を起動し、$check が成功する (終了コード 0) まで待つ。
# $poison (VMU ファイル → 中身) を渡すと、Flycast が VMU を読み込んで開いた直後にファイルをその中身で上書きする。
# Flycast は ROM が書いたブロックのバイトだけをファイルに書くので、終了後のファイルで「書いたブロック」が分かる
function Invoke-Flycast([scriptblock]$check, [hashtable]$poison) {
    Stop-OurFlycast
    Start-Sleep -Milliseconds 300
    $p = Start-Process -FilePath $flycast -ArgumentList "`"$cdi`"" -WorkingDirectory $emu -PassThru
    $t0 = Get-Date
    if ($poison) {
        # 2 回続けて開いたままなら読み込み (一瞬だけ開く) は終わっている
        $streak = 0
        while ($streak -lt 2 -and ((Get-Date) - $t0).TotalSeconds -lt 30 -and -not $p.HasExited) {
            Start-Sleep -Milliseconds 250
            if (@($poison.Keys | Where-Object { -not (Test-Held $_) }).Count -eq 0) { $streak++ } else { $streak = 0 }
        }
        if ($streak -lt 2) { Write-Host "Flycast が VMU ファイルを開きませんでした"; Stop-OurFlycast; return $false }
        foreach ($k in $poison.Keys) {
            $b = [IO.File]::ReadAllBytes($poison[$k])
            $fs = New-Object IO.FileStream($k, [IO.FileMode]::Open, [IO.FileAccess]::Write, ([IO.FileShare]"ReadWrite, Delete"))
            $fs.Write($b, 0, $b.Length)
            $fs.Close()
        }
    }
    $done = $false
    while (((Get-Date) - $t0).TotalSeconds -lt $Timeout) {
        Start-Sleep -Seconds 2
        if ($p.HasExited) { Write-Host "Flycast が途中で終了しました"; break }
        $null = & $check
        if ($LASTEXITCODE -eq 0) { $done = $true; break }
    }
    Start-Sleep -Seconds 2
    Stop-OurFlycast
    Start-Sleep -Milliseconds 500
    if (-not $done) { Write-Host "タイムアウト ($Timeout 秒) — 一致しませんでした" }
    return $done
}

$ErrorActionPreference = "Continue"
$verify = Join-Path $root "scripts\verify-transfer.js"
$pass = $true
try {
    # 1 回目: A1 = テスト用イメージ、A2 = 空 → 丸ごとコピーと書き戻しで中身がバイト単位で一致するか
    Write-Host "== 1: A1 → 空の A2 にコピー、A1 に別のイメージを書き戻す"
    Copy-Item $orig $a1 -Force
    Remove-Item $a2 -ErrorAction SilentlyContinue
    & node $cli format $a2 | Out-Null
    $null = Invoke-Flycast { & node $verify $orig $a2 $restoreImg $a1 --quiet } $null
    Copy-Item $a1 (Join-Path $outDir "after_a1.bin") -Force
    Copy-Item $a2 (Join-Path $outDir "after_a2.bin") -Force
    & node $verify $orig (Join-Path $outDir "after_a2.bin") $restoreImg (Join-Path $outDir "after_a1.bin")
    if ($LASTEXITCODE -ne 0) { $pass = $false }

    # 2 回目: 違うブロックだけ書くか。A1 = 書き戻すイメージの 3 ブロック (5, 100, ルート 255) だけ変えたもの、A2 = A1 と同じ
    #   COPY A1 → A2 は 0 ブロック、RESTORE は 3 ブロックだけ書くはず
    Write-Host "== 2: 同じ中身へのコピー (0 ブロック) と 3 ブロック違いの書き戻し"
    $diffImg = Join-Path $outDir "diff3_a1.bin"
    $poisonA1 = Join-Path $outDir "poison_a1.bin"
    $poisonA2 = Join-Path $outDir "poison_a2.bin"
    & node $verify --flip $restoreImg $diffImg 5 100 255
    & node $verify --invert $restoreImg $poisonA1
    & node $verify --invert $diffImg $poisonA2
    Copy-Item $diffImg $a1 -Force
    Copy-Item $diffImg $a2 -Force
    $null = Invoke-Flycast {
        & node $verify --written "COPY" $diffImg $diffImg $a2 --quiet
        if ($LASTEXITCODE -eq 0) { & node $verify --written "RESTORE" $diffImg $restoreImg $a1 --quiet }
    } @{ $a1 = $poisonA1; $a2 = $poisonA2 }
    Copy-Item $a1 (Join-Path $outDir "after2_a1.bin") -Force
    Copy-Item $a2 (Join-Path $outDir "after2_a2.bin") -Force
    & node $verify --written "COPY A1→A2 (同じ中身)" $diffImg $diffImg (Join-Path $outDir "after2_a2.bin")
    if ($LASTEXITCODE -ne 0) { $pass = $false }
    & node $verify --written "RESTORE →A1 (3 ブロック違い)" $diffImg $restoreImg (Join-Path $outDir "after2_a1.bin")
    if ($LASTEXITCODE -ne 0) { $pass = $false }
}
finally {
    Stop-OurFlycast
    foreach ($f in $saved.Keys) { Copy-Item $saved[$f] $f -Force }
}
Write-Host $(if ($pass) { "PASS (全体)" } else { "FAIL (全体)" })
exit $(if ($pass) { 0 } else { 1 })
