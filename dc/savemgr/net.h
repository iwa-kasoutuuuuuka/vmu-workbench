/* net — BBA を使えるようにして HTTP サーバ (httpd.c) を別のスレッドで動かす */
#ifndef NET_H
#define NET_H

#include <stdint.h>

enum { NET_OFF = 0, NET_STARTING, NET_UP, NET_NO_ADAPTER, NET_ERROR };

typedef struct {
    int state;
    int dcload;                 /* dcload-ip から起動した (IP は dcload のもの。/pc/ も使える) */
    char ip[16];
    char mac[18];
    unsigned requests;
    char last_client[16];
    char last_path[48];
} net_status_t;

extern net_status_t g_net;

/* 既定の IP (仕様の「決めること」#2: 直結ケーブルで PC が 192.168.10.1)。make NET_IP=... で変えられる */
#ifndef NET_IP
#define NET_IP "192.168.10.2"
#endif

void net_start(void);          /* すぐ戻る。準備は別のスレッドで */

#endif
