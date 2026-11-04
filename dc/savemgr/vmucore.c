/*
 * vmucore — VMU イメージ操作 (src/vmu.js / src/vms.js と同じ結果になるように書いてある。説明は vmucore.h)
 */
#include "vmucore.h"
#include <string.h>

#define ROOT_BLOCK 255
#define ROOT_OFF   (ROOT_BLOCK * VMU_BLOCK_SIZE)

/* 書き込みの取り消し用と、整理のときの一時置き場 (DC では静的に 256KB) */
static uint8_t backup_buf[VMU_IMAGE_SIZE];
static uint8_t scratch_buf[VMU_IMAGE_SIZE];

static uint16_t rd16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static void wr16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
static uint32_t rd32(const uint8_t *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
static int to_bcd(int n) { return (((n / 10) % 10) << 4) | (n % 10); }

/* ---------------- ルート・FAT ---------------- */

void vc_get_root(const uint8_t *img, vc_root_t *r) {
    const uint8_t *p = img + ROOT_OFF;
    r->formatted = 1;
    for(int i = 0; i < 16; i++) if(p[i] != 0x55) r->formatted = 0;
    memcpy(r->timestamp, p + 0x30, 8);
    r->root_block = rd16(p + 0x44);
    r->fat_block = rd16(p + 0x46);
    r->fat_size = rd16(p + 0x48);
    r->dir_block = rd16(p + 0x4a);
    r->dir_size = rd16(p + 0x4c);
    r->user_blocks = rd16(p + 0x50);
}

int vc_root_ok(const uint8_t *img) {
    vc_root_t r;
    vc_get_root(img, &r);
    return r.formatted && r.fat_block < VMU_BLOCK_COUNT && r.dir_block < VMU_BLOCK_COUNT &&
           r.dir_size >= 1 && r.dir_size <= r.dir_block + 1 && r.user_blocks <= VMU_BLOCK_COUNT;
}

static int user_blocks(const uint8_t *img) {
    int n = rd16(img + ROOT_OFF + 0x50);
    return n > VMU_BLOCK_COUNT ? VMU_BLOCK_COUNT : n;
}

static long fat_offset(const uint8_t *img, int block) {
    long off = (long)rd16(img + ROOT_OFF + 0x46) * VMU_BLOCK_SIZE + block * 2;
    return (off < 0 || off + 1 >= VMU_IMAGE_SIZE) ? -1 : off;
}

uint16_t vc_get_fat(const uint8_t *img, int block) {
    long off = fat_offset(img, block);
    return off < 0 ? 0xffff : rd16(img + off);
}

void vc_set_fat(uint8_t *img, int block, uint16_t value) {
    long off = fat_offset(img, block);
    if(off >= 0) wr16(img + off, value);
}

void vc_format(uint8_t *img, const uint8_t ts[8]) {
    memset(img, 0, VMU_IMAGE_SIZE);
    uint8_t *r = img + ROOT_OFF;
    memset(r, 0x55, 16);
    if(ts) memcpy(r + 0x30, ts, 8);
    wr16(r + 0x44, ROOT_BLOCK);   /* 0 だと VMU 本体の BIOS が「システムガ コワレテイマス」 */
    wr16(r + 0x46, 254);
    wr16(r + 0x48, 1);
    wr16(r + 0x4a, 253);
    wr16(r + 0x4c, 13);
    wr16(r + 0x50, 200);
    for(int b = 0; b < VMU_BLOCK_COUNT; b++) vc_set_fat(img, b, VMU_FAT_FREE);
    vc_set_fat(img, ROOT_BLOCK, VMU_FAT_END);
    vc_set_fat(img, 254, VMU_FAT_END);
    for(int b = 253; b > 241; b--) vc_set_fat(img, b, (uint16_t)(b - 1));
    vc_set_fat(img, 241, VMU_FAT_END);
}

int vc_chain(const uint8_t *img, int first, int max_blocks, uint8_t *blocks) {
    uint8_t seen[VMU_BLOCK_COUNT];
    int n = 0, b = first;
    memset(seen, 0, sizeof(seen));
    while(b != VMU_FAT_END) {
        if(b >= VMU_BLOCK_COUNT || seen[b] || n >= max_blocks) return VMU_ERR_BROKEN_CHAIN;
        seen[b] = 1;
        blocks[n++] = (uint8_t)b;
        b = vc_get_fat(img, b);
        if(b == VMU_FAT_FREE) return VMU_ERR_BROKEN_CHAIN;
    }
    return n;
}

int vc_free_count(const uint8_t *img) {
    int n = 0, ub = user_blocks(img);
    for(int b = 0; b < ub; b++) if(vc_get_fat(img, b) == VMU_FAT_FREE) n++;
    return n;
}

int vc_fix_root(uint8_t *img) {
    vc_root_t r;
    vc_get_root(img, &r);
    if(!r.formatted || r.root_block == ROOT_BLOCK) return 0;
    wr16(img + ROOT_OFF + 0x44, ROOT_BLOCK);
    return 1;
}

/* ---------------- ディレクトリ ---------------- */

int vc_dir_slots(const uint8_t *img) {
    int dir_block = rd16(img + ROOT_OFF + 0x4a), dir_size = rd16(img + ROOT_OFF + 0x4c);
    if(dir_block >= VMU_BLOCK_COUNT) return 0;
    if(dir_size > dir_block + 1) dir_size = dir_block + 1;
    return dir_size * (VMU_BLOCK_SIZE / VMU_DIR_ENTRY);
}

size_t vc_dir_offset(const uint8_t *img, int slot) {
    int dir_block = rd16(img + ROOT_OFF + 0x4a);
    int per = VMU_BLOCK_SIZE / VMU_DIR_ENTRY;
    return (size_t)(dir_block - slot / per) * VMU_BLOCK_SIZE + (size_t)(slot % per) * VMU_DIR_ENTRY;
}

/* 名前の長さ (末尾の 0 と空白を除く。vmu.js の replace(/[\0 ]+$/, '') と同じ) */
static int raw_name_len(const uint8_t *raw12) {
    int n = VMU_NAME_LEN;
    while(n > 0 && (raw12[n - 1] == 0 || raw12[n - 1] == ' ')) n--;
    return n;
}

void vc_parse_entry(const uint8_t *img, int slot, vc_entry_t *e) {
    const uint8_t *d = img + vc_dir_offset(img, slot);
    memset(e, 0, sizeof(*e));
    e->slot = slot;
    e->type = d[0];
    e->copy_protected = d[1] == 0xff;
    e->first_block = rd16(d + 2);
    int n = raw_name_len(d + 4);
    memcpy(e->name, d + 4, (size_t)n);
    e->name[n] = 0;
    e->name_len = (uint8_t)n;
    memcpy(e->timestamp, d + 16, 8);
    e->size_blocks = rd16(d + 24);
    e->header_offset = rd16(d + 26);
    memcpy(e->raw, d, VMU_DIR_ENTRY);
}

int vc_list(const uint8_t *img, vc_entry_t *out, int max) {
    int n = 0, slots = vc_dir_slots(img);
    for(int s = 0; s < slots; s++) {
        if(img[vc_dir_offset(img, s)] == VMU_FILE_NONE) continue;
        if(n < max) vc_parse_entry(img, s, &out[n]);
        n++;
    }
    return n;
}

/* 名前で探す (末尾の空白は無視)。見つかった slot or -1 */
static int find_slot(const uint8_t *img, const char *name) {
    int qn = (int)strlen(name);
    while(qn > 0 && name[qn - 1] == ' ') qn--;
    int slots = vc_dir_slots(img);
    for(int s = 0; s < slots; s++) {
        const uint8_t *d = img + vc_dir_offset(img, s);
        if(d[0] == VMU_FILE_NONE) continue;
        if(raw_name_len(d + 4) == qn && memcmp(d + 4, name, (size_t)qn) == 0) return s;
    }
    return -1;
}

int vc_find(const uint8_t *img, const char *name, vc_entry_t *e) {
    int s = find_slot(img, name);
    if(s < 0) return 0;
    if(e) vc_parse_entry(img, s, e);
    return 1;
}

/* ---------------- ファイル ---------------- */

int vc_read_file(const uint8_t *img, const vc_entry_t *e, uint8_t *out, size_t cap) {
    uint8_t blocks[VMU_BLOCK_COUNT];
    int n = vc_chain(img, e->first_block, e->size_blocks, blocks);
    if(n < 0) return n;
    if((size_t)n * VMU_BLOCK_SIZE > cap) return VMU_ERR_TOO_BIG;
    for(int i = 0; i < n; i++) memcpy(out + i * VMU_BLOCK_SIZE, img + blocks[i] * VMU_BLOCK_SIZE, VMU_BLOCK_SIZE);
    return n * VMU_BLOCK_SIZE;
}

/* 空きを割り当てる: ゲームはブロック 0 から連続、データは本体と同じく上 (大きい番号) から */
static int allocate(const uint8_t *img, int size_blocks, uint8_t type, uint8_t *blocks) {
    int ub = user_blocks(img);
    if(type == VMU_FILE_GAME) {
        for(int b = 0; b < size_blocks; b++) {
            if(b >= ub || vc_get_fat(img, b) != VMU_FAT_FREE) return VMU_ERR_NO_GAME_SPACE;
            blocks[b] = (uint8_t)b;
        }
        return size_blocks;
    }
    if(vc_free_count(img) < size_blocks) return VMU_ERR_NO_SPACE;
    int n = 0;
    for(int b = ub - 1; b >= 0 && n < size_blocks; b--)
        if(vc_get_fat(img, b) == VMU_FAT_FREE) blocks[n++] = (uint8_t)b;
    return n;
}

static void place_data(uint8_t *img, const uint8_t *data, size_t len, const uint8_t *blocks, int n) {
    for(int i = 0; i < n; i++) {
        uint8_t *dst = img + blocks[i] * VMU_BLOCK_SIZE;
        size_t from = (size_t)i * VMU_BLOCK_SIZE;
        size_t take = from >= len ? 0 : (len - from < VMU_BLOCK_SIZE ? len - from : VMU_BLOCK_SIZE);
        if(take) memcpy(dst, data + from, take);
        memset(dst + take, 0, VMU_BLOCK_SIZE - take);
        vc_set_fat(img, blocks[i], i + 1 < n ? blocks[i + 1] : VMU_FAT_END);
    }
}

/* 壊れていても辿れるところまで (範囲外・ループ・未使用・exclude で止まる)。ブロック数 */
static int chain_safe(const uint8_t *img, int first, const uint8_t *exclude, uint8_t *blocks) {
    uint8_t seen[VMU_BLOCK_COUNT];
    int n = 0, ub = user_blocks(img);
    memset(seen, 0, sizeof(seen));
    for(int b = first; b < ub && !seen[b] && !(exclude && exclude[b]);) {
        seen[b] = 1;
        blocks[n++] = (uint8_t)b;
        int next = vc_get_fat(img, b);
        if(next == VMU_FAT_END || next == VMU_FAT_FREE) break;
        b = next;
    }
    return n;
}

static int delete_slot(uint8_t *img, int slot) {
    uint8_t others[VMU_BLOCK_COUNT], blocks[VMU_BLOCK_COUNT];
    int slots = vc_dir_slots(img);
    if(slot < 0 || slot >= slots) return VMU_ERR_NOT_FOUND;
    size_t off = vc_dir_offset(img, slot);
    if(img[off] == VMU_FILE_NONE) return VMU_ERR_NOT_FOUND;
    /* 壊れたつながりでも消せるように辿れる範囲で解放する。他のファイルのブロックは解放しない */
    memset(others, 0, sizeof(others));
    for(int s = 0; s < slots; s++) {
        size_t o = vc_dir_offset(img, s);
        if(s == slot || img[o] == VMU_FILE_NONE) continue;
        int n = chain_safe(img, rd16(img + o + 2), NULL, blocks);
        for(int i = 0; i < n; i++) others[blocks[i]] = 1;
    }
    int n = chain_safe(img, rd16(img + off + 2), others, blocks);
    for(int i = 0; i < n; i++) {
        vc_set_fat(img, blocks[i], VMU_FAT_FREE);
        memset(img + blocks[i] * VMU_BLOCK_SIZE, 0, VMU_BLOCK_SIZE);
    }
    memset(img + off, 0, VMU_DIR_ENTRY);
    return VMU_OK;
}

int vc_delete_file(uint8_t *img, int slot) {
    return delete_slot(img, slot);
}

int vc_write_file(uint8_t *img, const char *name, const uint8_t *data, size_t len, uint8_t type,
                   int copy_protected, const uint8_t ts[8], uint16_t header_offset, int overwrite) {
    uint8_t blocks[VMU_BLOCK_COUNT];
    int nl = (int)strlen(name);
    while(nl > 0 && name[nl - 1] == ' ') nl--;
    if(nl < 1 || nl > VMU_NAME_LEN) return VMU_ERR_BAD_NAME;
    for(int i = 0; i < nl; i++) if((unsigned char)name[i] < 0x20 || (unsigned char)name[i] > 0x7e) return VMU_ERR_BAD_NAME;
    int size_blocks = (int)((len + VMU_BLOCK_SIZE - 1) / VMU_BLOCK_SIZE);
    if(size_blocks == 0) return VMU_ERR_EMPTY;
    if(size_blocks > VMU_BLOCK_COUNT) return VMU_ERR_NO_SPACE;

    memcpy(backup_buf, img, VMU_IMAGE_SIZE);
    int err = VMU_OK, slot = -1;
    char nm[VMU_NAME_LEN + 1];
    memcpy(nm, name, (size_t)nl);
    nm[nl] = 0;
    int existing = find_slot(img, nm);
    if(existing >= 0) {
        if(!overwrite) { err = VMU_ERR_EXISTS; goto fail; }
        delete_slot(img, existing);
    }
    if(type == VMU_FILE_GAME) {
        int slots = vc_dir_slots(img);
        for(int s = 0; s < slots; s++)
            if(img[vc_dir_offset(img, s)] == VMU_FILE_GAME) { err = VMU_ERR_GAME_EXISTS; goto fail; }
    }
    int n = allocate(img, size_blocks, type, blocks);
    if(n < 0) { err = n; goto fail; }
    int slots = vc_dir_slots(img);
    for(int s = 0; s < slots; s++) if(img[vc_dir_offset(img, s)] == VMU_FILE_NONE) { slot = s; break; }
    if(slot < 0) { err = VMU_ERR_DIR_FULL; goto fail; }
    place_data(img, data, len, blocks, n);

    uint8_t *e = img + vc_dir_offset(img, slot);
    memset(e, 0, VMU_DIR_ENTRY);
    e[0] = type;
    e[1] = copy_protected ? 0xff : 0x00;
    wr16(e + 2, blocks[0]);
    memcpy(e + 4, nm, (size_t)nl);
    if(ts) memcpy(e + 16, ts, 8);
    wr16(e + 24, (uint16_t)size_blocks);
    wr16(e + 26, header_offset);
    return slot;
fail:
    memcpy(img, backup_buf, VMU_IMAGE_SIZE);
    return err;
}

int vc_fragmented(const uint8_t *img, int slot) {
    uint8_t blocks[VMU_BLOCK_COUNT];
    vc_entry_t e;
    vc_parse_entry(img, slot, &e);
    int n = chain_safe(img, e.first_block, NULL, blocks);
    for(int i = 1; i < n; i++) {
        int d = blocks[i] - blocks[i - 1];
        if(d != 1 && d != -1) return 1;
    }
    return 0;
}

/* 断片化を解消: ゲームはブロック 0 から、データはディレクトリ順に上から詰め直す。ディレクトリの並び・属性はそのまま */
int vc_defragment(uint8_t *img) {
    static vc_entry_t files[VMU_MAX_FILES];
    static size_t data_at[VMU_MAX_FILES];
    static int order[VMU_MAX_FILES];
    uint8_t blocks[VMU_BLOCK_COUNT];
    if(vc_check(img, NULL, 0) > 0) return VMU_ERR_CHECK_FAILED;

    memcpy(backup_buf, img, VMU_IMAGE_SIZE);
    int nf = vc_list(img, files, VMU_MAX_FILES);
    if(nf > VMU_MAX_FILES) nf = VMU_MAX_FILES;
    size_t used = 0;
    for(int i = 0; i < nf; i++) {
        int r = vc_read_file(img, &files[i], scratch_buf + used, sizeof(scratch_buf) - used);
        if(r < 0) { memcpy(img, backup_buf, VMU_IMAGE_SIZE); return r; }
        data_at[i] = used;
        used += (size_t)r;
    }
    int ub = user_blocks(img);
    for(int b = 0; b < ub; b++) {
        vc_set_fat(img, b, VMU_FAT_FREE);
        memset(img + b * VMU_BLOCK_SIZE, 0, VMU_BLOCK_SIZE);
    }
    /* ゲームを先に (それ以外は元の順。vmu.js の安定ソートと同じ) */
    int k = 0;
    for(int i = 0; i < nf; i++) if(files[i].type == VMU_FILE_GAME) order[k++] = i;
    for(int i = 0; i < nf; i++) if(files[i].type != VMU_FILE_GAME) order[k++] = i;
    for(int j = 0; j < nf; j++) {
        vc_entry_t *e = &files[order[j]];
        int n = allocate(img, e->size_blocks, e->type, blocks);
        if(n < 0) { memcpy(img, backup_buf, VMU_IMAGE_SIZE); return n; }
        place_data(img, scratch_buf + data_at[order[j]], (size_t)e->size_blocks * VMU_BLOCK_SIZE, blocks, n);
        wr16(img + vc_dir_offset(img, e->slot) + 2, blocks[0]);
    }
    return VMU_OK;
}

int vc_reorder(uint8_t *img, const int *slots, int n) {
    static vc_entry_t list[VMU_MAX_FILES];
    static uint8_t raws[VMU_MAX_FILES][VMU_DIR_ENTRY];
    uint8_t taken[VMU_MAX_FILES];
    int nf = vc_list(img, list, VMU_MAX_FILES), k = 0, total = vc_dir_slots(img);
    if(nf > VMU_MAX_FILES) nf = VMU_MAX_FILES;
    memset(taken, 0, sizeof(taken));
    for(int i = 0; i < n; i++) {
        int found = -1;
        for(int j = 0; j < nf; j++) if(list[j].slot == slots[i]) found = j;
        if(found < 0) return VMU_ERR_NOT_FOUND;
    }
    for(int i = 0; i < n; i++)
        for(int j = 0; j < nf; j++)
            if(list[j].slot == slots[i] && !taken[j]) { taken[j] = 1; memcpy(raws[k++], list[j].raw, VMU_DIR_ENTRY); }
    for(int j = 0; j < nf; j++) if(!taken[j]) memcpy(raws[k++], list[j].raw, VMU_DIR_ENTRY);
    for(int s = 0; s < total; s++) memset(img + vc_dir_offset(img, s), 0, VMU_DIR_ENTRY);
    for(int i = 0; i < k; i++) memcpy(img + vc_dir_offset(img, i), raws[i], VMU_DIR_ENTRY);
    return VMU_OK;
}

/* ---------------- 整合性 ---------------- */

static void add_problem(vc_problem_t *out, int max, int *n, int code, int slot, int a, int b) {
    if(out && *n < max) { out[*n].code = code; out[*n].slot = slot; out[*n].a = a; out[*n].b = b; }
    (*n)++;
}

int vc_check(const uint8_t *img, vc_problem_t *out, int max) {
    static vc_entry_t list[VMU_MAX_FILES];
    int owner[VMU_BLOCK_COUNT];
    uint8_t blocks[VMU_BLOCK_COUNT];
    int n = 0;
    vc_root_t r;
    vc_get_root(img, &r);
    if(!r.formatted) add_problem(out, max, &n, VMU_PROB_NOT_FORMATTED, -1, 0, 0);
    else if(r.root_block != ROOT_BLOCK) add_problem(out, max, &n, VMU_PROB_ROOT_POS, -1, r.root_block, 0);
    for(int i = 0; i < VMU_BLOCK_COUNT; i++) owner[i] = -1;
    int nf = vc_list(img, list, VMU_MAX_FILES);
    if(nf > VMU_MAX_FILES) nf = VMU_MAX_FILES;
    for(int i = 0; i < nf; i++) {
        /* 同名: 直前に同じ名前だったファイル (vmu.js の Map と同じく後のもので上書き) */
        int prev = -1;
        for(int j = 0; j < i; j++)
            if(list[j].name_len == list[i].name_len && memcmp(list[j].name, list[i].name, list[i].name_len) == 0) prev = list[j].slot;
        if(prev >= 0) add_problem(out, max, &n, VMU_PROB_DUP_NAME, list[i].slot, prev, list[i].slot);
        int c = vc_chain(img, list[i].first_block, VMU_BLOCK_COUNT, blocks);
        if(c < 0) { add_problem(out, max, &n, VMU_PROB_CHAIN, list[i].slot, 0, 0); continue; }
        if(c != list[i].size_blocks) add_problem(out, max, &n, VMU_PROB_SIZE, list[i].slot, list[i].size_blocks, c);
        for(int k = 0; k < c; k++) {
            if(owner[blocks[k]] >= 0) add_problem(out, max, &n, VMU_PROB_SHARED_BLOCK, list[i].slot, blocks[k], owner[blocks[k]]);
            owner[blocks[k]] = list[i].slot;
        }
    }
    return n;
}

/* ---------------- VMS ヘッダ ---------------- */

static const size_t eyecatch_sizes[4] = { 0, 72 * 56 * 2, 512 + 72 * 56, 32 + 72 * 56 / 2 };

size_t vms_header_position(const vc_entry_t *e) {
    return e->type == VMU_FILE_GAME ? (size_t)e->header_offset * VMU_BLOCK_SIZE : 0;
}

static void copy_text(char *dst, const uint8_t *src, int n) {
    int len = 0;
    while(len < n && src[len]) len++;
    while(len > 0 && (src[len - 1] == ' ' || src[len - 1] == '\t' || src[len - 1] == '\r' || src[len - 1] == '\n')) len--;
    memcpy(dst, src, (size_t)len);
    dst[len] = 0;
}

int vms_parse_header(const uint8_t *file, size_t len, size_t offset, vms_header_t *h) {
    if(len < offset + VMS_HEADER_SIZE) return 0;
    const uint8_t *p = file + offset;
    memset(h, 0, sizeof(*h));
    h->offset = offset;
    copy_text(h->description, p, 16);
    copy_text(h->long_description, p + 0x10, 32);
    copy_text(h->app_id, p + 0x30, 16);
    h->icon_count = rd16(p + 0x40);
    h->anim_speed = rd16(p + 0x42);
    h->eyecatch_type = rd16(p + 0x44);
    h->crc = rd16(p + 0x46);
    h->data_size = rd32(p + 0x48);
    for(int i = 0; i < 16; i++) h->palette[i] = rd16(p + 0x60 + i * 2);
    h->valid = h->icon_count >= 1 && h->icon_count <= 3 && h->eyecatch_type <= 3;
    h->icons_offset = offset + VMS_HEADER_SIZE;
    h->eyecatch_offset = h->icons_offset + (size_t)h->icon_count * VMS_ICON_SIZE;
    h->data_offset = h->eyecatch_offset + (h->eyecatch_type <= 3 ? eyecatch_sizes[h->eyecatch_type] : 0);
    return 1;
}

int vms_crc_range_valid(const vms_header_t *h, size_t len) {
    return h->valid && h->data_offset + h->data_size <= len;
}

/* CRC16 (CCITT、初期値 0、ヘッダの CRC 欄を 0 として計算。KOS の vmu_pkg_crc と同じ)。範囲は呼ぶ側で確かめておく */
uint16_t vms_calc_crc(const uint8_t *file, const vms_header_t *h) {
    size_t n = h->data_offset - h->offset + h->data_size;
    const uint8_t *p = file + h->offset;
    unsigned crc = 0;
    for(size_t i = 0; i < n; i++) {
        unsigned b = (i == 0x46 || i == 0x47) ? 0 : p[i];
        crc ^= b << 8;
        for(int k = 0; k < 8; k++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return (uint16_t)crc;
}

uint16_t vms_update_crc(uint8_t *file, const vms_header_t *h) {
    uint16_t crc = vms_calc_crc(file, h);
    wr16(file + h->offset + 0x46, crc);
    return crc;
}

/* ---------------- DCI ---------------- */

void vc_swap32(const uint8_t *src, uint8_t *dst, size_t len) {
    size_t i = 0;
    for(; i + 3 < len; i += 4) {
        uint8_t a = src[i], b = src[i + 1], c = src[i + 2], d = src[i + 3];
        dst[i] = d; dst[i + 1] = c; dst[i + 2] = b; dst[i + 3] = a;
    }
    for(; i < len; i++) dst[i] = src[i];
}

size_t vc_to_dci(const vc_entry_t *e, const uint8_t *data, size_t len, uint8_t *out) {
    memcpy(out, e->raw, VMU_DIR_ENTRY);
    vc_swap32(data, out + VMU_DIR_ENTRY, len);
    return VMU_DIR_ENTRY + len;
}

int vc_parse_dci(const uint8_t *dci, size_t len, vc_dci_t *o) {
    if(len < VMU_DIR_ENTRY) return VMU_ERR_BAD_DCI;
    memset(o, 0, sizeof(*o));
    o->size_blocks = rd16(dci + 24);
    if(o->size_blocks == 0 || len < VMU_DIR_ENTRY + (size_t)o->size_blocks * VMU_BLOCK_SIZE) return VMU_ERR_BAD_DCI;
    o->type = dci[0];
    o->copy_protected = dci[1] == 0xff;
    int n = raw_name_len(dci + 4);
    memcpy(o->name, dci + 4, (size_t)n);
    o->name[n] = 0;
    o->header_offset = rd16(dci + 26);
    memcpy(o->timestamp, dci + 16, 8);
    o->swapped = dci + VMU_DIR_ENTRY;
    return VMU_OK;
}

/* ---------------- その他 ---------------- */

void vc_encode_timestamp(uint8_t ts[8], int year, int month, int day, int hour, int min, int sec, int wday_mon0) {
    ts[0] = (uint8_t)to_bcd(year / 100);
    ts[1] = (uint8_t)to_bcd(year % 100);
    ts[2] = (uint8_t)to_bcd(month);
    ts[3] = (uint8_t)to_bcd(day);
    ts[4] = (uint8_t)to_bcd(hour);
    ts[5] = (uint8_t)to_bcd(min);
    ts[6] = (uint8_t)to_bcd(sec);
    ts[7] = (uint8_t)to_bcd(wday_mon0);
}

uint32_t vc_crc32(const uint8_t *p, size_t n) {
    uint32_t c = 0xffffffffu;
    for(size_t i = 0; i < n; i++) {
        c ^= p[i];
        for(int k = 0; k < 8; k++) c = (c >> 1) ^ (0xedb88320u & (0u - (c & 1)));
    }
    return ~c;
}

const char *vmucore_strerror(int err) {
    switch(err) {
        case VMU_OK: return "ok";
        case VMU_ERR_NOT_FORMATTED: return "not formatted";
        case VMU_ERR_BAD_NAME: return "bad file name";
        case VMU_ERR_EMPTY: return "empty file";
        case VMU_ERR_EXISTS: return "file exists";
        case VMU_ERR_GAME_EXISTS: return "a game file is already there";
        case VMU_ERR_NO_GAME_SPACE: return "no room for a game at block 0";
        case VMU_ERR_NO_SPACE: return "not enough free blocks";
        case VMU_ERR_DIR_FULL: return "directory full";
        case VMU_ERR_BROKEN_CHAIN: return "broken FAT chain";
        case VMU_ERR_NOT_FOUND: return "file not found";
        case VMU_ERR_CHECK_FAILED: return "image has problems";
        case VMU_ERR_TOO_BIG: return "too big";
        case VMU_ERR_BAD_DCI: return "bad DCI";
        case VMU_ERR_BAD_ROOT: return "bad root block";
        default: return "error";
    }
}
