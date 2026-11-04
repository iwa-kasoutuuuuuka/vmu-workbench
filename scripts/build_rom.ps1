# Builds an emu\<Rom> program (default: vmucheck, the Flycast check ROM) with DreamSDK's shell and KallistiOS.
#   npm run build:rom
#   powershell -ExecutionPolicy Bypass -File scripts/build_rom.ps1 -Rom vmutransfer
param(
    [string]$Rom = "vmucheck",
    [string]$KosEnviron = "/h/DC/KallistiOS/environ.sh",
    [string]$Bash = "C:\DreamSDK\usr\bin\bash.exe"
)
$ErrorActionPreference = "Stop"
$romDir = Join-Path (Split-Path $PSScriptRoot -Parent) "emu\$Rom"
if (-not (Test-Path (Join-Path $romDir "Makefile"))) { throw "no Makefile in $romDir" }
if (-not (Test-Path $Bash)) { throw "DreamSDK's bash not found: $Bash (install DreamSDK or pass -Bash)" }
$posixDir = "/" + $romDir.Substring(0, 1).ToLower() + ($romDir.Substring(2) -replace '\\', '/')
& $Bash --login -c "export MSYSTEM=MINGW64 LANG=C; source $KosEnviron >/dev/null && cd '$posixDir' && make cdi" | Out-Host
if ($LASTEXITCODE -ne 0) { throw "make cdi failed in $romDir" }
$cdi = Get-ChildItem $romDir -Filter *.cdi | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host "OK: $($cdi.FullName)"
