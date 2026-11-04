/*
 * store — 実機の VMU (A1〜D2) とその RAM 上の写し。画面と (後で) ネットワークの両方がここを通して読み書きする。
 *
 * 読むときは 256 ブロックを丸ごと RAM に読む。書くときは RAM 上で新しいイメージを組み立てて store_commit に渡すと、
 * 変わったブロックだけを データ → FAT → ディレクトリ → ルート の順に書き、1 ブロックずつ読み直して確かめる。
 * 書く前のイメージは 1 回分だけ取り消し用に残す。
 */
#ifndef STORE_H
#define STORE_H

#include <stdint.h>
#include "vmucore.h"

#define STORE_SLOTS 8

enum {
    ST_ERR_NO_VMU = -100,       /* 挿さっていない */
    ST_ERR_READ = -101,         /* 読めない */
    ST_ERR_WRITE = -102,        /* 書けない / 読み直すと違う */
    ST_ERR_REPLACED = -103,     /* 書く直前に VMU が差し替えられた (ルートブロックが違う) */
    ST_ERR_NOT_LOADED = -104,
    ST_ERR_NO_UNDO = -105
};

typedef struct {
    int present;                /* VMU が挿さっている */
    int loaded;                 /* img が VMU と同じ */
    int load_error;             /* 最後の読み込みの結果 (0 か負) */
    uint32_t crc;               /* img の CRC32 (版。PC からの書き込みの ETag にも使う) */
    uint8_t img[VMU_IMAGE_SIZE];
} store_slot_t;

typedef void (*store_progress_t)(int done, int total, void *ctx);

extern store_slot_t g_slot[STORE_SLOTS];

const char *store_slot_name(int s);           /* "A1" など */
uint32_t store_poll(void);                    /* 抜き差しを調べる。変わったスロットのビット */
int store_load(int s, store_progress_t cb, void *ctx);
int store_ensure(int s, store_progress_t cb, void *ctx);   /* 読んでいなければ読む */
/* 書く。new_img は呼んだ後も呼ぶ側のもの。成功したら g_slot[s].img = new_img */
int store_commit(int s, const uint8_t *new_img, store_progress_t cb, void *ctx);
int store_changed_blocks(int s, const uint8_t *new_img);   /* 書くことになるブロック数 */
uint8_t *store_work(int s);                   /* 編集用の作業イメージ (slot s の写し)。1 つだけ */
int store_can_undo(int s);
int store_undo(int s, store_progress_t cb, void *ctx);
void store_now_timestamp(uint8_t ts[8]);      /* DC の時計から */
/* HTTP のスレッドから: 様子と中身の写し (読んでいなければ読む)。0 か負のエラー */
int store_snapshot(int s, uint8_t *img, int *present, int *readable, uint32_t *crc);
void store_lock(void);
void store_unlock(void);

#endif
