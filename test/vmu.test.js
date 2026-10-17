import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Vmu, VmuError, IMAGE_SIZE, BLOCK_SIZE, FAT_FREE, FAT_END, FILE_GAME,
  encodeTimestamp, decodeTimestamp,
} from '../src/vmu.js';
import {
  parseHeader, iconToRgba, calcCrc, updateCrc, toDci, fromDci, argb4444ToRgba, rgbaToArgb4444,
} from '../src/vms.js';

const bytes = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);

test('フォーマット直後は200ブロック空き・ファイルなし', () => {
  const vmu = Vmu.format();
  assert.equal(vmu.root.formatted, true);
  assert.equal(vmu.root.userBlocks, 200);
  assert.equal(vmu.freeBlocks().length, 200);
  assert.deepEqual(vmu.list(), []);
  assert.equal(vmu.getFat(241), FAT_END);
  assert.deepEqual(vmu.check(), []);
});

test('サイズ不正なイメージは拒否', () => {
  assert.throws(() => new Vmu(new Uint8Array(100)), VmuError);
});

test('タイムスタンプのBCD往復', () => {
  const d = new Date(2001, 2, 4, 5, 6, 7);
  assert.equal(decodeTimestamp(encodeTimestamp(d)).getTime(), d.getTime());
});

test('ファイルの書き込み・読み出し・削除', () => {
  const vmu = Vmu.format();
  const data = bytes(1500);
  const e = vmu.writeFile('SONIC2___S01', data);
  assert.equal(e.sizeBlocks, 3);
  assert.equal(vmu.freeBlocks().length, 197);
  assert.deepEqual(vmu.chain(e.firstBlock), [199, 198, 197]);
  assert.deepEqual(vmu.readFile(e).subarray(0, 1500), data);

  // 再読み込みしても同じ
  const reloaded = new Vmu(vmu.toBytes());
  assert.equal(reloaded.list()[0].name, 'SONIC2___S01');

  vmu.deleteFile(e);
  assert.equal(vmu.freeBlocks().length, 200);
  assert.deepEqual(vmu.list(), []);
  assert.equal(vmu.getFat(199), FAT_FREE);
});

test('同名ファイルは上書き指定なしでエラー', () => {
  const vmu = Vmu.format();
  vmu.writeFile('A', bytes(10));
  assert.throws(() => vmu.writeFile('A', bytes(10)), /既に存在/);
  vmu.writeFile('A', bytes(600), { overwrite: true });
  assert.equal(vmu.list().length, 1);
  assert.equal(vmu.find('A').sizeBlocks, 2);
});

test('容量不足でエラー', () => {
  const vmu = Vmu.format();
  vmu.writeFile('BIG', bytes(BLOCK_SIZE * 199));
  assert.throws(() => vmu.writeFile('B2', bytes(BLOCK_SIZE * 2)), /空き容量不足/);
});

test('ゲームファイルはブロック0から連続配置', () => {
  const vmu = Vmu.format();
  const e = vmu.writeFile('MINIGAME', bytes(BLOCK_SIZE * 4), { type: FILE_GAME, headerOffset: 1 });
  assert.deepEqual(vmu.chain(e.firstBlock), [0, 1, 2, 3]);
  assert.equal(e.headerOffset, 1);
});

test('別イメージへのコピー', () => {
  const src = Vmu.format();
  const dst = Vmu.format();
  const e = src.writeFile('SAVE', bytes(2000), { copyProtected: true });
  dst.writeFile(e.name, src.readFile(e), { type: e.type, copyProtected: e.copyProtected, date: e.timestamp });
  assert.deepEqual(dst.readFile(dst.find('SAVE')), src.readFile(e));
  assert.equal(dst.find('SAVE').copyProtected, true);
});

test('壊れたFATチェーンを検出', () => {
  const vmu = Vmu.format();
  const e = vmu.writeFile('X', bytes(1024));
  vmu.setFat(e.firstBlock, e.firstBlock); // 自己ループ
  assert.ok(vmu.check().length > 0);
});

function makeSave() {
  const file = new Uint8Array(BLOCK_SIZE * 2);
  const v = new DataView(file.buffer);
  file.set(new TextEncoder().encode('TEST SAVE'), 0);
  file.set(new TextEncoder().encode('LONG DESCRIPTION'), 0x10);
  file.set(new TextEncoder().encode('APPID'), 0x30);
  v.setUint16(0x40, 1, true);   // アイコン1枚
  v.setUint32(0x48, 100, true); // データ100バイト
  v.setUint16(0x60, 0xf000, true); // 黒
  v.setUint16(0x62, 0xff00, true); // 赤
  file[0x80] = 0x10; // 左上: 赤, 次: 黒
  return file;
}

test('VMSヘッダとアイコンの解析', () => {
  const file = makeSave();
  const h = parseHeader(file);
  assert.equal(h.description, 'TEST SAVE');
  assert.equal(h.longDescription, 'LONG DESCRIPTION');
  assert.equal(h.iconCount, 1);
  assert.equal(h.dataOffset, 0x80 + 512);
  const rgba = iconToRgba(file, h, 0);
  assert.deepEqual([...rgba.subarray(0, 8)], [255, 0, 0, 255, 0, 0, 0, 255]);
});

test('CRCの更新', () => {
  const file = makeSave();
  const h = parseHeader(file);
  const crc = updateCrc(file, h);
  assert.equal(parseHeader(file).crc, crc);
  assert.equal(calcCrc(file, parseHeader(file)), crc); // CRC欄自身は計算対象外
  file[h.dataOffset] ^= 1;
  assert.notEqual(calcCrc(file, h), crc);
});

test('ARGB4444変換の往復', () => {
  for (const c of [0xf000, 0xffff, 0x8a5c]) assert.equal(rgbaToArgb4444(argb4444ToRgba(c)), c);
});

test('DCIの往復', () => {
  const vmu = Vmu.format();
  const e = vmu.writeFile('DCITEST', bytes(700), { copyProtected: true });
  const dci = toDci(e, vmu.readFile(e));
  assert.equal(dci.length, 32 + 1024);
  assert.notDeepEqual(dci.subarray(32, 36), vmu.readFile(e).subarray(0, 4));
  const parsed = fromDci(dci);
  assert.equal(parsed.name, 'DCITEST');
  assert.equal(parsed.copyProtected, true);
  assert.deepEqual(parsed.data, vmu.readFile(e));
});

test('IMAGE_SIZEは128KB', () => assert.equal(IMAGE_SIZE, 131072));

test('フォーマット: ルートの位置 (0x44) = 255。古いイメージは fixRoot で直る', () => {
  const vmu = Vmu.format();
  assert.equal(vmu.root.rootBlock, 255);
  assert.deepEqual(vmu.check(), []);
  vmu.data[255 * 512 + 0x44] = 0;
  assert.match(vmu.check().join(), /ルートの位置/);
  assert.equal(vmu.fixRoot(), true);
  assert.equal(vmu.fixRoot(), false);
  assert.deepEqual(vmu.check(), []);
});
