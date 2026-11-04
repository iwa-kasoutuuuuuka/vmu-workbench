#!/bin/bash
# DreamSDK のシェルで make する。Windows からは:
#   C:\DreamSDK\usr\bin\bash.exe --login -c "/h/DC/tools/vmu-workbench/dc/savemgr/build.sh [cdi|clean]"
here="$(cd "$(dirname "$0")" && pwd)"
export MSYSTEM=MINGW64 LANG=C
source /h/DC/KallistiOS/environ.sh >/dev/null
cd "$here" && make "$@"
