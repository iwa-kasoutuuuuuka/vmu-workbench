/*
 * vmucore を PC で動かすテスト用プログラム (test/vmucore.test.js が使う)。
 *
 *   vmucore_host <入力イメージ|-> <出力イメージ> < 命令
 *
 * 入力が "-" なら空 (0) のイメージから始める。命令は 1 行 1 つ:
 *   format <ts16進16桁>
 *   write <名前16進> <種類16進> <コピー禁止0/1> <ヘッダ位置> <上書き0/1> <ts16進16桁> <データファイル>
 *   delete <名前16進> | defrag | fixroot | reorder <slot>... | crc <名前16進> | dci <名前16進> <出力ファイル>
 *   nop (何もしない)
 *   undci <DCIファイル>   (DCI を読んで同じ名前・属性・日時で書く。上書きなし)
 * 各命令の結果を 1 行ずつ出す (ok <値> / err <コード>)。最後に list と check の結果を出してイメージを書く。
 */
#include "../vmucore.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint8_t img[VMU_IMAGE_SIZE];
static uint8_t buf[VMU_IMAGE_SIZE * 2];
static uint8_t buf2[VMU_IMAGE_SIZE * 2];

static void hex_ts(const char *s, uint8_t ts[8]) {
    for(int i = 0; i < 8; i++) {
        unsigned v = 0;
        sscanf(s + i * 2, "%2x", &v);
        ts[i] = (uint8_t)v;
    }
}

static long load(const char *path, uint8_t *dst, size_t cap) {
    FILE *f = fopen(path, "rb");
    if(!f) return -1;
    long n = (long)fread(dst, 1, cap, f);
    fclose(f);
    return n;
}

/* 名前は 16 進で渡す (空白を含む名前のため)。"-" は空の名前 */
static void unhex_name(const char *h, char *name) {
    int n = 0;
    unsigned v;
    while(n < 63 && h[n * 2] && h[n * 2 + 1] && sscanf(h + n * 2, "%2x", &v) == 1) name[n++] = (char)v;
    name[n] = 0;
}

/* 1 行に収めるため、表示できない文字を ? に (テストは ASCII でない説明を比べない) */
static void printable(char *s) {
    for(; *s; s++) if((unsigned char)*s < 0x20 || (unsigned char)*s > 0x7e) *s = '?';
}

static void name_arg(char *line, char *name) {
    char h[130] = "";
    sscanf(line, "%129s", h);
    unhex_name(h, name);
}

int main(int argc, char **argv) {
    char line[1024];
    if(argc < 3) { fprintf(stderr, "usage: vmucore_host <in|-> <out> < ops\n"); return 2; }
    if(strcmp(argv[1], "-") != 0 && load(argv[1], img, sizeof(img)) != VMU_IMAGE_SIZE) {
        fprintf(stderr, "cannot read %s\n", argv[1]);
        return 2;
    }
    while(fgets(line, sizeof(line), stdin)) {
        line[strcspn(line, "\r\n")] = 0;
        char op[16] = "";
        int pos = 0;
        if(sscanf(line, "%15s %n", op, &pos) < 1) continue;
        char *rest = line + pos;
        if(!strcmp(op, "format")) {
            uint8_t ts[8];
            hex_ts(rest, ts);
            vc_format(img, ts);
            printf("ok 0\n");
        } else if(!strcmp(op, "write")) {
            char hname[130], name[64], tshex[32], path[512];
            unsigned type;
            int prot, hdr, ow, n2 = 0;
            if(sscanf(rest, "%129s %x %d %d %d %31s %n", hname, &type, &prot, &hdr, &ow, tshex, &n2) < 6) { printf("err parse\n"); continue; }
            unhex_name(hname, name);
            strncpy(path, rest + n2, sizeof(path) - 1);
            path[sizeof(path) - 1] = 0;
            long len = load(path, buf, sizeof(buf));
            if(len < 0) { printf("err nofile\n"); continue; }
            uint8_t ts[8];
            hex_ts(tshex, ts);
            int r = vc_write_file(img, name, buf, (size_t)len, (uint8_t)type, prot, ts, (uint16_t)hdr, ow);
            printf(r < 0 ? "err %d\n" : "ok %d\n", r);
        } else if(!strcmp(op, "delete")) {
            char name[64];
            vc_entry_t e;
            name_arg(rest, name);
            if(!vc_find(img, name, &e)) { printf("err %d\n", VMU_ERR_NOT_FOUND); continue; }
            int r = vc_delete_file(img, e.slot);
            printf(r < 0 ? "err %d\n" : "ok %d\n", r);
        } else if(!strcmp(op, "defrag")) {
            int r = vc_defragment(img);
            printf(r < 0 ? "err %d\n" : "ok %d\n", r);
        } else if(!strcmp(op, "fixroot")) {
            printf("ok %d\n", vc_fix_root(img));
        } else if(!strcmp(op, "reorder")) {
            int slots[VMU_MAX_FILES], n = 0, used;
            char *p = rest;
            while(n < VMU_MAX_FILES && sscanf(p, "%d%n", &slots[n], &used) == 1) { n++; p += used; }
            int r = vc_reorder(img, slots, n);
            printf(r < 0 ? "err %d\n" : "ok %d\n", r);
        } else if(!strcmp(op, "crc")) {
            char name[64];
            vc_entry_t e;
            vms_header_t h;
            name_arg(rest, name);
            if(!vc_find(img, name, &e)) { printf("err %d\n", VMU_ERR_NOT_FOUND); continue; }
            int len = vc_read_file(img, &e, buf, sizeof(buf));
            if(len < 0) { printf("err %d\n", len); continue; }
            if(!vms_parse_header(buf, (size_t)len, vms_header_position(&e), &h)) { printf("ok nohdr\n"); continue; }
            int range = vms_crc_range_valid(&h, (size_t)len);
            printable(h.description);
            printable(h.long_description);
            printable(h.app_id);
            printf("ok %d %d %d %u %s|%s|%s\n", h.valid, range, h.crc, range ? vms_calc_crc(buf, &h) : 0,
                   h.description, h.long_description, h.app_id);
        } else if(!strcmp(op, "dci")) {
            char hname[130], name[64], path[512];
            vc_entry_t e;
            if(sscanf(rest, "%129s %511s", hname, path) < 2) { printf("err parse\n"); continue; }
            unhex_name(hname, name);
            if(!vc_find(img, name, &e)) { printf("err %d\n", VMU_ERR_NOT_FOUND); continue; }
            int len = vc_read_file(img, &e, buf, sizeof(buf));
            if(len < 0) { printf("err %d\n", len); continue; }
            size_t n = vc_to_dci(&e, buf, (size_t)len, buf2);
            FILE *f = fopen(path, "wb");
            fwrite(buf2, 1, n, f);
            fclose(f);
            printf("ok %u\n", (unsigned)n);
        } else if(!strcmp(op, "undci")) {
            vc_dci_t d;
            long len = load(rest, buf2, sizeof(buf2));
            int r = len < 0 ? VMU_ERR_BAD_DCI : vc_parse_dci(buf2, (size_t)len, &d);
            if(r < 0) { printf("err %d\n", r); continue; }
            size_t dl = (size_t)d.size_blocks * VMU_BLOCK_SIZE;
            vc_swap32(d.swapped, buf, dl);
            r = vc_write_file(img, d.name, buf, dl, d.type, d.copy_protected, d.timestamp, d.header_offset, 0);
            printf(r < 0 ? "err %d\n" : "ok %d\n", r);
        } else if(!strcmp(op, "nop")) {
            printf("ok 0\n");
        } else {
            printf("err unknown\n");
        }
    }

    static vc_entry_t list[VMU_MAX_FILES];
    int n = vc_list(img, list, VMU_MAX_FILES);
    printf("list %d free %d\n", n, vc_free_count(img));
    for(int i = 0; i < n && i < VMU_MAX_FILES; i++) {
        printf("file %d ", list[i].slot);
        if(!list[i].name_len) printf("-");
        for(int k = 0; k < list[i].name_len; k++) printf("%02x", (unsigned char)list[i].name[k]);
        printf(" %02x %d %d %d %d ", list[i].type, list[i].copy_protected,
               list[i].first_block, list[i].size_blocks, vc_fragmented(img, list[i].slot));
        for(int k = 0; k < 8; k++) printf("%02x", list[i].timestamp[k]);
        printf("\n");
    }
    static vc_problem_t probs[8192];
    int np = vc_check(img, probs, 8192);
    printf("check %d\n", np);
    for(int i = 0; i < np && i < 8192; i++) printf("prob %d %d %d %d\n", probs[i].code, probs[i].slot, probs[i].a, probs[i].b);
    printf("crc32 %08x\n", (unsigned)vc_crc32(img, sizeof(img)));

    FILE *f = fopen(argv[2], "wb");
    if(!f) return 2;
    fwrite(img, 1, sizeof(img), f);
    fclose(f);
    return 0;
}
