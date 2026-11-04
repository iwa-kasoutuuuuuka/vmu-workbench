/*
 * savemgr — Dreamcast 本体で動く VMU セーブマネージャ (仕様: docs/dc-savemgr-spec.md)
 *
 * 段階 2: 本体だけで使う機能 (一覧・コピー・削除・情報・中身・丸ごとコピー・整理・検査・取り消し・初期化)。
 * BBA で PC とつなぐ機能は次の段階で足す。VMU の処理は vmucore.c (PC でも vmu.js と同じ結果になるか試してある)、
 * 実機との読み書きは store.c。
 *
 * ROM 内に auto (romdisk/auto) があると、起動時にその命令を実行する (Flycast での自動確認用。scripts/savemgr-test.js。auto 入りは savemgr_test.cdi という別の名前で作る)。
 */
#include <kos.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "vmucore.h"
#include "store.h"
#include "gfx.h"
#include "msg.h"
#include "net.h"
#include "httpd.h"

#define VERSION HTTPD_VERSION

/* 色 */
#define C_BG      RGB(16, 24, 48)
#define C_BAR     RGB(32, 48, 96)
#define C_SEL     RGB(56, 88, 168)
#define C_TEXT    RGB(240, 240, 240)
#define C_DIM     RGB(150, 160, 180)
#define C_WARN    RGB(255, 200, 80)
#define C_ERR     RGB(255, 110, 110)
#define C_OK      RGB(120, 230, 140)
#define C_BOX     RGB(24, 32, 64)
#define C_LINE    RGB(120, 150, 220)

/* ---------------- 入力 ---------------- */

#define K_L (1u << 20)
#define K_R (1u << 21)
#define K_DIRS (CONT_DPAD_UP | CONT_DPAD_DOWN | CONT_DPAD_LEFT | CONT_DPAD_RIGHT | K_L | K_R)

static uint32_t pad_prev;
static uint64_t pad_hold_ms;

static uint64_t now_ms(void) { return timer_ms_gettime64(); }

/* 押した瞬間のボタン (方向と L/R は押し続けると繰り返す) */
static uint32_t pad_read(void) {
    maple_device_t *c = maple_enum_type(0, MAPLE_FUNC_CONTROLLER);
    cont_state_t *st = c ? (cont_state_t *)maple_dev_status(c) : NULL;
    uint32_t b = 0;
    if(st) {
        b = st->buttons;
        if(st->ltrig > 160) b |= K_L;
        if(st->rtrig > 160) b |= K_R;
    }
    uint32_t down = b & ~pad_prev;
    uint64_t t = now_ms();
    if(down & K_DIRS) pad_hold_ms = t + 350;
    else if((b & K_DIRS) && (b & K_DIRS) == (pad_prev & K_DIRS) && t >= pad_hold_ms) {
        down |= b & K_DIRS;
        pad_hold_ms = t + 70;
    }
    pad_prev = b;
    return down;
}

/* ---------------- 一覧 (選んでいる VMU のファイル) ---------------- */

typedef struct {
    vc_entry_t e;
    int readable;
    int has_hdr;                 /* VMS ヘッダらしいものがある */
    vms_header_t h;
    int crc_state;               /* 0 = なし, 1 = 正しい, 2 = 合わない */
    int frag;
    uint8_t icons[3][VMS_ICON_SIZE];
    int icon_n;
} item_t;

static item_t items[VMU_MAX_FILES];
static int order[VMU_MAX_FILES];
static int n_items;
static int cache_slot = -1, cache_valid = 0, cache_sort = -1;
static uint32_t cache_crc;
static uint8_t file_buf[VMU_IMAGE_SIZE];

static int cur_slot = 0, cursor = 0, scroll = 0, sort_mode = 0;

static int date_key(const uint8_t *ts) {
    /* BCD をそのまま並べると古い順に比べられる (世紀, 年, 月, 日, 時, 分) */
    return (ts[0] << 24 | ts[1] << 16 | ts[2] << 8 | ts[3]) ^ 0;
}

static int cmp_items(int a, int b) {
    const item_t *x = &items[a], *y = &items[b];
    int r = 0;
    switch(sort_mode) {
        case 1: r = memcmp(x->e.raw + 4, y->e.raw + 4, VMU_NAME_LEN); break;
        case 2: r = memcmp(y->e.raw + 16, x->e.raw + 16, 7); break;
        case 3: r = (int)y->e.size_blocks - (int)x->e.size_blocks; break;
        default: break;
    }
    return r ? r : x->e.slot - y->e.slot;
}

static void sort_items(void) {
    for(int i = 0; i < n_items; i++) order[i] = i;
    for(int i = 1; i < n_items; i++) {   /* 件数が少ないので挿入ソート */
        int v = order[i], j = i - 1;
        while(j >= 0 && cmp_items(order[j], v) > 0) { order[j + 1] = order[j]; j--; }
        order[j + 1] = v;
    }
    (void)date_key;
}

static void rebuild_items(void) {
    store_slot_t *sl = &g_slot[cur_slot];
    static vc_entry_t list[VMU_MAX_FILES];
    n_items = 0;
    cache_slot = cur_slot;
    cache_valid = sl->loaded;
    cache_crc = sl->crc;
    cache_sort = sort_mode;
    if(!sl->loaded || !vc_root_ok(sl->img)) return;
    int n = vc_list(sl->img, list, VMU_MAX_FILES);
    if(n > VMU_MAX_FILES) n = VMU_MAX_FILES;
    for(int i = 0; i < n; i++) {
        item_t *it = &items[n_items++];
        memset(it, 0, sizeof(*it));
        it->e = list[i];
        it->frag = vc_fragmented(sl->img, list[i].slot);
        int len = vc_read_file(sl->img, &list[i], file_buf, sizeof(file_buf));
        it->readable = len >= 0;
        if(len < 0) continue;
        if(vms_parse_header(file_buf, (size_t)len, vms_header_position(&list[i]), &it->h) && it->h.valid) {
            it->has_hdr = 1;
            it->icon_n = it->h.icon_count;
            for(int k = 0; k < it->icon_n; k++) {
                size_t off = it->h.icons_offset + (size_t)k * VMS_ICON_SIZE;
                if(off + VMS_ICON_SIZE <= (size_t)len) memcpy(it->icons[k], file_buf + off, VMS_ICON_SIZE);
                else it->icon_n = k;
            }
            if(vms_crc_range_valid(&it->h, (size_t)len)) it->crc_state = vms_calc_crc(file_buf, &it->h) == it->h.crc ? 1 : 2;
        }
    }
    sort_items();
}

static void ensure_items(void) {
    store_slot_t *sl = &g_slot[cur_slot];
    if(cache_slot != cur_slot || cache_valid != sl->loaded || (sl->loaded && cache_crc != sl->crc) || cache_sort != sort_mode) {
        rebuild_items();
        if(cursor >= n_items) cursor = n_items ? n_items - 1 : 0;
    }
}

static item_t *cur_item(void) { return n_items ? &items[order[cursor]] : NULL; }

/* ---------------- 文言 ---------------- */

static const char *err_text(int r) {
    static char buf[64];
    switch(r) {
        case VMU_ERR_NOT_FORMATTED: return M_E_NOT_FORMATTED;
        case VMU_ERR_BAD_NAME: return M_E_BAD_NAME;
        case VMU_ERR_EXISTS: return M_E_EXISTS;
        case VMU_ERR_GAME_EXISTS: return M_E_GAME_EXISTS;
        case VMU_ERR_NO_GAME_SPACE: return M_E_NO_GAME_SPACE;
        case VMU_ERR_NO_SPACE: return M_E_NO_SPACE;
        case VMU_ERR_DIR_FULL: return M_E_DIR_FULL;
        case VMU_ERR_BROKEN_CHAIN: return M_E_BROKEN;
        case VMU_ERR_CHECK_FAILED: return M_E_CHECK_FAILED;
        case ST_ERR_NO_VMU: return M_E_NO_VMU;
        case ST_ERR_READ: return M_E_READ;
        case ST_ERR_WRITE: return M_E_WRITE;
        case ST_ERR_REPLACED: return M_E_REPLACED;
        default: snprintf(buf, sizeof(buf), M_E_OTHER, r); return buf;
    }
}

static void fmt_date(char *out, size_t n, const uint8_t *ts, int with_time) {
    if(!memcmp(ts, "\0\0\0\0\0\0\0", 7)) { snprintf(out, n, "--"); return; }
    if(with_time) snprintf(out, n, "%02x%02x/%02x/%02x %02x:%02x:%02x", ts[0], ts[1], ts[2], ts[3], ts[4], ts[5], ts[6]);
    else snprintf(out, n, "%02x/%02x/%02x", ts[1], ts[2], ts[3]);
}

/* ---------------- 画面 ---------------- */

static const char *sort_name(void) {
    static const char *n[4] = { M_SORT_0, M_SORT_1, M_SORT_2, M_SORT_3 };
    return n[sort_mode & 3];
}

#define LIST_Y 112
#define ROW_H 36
#define ROWS 8

static void draw_icon_of(const item_t *it, int x, int y, int scale) {
    if(!it->has_hdr || it->icon_n == 0) {
        gfx_frame(x, y, 32 * scale, 32 * scale, C_DIM);
        return;
    }
    int speed = it->h.anim_speed ? it->h.anim_speed : 10;
    int frame = it->icon_n > 1 ? (int)((now_ms() * 30 / 1000 / (uint64_t)speed) % (uint64_t)it->icon_n) : 0;
    gfx_icon(x, y, it->icons[frame], it->h.palette, scale);
}

static void draw_main(void) {
    char buf[96];
    ensure_items();
    gfx_clear(C_BG);
    gfx_rect(0, 0, SCR_W, 44, C_BAR);
    gfx_text(24, 12, C_TEXT, M_TITLE, 0);
    {
        char lan[40];
        uint16_t lc = C_DIM;
        if(g_net.state == NET_UP) { snprintf(lan, sizeof(lan), M_LAN_UP, g_net.ip); lc = C_OK; }
        else snprintf(lan, sizeof(lan), "%s", g_net.state == NET_STARTING ? M_LAN_STARTING : g_net.state == NET_ERROR ? M_LAN_ERROR : M_LAN_NONE);
        gfx_text(SCR_W - 24 - gfx_text_width(lan), 12, lc, lan, 0);
    }

    /* スロットの札 */
    for(int s = 0; s < STORE_SLOTS; s++) {
        int x = 20 + s * 76, y = 50;
        store_slot_t *sl = &g_slot[s];
        uint16_t bg = s == cur_slot ? C_SEL : C_BOX;
        gfx_rect(x, y, 72, 54, bg);
        if(s == cur_slot) gfx_frame(x, y, 72, 54, C_LINE);
        gfx_text(x + 24, y + 3, sl->present ? C_TEXT : C_DIM, store_slot_name(s), 0);
        if(!sl->present) gfx_text(x + 24, y + 27, C_DIM, "--", 0);
        else if(!sl->loaded) gfx_text(x + 18, y + 27, sl->load_error ? C_ERR : C_DIM, sl->load_error ? "ERR" : "...", 0);
        else if(!vc_root_ok(sl->img)) gfx_text(x + 24, y + 27, C_WARN, "??", 0);
        else {
            snprintf(buf, sizeof(buf), "%d", vc_free_count(sl->img));
            gfx_text(x + (72 - gfx_text_width(buf)) / 2, y + 27, C_TEXT, buf, 0);
        }
    }

    store_slot_t *sl = &g_slot[cur_slot];
    const char *center = NULL;
    uint16_t center_c = C_DIM;
    if(!sl->present) center = M_NO_VMU;
    else if(!sl->loaded) { center = sl->load_error ? M_READ_ERROR : M_LOADING; center_c = sl->load_error ? C_ERR : C_DIM; }
    else if(!vc_root_ok(sl->img)) { center = M_UNFORMATTED; center_c = C_WARN; }
    else if(n_items == 0) center = M_EMPTY;
    if(center) gfx_text_center(LIST_Y + 120, center_c, center);
    else {
        if(cursor < scroll) scroll = cursor;
        if(cursor >= scroll + ROWS) scroll = cursor - ROWS + 1;
        for(int r = 0; r < ROWS && scroll + r < n_items; r++) {
            int i = scroll + r, y = LIST_Y + r * ROW_H;
            item_t *it = &items[order[i]];
            if(i == cursor) gfx_rect(16, y, SCR_W - 32, ROW_H, C_SEL);
            draw_icon_of(it, 24, y + 2, 1);
            /* VMS の説明 (短い方 + 本体用の長い方)。ヘッダがなければファイル名 */
            uint16_t c = !it->readable ? C_ERR : it->crc_state == 2 ? C_WARN : C_TEXT;
            if(it->has_hdr && (it->h.description[0] || it->h.long_description[0])) {
                int w = gfx_text(64, y + 6, c, it->h.description, 384);
                if(w < 372) gfx_text(64 + w + 12, y + 6, C_DIM, it->h.long_description, 384 - w - 12);
            } else gfx_text(64, y + 6, c, it->e.name, 384);
            snprintf(buf, sizeof(buf), "%d", it->e.size_blocks);
            gfx_text(496 - gfx_text_width(buf), y + 6, C_TEXT, buf, 0);
            fmt_date(buf, sizeof(buf), it->e.timestamp, 0);
            gfx_text(516, y + 6, C_DIM, buf, 0);
        }
        if(scroll > 0) gfx_text(SCR_W - 36, LIST_Y - 2, C_DIM, "\x81\xa3", 0);                 /* ▲ */
        if(scroll + ROWS < n_items) gfx_text(SCR_W - 36, LIST_Y + ROWS * ROW_H - 22, C_DIM, "\x81\xa5", 0);  /* ▼ */
    }

    /* 選んでいるファイル */
    gfx_rect(0, 404, SCR_W, 28, C_BOX);
    int sort_x = SCR_W - 24 - gfx_text_width(sort_name());
    gfx_text(sort_x, 406, C_DIM, sort_name(), 0);
    item_t *it = cur_item();
    if(it && !center) {
        /* 並べ替えの表示 (右端) に重ならないところまで */
        int x = 24, lim = sort_x - 16;
#define PIECE(c, s) do { if(lim - x >= 12) x += gfx_text(x, 406, c, s, lim - x) + 16; } while(0)
        PIECE(C_TEXT, it->e.name);
        PIECE(C_DIM, it->e.type == VMU_FILE_GAME ? M_TYPE_GAME : M_TYPE_DATA);
        if(it->e.copy_protected) PIECE(C_WARN, M_PROTECTED);
        if(it->crc_state == 2) PIECE(C_WARN, "CRC NG");
#undef PIECE
    }
    gfx_text(24, 440, C_DIM, M_HELP_MAIN, 0);
}

/* 箱を描く (中央) */
static void draw_box(int w, int h, int *bx, int *by) {
    int x = (SCR_W - w) / 2, y = (SCR_H - h) / 2;
    gfx_rect(x, y, w, h, C_BOX);
    gfx_frame(x, y, w, h, C_LINE);
    *bx = x;
    *by = y;
}

/* ---------------- 進み具合 ---------------- */

static const char *progress_title;

static void progress_cb(int done, int total, void *ctx) {
    (void)ctx;
    int bx, by;
    char buf[64];
    draw_main();
    draw_box(520, 120, &bx, &by);
    gfx_text_center(by + 16, C_WARN, progress_title);
    gfx_rect(bx + 30, by + 56, 460, 16, C_BG);
    if(total > 0) gfx_rect(bx + 30, by + 56, 460 * done / total, 16, C_OK);
    snprintf(buf, sizeof(buf), M_WRITE_PROGRESS, done, total);
    gfx_text_center(by + 82, C_TEXT, buf);
    gfx_present();
}

static int load_slot(int s) {
    progress_title = M_LOADING;
    return store_ensure(s, progress_cb, NULL);
}

/* 書いて、結果を返す (書いたブロック数か負のエラー) */
static int commit(int s, const uint8_t *img) {
    progress_title = M_WRITING;
    progress_cb(0, store_changed_blocks(s, img), NULL);
    return store_commit(s, img, progress_cb, NULL);
}

/* ---------------- 小さな画面 (選ぶ・確かめる・知らせる) ---------------- */

static int auto_mode;   /* 自動実行中は確認を出さない */

/* 自動実行の記録: シリアルに出し、最後に B1 の VMU があれば SMGRLOG に書く (Flycast のシリアルは読みにくいので) */
static char auto_log[4096];
static int auto_log_len;
static void alog(const char *fmt, ...) {
    char line[160];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof(line), fmt, ap);
    va_end(ap);
    printf("%s", line);
    int n = (int)strlen(line);
    if(auto_log_len + n < (int)sizeof(auto_log)) { memcpy(auto_log + auto_log_len, line, (size_t)n); auto_log_len += n; }
}

/* 自動実行の show 命令: 画面をしばらく出してから B を押したことにして閉じる (画面の確認用) */
static uint64_t auto_show_until;
static uint32_t ui_key(void) {
    if(auto_show_until) {
        pad_read();
        if(now_ms() < auto_show_until) return 0;
        auto_show_until = 0;
        return CONT_B;
    }
    return pad_read();
}

static int ui_menu(const char *title, const char **labels, const int *enabled, int n) {
    int sel = 0;
    while(n > 0 && enabled && !enabled[sel] && sel < n - 1) sel++;
    for(;;) {
        int bx, by, h = 64 + n * 32;
        draw_main();
        draw_box(440, h, &bx, &by);
        gfx_text(bx + 20, by + 12, C_WARN, title, 400);
        for(int i = 0; i < n; i++) {
            int y = by + 48 + i * 32;
            if(i == sel) gfx_rect(bx + 12, y - 4, 416, 32, C_SEL);
            gfx_text(bx + 28, y, enabled && !enabled[i] ? C_DIM : C_TEXT, labels[i], 392);
        }
        gfx_present();
        uint32_t k = ui_key();
        if(k & CONT_DPAD_UP) { do sel = (sel + n - 1) % n; while(enabled && !enabled[sel]); }
        if(k & CONT_DPAD_DOWN) { do sel = (sel + 1) % n; while(enabled && !enabled[sel]); }
        if(k & CONT_A) return sel;
        if(k & CONT_B) return -1;
    }
}

/* 2 行までの文を出して待つ。ask なら A=1 / B=0 */
static int ui_dialog(uint16_t color, const char *l1, const char *l2, int ask) {
    if(auto_mode) {
        alog("DIALOG %s%s%s\n", l1, l2 ? " / " : "", l2 ? l2 : "");
        return 1;
    }
    for(;;) {
        int bx, by;
        draw_main();
        draw_box(600, 160, &bx, &by);
        gfx_text_center(by + 24, color, l1);
        if(l2) gfx_text_center(by + 60, C_TEXT, l2);
        gfx_text_center(by + 112, C_DIM, ask ? M_YESNO : M_OK_KEY);
        gfx_present();
        uint32_t k = ui_key();
        if(k & CONT_A) return 1;
        if(k & CONT_B) return 0;
    }
}

static int ui_confirm(const char *l1, const char *l2) { return ui_dialog(C_WARN, l1, l2, 1); }
static void ui_message(const char *l1, const char *l2) { ui_dialog(C_TEXT, l1, l2, 0); }
static void ui_error(int r) { ui_dialog(C_ERR, err_text(r), NULL, 0); }

/* コピー先の VMU を選ぶ。挿さっていてフォーマット済みのもの */
static int ui_pick_slot(int exclude) {
    static char lab[STORE_SLOTS][48];
    const char *labels[STORE_SLOTS];
    int map[STORE_SLOTS], n = 0;
    for(int s = 0; s < STORE_SLOTS; s++) {
        if(s == exclude || !g_slot[s].present) continue;
        if(load_slot(s) != 0) continue;
        int free = vc_root_ok(g_slot[s].img) ? vc_free_count(g_slot[s].img) : 0;
        snprintf(lab[n], sizeof(lab[n]), M_DEST_FMT, store_slot_name(s), free);
        labels[n] = lab[n];
        map[n++] = s;
    }
    if(n == 0) { ui_message(M_NO_DEST, NULL); return -1; }
    int r = ui_menu(M_PICK_DEST, labels, NULL, n);
    return r < 0 ? -1 : map[r];
}

/* ---------------- 操作 (自動実行と画面の両方から使う) ---------------- */

/* ファイルを別の VMU へ。コピー禁止は本体と同じくコピーしない */
static int act_copy(int src, const vc_entry_t *e, int dst, int confirm) {
    char l1[128], l2[128];
    if(e->copy_protected) return 1;   /* 呼ぶ側で知らせる */
    int r = load_slot(dst);
    if(r < 0) return r;
    if(!vc_root_ok(g_slot[dst].img)) return VMU_ERR_NOT_FORMATTED;
    int len = vc_read_file(g_slot[src].img, e, file_buf, sizeof(file_buf));
    if(len < 0) return len;
    int overwrite = vc_find(g_slot[dst].img, e->name, NULL);
    if(overwrite && confirm) {
        snprintf(l1, sizeof(l1), M_OVERWRITE_CONFIRM, store_slot_name(dst));
        if(!ui_confirm(l1, e->name)) return 0;
    }
    uint8_t *work = store_work(dst);
    r = vc_write_file(work, e->name, file_buf, (size_t)len, e->type, e->copy_protected, e->timestamp, e->header_offset, overwrite);
    if(r < 0) return r;
    if(confirm) {
        snprintf(l1, sizeof(l1), M_COPY_CONFIRM, store_slot_name(src), e->name, store_slot_name(dst));
        snprintf(l2, sizeof(l2), M_DEST_FMT, store_slot_name(dst), vc_free_count(work));
        if(!ui_confirm(l1, l2)) return 0;
    }
    return commit(dst, work);
}

static int act_delete(int s, const vc_entry_t *e) {
    uint8_t *work = store_work(s);
    int r = vc_delete_file(work, e->slot);
    return r < 0 ? r : commit(s, work);
}

static int act_defrag(int s) {
    uint8_t *work = store_work(s);
    int r = vc_defragment(work);
    return r < 0 ? r : commit(s, work);
}

/* 丸ごと写す。コピー禁止のファイルは写した後で消す (VMU どうしのコピーは本体と同じく禁止)。*skipped に消した数 */
static int act_whole(int src, int dst, int *skipped) {
    static vc_entry_t list[VMU_MAX_FILES];
    int r = load_slot(dst);
    if(r < 0) return r;
    uint8_t *work = store_work(dst);
    memcpy(work, g_slot[src].img, VMU_IMAGE_SIZE);
    *skipped = 0;
    int n = vc_list(work, list, VMU_MAX_FILES);
    for(int i = 0; i < n && i < VMU_MAX_FILES; i++)
        if(list[i].copy_protected && vc_delete_file(work, list[i].slot) == 0) (*skipped)++;
    return commit(dst, work);
}

static int act_format(int s) {
    uint8_t ts[8];
    int r = load_slot(s);
    if(r < 0) return r;
    uint8_t *work = store_work(s);
    store_now_timestamp(ts);
    vc_format(work, ts);
    return commit(s, work);
}

static int act_undo(int s) {
    progress_title = M_WRITING;
    return store_undo(s, progress_cb, NULL);
}

/* ---------------- 画面ごとの操作 ---------------- */

static void after_write(int r) {
    if(r < 0) ui_error(r);
    else if(r == 0) ui_message(M_NOTHING_TO_WRITE, NULL);
    else ui_message(M_DONE, NULL);
}

static void screen_info(item_t *it) {
    char buf[96];
    for(;;) {
        int bx, by, y;
        draw_main();
        draw_box(600, 440, &bx, &by);
        draw_icon_of(it, bx + 600 - 96, by + 20, 2);
        y = by + 16;
#define ROW(label, ...) do { gfx_text(bx + 20, y, C_DIM, label, 150); snprintf(buf, sizeof(buf), __VA_ARGS__); \
                             gfx_text(bx + 176, y, C_TEXT, buf, 330); y += 26; } while(0)
        ROW(M_I_NAME, "%s", it->e.name);
        ROW(M_I_TYPE, "%s", it->e.type == VMU_FILE_GAME ? M_TYPE_GAME : M_TYPE_DATA);
        ROW(M_I_PROTECT, "%s", it->e.copy_protected ? M_YES : M_NO);
        ROW(M_I_SIZE, M_BLOCKS_FMT, it->e.size_blocks);
        ROW(M_I_FIRST, "%d", it->e.first_block);
        fmt_date(buf, sizeof(buf), it->e.timestamp, 1);
        { char d[40]; strcpy(d, buf); ROW(M_I_DATE, "%s", d); }
        ROW(M_I_DESC, "%s", it->has_hdr ? it->h.description : "-");
        gfx_text(bx + 20, y, C_DIM, M_I_LDESC, 150); y += 26;
        gfx_text(bx + 40, y, C_TEXT, it->has_hdr ? it->h.long_description : "-", 540); y += 26;
        ROW(M_I_APPID, "%s", it->has_hdr ? it->h.app_id : "-");
        ROW(M_I_ICONS, M_ICONS_FMT, it->has_hdr ? it->icon_n : 0);
        ROW(M_I_CRC, "%s", it->crc_state == 1 ? M_CRC_OK : it->crc_state == 2 ? M_CRC_BAD : M_CRC_NONE);
        ROW(M_I_FRAG, "%s", it->frag ? M_YES : M_NO);
#undef ROW
        gfx_text(bx + 20, by + 440 - 32, C_DIM, M_HELP_BACK, 0);
        gfx_present();
        if(ui_key() & (CONT_A | CONT_B)) return;
    }
}

/* 中身を 16 進で (読むだけ)。ヘッダ・アイコン・データで色を変える */
static void screen_hex(item_t *it) {
    int len = vc_read_file(g_slot[cur_slot].img, &it->e, file_buf, sizeof(file_buf));
    if(len < 0) { ui_error(len); return; }
    const int per = 8, lines = 13;
    int top = 0, max_top = (len + per - 1) / per - lines;
    if(max_top < 0) max_top = 0;
    for(;;) {
        char buf[96];
        draw_main();
        gfx_rect(16, 50, SCR_W - 32, 380, C_BOX);
        gfx_frame(16, 50, SCR_W - 32, 380, C_LINE);
        snprintf(buf, sizeof(buf), "%s  %d bytes", it->e.name, len);
        gfx_text(32, 56, C_WARN, buf, 0);
        for(int l = 0; l < lines; l++) {
            int off = (top + l) * per, y = 86 + l * 26;
            if(off >= len) break;
            gfx_textf(32, y, C_DIM, "%05X", off);
            for(int i = 0; i < per && off + i < len; i++) {
                size_t p = (size_t)(off + i);
                uint16_t c = C_TEXT;
                if(it->has_hdr) {
                    if(p >= it->h.offset && p < it->h.offset + VMS_HEADER_SIZE) c = (p == it->h.offset + 0x46 || p == it->h.offset + 0x47) ? C_ERR : C_WARN;
                    else if(p >= it->h.icons_offset && p < it->h.data_offset) c = RGB(120, 200, 255);
                }
                gfx_textf(104 + i * 36, y, c, "%02X", file_buf[p]);
                char ch[2] = { (char)(file_buf[p] >= 0x20 && file_buf[p] < 0x7f ? file_buf[p] : '.'), 0 };
                gfx_text(404 + i * 12, y, C_DIM, ch, 0);
            }
        }
        gfx_rect(0, 436, SCR_W, 32, C_BG);
        gfx_text(24, 440, C_DIM, M_HELP_HEX, 0);
        gfx_present();
        uint32_t k = ui_key();
        if(k & CONT_B) return;
        if(k & CONT_DPAD_UP) top--;
        if(k & CONT_DPAD_DOWN) top++;
        if(k & K_L) top -= lines;
        if(k & K_R) top += lines;
        if(top > max_top) top = max_top;
        if(top < 0) top = 0;
    }
}

static void screen_check(int s) {
    static vc_problem_t probs[64];
    static vc_entry_t list[VMU_MAX_FILES];
    char lines_buf[16][96], title[64];
    int n = vc_check(g_slot[s].img, probs, 64), nl = 0;
    int nf = vc_list(g_slot[s].img, list, VMU_MAX_FILES), frag = 0;
    for(int i = 0; i < nf && i < VMU_MAX_FILES; i++) frag += vc_fragmented(g_slot[s].img, list[i].slot);
    for(int i = 0; i < n && i < 64 && nl < 11; i++) {
        vc_entry_t e;
        const char *name = "?";
        if(probs[i].slot >= 0) { vc_parse_entry(g_slot[s].img, probs[i].slot, &e); name = e.name; }
        char *o = lines_buf[nl++];
        switch(probs[i].code) {
            case VMU_PROB_NOT_FORMATTED: snprintf(o, 96, "%s", M_P_NOT_FORMATTED); break;
            case VMU_PROB_ROOT_POS: snprintf(o, 96, M_P_ROOT_POS, probs[i].a); break;
            case VMU_PROB_DUP_NAME: snprintf(o, 96, M_P_DUP, name); break;
            case VMU_PROB_SIZE: snprintf(o, 96, M_P_SIZE, name, probs[i].a, probs[i].b); break;
            case VMU_PROB_SHARED_BLOCK: snprintf(o, 96, M_P_SHARED, name, probs[i].a); break;
            default: snprintf(o, 96, M_P_CHAIN, name); break;
        }
    }
    if(n > nl) snprintf(lines_buf[nl++], 96, "... (%d)", n);
    if(auto_mode) {
        alog("CHECK %s problems %d frag %d\n", store_slot_name(s), n, frag);
        if(!auto_show_until) return;
    }
    snprintf(title, sizeof(title), M_CHECK_TITLE, store_slot_name(s));
    for(;;) {
        int bx, by;
        draw_main();
        draw_box(600, 420, &bx, &by);
        gfx_text(bx + 20, by + 14, C_WARN, title, 0);
        if(n == 0) gfx_text(bx + 20, by + 50, C_OK, M_CHECK_OK, 0);
        for(int i = 0; i < nl; i++) gfx_text(bx + 20, by + 50 + i * 28, C_ERR, lines_buf[i], 560);
        gfx_textf(bx + 20, by + 420 - 64, C_TEXT, M_CHECK_FRAG, frag);
        gfx_text(bx + 20, by + 420 - 34, C_DIM, M_HELP_BACK, 0);
        gfx_present();
        if(ui_key() & (CONT_A | CONT_B)) return;
    }
}

/* ネットワークの様子 (START) */
static void screen_net(void) {
    char buf[96];
    for(;;) {
        int bx, by, y;
        draw_main();
        draw_box(600, 400, &bx, &by);
        gfx_text(bx + 20, by + 14, C_WARN, M_NET_TITLE, 0);
        y = by + 52;
#define NROW(label, c, ...) do { gfx_text(bx + 20, y, C_DIM, label, 170); snprintf(buf, sizeof(buf), __VA_ARGS__); \
                                 gfx_text(bx + 200, y, c, buf, 380); y += 28; } while(0)
        const char *st = g_net.state == NET_UP ? M_S_UP : g_net.state == NET_STARTING ? M_S_STARTING
                       : g_net.state == NET_ERROR ? M_S_ERROR : M_S_NONE;
        NROW(M_N_STATE, g_net.state == NET_UP ? C_OK : C_WARN, "%s", st);
        NROW(M_N_IP, C_TEXT, "%s", g_net.state == NET_UP ? g_net.ip : "-");
        NROW(M_N_MAC, C_TEXT, "%s", g_net.mac[0] ? g_net.mac : "-");
        NROW(M_N_URL, C_TEXT, "http://%s/", g_net.ip);
        NROW(M_N_DCLOAD, C_TEXT, "%s", g_net.dcload ? M_YES : M_NO);
        NROW(M_N_REQ, C_TEXT, "%u", g_net.requests);
        NROW(M_N_LAST, C_TEXT, "%s", g_net.last_client[0] ? g_net.last_client : "-");
        gfx_text(bx + 200, y, C_DIM, g_net.last_path, 380);
        y += 28;
        NROW(M_N_VER, C_TEXT, "%s", VERSION);
#undef NROW
        gfx_text(bx + 20, by + 400 - 92, C_DIM, M_N_PC, 560);
        gfx_text(bx + 20, by + 400 - 64, C_DIM, M_N_READONLY, 560);
        gfx_text(bx + 20, by + 400 - 34, C_DIM, M_HELP_BACK, 0);
        gfx_present();
        if(ui_key() & (CONT_A | CONT_B | CONT_START)) return;
    }
}

static void menu_file(void) {
    item_t *it = cur_item();
    if(!it) return;
    const char *labels[4] = { M_M_COPY, M_M_DELETE, M_M_INFO, M_M_HEX };
    int en[4] = { 1, 1, 1, it->readable };
    char l1[128];
    switch(ui_menu(it->e.name, labels, en, 4)) {
        case 0: {
            if(it->e.copy_protected) { ui_dialog(C_WARN, M_PROTECTED_NO, it->e.name, 0); break; }
            vc_entry_t e = it->e;
            int dst = ui_pick_slot(cur_slot);
            if(dst < 0) break;
            int r = act_copy(cur_slot, &e, dst, 1);
            if(r != 0) after_write(r);
            break;
        }
        case 1: {
            vc_entry_t e = it->e;
            snprintf(l1, sizeof(l1), M_DELETE_CONFIRM, e.name);
            if(ui_confirm(l1, NULL)) after_write(act_delete(cur_slot, &e));
            break;
        }
        case 2: screen_info(it); break;
        case 3: screen_hex(it); break;
        default: break;
    }
}

static void menu_vmu(void) {
    store_slot_t *sl = &g_slot[cur_slot];
    if(!sl->present || !sl->loaded) return;
    char title[48], l1[128], l2[128];
    int fmt = vc_root_ok(sl->img);
    const char *labels[5] = { M_M_WHOLE, M_M_DEFRAG, M_M_CHECK, M_M_UNDO, M_M_FORMAT };
    int en[5] = { fmt, fmt, 1, store_can_undo(cur_slot), 1 };
    snprintf(title, sizeof(title), M_VMU_MENU, store_slot_name(cur_slot));
    switch(ui_menu(title, labels, en, 5)) {
        case 0: {
            int dst = ui_pick_slot(cur_slot), skipped = 0;
            if(dst < 0) break;
            snprintf(l1, sizeof(l1), M_WHOLE_CONFIRM, store_slot_name(cur_slot), store_slot_name(dst));
            snprintf(l2, sizeof(l2), M_WHOLE_CONFIRM2, store_slot_name(dst));
            if(!ui_confirm(l1, l2)) break;
            int r = act_whole(cur_slot, dst, &skipped);
            if(r >= 0 && skipped) {
                snprintf(l2, sizeof(l2), M_WHOLE_SKIPPED, skipped);
                ui_message(M_DONE, l2);
            } else after_write(r);
            break;
        }
        case 1: {
            static vc_entry_t list[VMU_MAX_FILES];
            int nf = vc_list(sl->img, list, VMU_MAX_FILES), frag = 0;
            for(int i = 0; i < nf && i < VMU_MAX_FILES; i++) frag += vc_fragmented(sl->img, list[i].slot);
            if(!frag) { ui_message(M_DEFRAG_NONE, NULL); break; }
            uint8_t *work = store_work(cur_slot);
            int r = vc_defragment(work);
            if(r < 0) { ui_error(r); break; }
            snprintf(l1, sizeof(l1), M_DEFRAG_CONFIRM, store_changed_blocks(cur_slot, work));
            if(ui_confirm(l1, NULL)) after_write(commit(cur_slot, work));
            break;
        }
        case 2: screen_check(cur_slot); break;
        case 3:
            snprintf(l1, sizeof(l1), M_UNDO_CONFIRM, store_slot_name(cur_slot));
            if(ui_confirm(l1, NULL)) after_write(act_undo(cur_slot));
            break;
        case 4:
            snprintf(l1, sizeof(l1), M_FORMAT_CONFIRM, store_slot_name(cur_slot));
            if(ui_confirm(l1, NULL) && ui_confirm(M_FORMAT_CONFIRM2, NULL)) after_write(act_format(cur_slot));
            break;
        default: break;
    }
}

/* ---------------- 自動実行 (Flycast での確認用) ---------------- */

static int slot_arg(const char *s) {
    if(s && (s[0] | 32) >= 'a' && (s[0] | 32) <= 'd' && (s[1] == '1' || s[1] == '2')) return ((s[0] | 32) - 'a') * 2 + s[1] - '1';
    return -1;
}

/* 命令: copy <元> <名前> <先> | delete <slot> <名前> | defrag <slot> | whole <元> <先> | format <slot>
 *       undo <slot> | check <slot> | select <slot> | sort <0-3> | down <n> | info | hex | wait <ms> */
static void run_auto(void) {
    static char script[2048];
    file_t f = fs_open("/rd/auto", O_RDONLY);
    if(f == FILEHND_INVALID) return;
    ssize_t n = fs_read(f, script, sizeof(script) - 1);
    fs_close(f);
    script[n > 0 ? n : 0] = 0;
    auto_mode = 1;
    for(char *line = strtok(script, "\r\n"); line; line = strtok(NULL, "\r\n")) {
        char cmd[16] = "", a[16] = "", b[16] = "", c[16] = "";
        if(sscanf(line, "%15s %15s %15s %15s", cmd, a, b, c) < 1 || cmd[0] == '#') continue;
        store_poll();
        int r = 0, sa = slot_arg(a);
        if(!strcmp(cmd, "copy") || !strcmp(cmd, "delete")) {
            int src = sa;
            const char *name = b;
            vc_entry_t e;
            r = src < 0 ? ST_ERR_NO_VMU : load_slot(src);
            if(r == 0 && !vc_find(g_slot[src].img, name, &e)) r = VMU_ERR_NOT_FOUND;
            if(r == 0) r = !strcmp(cmd, "copy") ? act_copy(src, &e, slot_arg(c), 0) : act_delete(src, &e);
        } else if(!strcmp(cmd, "defrag")) r = load_slot(sa) < 0 ? ST_ERR_READ : act_defrag(sa);
        else if(!strcmp(cmd, "whole")) {
            int skipped = 0;
            r = load_slot(sa) < 0 ? ST_ERR_READ : act_whole(sa, slot_arg(b), &skipped);
            alog("AUTO whole skipped %d\n", skipped);
        } else if(!strcmp(cmd, "format")) r = act_format(sa);
        else if(!strcmp(cmd, "undo")) r = act_undo(sa);
        else if(!strcmp(cmd, "check")) { r = load_slot(sa); if(r == 0) screen_check(sa); }
        else if(!strcmp(cmd, "select")) { cur_slot = sa; cursor = 0; load_slot(sa); }
        else if(!strcmp(cmd, "sort")) sort_mode = atoi(a) & 3;
        else if(!strcmp(cmd, "down")) { ensure_items(); cursor += atoi(a); if(cursor >= n_items) cursor = n_items - 1; if(cursor < 0) cursor = 0; }
        else if(!strcmp(cmd, "wait")) {
            uint64_t end = now_ms() + (uint64_t)atoi(a);
            while(now_ms() < end) { draw_main(); gfx_present(); }
        } else if(!strcmp(cmd, "show")) {
            /* 画面を 2.5 秒出す: show file | vmu | info | hex | check */
            ensure_items();
            auto_show_until = now_ms() + 2500;
            if(!strcmp(a, "file")) menu_file();
            else if(!strcmp(a, "vmu")) menu_vmu();
            else if(!strcmp(a, "info") && cur_item()) screen_info(cur_item());
            else if(!strcmp(a, "hex") && cur_item()) screen_hex(cur_item());
            else if(!strcmp(a, "check")) screen_check(cur_slot);
            else if(!strcmp(a, "net")) screen_net();
            auto_show_until = 0;
        } else { alog("AUTO unknown %s\n", cmd); continue; }
        alog("AUTO %s %s %s %s -> %d\n", cmd, a, b, c, r);
    }
    alog("AUTO DONE\n");
    const int log_slot = 2;   /* B1 */
    if(load_slot(log_slot) == 0 && vc_root_ok(g_slot[log_slot].img)) {
        uint8_t ts[8], *work = store_work(log_slot);
        store_now_timestamp(ts);
        if(vc_write_file(work, "SMGRLOG", (const uint8_t *)auto_log, (size_t)auto_log_len, VMU_FILE_DATA, 0, ts, 0, 1) >= 0)
            commit(log_slot, work);
    }
    auto_mode = 0;
}

/* ---------------- 本体 ---------------- */

int main(int argc, char **argv) {
    (void)argc; (void)argv;
    gfx_init();
    net_start();
    printf("savemgr " VERSION "\n");
    store_poll();
    for(int s = 0; s < STORE_SLOTS; s++) if(g_slot[s].present) { cur_slot = s; break; }
    run_auto();
    for(;;) {
        uint32_t changed = store_poll();
        store_slot_t *sl = &g_slot[cur_slot];
        if(changed & (1u << cur_slot)) { cursor = 0; scroll = 0; }
        if(sl->present && !sl->loaded && !sl->load_error) load_slot(cur_slot);
        uint32_t k = pad_read();
        ensure_items();
        if(k & CONT_DPAD_LEFT) { cur_slot = (cur_slot + STORE_SLOTS - 1) % STORE_SLOTS; cursor = scroll = 0; }
        if(k & CONT_DPAD_RIGHT) { cur_slot = (cur_slot + 1) % STORE_SLOTS; cursor = scroll = 0; }
        if(k & CONT_DPAD_UP && cursor > 0) cursor--;
        if(k & CONT_DPAD_DOWN && cursor + 1 < n_items) cursor++;
        if(k & K_L) { cursor -= ROWS; if(cursor < 0) cursor = 0; }
        if(k & K_R) { cursor += ROWS; if(cursor >= n_items) cursor = n_items ? n_items - 1 : 0; }
        if(k & CONT_X) sort_mode = (sort_mode + 1) & 3;
        if(k & CONT_A) {
            if(sl->present && sl->load_error) { sl->load_error = 0; }
            else menu_file();
        }
        if(k & CONT_Y) menu_vmu();
        if(k & CONT_START) screen_net();
        draw_main();
        gfx_present();
    }
    return 0;
}
