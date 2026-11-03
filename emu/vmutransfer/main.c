/*
 * vmutransfer — 実機の VMU と PC の間でイメージ (128KB) をやり取りする ROM (KallistiOS)
 *
 * ブロック単位 (vmu_block_read / vmu_block_write) で VMU 全体を読み書きする。ファイルシステムを介さないので
 * ゲーム (ミニゲーム) やコピー禁止のファイルも含めて丸ごと移せる。
 *
 *   A ボタン      A1 の VMU → PC の /pc/vmu_dump.bin   (dcload-ip / dcload-serial で起動したときだけ)
 *   X ボタン      A1 の VMU → A2 の VMU に丸ごとコピー
 *   Y ボタン      イメージ → A1 の VMU に書き戻す (/pc/vmu_restore.bin、無ければ ROM 内の /rd/restore.bin)
 *                 確認のため START を押すまで書かない
 *
 * ROM 内 (romdisk) に auto というファイルがあると、その中の命令 (copy / restore) を起動時に自動で実行する
 * (scripts/vmu_transfer.ps1 -Test が Flycast での自動検証に使う)。
 *
 * dcload から起動したときは PC の VMU_PC_DIR/vmu_cmd も同じように読む (dump / restore / copy と、対象の
 * スロット a1〜d2。例 "dump restore b1")。実行後は結果を VMU_PC_DIR/vmu_result.txt に書き、vmu_cmd を消して
 * dcload に戻る (dc-bba-tools の scripts/dc_vmu.ps1 が使う)。VMU_PC_DIR はビルド時に
 * make VMU_PC_DIR=/pc/... で決める (既定 /pc = dc-tool-ip を動かしたドライブの直下)。
 */
#include <kos.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include "pcdir.h"           /* make が作る (VMU_PC_DIR) */

#ifndef VMU_PC_DIR
#define VMU_PC_DIR "/pc"
#endif
#define PC_DUMP    VMU_PC_DIR "/vmu_dump.bin"
#define PC_RESTORE VMU_PC_DIR "/vmu_restore.bin"
#define PC_CMD     VMU_PC_DIR "/vmu_cmd"
#define PC_RESULT  VMU_PC_DIR "/vmu_result.txt"

#define BLOCKS 256
#define BLOCK_SIZE 512
#define IMAGE_SIZE (BLOCKS * BLOCK_SIZE)

static uint8 image[IMAGE_SIZE];
static uint8 check[BLOCK_SIZE];
static int screen_y = 60;
static int slot_port = 0, slot_unit = 1;   /* dump / restore の対象 (既定 A1) */
static char result[160];

static void out(const char *fmt, ...) {
    char line[128];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof(line), fmt, ap);
    va_end(ap);
    printf("%s\n", line);
    if(screen_y > 440) {
        /* 画面の下まで来たら上から書き直す */
        memset(vram_s + 60 * 640, 0, (480 - 60) * 640 * 2);
        screen_y = 60;
    }
    bfont_draw_str(vram_s + screen_y * 640 + 20, 640, 1, line);
    screen_y += 24;
}

static int is_image(const uint8 *img) {
    /* ルートブロック (255) の先頭 16 バイトはフォーマット済みなら 0x55 */
    for(int i = 0; i < 16; i++) if(img[255 * BLOCK_SIZE + i] != 0x55) return 0;
    return 1;
}

static int read_vmu(maple_device_t *dev, uint8 *dst) {
    for(int b = 0; b < BLOCKS; b++) {
        int ok = -1;
        for(int retry = 0; retry < 3 && ok != 0; retry++) ok = vmu_block_read(dev, b, dst + b * BLOCK_SIZE);
        if(ok != 0) {
            out("READ ERROR block %d", b);
            return -1;
        }
    }
    return 0;
}

static int write_vmu(maple_device_t *dev, const uint8 *src) {
    /* ルートブロックを最後に書く (途中で失敗してもフォーマット情報が古いまま残るように) */
    for(int b = 0; b < BLOCKS; b++) {
        int ok = -1;
        for(int retry = 0; retry < 3 && ok != 0; retry++) {
            ok = vmu_block_write(dev, b, src + b * BLOCK_SIZE);
            if(ok == 0) ok = vmu_block_read(dev, b, check) == 0 && !memcmp(check, src + b * BLOCK_SIZE, BLOCK_SIZE) ? 0 : -1;
        }
        if(ok != 0) {
            out("WRITE ERROR block %d", b);
            return -1;
        }
        if((b & 63) == 63) out("  %d / %d", b + 1, BLOCKS);
    }
    /* Flycast は最後の書き込みの末尾 128 バイトをファイルに保存しないことがあるので、ルートを書き直して確定させる */
    vmu_block_write(dev, 255, src + 255 * BLOCK_SIZE);
    return 0;
}

static maple_device_t *vmu_at(int port, int unit) {
    maple_device_t *dev = maple_enum_dev(port, unit);
    if(!dev || !(dev->info.functions & MAPLE_FUNC_MEMCARD)) return NULL;
    return dev;
}

/* dcload の /pc は 1 回で大きく読み書きすると止まることがある (実機で 128 KB の fs_write が戻らなかった)。
   4 KB ずつに分ける */
#define IO_CHUNK 4096
static ssize_t io_chunks(file_t f, uint8 *buf, size_t len, int wr) {
    size_t done = 0;
    while(done < len) {
        size_t k = len - done < IO_CHUNK ? len - done : IO_CHUNK;
        ssize_t n = wr ? fs_write(f, buf + done, k) : fs_read(f, buf + done, k);
        if(n <= 0) break;
        done += (size_t)n;
    }
    return (ssize_t)done;
}

static int load_file(const char *path, uint8 *dst) {
    file_t f = fs_open(path, O_RDONLY);
    if(f == FILEHND_INVALID) return -1;
    ssize_t n = io_chunks(f, dst, IMAGE_SIZE, 0);
    fs_close(f);
    return n == IMAGE_SIZE ? 0 : -2;
}

static uint32 crc32(const uint8 *p, size_t n) {
    uint32 c = 0xFFFFFFFFu;
    while(n--) {
        c ^= *p++;
        for(int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
    }
    return c ^ 0xFFFFFFFFu;
}

static int do_dump(void) {
    maple_device_t *a1 = vmu_at(slot_port, slot_unit);
    if(!a1) { out("NO VMU at %c%d", 'A' + slot_port, slot_unit); return -1; }
    if(dcload_type == DCLOAD_TYPE_NONE) { out("DUMP needs dcload (/pc)"); return -1; }
    out("DUMP %c%d -> %s", 'A' + slot_port, slot_unit, PC_DUMP);
    if(read_vmu(a1, image) != 0) return -1;
    file_t f = fs_open(PC_DUMP, O_WRONLY | O_TRUNC);
    if(f == FILEHND_INVALID) { out("DUMP open error"); return -1; }
    ssize_t n = io_chunks(f, image, IMAGE_SIZE, 1);
    fs_close(f);
    out("DUMP %s crc32 %08lx", n == IMAGE_SIZE ? "OK" : "ERROR", (unsigned long)crc32(image, IMAGE_SIZE));
    snprintf(result + strlen(result), sizeof(result) - strlen(result), "dump %s %08lx\n",
             n == IMAGE_SIZE ? "OK" : "ERROR", (unsigned long)crc32(image, IMAGE_SIZE));
    return n == IMAGE_SIZE ? 0 : -1;
}

static int do_copy(void) {
    maple_device_t *a1 = vmu_at(0, 1), *a2 = vmu_at(0, 2);
    if(!a1 || !a2) { out("COPY needs VMUs at A1 and A2"); return -1; }
    out("COPY A1 -> A2");
    if(read_vmu(a1, image) != 0) return -1;
    int r = write_vmu(a2, image);
    out("COPY %s crc32 %08lx", r == 0 ? "OK" : "ERROR", (unsigned long)crc32(image, IMAGE_SIZE));
    return r;
}

static int load_restore_image(void) {
    if(dcload_type != DCLOAD_TYPE_NONE && load_file(PC_RESTORE, image) == 0) {
        out("source %s", PC_RESTORE);
    } else if(load_file("/rd/restore.bin", image) == 0) {
        out("source /rd/restore.bin");
    } else {
        out("NO restore image (%s or /rd/restore.bin)", PC_RESTORE);
        return -1;
    }
    if(!is_image(image)) { out("restore image is not a formatted VMU"); return -1; }
    return 0;
}

static int do_restore(void) {
    maple_device_t *a1 = vmu_at(slot_port, slot_unit);
    if(!a1) { out("NO VMU at %c%d", 'A' + slot_port, slot_unit); return -1; }
    out("RESTORE -> %c%d", 'A' + slot_port, slot_unit);
    int r = write_vmu(a1, image);
    out("RESTORE %s crc32 %08lx", r == 0 ? "OK" : "ERROR", (unsigned long)crc32(image, IMAGE_SIZE));
    snprintf(result + strlen(result), sizeof(result) - strlen(result), "restore %s %08lx\n",
             r == 0 ? "OK" : "ERROR", (unsigned long)crc32(image, IMAGE_SIZE));
    return r;
}

/* 命令ファイルを実行する。無ければ -1、あれば 0 (成功) / 1 (失敗)。dump は書き戻しの前に行う (書き戻す前の控え) */
static int run_auto(const char *path) {
    static char cmd[256];
    file_t f = fs_open(path, O_RDONLY);
    if(f == FILEHND_INVALID) return -1;
    ssize_t n = fs_read(f, cmd, sizeof(cmd) - 1);
    fs_close(f);
    cmd[n > 0 ? n : 0] = 0;
    out("AUTO: %s", cmd);
    for(char *p = cmd; p[0] && p[1]; p++) {
        if(p[0] >= 'a' && p[0] <= 'd' && p[1] >= '1' && p[1] <= '2' && (p == cmd || p[-1] == ' ' || p[-1] == '\n')) {
            slot_port = p[0] - 'a'; slot_unit = p[1] - '0';
        }
    }
    int ok = 1;
    if(strstr(cmd, "dump")) ok &= do_dump() == 0;
    if(ok && strstr(cmd, "copy")) ok &= do_copy() == 0;
    if(ok && strstr(cmd, "restore")) ok &= load_restore_image() == 0 && do_restore() == 0;
    out(ok ? "AUTO END OK" : "AUTO END ERROR");
    return ok ? 0 : 1;
}

int main(int argc, char **argv) {
    bfont_draw_str(vram_s + 20 * 640 + 20, 640, 1, "VMU Workbench transfer  A:dump to PC  X:copy A1->A2  Y:restore to A1");
    out("dcload: %s", dcload_type == DCLOAD_TYPE_NONE ? "none" : "connected (/pc)");
    out("A1 %s / A2 %s", vmu_at(0, 1) ? "VMU" : "-", vmu_at(0, 2) ? "VMU" : "-");
    run_auto("/rd/auto");
    if(dcload_type != DCLOAD_TYPE_NONE) {
        int r = run_auto(PC_CMD);
        if(r >= 0) {
            /* PC からの命令: 結果を書いて dcload に戻る */
            snprintf(result + strlen(result), sizeof(result) - strlen(result), "%s\n", r == 0 ? "END OK" : "END ERROR");
            fs_unlink(PC_CMD);
            file_t f = fs_open(PC_RESULT, O_WRONLY | O_TRUNC);
            if(f != FILEHND_INVALID) { fs_write(f, result, strlen(result)); fs_close(f); }
            exit(r);
        }
    }

    uint32 prev = 0;
    int armed = 0;
    for(;;) {
        maple_device_t *cont = maple_enum_type(0, MAPLE_FUNC_CONTROLLER);
        cont_state_t *st = cont ? (cont_state_t *)maple_dev_status(cont) : NULL;
        uint32 btn = st ? st->buttons : 0;
        uint32 down = btn & ~prev;
        prev = btn;
        if(down & CONT_A) do_dump();
        if(down & CONT_X) do_copy();
        if(down & CONT_Y) {
            if(load_restore_image() == 0) {
                out("press START to overwrite A1 (B to cancel)");
                armed = 1;
            }
        }
        if(armed && (down & CONT_START)) { armed = 0; do_restore(); }
        if(armed && (down & CONT_B)) { armed = 0; out("cancelled"); }
        thd_sleep(30);
    }
    return 0;
}
