/* store — 実機 VMU の読み書き (説明は store.h) */
#include <kos.h>
#include <string.h>
#include <time.h>
#include "store.h"

store_slot_t g_slot[STORE_SLOTS];

/* 画面のスレッドと HTTP のスレッドの両方から使うので、写しを変えるところは鍵をかける (同じスレッドなら重ねてかけられる) */
static mutex_t lock = RECURSIVE_MUTEX_INITIALIZER;
void store_lock(void) { mutex_lock(&lock); }
void store_unlock(void) { mutex_unlock(&lock); }

static uint8_t work_img[VMU_IMAGE_SIZE];
static uint8_t undo_img[VMU_IMAGE_SIZE];
static int undo_slot = -1;
static uint32_t undo_after_crc;     /* 取り消せるのは、書いた後に何も変わっていないときだけ */
static uint8_t check_buf[VMU_BLOCK_SIZE];

static const char *names[STORE_SLOTS] = { "A1", "A2", "B1", "B2", "C1", "C2", "D1", "D2" };

const char *store_slot_name(int s) { return s >= 0 && s < STORE_SLOTS ? names[s] : "--"; }

static maple_device_t *dev_of(int s) {
    maple_device_t *d = maple_enum_dev(s / 2, s % 2 + 1);
    return d && (d->info.functions & MAPLE_FUNC_MEMCARD) ? d : NULL;
}

uint32_t store_poll(void) {
    uint32_t changed = 0;
    store_lock();
    for(int s = 0; s < STORE_SLOTS; s++) {
        int p = dev_of(s) != NULL;
        if(p != g_slot[s].present) {
            changed |= 1u << s;
            g_slot[s].present = p;
            g_slot[s].loaded = 0;   /* 抜いたら写しは捨てる (別の VMU が挿さるかもしれない) */
            g_slot[s].load_error = 0;
            if(undo_slot == s) undo_slot = -1;
        }
    }
    store_unlock();
    return changed;
}

static int read_block(maple_device_t *d, int b, uint8_t *dst) {
    for(int retry = 0; retry < 3; retry++) if(vmu_block_read(d, (uint16_t)b, dst) == MAPLE_EOK) return 0;
    return -1;
}

static int load_locked(int s, store_progress_t cb, void *ctx) {
    maple_device_t *d = dev_of(s);
    store_slot_t *sl = &g_slot[s];
    sl->loaded = 0;
    if(!d) return sl->load_error = ST_ERR_NO_VMU;
    for(int b = 0; b < VMU_BLOCK_COUNT; b++) {
        if(read_block(d, b, sl->img + b * VMU_BLOCK_SIZE) != 0) return sl->load_error = ST_ERR_READ;
        if(cb && (b & 15) == 15) cb(b + 1, VMU_BLOCK_COUNT, ctx);
    }
    sl->crc = vc_crc32(sl->img, VMU_IMAGE_SIZE);
    sl->loaded = 1;
    return sl->load_error = 0;
}

int store_load(int s, store_progress_t cb, void *ctx) {
    store_lock();
    int r = load_locked(s, cb, ctx);
    store_unlock();
    return r;
}

int store_ensure(int s, store_progress_t cb, void *ctx) {
    store_lock();
    int r = !g_slot[s].present ? ST_ERR_NO_VMU : g_slot[s].loaded ? 0 : load_locked(s, cb, ctx);
    store_unlock();
    return r;
}

int store_snapshot(int s, uint8_t *img, int *present, int *readable, uint32_t *crc) {
    store_lock();
    *present = g_slot[s].present;
    *readable = 0;
    int r = *present ? (g_slot[s].loaded ? 0 : load_locked(s, NULL, NULL)) : ST_ERR_NO_VMU;
    if(r == 0) {
        *readable = 1;
        *crc = g_slot[s].crc;
        if(img) memcpy(img, g_slot[s].img, VMU_IMAGE_SIZE);
    }
    store_unlock();
    return r;
}

uint8_t *store_work(int s) {
    memcpy(work_img, g_slot[s].img, VMU_IMAGE_SIZE);
    return work_img;
}

/* 書く順番: ユーザー領域など → FAT (254) → ディレクトリ (253〜241) → ルート (255) */
static int order_blocks(const uint8_t *old_img, const uint8_t *new_img, uint8_t *out) {
    int n = 0;
#define DIFF(b) (memcmp(old_img + (b) * VMU_BLOCK_SIZE, new_img + (b) * VMU_BLOCK_SIZE, VMU_BLOCK_SIZE) != 0)
    for(int b = 0; b < 241; b++) if(DIFF(b)) out[n++] = (uint8_t)b;
    if(DIFF(254)) out[n++] = 254;
    for(int b = 253; b >= 241; b--) if(DIFF(b)) out[n++] = (uint8_t)b;
    if(DIFF(255)) out[n++] = 255;
#undef DIFF
    return n;
}

int store_changed_blocks(int s, const uint8_t *new_img) {
    uint8_t order[VMU_BLOCK_COUNT];
    return order_blocks(g_slot[s].img, new_img, order);
}

static int commit_locked(int s, const uint8_t *new_img, store_progress_t cb, void *ctx) {
    static uint8_t before[VMU_IMAGE_SIZE];
    uint8_t order[VMU_BLOCK_COUNT];
    store_slot_t *sl = &g_slot[s];
    maple_device_t *d = dev_of(s);
    if(!d) return ST_ERR_NO_VMU;
    if(!sl->loaded) return ST_ERR_NOT_LOADED;
    int n = order_blocks(sl->img, new_img, order);
    if(n == 0) return 0;

    /* 差し替え検出: 今の VMU のルートブロックが写しと同じか */
    if(read_block(d, 255, check_buf) != 0) return ST_ERR_READ;
    if(memcmp(check_buf, sl->img + 255 * VMU_BLOCK_SIZE, VMU_BLOCK_SIZE) != 0) {
        sl->loaded = 0;
        return ST_ERR_REPLACED;
    }

    memcpy(before, sl->img, VMU_IMAGE_SIZE);
    for(int i = 0; i < n; i++) {
        int b = order[i], ok = 0;
        const uint8_t *src = new_img + b * VMU_BLOCK_SIZE;
        for(int retry = 0; retry < 3 && !ok; retry++) {
            if(vmu_block_write(d, (uint16_t)b, src) != MAPLE_EOK) continue;
            ok = read_block(d, b, check_buf) == 0 && memcmp(check_buf, src, VMU_BLOCK_SIZE) == 0;
        }
        if(!ok) {
            /* どこまで書けたか分からないので写しは捨てる。書く前のイメージは取り消し用に残す */
            sl->loaded = 0;
            memcpy(undo_img, before, VMU_IMAGE_SIZE);
            undo_slot = -1;
            return ST_ERR_WRITE;
        }
        if(cb) cb(i + 1, n, ctx);
    }
    /* Flycast は最後の書き込みの末尾をファイルに保存しないことがあるので、最後のブロックをもう一度書いて確定させる */
    vmu_block_write(d, order[n - 1], new_img + order[n - 1] * VMU_BLOCK_SIZE);

    memcpy(undo_img, before, VMU_IMAGE_SIZE);
    memcpy(sl->img, new_img, VMU_IMAGE_SIZE);
    sl->crc = vc_crc32(sl->img, VMU_IMAGE_SIZE);
    undo_slot = s;
    undo_after_crc = sl->crc;
    return n;
}

int store_commit(int s, const uint8_t *new_img, store_progress_t cb, void *ctx) {
    store_lock();
    int r = commit_locked(s, new_img, cb, ctx);
    store_unlock();
    return r;
}

int store_can_undo(int s) {
    return undo_slot == s && g_slot[s].loaded && g_slot[s].crc == undo_after_crc;
}

int store_undo(int s, store_progress_t cb, void *ctx) {
    static uint8_t img[VMU_IMAGE_SIZE];
    if(!store_can_undo(s)) return ST_ERR_NO_UNDO;
    memcpy(img, undo_img, VMU_IMAGE_SIZE);   /* commit が undo_img を書き換えるので写してから */
    return store_commit(s, img, cb, ctx);
}

void store_now_timestamp(uint8_t ts[8]) {
    /* DC の時計は本体で設定した時刻をそのまま持つ (時差なし) ので gmtime で読む */
    time_t t = time(NULL);
    struct tm tm;
    gmtime_r(&t, &tm);
    vc_encode_timestamp(ts, tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec,
                         (tm.tm_wday + 6) % 7);
}
