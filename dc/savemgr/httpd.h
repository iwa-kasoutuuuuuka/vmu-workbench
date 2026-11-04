/*
 * httpd — セーブマネージャの HTTP の受け答え (仕様 docs/dc-savemgr-spec.md の 6 章)。
 * ソケットと VMU の中身は「裏方」(DC では net.c、PC のテストでは host/http_host.c) が用意する。
 * ここは KallistiOS に依存しないので PC でもビルドしてテストする。
 *
 * 段階 3 は読むだけ: GET / (簡易 Web ページ)、/api/info、/api/vmu/{slot}、/api/vmu/{slot}/image、
 * /api/vmu/{slot}/file/{名前}?fmt=raw|dci、/api/vmu/{slot}/check。書き込み (PUT など) は 405。
 */
#ifndef HTTPD_H
#define HTTPD_H

#include <stddef.h>
#include <stdint.h>

#define HTTPD_SLOTS 8
#define HTTPD_VERSION "0.3"

typedef struct {
    int present;            /* VMU が挿さっている */
    int readable;           /* 読めた (img が有効) */
    uint32_t crc;           /* img の CRC32 (ETag) */
} httpd_slot_t;

/* ---- 裏方が用意する関数 ---- */
int httpd_recv(int fd, void *buf, int len);          /* 0 = 閉じた、負 = エラー */
int httpd_send(int fd, const void *buf, int len);    /* 全部送れたら len */
/* スロット s の様子。img が NULL でなければ中身 (128KB) も写す (読んでいなければ読む) */
int httpd_slot(int s, httpd_slot_t *info, uint8_t *img);
/* /api/info に足す JSON のメンバー ("ip":"...","dcload":false など、先頭のカンマなし) */
void httpd_status_json(char *out, size_t n);
void httpd_log(const char *method, const char *path, int status);

/* 1 つの接続を処理する (要求を 1 つ読んで答える。Connection: close) */
void httpd_serve(int fd);

#endif
