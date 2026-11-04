/* gfx — 640x480 RGB565 の裏画面に描いて、まとめて表示する。文字は BIOS のフォント (Shift-JIS) */
#ifndef GFX_H
#define GFX_H

#include <stdint.h>

#define SCR_W 640
#define SCR_H 480
#define RGB(r, g, b) ((uint16_t)((((r) >> 3) << 11) | (((g) >> 2) << 5) | ((b) >> 3)))
#define FONT_H 24

extern uint16_t *gfx_fb;

void gfx_init(void);
void gfx_clear(uint16_t c);
void gfx_rect(int x, int y, int w, int h, uint16_t c);
void gfx_frame(int x, int y, int w, int h, uint16_t c);
int gfx_text_width(const char *s);
/* 文字を描いて幅 (px) を返す。max_px > 0 ならそこで切る (2 バイト文字の途中では切らない) */
int gfx_text(int x, int y, uint16_t fg, const char *s, int max_px);
int gfx_textf(int x, int y, uint16_t fg, const char *fmt, ...);
void gfx_text_center(int y, uint16_t fg, const char *s);
/* VMS アイコン (32x32、4bpp、ARGB4444 のパレット) を scale 倍で */
void gfx_icon(int x, int y, const uint8_t *icon, const uint16_t *palette, int scale);
void gfx_present(void);

#endif
