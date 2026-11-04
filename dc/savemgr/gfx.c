/* gfx — 裏画面への描画 (説明は gfx.h) */
#include <kos.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include "gfx.h"

static uint16_t fb_buf[SCR_W * SCR_H] __attribute__((aligned(32)));
uint16_t *gfx_fb = fb_buf;

void gfx_init(void) {
    vid_set_mode(DM_640x480, PM_RGB565);
    bfont_set_encoding(BFONT_CODE_SJIS);
}

void gfx_clear(uint16_t c) {
    uint32_t v = c | ((uint32_t)c << 16), *p = (uint32_t *)fb_buf;
    for(int i = 0; i < SCR_W * SCR_H / 2; i++) p[i] = v;
}

void gfx_rect(int x, int y, int w, int h, uint16_t c) {
    if(x < 0) { w += x; x = 0; }
    if(y < 0) { h += y; y = 0; }
    if(x + w > SCR_W) w = SCR_W - x;
    if(y + h > SCR_H) h = SCR_H - y;
    for(int j = 0; j < h; j++) {
        uint16_t *p = fb_buf + (y + j) * SCR_W + x;
        for(int i = 0; i < w; i++) p[i] = c;
    }
}

void gfx_frame(int x, int y, int w, int h, uint16_t c) {
    gfx_rect(x, y, w, 2, c);
    gfx_rect(x, y + h - 2, w, 2, c);
    gfx_rect(x, y, 2, h, c);
    gfx_rect(x + w - 2, y, 2, h, c);
}

static int is_lead(unsigned char c) { return (c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc); }

int gfx_text_width(const char *s) {
    int w = 0;
    for(const unsigned char *p = (const unsigned char *)s; *p;) {
        if(is_lead(*p) && p[1]) { w += 24; p += 2; }
        else { w += 12; p++; }
    }
    return w;
}

int gfx_text(int x, int y, uint16_t fg, const char *s, int max_px) {
    char buf[256];
    int w = 0, n = 0, limit = max_px > 0 ? max_px : SCR_W - x;
    for(const unsigned char *p = (const unsigned char *)s; *p && n < (int)sizeof(buf) - 2;) {
        int cw = is_lead(*p) && p[1] ? 24 : 12, cb = cw == 24 ? 2 : 1;
        if(w + cw > limit) break;
        /* 表示できない制御文字は空白に */
        if(cb == 1 && *p < 0x20) buf[n++] = ' ';
        else { memcpy(buf + n, p, (size_t)cb); n += cb; }
        p += cb;
        w += cw;
    }
    buf[n] = 0;
    if(y < 0 || y + FONT_H > SCR_H || x < 0) return w;
    bfont_draw_str_ex(fb_buf + y * SCR_W + x, SCR_W, fg, 0, 16, false, buf);
    return w;
}

int gfx_textf(int x, int y, uint16_t fg, const char *fmt, ...) {
    char buf[256];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    return gfx_text(x, y, fg, buf, 0);
}

void gfx_text_center(int y, uint16_t fg, const char *s) {
    int w = gfx_text_width(s);
    if(w > SCR_W - 32) w = SCR_W - 32;
    gfx_text((SCR_W - w) / 2, y, fg, s, SCR_W - 32);
}

static uint16_t blend(uint16_t bg, uint16_t argb) {
    int a = (argb >> 12) & 15;
    int r = (argb >> 8) & 15, g = (argb >> 4) & 15, b = argb & 15;
    int br = (bg >> 11) & 31, bgg = (bg >> 5) & 63, bb = bg & 31;
    int or_ = (r * 31 / 15 * a + br * (15 - a)) / 15;
    int og = (g * 63 / 15 * a + bgg * (15 - a)) / 15;
    int ob = (b * 31 / 15 * a + bb * (15 - a)) / 15;
    return (uint16_t)((or_ << 11) | (og << 5) | ob);
}

void gfx_icon(int x, int y, const uint8_t *icon, const uint16_t *palette, int scale) {
    for(int i = 0; i < 32 * 32; i++) {
        int c = icon[i >> 1];
        c = (i & 1) ? (c & 15) : (c >> 4);
        uint16_t argb = palette[c];
        if(((argb >> 12) & 15) == 0) continue;
        int px = x + (i & 31) * scale, py = y + (i >> 5) * scale;
        for(int dy = 0; dy < scale; dy++)
            for(int dx = 0; dx < scale; dx++) {
                int X = px + dx, Y = py + dy;
                if(X < 0 || Y < 0 || X >= SCR_W || Y >= SCR_H) continue;
                uint16_t *p = fb_buf + Y * SCR_W + X;
                *p = blend(*p, argb);
            }
    }
}

void gfx_present(void) {
    vid_waitvbl();
    sq_cpy(vram_s, fb_buf, sizeof(fb_buf));
}
