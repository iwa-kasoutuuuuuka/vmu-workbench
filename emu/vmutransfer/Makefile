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
MKDCDISC = /d/DC/tools/mkdcdisc_bin/mkdcdisc_win/mkdcdisc64.exe

KOS_CFLAGS += -std=gnu99

all: rm-elf $(TARGET)

include $(KOS_BASE)/Makefile.rules

clean:
	-rm -f $(TARGET) $(OBJS) $(CDI) romdisk.img

rm-elf:
	-rm -f $(TARGET) romdisk.img romdisk.o

$(TARGET): $(OBJS)
	$(KOS_CC) $(KOS_CFLAGS) $(KOS_LDFLAGS) -o $(TARGET) $(KOS_START) $(OBJS) $(OBJEXTRA) $(KOS_LIBS)

cdi: rm-elf $(TARGET)
	$(MKDCDISC) -e $(TARGET) -o $(CDI)
