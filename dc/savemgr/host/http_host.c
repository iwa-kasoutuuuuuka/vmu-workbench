/*
 * httpd.c を PC で動かすテスト用サーバ (test/savemgr-http.test.js が使う)。
 *
 *   http_host <フォルダ> [ポート]      フォルダの a1.bin〜d2.bin を VMU として見せる (無いスロットは「挿さっていない」)
 *
 * ポート 0 (既定) なら空いているポートを使う。始めに "LISTENING <ポート>" を出す。ファイルは要求のたびに読み直す。
 */
#include "../httpd.h"
#include "../vmucore.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
typedef int socklen_t;
#define CLOSESOCK closesocket
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#define CLOSESOCK close
#endif

static const char *dir;
static const char *names[HTTPD_SLOTS] = { "a1", "a2", "b1", "b2", "c1", "c2", "d1", "d2" };

int httpd_recv(int fd, void *buf, int len) { return recv(fd, (char *)buf, len, 0); }
int httpd_send(int fd, const void *buf, int len) { return send(fd, (const char *)buf, len, 0); }

int httpd_slot(int s, httpd_slot_t *info, uint8_t *img) {
    static uint8_t tmp[VMU_IMAGE_SIZE + 1];
    char path[1024];
    snprintf(path, sizeof(path), "%s/%s.bin", dir, names[s]);
    memset(info, 0, sizeof(*info));
    FILE *f = fopen(path, "rb");
    if(!f) return 0;
    info->present = 1;
    size_t n = fread(tmp, 1, sizeof(tmp), f);
    fclose(f);
    if(n != VMU_IMAGE_SIZE) return -1;
    info->readable = 1;
    info->crc = vc_crc32(tmp, VMU_IMAGE_SIZE);
    if(img) memcpy(img, tmp, VMU_IMAGE_SIZE);
    return 0;
}

void httpd_status_json(char *out, size_t n) {
    snprintf(out, n, "\"ip\":\"127.0.0.1\",\"dcload\":false,\"host\":true");
}

void httpd_log(const char *method, const char *path, int status) {
    printf("REQ %s %s %d\n", method, path, status);
    fflush(stdout);
}

int main(int argc, char **argv) {
    if(argc < 2) { fprintf(stderr, "usage: http_host <dir> [port]\n"); return 2; }
    dir = argv[1];
    int port = argc > 2 ? atoi(argv[2]) : 0;
#ifdef _WIN32
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
#endif
    int s = (int)socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, (const char *)&one, sizeof(one));
    struct sockaddr_in a;
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_port = htons((unsigned short)port);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if(bind(s, (struct sockaddr *)&a, sizeof(a)) != 0 || listen(s, 8) != 0) { fprintf(stderr, "bind/listen failed\n"); return 1; }
    socklen_t al = sizeof(a);
    getsockname(s, (struct sockaddr *)&a, &al);
    printf("LISTENING %d\n", ntohs(a.sin_port));
    fflush(stdout);
    for(;;) {
        int c = (int)accept(s, NULL, NULL);
        if(c < 0) continue;
        httpd_serve(c);
        CLOSESOCK(c);
    }
}
