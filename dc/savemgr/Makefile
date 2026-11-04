#
# savemgr — Dreamcast 本体で動く VMU セーブマネージャ (仕様: docs/dc-savemgr-spec.md)
# DreamSDK のシェルで: source /h/DC/KallistiOS/environ.sh && make        (ELF)
#                      make cdi                                           (GDEMU などで起動する CDI)
# romdisk/auto に命令を書くと起動時に実行する (Flycast での確認用。scripts/savemgr-test.js が使う。テスト用は savemgr_test.cdi という別の名前で作る)
#
# PC 上のテスト (vmucore.c を vmu.js と比べる) は npm test (test/vmucore.test.js) がする。
#

TARGET ?= savemgr.elf
OBJS = main.o store.o gfx.o vmucore.o httpd.o net.o romdisk.o
KOS_ROMDISK_DIR = romdisk
CDI ?= savemgr.cdi
MKDCDISC ?= /h/DC/tools/mkdcdisc_bin/mkdcdisc_win/mkdcdisc64.exe
PYTHON ?= python

# NET_IP: Dreamcast の IP (既定 192.168.10.2、dcload から起動したときは dcload の IP)
ifdef NET_IP
KOS_CFLAGS += -DNET_IP=\"$(NET_IP)\"
endif
KOS_CFLAGS += -std=gnu99 -Wall -Wextra -Wno-unused-parameter
.DEFAULT_GOAL := all

msg.h: msg_ja.txt mkmsg.py
	$(PYTHON) mkmsg.py msg_ja.txt msg.h || (rm -f msg.h; false)
www.h: www/index.html mkwww.py
	$(PYTHON) mkwww.py www/index.html www.h || (rm -f www.h; false)
main.o: msg.h vmucore.h store.h gfx.h net.h httpd.h
httpd.o: www.h httpd.h vmucore.h
net.o: net.h httpd.h store.h
store.o: store.h vmucore.h
vmucore.o: vmucore.h

all: rm-elf $(TARGET)

include $(KOS_BASE)/Makefile.rules

clean:
	-rm -f $(TARGET) $(OBJS) $(CDI) romdisk.img msg.h www.h

rm-elf:
	-rm -f $(TARGET) romdisk.img romdisk.o

$(TARGET): $(OBJS)
	$(KOS_CC) $(KOS_CFLAGS) $(KOS_LDFLAGS) -o $(TARGET) $(KOS_START) $(OBJS) $(OBJEXTRA) $(KOS_LIBS)

cdi: rm-elf $(TARGET)
	$(MKDCDISC) -e $(TARGET) -o $(CDI) -n "VMU SAVE MANAGER"
