// アセンブラの出力を、資料 (mc.pp.se/dc/vms/cpu.html) のコード欄から作ったバイト列と突き合わせる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assemble } from '../src/vmuasm.js';

const asm = (src) => [...assemble(src).bytes];

test('各命令の符号化 (資料のビット配置と一致)', () => {
  const cases = [
    ['nop', [0x00]], ['ret', [0xa0]], ['reti', [0xb0]], ['mul', [0x30]], ['div', [0x40]], ['ldc', [0xc1]], ['ldf', [0x50]], ['stf', [0x51]],
    ['ld acc', [0x03, 0x00]], ['ld 0x040', [0x02, 0x40]], ['ld @r2', [0x06]], ['st b', [0x13, 0x02]], ['st @r1', [0x15]],
    ['mov #0x12,acc', [0x23, 0x00, 0x12]], ['mov #5,@r3', [0x27, 0x05]], ['mov #1,0x30', [0x22, 0x30, 0x01]],
    ['add #1', [0x81, 0x01]], ['add b', [0x83, 0x02]], ['add @r0', [0x84]], ['addc #2', [0x91, 0x02]], ['sub c', [0xa3, 0x03]],
    ['subc @r3', [0xb7]], ['or #0x10', [0xd1, 0x10]], ['and acc', [0xe3, 0x00]], ['xor @r1', [0xf5]],
    ['inc 0x30', [0x62, 0x30]], ['dec b', [0x73, 0x02]], ['inc @r0', [0x64]], ['xch b', [0xc3, 0x02]], ['push acc', [0x61, 0x00]], ['pop psw', [0x71, 0x01]],
    ['set1 acc,3', [0xfb, 0x00]], ['clr1 0x020,7', [0xcf, 0x20]], ['not1 ext,0', [0xb8, 0x0d]],
    ['callf 0x1234', [0x20, 0x12, 0x34]], ['jmpf 0xabcd', [0x21, 0xab, 0xcd]],
  ];
  for (const [src, bytes] of cases) assert.deepEqual(asm(src), bytes, src);
});

test('分岐の相対アドレスとラベル', () => {
  // x: br x → 自分自身 (-2)
  assert.deepEqual(asm('x: br x'), [0x01, 0xfe]);
  // 前方参照: bz で 1 つ飛ばす
  assert.deepEqual(asm('bz l\nnop\nl: nop'), [0x80, 0x01, 0x00, 0x00]);
  assert.deepEqual(asm('l: be #5,l'), [0x31, 0x05, 0xfd]);
  assert.deepEqual(asm('l: bne b,l'), [0x43, 0x02, 0xfd]);
  assert.deepEqual(asm('l: be @r1,#9,l'), [0x35, 0x09, 0xfd]);
  assert.deepEqual(asm('l: dbnz c,l'), [0x53, 0x03, 0xfd]);
  assert.deepEqual(asm('l: dbnz @r2,l'), [0x56, 0xfe]);
  assert.deepEqual(asm('l: bp acc,7,l'), [0x7f, 0x00, 0xfd]);
  assert.deepEqual(asm('l: bn p3,4,l'), [0x9c, 0x4c, 0xfd]);
  assert.deepEqual(asm('l: bpc 0x030,0,l'), [0x48, 0x30, 0xfd]);
  // CALL / JMP a12 (a11 は先頭バイトの bit4)
  assert.deepEqual(asm('.org 0x0800\njmp 0x0834'), [...new Array(0x800).fill(0), 0x38, 0x34]);
  assert.deepEqual(asm('call 0x010'), [0x08, 0x10]);
  // BRF / CALLR: 「次の命令 - 1」からの符号なし 16bit
  assert.deepEqual(asm('brf 0x0010'), [0x11, 0x0e, 0x00]);
});

test('疑似命令とエラー', () => {
  const r = assemble('.equ X,0x40\n.org 4\nstart: .byte 1,"AB"\n.word 0x1234\n.fill 2,0xff\nmov #X>>4,b');
  assert.deepEqual([...r.bytes], [0, 0, 0, 0, 1, 0x41, 0x42, 0x34, 0x12, 0xff, 0xff, 0x23, 0x02, 0x04]);
  assert.equal(r.labels.start, 4);
  assert.throws(() => assemble('foo'), /知らない命令/);
  assert.throws(() => assemble('br nowhere'), /未定義/);
  assert.throws(() => assemble('.org 0\nbr far\n.org 0x200\nfar: nop'), /遠すぎ/);
  assert.throws(() => assemble('jmp 0x1000'), /同じ 4KB/);
});
