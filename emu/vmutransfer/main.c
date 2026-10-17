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
 */
#include <kos.h>
#include <string.h>
#include <stdio.h>

#define BLOCKS 256
#define BLOCK_SIZE 512
#define IMAGE_SIZE (BLOCKS * BLOCK_SIZE)

static uint8 image[IMAGE_SIZE];
static uint8 check[BLOCK_SIZE];
static int screen_y = 60;

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

static int load_file(const char *path, uint8 *dst) {
    file_t f = fs_open(path, O_RDONLY);
    if(f == FILEHND_INVALID) return -1;
    ssize_t n = fs_read(f, dst, IMAGE_SIZE);
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
    maple_device_t *a1 = vmu_at(0, 1);
    if(!a1) { out("NO VMU at A1"); return -1; }
    if(dcload_type == DCLOAD_TYPE_NONE) { out("DUMP needs dcload (/pc)"); return -1; }
    out("DUMP A1 -> /pc/vmu_dump.bin");
    if(read_vmu(a1, image) != 0) return -1;
    file_t f = fs_open("/pc/vmu_dump.bin", O_WRONLY | O_TRUNC);
    if(f == FILEHND_INVALID) { out("DUMP open error"); return -1; }
    ssize_t n = fs_write(f, image, IMAGE_SIZE);
    fs_close(f);
    out("DUMP %s crc32 %08lx", n == IMAGE_SIZE ? "OK" : "ERROR", (unsigned long)crc32(image, IMAGE_SIZE));
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
    if(dcload_type != DCLOAD_TYPE_NONE && load_file("/pc/vmu_restore.bin", image) == 0) {
        out("source /pc/vmu_restore.bin");
    } else if(load_file("/rd/restore.bin", image) == 0) {
        out("source /rd/restore.bin");
    } else {
        out("NO restore image (/pc/vmu_restore.bin or /rd/restore.bin)");
        return -1;
    }
    if(!is_image(image)) { out("restore image is not a formatted VMU"); return -1; }
    return 0;
}

static int do_restore(void) {
    maple_device_t *a1 = vmu_at(0, 1);
    if(!a1) { out("NO VMU at A1"); return -1; }
    out("RESTORE -> A1");
    int r = write_vmu(a1, image);
    out("RESTORE %s crc32 %08lx", r == 0 ? "OK" : "ERROR", (unsigned long)crc32(image, IMAGE_SIZE));
    return r;
}

static void run_auto(void) {
    static char cmd[256];
    file_t f = fs_open("/rd/auto", O_RDONLY);
    if(f == FILEHND_INVALID) return;
    ssize_t n = fs_read(f, cmd, sizeof(cmd) - 1);
    fs_close(f);
    cmd[n > 0 ? n : 0] = 0;
    out("AUTO: %s", cmd);
    int ok = 1;
    if(strstr(cmd, "copy")) ok &= do_copy() == 0;
    if(strstr(cmd, "restore")) ok &= load_restore_image() == 0 && do_restore() == 0;
    out(ok ? "AUTO END OK" : "AUTO END ERROR");
}

int main(int argc, char **argv) {
    bfont_draw_str(vram_s + 20 * 640 + 20, 640, 1, "DC_VMU vmutransfer   A:dump to PC  X:copy A1->A2  Y:restore to A1");
    out("dcload: %s", dcload_type == DCLOAD_TYPE_NONE ? "none" : "connected (/pc)");
    out("A1 %s / A2 %s", vmu_at(0, 1) ? "VMU" : "-", vmu_at(0, 2) ? "VMU" : "-");
    run_auto();

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
