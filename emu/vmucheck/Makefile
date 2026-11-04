#
# vmucheck — VMU Workbench エミュレーター検証用ROM
# DreamSDK のシェルで: source /h/DC/KallistiOS/environ.sh && make cdi
#

TARGET = vmucheck.elf
OBJS = main.o
CDI = vmucheck.cdi
MKDCDISC ?= /h/DC/tools/mkdcdisc_bin/mkdcdisc_win/mkdcdisc64.exe

KOS_CFLAGS += -std=gnu99

all: rm-elf $(TARGET)

include $(KOS_BASE)/Makefile.rules

clean:
	-rm -f $(TARGET) $(OBJS) $(CDI)

rm-elf:
	-rm -f $(TARGET)

$(TARGET): $(OBJS)
	$(KOS_CC) $(KOS_CFLAGS) $(KOS_LDFLAGS) -o $(TARGET) $(KOS_START) $(OBJS) $(OBJEXTRA) $(KOS_LIBS)

cdi: $(TARGET)
	$(MKDCDISC) -e $(TARGET) -o $(CDI)
