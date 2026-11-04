/*
 * vmucore — VMU (128KB) イメージを RAM 上で操作する部品。KallistiOS に依存しない (PC でもビルドしてテストする)。
 *
 * 判定と書き込み結果は src/vmu.js / src/vms.js と同じにする: 同じイメージに同じ操作をすると同じ 128KB になる
 * (test/vmucore.test.js が PC 上で比べる)。
 *
 * ブロック 255 ルート、254 FAT、253〜241 ディレクトリ (13 ブロック、1 件 32 バイト)、0〜199 ユーザー領域。
 */
#ifndef VMUCORE_H
#define VMUCORE_H

#include <stddef.h>
#include <stdint.h>

#define VMU_BLOCK_SIZE  512
#define VMU_BLOCK_COUNT 256
#define VMU_IMAGE_SIZE  (VMU_BLOCK_SIZE * VMU_BLOCK_COUNT)
#define VMU_DIR_ENTRY   32
#define VMU_NAME_LEN    12
#define VMU_MAX_FILES   (13 * VMU_BLOCK_SIZE / VMU_DIR_ENTRY)   /* 208 */

#define VMU_FAT_FREE 0xfffc
#define VMU_FAT_END  0xfffa

#define VMU_FILE_NONE 0x00
#define VMU_FILE_DATA 0x33
#define VMU_FILE_GAME 0xcc

#define VMS_HEADER_SIZE 0x80
#define VMS_ICON_SIZE   512

/* 失敗の理由 (負の値で返す)。文言は呼ぶ側で用意する (vmucore_strerror は英語の短い説明) */
enum {
    VMU_OK = 0,
    VMU_ERR_NOT_FORMATTED = -1,   /* ルートブロックに 0x55 がない */
    VMU_ERR_BAD_NAME = -2,        /* 名前が 1〜12 文字の ASCII でない */
    VMU_ERR_EMPTY = -3,           /* 0 バイトのファイル */
    VMU_ERR_EXISTS = -4,          /* 同名のファイルがある (上書き指定なし) */
    VMU_ERR_GAME_EXISTS = -5,     /* ゲームは 1 つしか置けない */
    VMU_ERR_NO_GAME_SPACE = -6,   /* ゲーム用のブロック 0〜 の連続領域がない */
    VMU_ERR_NO_SPACE = -7,        /* 空きブロック不足 */
    VMU_ERR_DIR_FULL = -8,        /* ディレクトリに空きがない */
    VMU_ERR_BROKEN_CHAIN = -9,    /* FAT のつながりが壊れている */
    VMU_ERR_NOT_FOUND = -10,      /* ファイルがない */
    VMU_ERR_CHECK_FAILED = -11,   /* 整合性に問題があるので中止 (整理) */
    VMU_ERR_TOO_BIG = -12,        /* 出力先が小さい / 元のサイズを超える */
    VMU_ERR_BAD_DCI = -13,        /* DCI が短い・壊れている */
    VMU_ERR_BAD_ROOT = -14        /* ルートブロックの FAT / ディレクトリ位置がおかしい */
};

/* ディレクトリ 1 件 (slot はディレクトリ内の位置: ブロック 253 の先頭が 0) */
typedef struct {
    int slot;
    uint8_t type;
    uint8_t copy_protected;       /* 1 = コピー禁止 (0xFF) */
    uint16_t first_block;
    char name[VMU_NAME_LEN + 1];  /* 末尾の 0 / 空白は除いてある */
    uint8_t name_len;             /* 途中に 0 があっても数える (壊れた名前を vmu.js と同じに扱う) */
    uint8_t timestamp[8];         /* BCD: 世紀, 年, 月, 日, 時, 分, 秒, 曜日 (0=月曜) */
    uint16_t size_blocks;
    uint16_t header_offset;       /* ゲームは VMS ヘッダのあるブロック (普通 1)、データは 0 */
    uint8_t raw[VMU_DIR_ENTRY];
} vc_entry_t;

/* ルートブロックの主な値 */
typedef struct {
    int formatted;
    uint16_t root_block, fat_block, fat_size, dir_block, dir_size, user_blocks;
    uint8_t timestamp[8];         /* フォーマット日時 (VMU の識別にも使う) */
} vc_root_t;

/* VMS ヘッダ */
typedef struct {
    size_t offset;                /* ファイル先頭からの位置 */
    char description[17];         /* VMU の画面用 (Shift-JIS のまま、末尾の空白を除く) */
    char long_description[33];    /* 本体の画面用 */
    char app_id[17];
    uint16_t icon_count, anim_speed, eyecatch_type, crc;
    uint32_t data_size;
    uint16_t palette[16];         /* ARGB4444 */
    int valid;                    /* アイコン 1〜3 枚・アイキャッチ 0〜3 (ヘッダなしの生データと区別する目安) */
    size_t icons_offset, eyecatch_offset, data_offset;
} vms_header_t;

/* ---- ルート・FAT ---- */
void vc_get_root(const uint8_t *img, vc_root_t *r);
int vc_root_ok(const uint8_t *img);              /* フォーマット済みで FAT / ディレクトリ位置が範囲内 */
void vc_format(uint8_t *img, const uint8_t ts[8]);
uint16_t vc_get_fat(const uint8_t *img, int block);
void vc_set_fat(uint8_t *img, int block, uint16_t value);
int vc_chain(const uint8_t *img, int first, int max_blocks, uint8_t *blocks);   /* ブロック数 or VMU_ERR_BROKEN_CHAIN */
int vc_free_count(const uint8_t *img);
int vc_fix_root(uint8_t *img);                   /* ルートの位置 (0x44) を 255 にする。直したら 1 */

/* ---- ディレクトリ ---- */
int vc_dir_slots(const uint8_t *img);            /* ディレクトリの件数 (普通 208) */
size_t vc_dir_offset(const uint8_t *img, int slot);
void vc_parse_entry(const uint8_t *img, int slot, vc_entry_t *e);
int vc_list(const uint8_t *img, vc_entry_t *out, int max);   /* 使用中のファイル (ディレクトリ順) */
int vc_find(const uint8_t *img, const char *name, vc_entry_t *e);   /* 1 = あった */

/* ---- ファイル ---- */
/* 中身を out へ (size_blocks × 512 バイト)。バイト数 or 負のエラー */
int vc_read_file(const uint8_t *img, const vc_entry_t *e, uint8_t *out, size_t cap);
/* ファイルを書く。ts が NULL ならタイムスタンプ 0 (呼ぶ側で時計から作って渡す)。新しい slot or 負のエラー。失敗したらイメージは元のまま */
int vc_write_file(uint8_t *img, const char *name, const uint8_t *data, size_t len, uint8_t type,
                   int copy_protected, const uint8_t ts[8], uint16_t header_offset, int overwrite);
int vc_delete_file(uint8_t *img, int slot);
int vc_defragment(uint8_t *img);
int vc_fragmented(const uint8_t *img, int slot); /* 1 = 連続していない */
/* ディレクトリの並びを変える: slots[] の順に先頭から並べ、残りは元の順で後ろへ */
int vc_reorder(uint8_t *img, const int *slots, int n);

/* ---- 整合性 ---- */
enum {
    VMU_PROB_NOT_FORMATTED = 1,   /* a = 0 */
    VMU_PROB_ROOT_POS,            /* a = ルートの位置の値 */
    VMU_PROB_DUP_NAME,            /* a, b = スロット */
    VMU_PROB_SIZE,                /* a = ディレクトリのサイズ, b = FAT のブロック数 */
    VMU_PROB_SHARED_BLOCK,        /* a = ブロック, b = 先に使っていたファイルのスロット */
    VMU_PROB_CHAIN                /* a = 0 */
};
typedef struct {
    int code;
    int slot;                     /* 対象ファイル (-1 = イメージ全体) */
    int a, b;
} vc_problem_t;
int vc_check(const uint8_t *img, vc_problem_t *out, int max);   /* 問題の件数 (max を超えた分も数える) */

/* ---- VMS ヘッダ ---- */
size_t vms_header_position(const vc_entry_t *e);
int vms_parse_header(const uint8_t *file, size_t len, size_t offset, vms_header_t *h);   /* 1 = 読めた */
int vms_crc_range_valid(const vms_header_t *h, size_t len);
uint16_t vms_calc_crc(const uint8_t *file, const vms_header_t *h);
uint16_t vms_update_crc(uint8_t *file, const vms_header_t *h);

/* ---- DCI (ディレクトリ 1 件 + 4 バイトごとにバイト順を反転したデータ) ---- */
size_t vc_to_dci(const vc_entry_t *e, const uint8_t *data, size_t len, uint8_t *out);   /* 出力バイト数 = 32 + len */
typedef struct {
    uint8_t type, copy_protected;
    char name[VMU_NAME_LEN + 1];
    uint16_t header_offset, size_blocks;
    uint8_t timestamp[8];
    const uint8_t *swapped;       /* 入力内のデータ (まだ反転したまま) */
} vc_dci_t;
int vc_parse_dci(const uint8_t *dci, size_t len, vc_dci_t *out);
void vc_swap32(const uint8_t *src, uint8_t *dst, size_t len);

/* ---- その他 ---- */
void vc_encode_timestamp(uint8_t ts[8], int year, int month, int day, int hour, int min, int sec, int wday_mon0);
uint32_t vc_crc32(const uint8_t *p, size_t n);   /* イメージの版 (ETag) 用 */
const char *vmucore_strerror(int err);

#endif
