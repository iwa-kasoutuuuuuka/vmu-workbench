/*
 * net — BBA の準備と HTTP サーバのスレッド (説明は net.h)。
 *
 * KOS の INIT_NET は使わない: INIT_NET だと IP が決まっていないとき DHCP を最大 60 秒待つため (直結ケーブルには DHCP がない)。
 * ここでは網の部品 (eth_init) を登録し、IP を先に入れてから net_init(0) を呼ぶ (IP が入っていると DHCP をしない)。
 * dcload-ip から起動したときは KOS と同じく dcload の IP を使い、dcload のコンソールとファイル (/pc/) を
 * fs_dclsocket で引き継ぐ。終わるとき (exit) の net_shutdown / fs_dclsocket_shutdown は KOS が呼ぶ。
 */
#include <kos.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <dc/fs_dclsocket.h>
#include "httpd.h"
#include "net.h"
#include "store.h"

net_status_t g_net;

void eth_init(void);                 /* KOS (hardware.c)。INIT_NET のときだけ KOS が呼ぶので自分で呼ぶ */
uint32_t _fs_dclsocket_get_ip(void); /* KOS (fs_dclsocket.c) */

/* ---- httpd の裏方 ---- */

int httpd_recv(int fd, void *buf, int len) { return (int)recv(fd, buf, (size_t)len, 0); }
int httpd_send(int fd, const void *buf, int len) { return (int)send(fd, buf, (size_t)len, 0); }

int httpd_slot(int s, httpd_slot_t *info, uint8_t *img) {
    int present = 0, readable = 0;
    uint32_t crc = 0;
    int r = store_snapshot(s, img, &present, &readable, &crc);
    info->present = present;
    info->readable = readable;
    info->crc = crc;
    return present ? r : 0;
}

void httpd_status_json(char *out, size_t n) {
    snprintf(out, n, "\"ip\":\"%s\",\"mac\":\"%s\",\"dcload\":%s,\"requests\":%u", g_net.ip, g_net.mac,
             g_net.dcload ? "true" : "false", g_net.requests);
}

static char cur_client[16];

void httpd_log(const char *method, const char *path, int status) {
    g_net.requests++;
    snprintf(g_net.last_client, sizeof(g_net.last_client), "%s", cur_client);
    snprintf(g_net.last_path, sizeof(g_net.last_path), "%s %s", method, path);
    printf("HTTP %s %s %s %d\n", cur_client, method, path, status);
}

/* ---- 準備 ---- */

static void set_addr(uint8_t out[4], uint32_t host_order) { net_ipv4_parse_address(host_order, out); }

static uint32_t parse_ip(const char *s) {
    unsigned a = 0, b = 0, c = 0, d = 0;
    sscanf(s, "%u.%u.%u.%u", &a, &b, &c, &d);
    return (a << 24) | (b << 16) | (c << 8) | d;
}

static int bring_up(void) {
    uint32_t ip = parse_ip(NET_IP);
    g_net.dcload = dcload_type == DCLOAD_TYPE_IP;
    if(g_net.dcload) {
        /* dcload の IP を使う (PC の dc-tool-ip はその IP と話す)。網を KOS に渡す間は dcload のコンソールを止める */
        union { uint32_t l; uint8_t b[4]; } d;
        d.l = _fs_dclsocket_get_ip();
        ip = ((uint32_t)d.b[3] << 24) | ((uint32_t)d.b[2] << 16) | ((uint32_t)d.b[1] << 8) | d.b[0];
        dbgio_disable();
    }
    eth_init();
    netif_t *nif;
    LIST_FOREACH(nif, net_get_if_list(), if_list) {
        set_addr(nif->ip_addr, ip);
        set_addr(nif->netmask, 0xffffff00);
        set_addr(nif->broadcast, (ip & 0xffffff00) | 0xff);
        set_addr(nif->gateway, (ip & 0xffffff00) | 1);
    }
    int r = net_init(0);
    if(g_net.dcload) {
        if(r == 0) {
            fs_dclsocket_init_console();
            if(!fs_dclsocket_init()) dbgio_dev_select("fs_dclsocket");
        }
        dbgio_enable();
    }
    if(r < 0 || !net_default_dev) return NET_NO_ADAPTER;
    /* ドライバが flashrom の設定で上書きしていても、こちらの IP に揃える */
    set_addr(net_default_dev->ip_addr, ip);
    const uint8_t *a = net_default_dev->ip_addr, *m = net_default_dev->mac_addr;
    snprintf(g_net.ip, sizeof(g_net.ip), "%d.%d.%d.%d", a[0], a[1], a[2], a[3]);
    snprintf(g_net.mac, sizeof(g_net.mac), "%02x:%02x:%02x:%02x:%02x:%02x", m[0], m[1], m[2], m[3], m[4], m[5]);
    return NET_UP;
}

static void *net_thread(void *arg) {
    (void)arg;
    g_net.state = bring_up();
    printf("net: %s ip %s mac %s%s\n", g_net.state == NET_UP ? "up" : "no adapter", g_net.ip, g_net.mac,
           g_net.dcload ? " (dcload)" : "");
    if(g_net.state != NET_UP) return NULL;

    int s = socket(PF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a;
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_port = htons(80);
    a.sin_addr.s_addr = htonl(INADDR_ANY);
    if(s < 0 || bind(s, (struct sockaddr *)&a, sizeof(a)) < 0 || listen(s, 4) < 0) {
        printf("net: cannot listen on port 80\n");
        g_net.state = NET_ERROR;
        return NULL;
    }
    for(;;) {
        struct sockaddr_in peer;
        socklen_t pl = sizeof(peer);
        int c = accept(s, (struct sockaddr *)&peer, &pl);
        if(c < 0) { thd_sleep(100); continue; }
        const uint8_t *p = (const uint8_t *)&peer.sin_addr.s_addr;
        snprintf(cur_client, sizeof(cur_client), "%d.%d.%d.%d", p[0], p[1], p[2], p[3]);
        httpd_serve(c);
        close(c);
    }
    return NULL;
}

void net_start(void) {
    g_net.state = NET_STARTING;
    snprintf(g_net.ip, sizeof(g_net.ip), "%s", NET_IP);
    thd_create(1, net_thread, NULL);
}
