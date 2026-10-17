import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Vmu, BLOCK_SIZE, FILE_GAME } from '../src/vmu.js';
import { parseHeader, calcCrc, updateCrc } from '../src/vms.js';
import { applyEdit, crcStatus } from '../src/edit.js';
import { readIcons, editVms, rgbaToIcons, iconsToStrip, frameToRgba } from '../src/vmsedit.js';
import { encodePng, decodePng } from '../src/png-node.js';

const sample = () => new Vmu(readFileSync(new URL('./fixtures/sample.bin', import.meta.url)));

test('説明文の書き換え (空白埋め、CRC 更新)', () => {
  const vmu = sample();
  const e = vmu.find('DCVMU_SAVE01');
  const out = editVms(vmu.readFile(e), e, { description: 'HELLO', longDescription: 'MODDED BY DC_VMU' });
  const h = parseHeader(out);
  assert.equal(h.description, 'HELLO');
  assert.equal(h.longDescription, 'MODDED BY DC_VMU');
  assert.equal(out[5], 0x20);
  assert.equal(calcCrc(out, h), h.crc);
  assert.throws(() => editVms(vmu.readFile(e), e, { description: 'X'.repeat(17) }), /16 文字/);
  assert.throws(() => editVms(vmu.readFile(e), e, { description: 'あ' }), /半角/);
});

test('アイコンのコマ数を増やすとデータを保ったままファイルが大きくなる', () => {
  const vmu = sample();
  const e = vmu.find('DCVMU_SAVE01');
  const before = vmu.readFile(e);
  const h0 = parseHeader(before);
  const icons = readIcons(before, e);
  assert.equal(icons.frames.length, 1);
  const frame2 = icons.frames[0].map((c) => (c + 1) % 5);
  const frame3 = icons.frames[0].map(() => 2);
  const out = editVms(before, e, { frames: [icons.frames[0], frame2, frame3], animSpeed: 12 });
  const h = parseHeader(out);
  assert.equal(h.iconCount, 3);
  assert.equal(h.animSpeed, 12);
  assert.equal(out.length % BLOCK_SIZE, 0);
  assert.deepEqual(out.subarray(h.dataOffset, h.dataOffset + h.dataSize), before.subarray(h0.dataOffset, h0.dataOffset + h0.dataSize));
  assert.deepEqual(readIcons(out, e).frames[1], frame2);
  assert.equal(calcCrc(out, h), h.crc);
  const { entry } = applyEdit(vmu, e, out);
  assert.ok(entry.sizeBlocks > e.sizeBlocks);
  assert.equal(crcStatus(vmu.readFile(entry), entry).status, 'ok');
  assert.deepEqual(vmu.check(), []);
  assert.throws(() => editVms(before, e, { frames: [] }), /1〜3/);
});

test('ゲームファイルはヘッダ位置より前のプログラムを保つ', () => {
  const file = new Uint8Array(BLOCK_SIZE + 0x80 + 512 + 16);
  file.fill(0xaa, 0, BLOCK_SIZE);
  const v = new DataView(file.buffer);
  v.setUint16(BLOCK_SIZE + 0x40, 1, true);
  v.setUint32(BLOCK_SIZE + 0x48, 16, true);
  updateCrc(file, parseHeader(file, BLOCK_SIZE));
  const vmu = Vmu.format();
  const e = vmu.writeFile('GAME', file, { type: FILE_GAME, headerOffset: 1 });
  const out = editVms(vmu.readFile(e), e, { description: 'GAME!' });
  assert.ok(out.subarray(0, BLOCK_SIZE).every((b) => b === 0xaa));
  assert.equal(parseHeader(out, BLOCK_SIZE).description, 'GAME!');
});

test('画像 → 16 色アイコン (減色) とその逆', () => {
  // 3 コマ分の横長画像: 2 色 + 透明
  const w = 96;
  const rgba = new Uint8ClampedArray(w * 32 * 4);
  for (let i = 0; i < w * 32; i++) rgba.set(i % w < 32 ? [255, 0, 0, 255] : i % w < 64 ? [0, 0, 255, 255] : [0, 0, 0, 0], i * 4);
  const icons = rgbaToIcons(rgba, w, 32);
  assert.equal(icons.frames.length, 3);
  assert.equal(icons.exact, true);
  assert.deepEqual([...frameToRgba(icons.palette, icons.frames[0]).subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...frameToRgba(icons.palette, icons.frames[2]).subarray(0, 4)].slice(3), [0]);
  const strip = iconsToStrip(icons);
  assert.equal(strip.width, 96);
  assert.throws(() => rgbaToIcons(new Uint8ClampedArray(40 * 32 * 4), 40, 32), /32 の倍数/);
  // 17 色以上は近い色に寄せる
  const many = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < 1024; i++) many.set([(i * 7) & 255, (i * 3) & 255, i & 255, 255], i * 4);
  const reduced = rgbaToIcons(many, 32, 32);
  assert.equal(reduced.exact, false);
  assert.ok(reduced.frames[0].every((c) => c < 16));
});

test('PNG の書き出しと読み込み (往復)', () => {
  const rgba = new Uint8ClampedArray(96 * 32 * 4).map((_, i) => (i * 37) & 255);
  const png = encodePng(rgba, 96, 32);
  const back = decodePng(png);
  assert.equal(back.width, 96);
  assert.equal(back.height, 32);
  assert.deepEqual(back.rgba, rgba);
  assert.throws(() => decodePng(new Uint8Array(8)), /PNG/);
});
