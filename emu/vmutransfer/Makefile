#
# vmutransfer — 実機 VMU ⇔ PC のイメージ転送 ROM
# MSYS2 MinGW64 で: source /d/DC/KallistiOS/environ.sh && make cdi
# romdisk/ に restore.bin (128KB) を置くと ROM に埋め込む。auto (copy / restore) を置くと起動時に自動実行
# (通常は scripts/vmu_transfer.ps1 が romdisk/ を用意してビルドする)
#

TARGET = vmutransfer.elf
OBJS = main.o romdisk.o
KOS_ROMDISK_DIR = romdisk
CDI = vmutransfer.cdi
MKDCDISC ?= /h/DC/tools/mkdcdisc_bin/mkdcdisc_win/mkdcdisc64.exe

KOS_CFLAGS += -std=gnu99
.DEFAULT_GOAL := all
# PC 側のフォルダ (dcload の /pc/...)。dc-bba-tools の dc_vmu.ps1 が make VMU_PC_DIR=/pc/... で指定する。
# kos-cc は引数の引用符を通さないので pcdir.h に書いて渡す (指定しなければ /pc)
ifdef VMU_PC_DIR
PCDIR_LINE = \#define VMU_PC_DIR "$(VMU_PC_DIR)"
else
PCDIR_LINE = /* VMU_PC_DIR: main.c の既定 */
endif
pcdir.h: FORCE
	@echo '$(PCDIR_LINE)' > pcdir.h.new; if cmp -s pcdir.h.new pcdir.h; then rm -f pcdir.h.new; else mv -f pcdir.h.new pcdir.h; fi
main.o: pcdir.h
FORCE:

all: rm-elf $(TARGET)

include $(KOS_BASE)/Makefile.rules

clean:
	-rm -f $(TARGET) $(OBJS) $(CDI) romdisk.img pcdir.h

rm-elf:
	-rm -f $(TARGET) romdisk.img romdisk.o

$(TARGET): $(OBJS)
	$(KOS_CC) $(KOS_CFLAGS) $(KOS_LDFLAGS) -o $(TARGET) $(KOS_START) $(OBJS) $(OBJEXTRA) $(KOS_LIBS)

cdi: rm-elf $(TARGET)
	$(MKDCDISC) -e $(TARGET) -o $(CDI)
