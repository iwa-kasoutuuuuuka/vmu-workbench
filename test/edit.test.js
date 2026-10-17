import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vmu, FILE_GAME, BLOCK_SIZE } from '../src/vmu.js';
import { parseHeader, updateCrc } from '../src/vms.js';
import { crcStatus, applyEdit, patchBytes, parseHexBytes, diffBytes, regions } from '../src/edit.js';

function makeSave(dataSize = 100, headerAt = 0) {
  const file = new Uint8Array(headerAt + 0x80 + 512 + dataSize);
  const v = new DataView(file.buffer);
  file.set(new TextEncoder().encode('EDIT TEST'), headerAt);
  v.setUint16(headerAt + 0x40, 1, true);
  v.setUint32(headerAt + 0x48, dataSize, true);
  for (let i = 0; i < dataSize; i++) file[headerAt + 0x80 + 512 + i] = i & 0xff;
  updateCrc(file, parseHeader(file, headerAt));
  return file;
}

test('CRC状態: 正常 / 不一致 / ヘッダ無し / 範囲外', () => {
  const vmu = Vmu.format();
  const e = vmu.writeFile('SAVE', makeSave());
  assert.equal(crcStatus(vmu.readFile(e), e).status, 'ok');

  const bad = vmu.readFile(e);
  bad[0x80 + 512] ^= 0xff;
  assert.equal(crcStatus(bad, e).status, 'ng');

  const raw = vmu.writeFile('RAW', new Uint8Array(100));
  assert.equal(crcStatus(vmu.readFile(raw), raw).status, 'none');

  const big = vmu.readFile(e);
  new DataView(big.buffer).setUint32(0x48, 99999, true);
  assert.equal(crcStatus(big, e).status, 'broken');
});

test('書き換え後にCRCを自動更新して書き戻す', () => {
  const vmu = Vmu.format();
  const e = vmu.writeFile('SAVE', makeSave());
  const edited = patchBytes(vmu.readFile(e), [{ offset: 0x80 + 512 + 10, bytes: parseHexBytes('DE AD BE EF') }]);
  assert.equal(crcStatus(edited, e).status, 'ng');

  const { crc } = applyEdit(vmu, e, edited);
  const after = vmu.readFile(e);
  assert.deepEqual([...after.subarray(0x80 + 512 + 10, 0x80 + 512 + 14)], [0xde, 0xad, 0xbe, 0xef]);
  assert.equal(crcStatus(after, e).status, 'ok');
  assert.equal(parseHeader(after).crc, crc);
  assert.deepEqual(vmu.check(), []);
});

test('fixCrc=false ならCRCはそのまま', () => {
  const vmu = Vmu.format();
  const e = vmu.writeFile('SAVE', makeSave());
  const edited = patchBytes(vmu.readFile(e), [{ offset: 0x290, bytes: Uint8Array.of(1) }]);
  assert.equal(applyEdit(vmu, e, edited, { fixCrc: false }).crc, null);
  assert.equal(crcStatus(vmu.readFile(e), e).status, 'ng');
});

test('ヘッダ無しファイルはCRCを触らない', () => {
  const vmu = Vmu.format();
  const e = vmu.writeFile('RAW', new Uint8Array(600));
  const edited = patchBytes(vmu.readFile(e), [{ offset: 0x46, bytes: Uint8Array.of(0x12, 0x34) }]);
  assert.equal(applyEdit(vmu, e, edited).crc, null);
  assert.deepEqual([...vmu.readFile(e).subarray(0x46, 0x48)], [0x12, 0x34]);
});

test('ゲームファイルはヘッダ位置ブロックのCRCを更新', () => {
  const vmu = Vmu.format();
  const e = vmu.writeFile('GAME', makeSave(64, BLOCK_SIZE), { type: FILE_GAME, headerOffset: 1 });
  const edited = patchBytes(vmu.readFile(e), [{ offset: BLOCK_SIZE + 0x80 + 512, bytes: Uint8Array.of(0xaa) }]);
  applyEdit(vmu, e, edited);
  assert.equal(crcStatus(vmu.readFile(e), e).status, 'ok');
  assert.equal(regions(vmu.readFile(e), e)[0].kind, 'program');
});

test('パッチ範囲外・HEX不正はエラー', () => {
  assert.throws(() => patchBytes(new Uint8Array(4), [{ offset: 3, bytes: Uint8Array.of(1, 2) }]), RangeError);
  assert.throws(() => parseHexBytes('F'), /不正/);
  assert.throws(() => parseHexBytes('ZZ'), /不正/);
  assert.deepEqual([...parseHexBytes('0x01, 0xff 10')], [1, 255, 16]);
});

test('差分を連続範囲で返す', () => {
  const a = Uint8Array.of(0, 1, 2, 3, 4, 5);
  const b = Uint8Array.of(0, 9, 9, 3, 4, 8);
  const d = diffBytes(a, b);
  assert.deepEqual(d.map((r) => [r.offset, [...r.after]]), [[1, [9, 9]], [5, [8]]]);
});

test('領域区分', () => {
  const vmu = Vmu.format();
  const e = vmu.writeFile('SAVE', makeSave(100));
  const kinds = regions(vmu.readFile(e), e).map((r) => r.kind);
  assert.deepEqual(kinds, ['header', 'crc', 'header', 'icon', 'data', 'pad']);
});
