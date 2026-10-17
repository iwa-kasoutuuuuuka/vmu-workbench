; DC_VMU 付属のデモ ミニゲーム: 十字キーで 8x8 のブロックを動かす (上半分の画面だけ)
;   node cli.js asm examples/hello-vmu.s hello.vms     → ヘッダの CRC 込みで .vms を作る
;   node cli.js import vmu.bin hello.vms HELLO --game  → ミニゲームとして書き込む (ブロック 0 から)
;   node cli.js run vmu.bin --keys "1:right,1.5:" --png lcd.png
; BIOS 無しでも動くよう、BIOS 呼び出し (時計・フラッシュ書き込みなど) は使わない

.equ X,0x10       ; ブロックの列 (バイト単位 0〜5)
.equ Y,0x11       ; ブロックの行 (0〜8)
.equ PREV,0x12    ; 前回の P3 (0 = 押している)
.equ PAT,0x13     ; 描くパターン (0xff 描画 / 0 消去)
.equ ROW,0x14
.equ TMP,0x15

; ---- 割り込みベクタ (使わないので戻るだけ) ----
.org 0x00
  jmpf main
.org 0x03
  reti
.org 0x0b
  reti
.org 0x13
  reti
.org 0x1b
  reti
.org 0x23
  reti
.org 0x2b
  reti
.org 0x33
  reti
.org 0x3b
  reti
.org 0x43
  reti
.org 0x4b
  reti

; ---- VMS ヘッダ (ゲームファイルはブロック 1 = 0x200 から) ----
.org 0x200
  .byte "HELLO VMU       "
  .byte "DC_VMU demo - move with D-pad   "
  .byte "DC_VMU          "
  .word 1           ; アイコン 1 コマ
  .word 10          ; アニメ速度
  .word 0           ; アイキャッチ無し
  .word 0           ; CRC (asm コマンドが計算して入れる)
  .word 0,0         ; データサイズ
  .fill 20,0
.org 0x260
  .word 0xffff,0xf000,0xf0a0,0xf00f,0,0,0,0,0,0,0,0,0,0,0,0
.org 0x280
  .fill 128,0x11
  .fill 256,0x23
  .fill 128,0x11

; ---- 本体 ----
.org 0x500
main:
  mov #0x80,vccr    ; LCD オン
  mov #0x09,mcr     ; グラフィックモード
  mov #1,xbnk
  call clear
  mov #0,xbnk
  call clear
  mov #2,X
  mov #4,Y
  mov #0xff,PREV
loop:
  mov #0xff,PAT
  call draw
wait:
  ld p3
  bne PREV,changed
  br wait
changed:
  st PREV
  mov #0,PAT
  call draw
  bp PREV,3,nr      ; 右
  ld X
  be #5,nr
  inc X
nr:
  bp PREV,2,nl      ; 左
  ld X
  bz nl
  dec X
nl:
  bp PREV,0,nu      ; 上
  ld Y
  bz nu
  dec Y
nu:
  bp PREV,1,nd      ; 下
  ld Y
  be #8,nd
  inc Y
nd:
  jmp loop

; 今の XBNK の XRAM (0x180〜0x1ff) を 0 にする
clear:
  mov #0x80,0x02    ; R2 = 0x80 → @R2 は 0x180
  mov #0x80,b
cl:
  mov #0,@r2
  inc 0x02
  dbnz b,cl
  ret

; (X, Y) から 8 行ぶん PAT を書く
draw:
  mov #8,c
  ld Y
  st ROW
dr:
  ld ROW
  and #0xfe         ; (行/2)*0x10 = (行 & 0xfe) * 8
  rol
  rol
  rol
  st TMP
  ld ROW
  and #1
  bz even
  ld TMP
  add #6            ; 奇数行は 6 バイト後ろ
  st TMP
even:
  ld TMP
  add X
  add #0x80
  st 0x02
  ld PAT
  st @r2
  inc ROW
  dbnz c,dr
  ret
