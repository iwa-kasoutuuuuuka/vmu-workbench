; DC_VMU 付属のデモ: 起動するたびに回数を数えてフラッシュに保存する (BIOS のフラッシュ書き込みを使う)
;   BIOS が必要: node cli.js run vmu.bin --bios <BIOS> --boot --save out.bin
; 回数は自分のファイルの 0x0600 (ブロック 3) の先頭バイト。画面の 1 行目に 2 進数で、2 行目に書き込みの結果 (0 = 成功) を表示
; MODE で BIOS に戻る
;
; BIOS 呼び出しの作法 (Marcus Comstedt の VMU 用サンプルと同じ): フラッシュの 0x100 / 0x110 / 0x120 / 0x130 / 0x1f0 に
; 「not1 ext,0 / jmpf 同じ番地」を置くと BIOS の同じ番地へ切り替わり、BIOS は終わるとフラッシュの直後の番地 (+5) に戻る
;   0x100 フラッシュ書き込み: RAM バンク 1 の 0x7d = バンク、0x7e/0x7f = 番地 (上位/下位)、0x80〜0xff = 128 バイト → ACC (0 = 成功)
;   0x1f0 BIOS に戻る

.equ COUNT_ADDR,0x0600
.equ COUNT,0x10
.equ PREV,0x11

.org 0x00
  jmpf main
.org 0x03
  reti
.org 0x0b
  reti
.org 0x13
  reti
.org 0x1b
  jmpf timer       ; ベースタイマー: BIOS の時計を進める
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
  clr1 p3int,1
  reti

.org 0x100
writeflash:
  not1 ext,0
  jmpf writeflash
  ret

.org 0x130
timer:
  push ie
  clr1 ie,7
  not1 ext,0
  jmpf timer
  pop ie
  reti

.org 0x1f0
goodbye:
  not1 ext,0
  jmpf goodbye

; ---- VMS ヘッダ ----
.org 0x200
  .byte "SAVE COUNTER    "
  .byte "DC_VMU flash save test          "
  .byte "DC_VMU          "
  .word 1,10,0,0,0,0
  .fill 20,0
.org 0x260
  .word 0xffff,0xf000,0,0,0,0,0,0,0,0,0,0,0,0,0,0
.org 0x280
  .fill 512,0x10

.org 0x500
main:
  set1 psw,1        ; RAM バンク 1 (BIOS から起動したときの状態。BIOS へ渡す 0x7d〜0xff もこのバンク)
  mov #0x80,vccr
  mov #0x09,mcr
  mov #1,xbnk
  call clear
  mov #0,xbnk
  call clear
  mov #0xff,PREV
  ; 回数を読む (LDF: FPR bit0 = バンク、TRH:TRL = 番地)
  mov #0,fpr
  mov #COUNT_ADDR>>8,trh
  mov #COUNT_ADDR&0xff,trl
  ldf
  inc acc
  st COUNT
  ; 書き込む 128 バイトを用意 (先頭 = 回数、残りは 0)
  mov #0,0x7d
  mov #COUNT_ADDR>>8,0x7e
  mov #COUNT_ADDR&0xff,0x7f
  mov #0x80,0x00   ; R0 = 0x80
  mov #128,b
fill:
  mov #0,@r0
  inc 0x00
  dbnz b,fill
  ld COUNT
  st 0x80
  call writeflash
  mov #0,xbnk       ; BIOS が XBNK を変えて戻ることがあるので選び直す
  ; 表示: 1 行目 = 回数、2 行目 = 結果
  st 0x186         ; 2 行目 (奇数行は +6)
  ld COUNT
  st 0x180
wait:
  ld p3
  bne PREV,changed
  br wait
changed:
  st PREV
  bn PREV,6,quit   ; MODE (0 = 押している)
  br wait
quit:
  jmp goodbye

; 今の XBNK の XRAM を 0 にする (BIOS のロゴを消す)
clear:
  mov #0x80,0x02
  mov #0x80,b
cl:
  mov #0,@r2
  inc 0x02
  dbnz b,cl
  ret

; 保存先 (ファイルの 4 ブロック目。0 で始まる)
.org COUNT_ADDR
  .fill 512,0
