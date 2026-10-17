// VMU エミュレーターのテスト。機械語は資料 (mc.pp.se/dc/vms/cpu.html) のコード欄のビット配置から直接組み立てる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VmuEmulator, FLASH_SIZE, looksLikeBios, LCD_W } from '../src/vmuemu.js';

/** フラッシュの 0 番地からプログラムを置いた (BIOS 無しの) エミュレーター */
function emu(...bytes) {
  const flash = new Uint8Array(FLASH_SIZE);
  flash.set(bytes.flat(Infinity), 0);
  return new VmuEmulator({ flash });
}
const run = (e, n) => {
  for (let i = 0; i < n; i++) e.step();
  return e;
};
const acc = (e) => e.read(0x100);
const psw = (e) => e.read(0x101);
const CY = 0x80, AC = 0x40, OV = 0x04;

// 命令の組み立て (資料のビット配置)
const MOVd = (d9, i8) => [0x22 | (d9 >> 8), d9 & 0xff, i8]; // 0010001d8 d7..d0 i7..i0
const LDd = (d9) => [0x02 | (d9 >> 8), d9 & 0xff];
const STd = (d9) => [0x12 | (d9 >> 8), d9 & 0xff];
const ADDi = (i) => [0x81, i];
const SUBi = (i) => [0xa1, i];
const ADDCi = (i) => [0x91, i];
const SET1 = (d9, b) => [0xe8 | ((d9 >> 8) << 4) | b, d9 & 0xff]; // 111d81b2b1b0
const CLR1 = (d9, b) => [0xc8 | ((d9 >> 8) << 4) | b, d9 & 0xff];
const BP = (d9, b, r) => [0x68 | ((d9 >> 8) << 4) | b, d9 & 0xff, r & 0xff];
const CALL = (a12) => [0x08 | ((a12 >> 11) << 4) | ((a12 >> 8) & 7), a12 & 0xff]; // 000a111a10a9a8
const JMP = (a12) => [0x28 | ((a12 >> 11) << 4) | ((a12 >> 8) & 7), a12 & 0xff];
const JMPF = (a16) => [0x21, a16 >> 8, a16 & 0xff];
const BR = (r) => [0x01, r & 0xff];
const RET = [0xa0];
const RETI = [0xb0];
const ACCA = 0x100, B = 0x102, C = 0x103, TRL = 0x104, TRH = 0x105, IE = 0x108, EXT = 0x10d;

test('MOV / LD / ST と ADD のフラグ (CY / AC / OV / P)', () => {
  const e = run(emu(MOVd(ACCA, 0x7f), ADDi(0x01)), 2);
  assert.equal(acc(e), 0x80);
  assert.equal(psw(e) & (CY | AC | OV), AC | OV); // 符号付きあふれ・下位桁上がり
  assert.equal(psw(e) & 1, 1); // パリティ (1 の数が奇数)
  const e2 = run(emu(MOVd(ACCA, 0xf0), ADDi(0x20)), 2);
  assert.equal(acc(e2), 0x10);
  assert.equal(psw(e2) & CY, CY);
  const e3 = run(emu(MOVd(ACCA, 0x10), SUBi(0x20), ADDCi(0x00)), 2);
  assert.equal(acc(e3), 0xf0);
  assert.equal(psw(e3) & CY, CY); // 借り
  run(e3, 1); // ADDC #0 で CY が加わる
  assert.equal(acc(e3), 0xf1);
  const e4 = run(emu(MOVd(0x050, 0x33), LDd(0x050), STd(0x051)), 3);
  assert.equal(acc(e4), 0x33);
  assert.equal(e4.read(0x051), 0x33);
});

test('CALL a12 / RET はスタックに下位→上位の順で積む', () => {
  // 0: CALL 0x010 / 2: MOV #1,ACC ... 0x010: MOV #0x55,B / RET
  const flash = [...CALL(0x010), ...MOVd(ACCA, 1)];
  const e = emu(flash);
  e.flash.set([...MOVd(B, 0x55), ...RET], 0x010);
  run(e, 1);
  assert.equal(e.pc, 0x010);
  assert.equal(e.ram[0][0x80], 0x02); // 戻り先の下位
  assert.equal(e.ram[0][0x81], 0x00); // 上位 (先頭に近い方が後)
  run(e, 3);
  assert.equal(e.read(B), 0x55);
  assert.equal(acc(e), 1);
  assert.equal(e.read(0x106), 0x7f); // SP が戻る
});

test('a11 が立った CALL / JMP (0x18〜 / 0x38〜) と JMP の上位 4 ビット保持', () => {
  const e = emu(JMP(0x834));
  assert.deepEqual(JMP(0x834), [0x38, 0x34]);
  run(e, 1);
  assert.equal(e.pc, 0x834);
  assert.deepEqual(CALL(0x900), [0x19, 0x00]);
});

test('ビット命令 SET1 / CLR1 / BP (d8 で SFR 側)', () => {
  const e = run(emu(MOVd(ACCA, 0), SET1(ACCA, 3), SET1(0x020, 7), CLR1(ACCA, 3)), 3);
  assert.equal(acc(e), 0x08);
  assert.equal(e.read(0x020), 0x80);
  run(e, 1);
  assert.equal(acc(e), 0);
  // BP: ビットが立っていれば分岐
  const b = emu(MOVd(ACCA, 0x04), BP(ACCA, 2, 3), MOVd(B, 1), MOVd(C, 2)); // MOV (3 バイト) を飛ばす
  run(b, 3);
  assert.equal(b.read(B), 0); // 飛ばされた
  assert.equal(b.read(C), 2);
});

test('間接アドレス @Ri (R0/R1 は RAM、R2/R3 は SFR 側)', () => {
  // RAM バンク 1 (BIOS 無しの起動状態) のセル 0 = R0
  const e = run(emu(MOVd(0x000, 0x40), [0x24, 0x77], MOVd(0x002, 0x02), [0x26, 0x99]), 4);
  assert.equal(e.read(0x040), 0x77); // MOV #0x77,@R0
  assert.equal(e.read(0x102), 0x99); // MOV #0x99,@R2 → 0x102 (B)
});

test('BE / BNE / DBNZ とループ', () => {
  // C を 5 回 DBNZ でまわす間に B を INC
  const prog = [...MOVd(C, 5), [0x63, 0x02], [0x53, 0x03, 0xfb], [0x31, 0x00, 0x00]]; // DBNZ は INC (2) + 自身 (3) 戻る
  const e = emu(prog);
  run(e, 1 + 5 * 2);
  assert.equal(e.read(B), 5);
  assert.equal(e.read(C), 0);
  // BE #i8: ACC == 0 → CY = 0、等しいので分岐
  const be = run(emu(MOVd(ACCA, 3), [0x31, 0x05, 0x02], MOVd(B, 1), MOVd(C, 1)), 2);
  assert.equal(psw(be) & CY, CY); // 3 < 5
  run(be, 1);
  assert.equal(be.read(B), 1); // 等しくないので分岐しない
});

test('MUL / DIV', () => {
  const m = run(emu(MOVd(ACCA, 0x12), MOVd(C, 0x34), MOVd(B, 0x56), [0x30]), 4);
  const v = 0x1234 * 0x56;
  assert.deepEqual([m.read(B), acc(m), m.read(C)], [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  assert.equal(psw(m) & OV, OV); // 16bit を超えた
  const d = run(emu(MOVd(ACCA, 0x12), MOVd(C, 0x34), MOVd(B, 0x10), [0x40]), 4);
  assert.deepEqual([acc(d), d.read(C), d.read(B)], [0x01, 0x23, 0x04]); // 0x1234 / 0x10 = 0x123 余り 4
});

test('ローテート / 論理演算 / XCH / LDC', () => {
  // ROL 0x81 → 0x03, OR 0x10 → 0x13, AND 0x1f → 0x13, XOR 1 → 0x12
  const e = run(emu(MOVd(ACCA, 0x81), [0xe0], [0xd1, 0x10], [0xe1, 0x1f], [0xf1, 0x01]), 5);
  assert.equal(acc(e), 0x12);
  // ROR / RORC (CY 経由) / XCH
  const r = run(emu(MOVd(ACCA, 0x01), [0xc0], MOVd(B, 0x5a), [0xc3, 0x02]), 4);
  assert.equal(acc(r), 0x5a);
  assert.equal(r.read(B), 0x80);
  const rc = run(emu(MOVd(ACCA, 0x01), [0xd0]), 2);
  assert.equal(acc(rc), 0x00);
  assert.equal(psw(rc) & CY, CY);
});

test('LDC はコード領域 (TRH:TRL + ACC) から読む', () => {
  const e = emu(MOVd(TRH, 0x01), MOVd(TRL, 0x00), MOVd(ACCA, 0x02), [0xc1]);
  e.flash.set([0xaa, 0xbb, 0xcc], 0x100);
  run(e, 4);
  assert.equal(acc(e), 0xcc);
});

test('タイマー 1 の割り込み (ベクタ 0x2B) と RETI', () => {
  // 0x00: JMP 0x50 / 0x2B: INC 0x30 ; RETI / 0x50: T1LR=0xF0, T1CNT=0x41 (下位を動かし割り込み許可), IE=0x80, ループ
  const e = emu(JMP(0x050));
  e.flash.set([0x62, 0x30, ...RETI], 0x2b);
  e.flash.set([...MOVd(0x11b, 0xf0), ...MOVd(0x118, 0x41), ...MOVd(IE, 0x80), ...BR(-2)], 0x050);
  run(e, 400);
  assert.ok(e.read(0x030) >= 5, `割り込み回数 ${e.read(0x030)}`);
  assert.equal(e.read(0x118) & 0x02, 0x02); // T1LOVF
});

test('ベースタイマーで HALT から復帰する', () => {
  // 0x1B: INC 0x31; RETI / main: BTCR=0x41 (動作+割り込み), IE=0x80, PCON=1 (HALT), INC 0x32, BR -?
  const e = emu(JMP(0x060));
  e.flash.set([0x62, 0x31, ...RETI], 0x1b);
  e.flash.set([...MOVd(0x17f, 0x41), ...MOVd(IE, 0x80), ...MOVd(0x107, 0x01), 0x62, 0x32, ...BR(-7)], 0x060);
  e.runFor(1.1);
  assert.equal(e.read(0x031), 2); // 0.5 秒ごと
  assert.equal(e.read(0x032), 2); // 復帰するたびに次の命令へ進んでいる
});

test('ボタン (P3、0 = 押下) と P3 割り込み', () => {
  const e = emu(JMP(0x070));
  e.flash.set([0x62, 0x33, ...RETI], 0x4b);
  e.flash.set([...MOVd(0x14e, 0x01), ...MOVd(IE, 0x80), ...LDd(0x14c), ...BR(-4)], 0x070);
  run(e, 3);
  e.setButtons(['a', 'up']);
  run(e, 4);
  assert.equal(e.read(0x033), 1);
  assert.equal(acc(e) & 0x11, 0); // A (bit4) と UP (bit0) が 0
  assert.equal(acc(e) & 0xee, 0xee);
});

test('LCD: XRAM の配置 (2 行で 0x10、1 行 6 バイト、バンク 1 は下半分)', () => {
  const e = run(emu(MOVd(0x125, 0), MOVd(0x180, 0x80), MOVd(0x186, 0x01), MOVd(0x125, 1), MOVd(0x185, 0x01), MOVd(0x127, 0x80), MOVd(0x120, 0x09)), 7);
  const { pixels, on } = e.lcd();
  assert.equal(pixels[0 * LCD_W + 0], 1); // 行 0 の左端
  assert.equal(pixels[1 * LCD_W + 7], 1); // 行 1 (0x186) の 8 画素目
  assert.equal(pixels[16 * LCD_W + 47], 1); // バンク 1 の先頭行の右端
  assert.equal(pixels.reduce((a, b) => a + b, 0), 3);
  assert.equal(on, true);
});

test('BIOS 無しで BIOS を呼ぶと止まる / BIOS らしさの判定', () => {
  const e = emu(MOVd(EXT, 0), JMPF(0x0100));
  run(e, 2);
  assert.equal(e.stopReason, 'bios');
  assert.match(e.stopMessage, /0x0100/);
  assert.equal(looksLikeBios(new Uint8Array(0x10000).fill(0xc8)), false);
  const rom = new Uint8Array(0x10000);
  rom.set([0x21, 0x01, 0x00]);
  assert.equal(looksLikeBios(rom), true);
});

test('LDF / STF: フラッシュは AA/55/A0 のコマンドの後だけ書ける', () => {
  const st = (addr, v) => [...MOVd(TRH, addr >> 8), ...MOVd(TRL, addr & 0xff), ...MOVd(ACCA, v), 0x51];
  const e = emu([...st(0x1000, 0x11), ...st(0x5555, 0xaa), ...st(0x2aaa, 0x55), ...st(0x5555, 0xa0), ...st(0x1000, 0x22),
    ...MOVd(TRH, 0x10), ...MOVd(TRL, 0x00), 0x50]);
  run(e, 4); // コマンド無しの書き込みは無視
  assert.equal(e.flash[0x1000], 0);
  run(e, 16 + 3);
  assert.equal(e.flash[0x1000], 0x22);
  assert.equal(acc(e), 0x22); // LDF で読み戻し
});
