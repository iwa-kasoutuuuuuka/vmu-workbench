#!/bin/bash
# bleem2 (メモリーカード有効版) を自動プレイ無しでビルドする。手で操作して PS1 ゲームの画面を確認する用。
# D:\DC は読むだけ: ソースを .emu/bleem2-noauto/ にコピーし (.o は除く)、そちらで設定を変えてビルドする。
#
#   MSYS2 MinGW64 で: bash scripts/build-bleem2-noauto.sh
#   成果物: .emu/bleem2-noauto/build/bleem2_noauto.cdi (ゲームイメージは D:\DC から読み込んで同梱)
set -e
SRC=/d/DC/bleem2-memcard
GAME="$SRC/build/Metal Slug X (USA).bin"
DST="$(cd "$(dirname "$0")/.." && pwd)/.emu/bleem2-noauto"

mkdir -p "$DST"
rm -rf "${DST:?}"/*                               # ディレクトリ自体は残す (開いているシェルがあると消せないため)
mkdir -p "$DST/src" "$DST/build"
cp "$SRC"/src/*.c "$SRC"/src/*.h "$DST/src/"       # 古い .o を持ち込むと再コンパイルされない
cp -r "$SRC/psbios" "$SRC/Makefile" "$DST/"
cd "$DST"
sed -i 's|include ../KallistiOS/Makefile.rules|include /d/DC/KallistiOS/Makefile.rules|' Makefile
sed -i 's|^#define AUTOPLAY              1|#define AUTOPLAY              0|' src/mips.h
sed -i 's|^#define RELEASE_BUILD         0|#define RELEASE_BUILD         1|' src/mips.h   # 画面のデバッグ表示を消す
grep -q '^#define AUTOPLAY              0' src/mips.h || { echo "mips.h の AUTOPLAY を書き換えられません"; exit 1; }

export TMP=/tmp TEMP=/tmp LANG=C PATH=/d/DC/tools/mkdcdisc_bin/mkdcdisc_win:$PATH
source /d/DC/KallistiOS/environ.sh > /dev/null
make
make cdi GAME="$GAME" CDI=build/bleem2_noauto.cdi
echo "OK: $DST/build/bleem2_noauto.cdi"
