/*
 * vmucheck — DC_VMU エミュレーター検証用ROM (KallistiOS)
 *
 * Dreamcast 本来の VMU ドライバ (KOS fs_vmu / vmufs) で A1 の VMU を読み、
 *   1. 全ファイルの生データ CRC32 を計算し、vmu_pkg_parse で VMS ヘッダ (CRC16) を検証
 *   2. 既知パターンのファイル VMUKOS を書き込む (ホスト側パーサの読み取り検証用)
 *   3. 結果を VMUCHECK (テキスト) として書き込む
 * ホスト側の scripts/verify-emu.js が VMUCHECK を読み、DC_VMU のパーサ結果と突き合わせる。
 */
#include <kos.h>
#include <dc/vmufs.h>
#include <string.h>
#include <stdio.h>

#define VMU_ROOT    "/vmu/a1"
#define REPORT_PATH VMU_ROOT "/VMUCHECK"
#define KOS_PATH    VMU_ROOT "/VMUKOS"
#define KOS_SIZE    (512 * 3 - 100) /* ブロック境界をまたぐサイズ */
#define REPORT_MAX  4096

static uint32 crc_table[256];

static void crc32_init(void) {
    for(uint32 i = 0; i < 256; i++) {
        uint32 c = i;
        for(int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
        crc_table[i] = c;
    }
}

static uint32 crc32(const uint8 *p, size_t n) {
    uint32 c = 0xFFFFFFFFu;
    while(n--) c = crc_table[(c ^ *p++) & 0xff] ^ (c >> 8);
    return c ^ 0xFFFFFFFFu;
}

static char report[REPORT_MAX];
static int report_len;
static int screen_y = 24;

static void out(const char *fmt, ...) {
    char line[128];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof(line), fmt, ap);
    va_end(ap);
    printf("%s\n", line);
    if(report_len + (int)strlen(line) + 2 < REPORT_MAX)
        report_len += sprintf(report + report_len, "%s\n", line);
    if(screen_y < 460) {
        bfont_draw_str(vram_s + screen_y * 640 + 20, 640, 0, line);
        screen_y += 24;
    }
}

static int check_files(void) {
    file_t d = fs_open(VMU_ROOT, O_RDONLY | O_DIR);
    if(d == FILEHND_INVALID) {
        out("ERROR opendir");
        return -1;
    }
    const dirent_t *de;
    while((de = fs_readdir(d)) != NULL) {
        /* KOS 2.3 以降は "." ".." も返す */
        if(!strcmp(de->name, ".") || !strcmp(de->name, "..") || (de->attr & O_DIR)) continue;
        char path[300];
        snprintf(path, sizeof(path), VMU_ROOT "/%s", de->name);
        /* O_META: ヘッダを解釈せず生データを読む */
        file_t f = fs_open(path, O_RDONLY | O_META);
        if(f == FILEHND_INVALID) {
            out("FILE %s ERROR", de->name);
            continue;
        }
        size_t size = fs_total(f);
        uint8 *buf = malloc(size);
        ssize_t got = buf ? fs_read(f, buf, size) : -1;
        fs_close(f);
        if(got != (ssize_t)size) out("FILE %s ERROR", de->name);
        else {
            out("FILE %s %u %08lx", de->name, (unsigned)size, (unsigned long)crc32(buf, size));
            /* KOS の VMS ヘッダ解析 (CRC16 検証込み)。DC_VMU の CRC 更新が実機側で受理されるかの確認 */
            vmu_pkg_t pkg;
            out("PKG %s %s", de->name, vmu_pkg_parse(buf, size, &pkg) == 0 ? "OK" : "NG");
        }
        free(buf);
    }
    fs_close(d);
    return 0;
}

static int write_raw(const char *path, const void *data, size_t len) {
    fs_unlink(path);
    file_t f = fs_open(path, O_WRONLY | O_TRUNC | O_META);
    printf("write_raw %s: open=%d len=%u\n", path, (int)f, (unsigned)len);
    if(f == FILEHND_INVALID) return -1;
    ssize_t n = fs_write(f, data, len);
    printf("write_raw %s: write=%d\n", path, (int)n);
    int c = fs_close(f);
    printf("write_raw %s: close=%d\n", path, c);
    return n == (ssize_t)len && c == 0 ? 0 : -1;
}

int main(int argc, char **argv) {
    crc32_init();
    bfont_draw_str(vram_s + 20, 640, 0, "DC_VMU vmucheck");

    maple_device_t *dev = maple_enum_dev(0, 1);
    if(!dev) {
        out("ERROR no VMU at A1");
    }
    else {
        /* 以前の実行結果は検証対象から外す */
        fs_unlink(REPORT_PATH);
        fs_unlink(KOS_PATH);

        out("VMUCHECK 1");
        out("FREE %d", vmufs_free_blocks(dev));
        check_files();

        static uint8 pattern[KOS_SIZE];
        for(int i = 0; i < KOS_SIZE; i++) pattern[i] = (uint8)(i * 13 + 7);
        out("KOSWRITE %s", write_raw(KOS_PATH, pattern, KOS_SIZE) == 0 ? "OK" : "ERROR");
        out("END");

        if(write_raw(REPORT_PATH, report, report_len) != 0)
            bfont_draw_str(vram_s + 440 * 640 + 20, 640, 0, "REPORT WRITE FAILED");
        /* Flycast は「最後に書いたブロックの最後の 128 バイト (4 回目の書き込み)」を VMU ファイルに
           保存しないことがある (結果ファイルのエントリがディレクトリの 384 バイト目以降に入ると消えた)。
           ルートブロックを読んで同じ内容を書き戻し、直前の書き込みを確定させる (内容は変わらない) */
        static uint8 root[512];
        if(vmu_block_read(dev, 255, root) == 0) vmu_block_write(dev, 255, root);
    }

    for(;;) thd_sleep(1000);
    return 0;
}
