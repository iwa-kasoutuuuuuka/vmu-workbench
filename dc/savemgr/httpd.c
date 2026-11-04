/* httpd — HTTP の受け答え (説明は httpd.h) */
#include "httpd.h"
#include "vmucore.h"
#include "www.h"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *slot_names[HTTPD_SLOTS] = { "a1", "a2", "b1", "b2", "c1", "c2", "d1", "d2" };

static uint8_t img[VMU_IMAGE_SIZE];
static uint8_t file_buf[VMU_IMAGE_SIZE + 64];
static char body[160 * 1024];          /* JSON の組み立て */
static size_t body_len;
static int body_overflow;

/* ---------------- 送る ---------------- */

static int send_all(int fd, const void *p, size_t n) {
    const char *c = (const char *)p;
    while(n > 0) {
        int chunk = n > 16384 ? 16384 : (int)n;
        int r = httpd_send(fd, c, chunk);
        if(r <= 0) return -1;
        c += r;
        n -= (size_t)r;
    }
    return 0;
}

static const char *reason(int status) {
    switch(status) {
        case 200: return "OK";
        case 204: return "No Content";
        case 400: return "Bad Request";
        case 404: return "Not Found";
        case 405: return "Method Not Allowed";
        case 503: return "Service Unavailable";
        default: return "Error";
    }
}

static void respond(int fd, int head_only, int status, const char *ctype, const char *extra, const void *data, size_t len) {
    char h[512];
    int n = snprintf(h, sizeof(h),
                     "HTTP/1.1 %d %s\r\n"
                     "Content-Type: %s\r\n"
                     "Content-Length: %u\r\n"
                     "Access-Control-Allow-Origin: *\r\n"
                     "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n"
                     "Access-Control-Expose-Headers: ETag, Content-Disposition\r\n"
                     "Cache-Control: no-store\r\n"
                     "Connection: close\r\n"
                     "%s\r\n",
                     status, reason(status), ctype, (unsigned)len, extra ? extra : "");
    send_all(fd, h, (size_t)n);
    if(!head_only && len) send_all(fd, data, len);
}

/* ---------------- JSON ---------------- */

static void out(const char *fmt, ...) {
    va_list ap;
    if(body_len >= sizeof(body) - 1) { body_overflow = 1; return; }
    va_start(ap, fmt);
    int n = vsnprintf(body + body_len, sizeof(body) - body_len, fmt, ap);
    va_end(ap);
    if(n < 0 || (size_t)n >= sizeof(body) - body_len) { body_overflow = 1; body_len = sizeof(body) - 1; }
    else body_len += (size_t)n;
}

/* 文字列 (バイト列) を JSON に。0x80 以上は \u00XX (Latin-1 として) */
static void out_str(const char *s, size_t n) {
    out("\"");
    for(size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if(c == '"' || c == '\\') out("\\%c", c);
        else if(c < 0x20 || c >= 0x7f) out("\\u%04x", c);
        else out("%c", c);
    }
    out("\"");
}

static void out_hex(const char *s) {
    out("\"");
    for(const unsigned char *p = (const unsigned char *)s; *p; p++) out("%02x", *p);
    out("\"");
}

static void out_date(const uint8_t *ts) {
    if(!memcmp(ts, "\0\0\0\0\0\0\0", 7)) { out("null"); return; }
    out("\"%02x%02x-%02x-%02xT%02x:%02x:%02x\"", ts[0], ts[1], ts[2], ts[3], ts[4], ts[5], ts[6]);
}

static void error_json(int fd, int head_only, int status, const char *msg) {
    body_len = 0;
    out("{\"error\":");
    out_str(msg, strlen(msg));
    out("}\n");
    respond(fd, head_only, status, "application/json", NULL, body, body_len);
}

/* ---------------- 要求の解釈 ---------------- */

static int hexval(int c) {
    if(c >= '0' && c <= '9') return c - '0';
    if(c >= 'a' && c <= 'f') return c - 'a' + 10;
    if(c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* %XX と + を戻す */
static void url_decode(char *s) {
    char *o = s;
    for(char *p = s; *p; p++) {
        if(*p == '%' && hexval(p[1]) >= 0 && hexval(p[2]) >= 0) { *o++ = (char)(hexval(p[1]) * 16 + hexval(p[2])); p += 2; }
        else if(*p == '+') *o++ = ' ';
        else *o++ = *p;
    }
    *o = 0;
}

static int slot_index(const char *s, size_t n) {
    for(int i = 0; i < HTTPD_SLOTS; i++)
        if(n == 2 && (s[0] | 32) == slot_names[i][0] && s[1] == slot_names[i][1]) return i;
    return -1;
}

static const char *query_value(const char *query, const char *key, char *buf, size_t n) {
    size_t kl = strlen(key);
    for(const char *p = query; p && *p;) {
        if(!strncmp(p, key, kl) && p[kl] == '=') {
            const char *v = p + kl + 1;
            size_t len = strcspn(v, "&");
            if(len >= n) len = n - 1;
            memcpy(buf, v, len);
            buf[len] = 0;
            url_decode(buf);
            return buf;
        }
        p = strchr(p, '&');
        if(p) p++;
    }
    return NULL;
}

/* ---------------- API ---------------- */

static void api_info(int fd, int head_only) {
    char status[256];
    httpd_status_json(status, sizeof(status));
    body_len = 0;
    out("{\"app\":\"savemgr\",\"version\":\"" HTTPD_VERSION "\",%s,\"slots\":[", status);
    for(int s = 0; s < HTTPD_SLOTS; s++) {
        httpd_slot_t si;
        int r = httpd_slot(s, &si, img);
        out("%s{\"slot\":\"%s\",\"present\":%s", s ? "," : "", slot_names[s], si.present ? "true" : "false");
        if(si.present) {
            out(",\"readable\":%s", r == 0 && si.readable ? "true" : "false");
            if(r == 0 && si.readable) {
                int fmt = vc_root_ok(img);
                vc_root_t root;
                vc_get_root(img, &root);
                out(",\"formatted\":%s,\"etag\":\"%08lx\",\"volume\":\"", fmt ? "true" : "false", (unsigned long)si.crc);
                for(int i = 0; i < 8; i++) out("%02x", root.timestamp[i]);
                out("\"");
                if(fmt) out(",\"free\":%d,\"files\":%d", vc_free_count(img), vc_list(img, NULL, 0));
            }
        }
        out("}");
    }
    out("]}\n");
    respond(fd, head_only, 200, "application/json", NULL, body, body_len);
}

/* スロットを読む。失敗したら答えを返して -1 */
static int load_for(int fd, int head_only, int s, httpd_slot_t *si) {
    int r = httpd_slot(s, si, img);
    if(!si->present) { error_json(fd, head_only, 404, "no VMU in this slot"); return -1; }
    if(r != 0 || !si->readable) { error_json(fd, head_only, 503, "cannot read this VMU"); return -1; }
    return 0;
}

static void api_list(int fd, int head_only, int s) {
    static vc_entry_t list[VMU_MAX_FILES];
    httpd_slot_t si;
    char etag[48];
    if(load_for(fd, head_only, s, &si) < 0) return;
    snprintf(etag, sizeof(etag), "ETag: \"%08lx\"\r\n", (unsigned long)si.crc);
    int fmt = vc_root_ok(img);
    body_len = 0;
    body_overflow = 0;
    out("{\"slot\":\"%s\",\"etag\":\"%08lx\",\"formatted\":%s", slot_names[s], (unsigned long)si.crc, fmt ? "true" : "false");
    if(!fmt) { out(",\"files\":[]}\n"); respond(fd, head_only, 200, "application/json", etag, body, body_len); return; }
    int n = vc_list(img, list, VMU_MAX_FILES);
    if(n > VMU_MAX_FILES) n = VMU_MAX_FILES;
    out(",\"free\":%d,\"files\":[", vc_free_count(img));
    for(int i = 0; i < n; i++) {
        vc_entry_t *e = &list[i];
        vms_header_t h;
        out("%s{\"dirSlot\":%d,\"name\":", i ? "," : "", e->slot);
        out_str(e->name, e->name_len);
        out(",\"type\":\"%s\",\"typeByte\":%d,\"protected\":%s,\"firstBlock\":%d,\"blocks\":%d,\"headerOffset\":%d,\"date\":",
            e->type == VMU_FILE_GAME ? "game" : e->type == VMU_FILE_DATA ? "data" : "other", e->type,
            e->copy_protected ? "true" : "false", e->first_block, e->size_blocks, e->header_offset);
        out_date(e->timestamp);
        out(",\"fragmented\":%s", vc_fragmented(img, e->slot) ? "true" : "false");
        int len = vc_read_file(img, e, file_buf, sizeof(file_buf));
        if(len < 0) { out(",\"readable\":false}"); continue; }
        out(",\"readable\":true");
        if(vms_parse_header(file_buf, (size_t)len, vms_header_position(e), &h) && h.valid) {
            /* 説明は Shift-JIS なので 16 進で (descHex)。ASCII だけの人向けに desc も */
            out(",\"header\":true,\"desc\":");
            out_str(h.description, strlen(h.description));
            out(",\"descHex\":");
            out_hex(h.description);
            out(",\"longDesc\":");
            out_str(h.long_description, strlen(h.long_description));
            out(",\"longDescHex\":");
            out_hex(h.long_description);
            out(",\"appId\":");
            out_str(h.app_id, strlen(h.app_id));
            int crc_ok = vms_crc_range_valid(&h, (size_t)len) ? (vms_calc_crc(file_buf, &h) == h.crc ? 1 : 2) : 0;
            out(",\"icons\":%d,\"animSpeed\":%d,\"crc\":\"%s\"}", h.icon_count, h.anim_speed,
                crc_ok == 1 ? "ok" : crc_ok == 2 ? "bad" : "none");
        } else out(",\"header\":false}");
    }
    out("]}\n");
    if(body_overflow) { error_json(fd, head_only, 503, "listing too large"); return; }
    respond(fd, head_only, 200, "application/json", etag, body, body_len);
}

static void api_image(int fd, int head_only, int s) {
    httpd_slot_t si;
    char extra[160];
    if(load_for(fd, head_only, s, &si) < 0) return;
    snprintf(extra, sizeof(extra), "ETag: \"%08lx\"\r\nContent-Disposition: attachment; filename=\"vmu_%s.bin\"\r\n",
             (unsigned long)si.crc, slot_names[s]);
    respond(fd, head_only, 200, "application/octet-stream", extra, img, VMU_IMAGE_SIZE);
}

static void api_file(int fd, int head_only, int s, char *name, const char *query) {
    httpd_slot_t si;
    vc_entry_t e;
    char fmt[8] = "raw", extra[200], fname[40];
    if(load_for(fd, head_only, s, &si) < 0) return;
    url_decode(name);
    query_value(query, "fmt", fmt, sizeof(fmt));
    if(!vc_root_ok(img) || !vc_find(img, name, &e)) { error_json(fd, head_only, 404, "no such file"); return; }
    int len = vc_read_file(img, &e, file_buf, sizeof(file_buf));
    if(len < 0) { error_json(fd, head_only, 503, "file is broken (FAT chain)"); return; }
    /* ファイル名に使えない文字は _ に */
    size_t k = 0;
    for(int i = 0; i < e.name_len && k < sizeof(fname) - 5; i++) {
        unsigned char c = (unsigned char)e.name[i];
        fname[k++] = (c > 0x20 && c < 0x7f && c != '"' && c != '\\' && c != '/') ? (char)c : '_';
    }
    fname[k] = 0;
    if(!strcmp(fmt, "dci")) {
        static uint8_t dci[VMU_IMAGE_SIZE + VMU_DIR_ENTRY];
        size_t n = vc_to_dci(&e, file_buf, (size_t)len, dci);
        snprintf(extra, sizeof(extra), "ETag: \"%08lx\"\r\nContent-Disposition: attachment; filename=\"%s.dci\"\r\n", (unsigned long)si.crc, fname);
        respond(fd, head_only, 200, "application/octet-stream", extra, dci, n);
    } else if(!strcmp(fmt, "raw")) {
        snprintf(extra, sizeof(extra), "ETag: \"%08lx\"\r\nContent-Disposition: attachment; filename=\"%s.vms\"\r\n", (unsigned long)si.crc, fname);
        respond(fd, head_only, 200, "application/octet-stream", extra, file_buf, (size_t)len);
    } else error_json(fd, head_only, 400, "fmt must be raw or dci");
}

static void api_check(int fd, int head_only, int s) {
    static vc_problem_t probs[256];
    static const char *codes[] = { "", "not_formatted", "root_position", "duplicate_name", "size_mismatch", "shared_block", "broken_chain" };
    httpd_slot_t si;
    if(load_for(fd, head_only, s, &si) < 0) return;
    int n = vc_check(img, probs, 256);
    body_len = 0;
    out("{\"slot\":\"%s\",\"etag\":\"%08lx\",\"count\":%d,\"problems\":[", slot_names[s], (unsigned long)si.crc, n);
    for(int i = 0; i < n && i < 256; i++) {
        int c = probs[i].code >= 1 && probs[i].code <= 6 ? probs[i].code : 6;
        out("%s{\"code\":\"%s\",\"dirSlot\":%d,\"a\":%d,\"b\":%d}", i ? "," : "", codes[c], probs[i].slot, probs[i].a, probs[i].b);
    }
    out("]}\n");
    respond(fd, head_only, 200, "application/json", NULL, body, body_len);
}

/* ---------------- 1 つの接続 ---------------- */

void httpd_serve(int fd) {
    static char req[4096];
    int got = 0;
    /* ヘッダの終わり (空行) まで読む */
    while(got < (int)sizeof(req) - 1) {
        int r = httpd_recv(fd, req + got, (int)sizeof(req) - 1 - got);
        if(r <= 0) break;
        got += r;
        req[got] = 0;
        if(strstr(req, "\r\n\r\n") || strstr(req, "\n\n")) break;
    }
    req[got] = 0;
    char method[8] = "", target[1024] = "";
    if(sscanf(req, "%7s %1023s", method, target) < 2) {
        if(got > 0) error_json(fd, 0, 400, "bad request");
        httpd_log("?", "?", 400);
        return;
    }
    int head_only = !strcmp(method, "HEAD");
    char *query = strchr(target, '?');
    if(query) *query++ = 0;
    int status = 200;

    if(!strcmp(method, "OPTIONS")) {
        respond(fd, 0, 204, "text/plain", NULL, NULL, 0);
        status = 204;
    } else if(strcmp(method, "GET") && !head_only) {
        error_json(fd, 0, 405, "this version can only read (GET)");
        status = 405;
    } else if(!strcmp(target, "/") || !strcmp(target, "/index.html")) {
        respond(fd, head_only, 200, "text/html; charset=utf-8", NULL, www_index, www_index_len);
    } else if(!strcmp(target, "/api/info")) {
        api_info(fd, head_only);
    } else if(!strncmp(target, "/api/vmu/", 9)) {
        char *p = target + 9;
        size_t sl = strcspn(p, "/");
        int s = slot_index(p, sl);
        char *rest = p + sl;
        if(s < 0) { error_json(fd, head_only, 404, "slot must be a1..d2"); status = 404; }
        else if(!*rest || !strcmp(rest, "/")) api_list(fd, head_only, s);
        else if(!strcmp(rest, "/image")) api_image(fd, head_only, s);
        else if(!strcmp(rest, "/check")) api_check(fd, head_only, s);
        else if(!strncmp(rest, "/file/", 6) && rest[6]) api_file(fd, head_only, s, rest + 6, query);
        else { error_json(fd, head_only, 404, "not found"); status = 404; }
    } else {
        error_json(fd, head_only, 404, "not found");
        status = 404;
    }
    httpd_log(method, target, status);
}
