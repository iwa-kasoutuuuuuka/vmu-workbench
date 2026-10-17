// レビューで見つかった不具合の回帰テストと、断片化解消・並べ替え
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vmu, VmuError, BLOCK_SIZE, FILE_GAME, FAT_FREE, encodeTimestamp, decodeTimestamp } from '../src/vmu.js';
import { applyEdit } from '../src/edit.js';
import { toDci, fromDci } from '../src/vms.js';

const fill = (blocks, v) => new Uint8Array(blocks * BLOCK_SIZE).fill(v);

test('上書きで容量不足なら元のファイルは消えない', () => {
  const vmu = Vmu.format();
  vmu.writeFile('BIG', fill(190, 1));
  vmu.writeFile('SAVE', fill(5, 2));
  const before = vmu.toBytes();
  assert.throws(() => vmu.writeFile('SAVE', fill(20, 3), { overwrite: true }), /空き容量不足/);
  assert.deepEqual(vmu.toBytes(), before);
  assert.equal(vmu.find('SAVE').sizeBlocks, 5);
});

test('ゲームの上書きで連続領域が無くても元は残る', () => {
  const vmu = Vmu.format();
  vmu.writeFile('GAME', fill(2, 1), { type: FILE_GAME });
  vmu.writeFile('X', fill(196, 2));
  const before = vmu.toBytes();
  assert.throws(() => vmu.writeFile('GAME', fill(5, 3), { type: FILE_GAME, overwrite: true }));
  assert.deepEqual(vmu.toBytes(), before);
});

test('末尾の空白は同じ名前として扱う (重複を作らない)', () => {
  const vmu = Vmu.format();
  vmu.writeFile('ABC', fill(1, 1));
  assert.throws(() => vmu.writeFile('ABC ', fill(1, 2)), /既に存在/);
  assert.equal(vmu.find('ABC  ').name, 'ABC');
  assert.throws(() => vmu.writeFile('   ', fill(1, 2)), VmuError);
  assert.equal(vmu.list().length, 1);
});

test('サイズ変更は同じスロット・属性・日時のまま置き換え、新しいエントリを返す', () => {
  const vmu = Vmu.format();
  vmu.writeFile('A', fill(1, 1));
  const ts = Uint8Array.of(0x00, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06); // 西暦 5 年 (世紀 00)
  const b = vmu.writeFile('B', fill(1, 2), { copyProtected: true, timestamp: ts });
  const { entry, resized } = applyEdit(vmu, b, fill(3, 9));
  assert.equal(resized, true);
  assert.equal(entry.slot, b.slot);
  assert.equal(entry.name, 'B');
  assert.equal(entry.copyProtected, true);
  assert.deepEqual([...entry.raw.subarray(16, 24)], [...ts]);
  assert.equal(entry.sizeBlocks, 3);
  assert.deepEqual(vmu.readFile(entry), fill(3, 9));
  assert.deepEqual(vmu.readFile(vmu.find('A')), fill(1, 1));
  assert.deepEqual(vmu.check(), []);
});

test('西暦 100 年未満の日時を壊さない', () => {
  const ts = Uint8Array.of(0x00, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06);
  const d = decodeTimestamp(ts);
  assert.equal(d.getFullYear(), 5);
  assert.deepEqual([...encodeTimestamp(d)].slice(0, 7), [...ts].slice(0, 7));
});

test('壊れたチェーンのファイルも削除でき、他のファイルのブロックは解放しない', () => {
  const vmu = Vmu.format();
  const a = vmu.writeFile('A', fill(2, 1));
  const b = vmu.writeFile('B', fill(2, 2));
  // A の 2 ブロック目を B の先頭につなぐ (交差リンク)
  const aBlocks = vmu.chain(a.firstBlock);
  vmu.setFat(aBlocks[1], b.firstBlock);
  assert.ok(vmu.check().length > 0);
  assert.equal(vmu.tryReadFile(vmu.find('A')), null);
  vmu.deleteFile(vmu.find('A'));
  assert.equal(vmu.find('A'), null);
  assert.deepEqual(vmu.readFile(vmu.find('B')), fill(2, 2));
  assert.equal(vmu.getFat(aBlocks[0]), FAT_FREE);
});

test('断片化の解消: 中身・名前・属性・並びはそのまま、連続に詰め直す', () => {
  const vmu = Vmu.format();
  vmu.writeFile('GAME', fill(2, 7), { type: FILE_GAME, headerOffset: 1 });
  vmu.writeFile('A', fill(2, 1));
  vmu.writeFile('GAP', fill(3, 2));
  vmu.writeFile('B', fill(1, 3), { copyProtected: true });
  vmu.deleteFile(vmu.find('GAP'));
  vmu.writeFile('C', fill(5, 4)); // 空きに分かれて入る
  assert.ok(vmu.fragmented().some((e) => e.name === 'C'));
  const before = Object.fromEntries(vmu.list().map((e) => [e.name, { data: vmu.readFile(e), slot: e.slot, raw: e.raw }]));
  vmu.defragment();
  assert.deepEqual(vmu.fragmented(), []);
  assert.deepEqual(vmu.check(), []);
  for (const e of vmu.list()) {
    assert.deepEqual(vmu.readFile(e), before[e.name].data, e.name);
    assert.equal(e.slot, before[e.name].slot);
    assert.deepEqual([...e.raw.subarray(16, 24)], [...before[e.name].raw.subarray(16, 24)]);
  }
  assert.deepEqual(vmu.chain(vmu.find('GAME').firstBlock), [0, 1]);
  assert.equal(vmu.find('B').copyProtected, true);
});

test('壊れたイメージの断片化解消は中止して何も変えない', () => {
  const vmu = Vmu.format();
  const a = vmu.writeFile('A', fill(2, 1));
  vmu.setFat(vmu.chain(a.firstBlock)[0], vmu.chain(a.firstBlock)[0]);
  const before = vmu.toBytes();
  assert.throws(() => vmu.defragment(), /中止/);
  assert.deepEqual(vmu.toBytes(), before);
});

test('ディレクトリの並べ替え', () => {
  const vmu = Vmu.format();
  for (const n of ['A', 'B', 'C', 'D']) vmu.writeFile(n, fill(1, n.charCodeAt(0)));
  vmu.reorder(['C', 'A']);
  assert.deepEqual(vmu.list().map((e) => e.name), ['C', 'A', 'B', 'D']);
  assert.deepEqual(vmu.readFile(vmu.find('C')), fill(1, 0x43));
  assert.throws(() => vmu.reorder(['NOPE']), /ありません/);
});

test('途中で切れた DCI は読み込まない', () => {
  const vmu = Vmu.format();
  const e = vmu.writeFile('X', fill(1, 5));
  const dci = toDci(e, vmu.readFile(e));
  assert.equal(fromDci(dci).data.length, BLOCK_SIZE);
  assert.throws(() => fromDci(dci.subarray(0, 32 + 10)), /切れて/);
});

test('チェックサム定義の追加検証', async () => {
  const { validateDef } = await import('../src/structdef.js');
  const base = { id: 'x', title: 'x', match: { fileName: 'X' }, base: 'file', fields: [{ name: 'v', offset: 0x10, type: 'u16le' }] };
  assert.match(validateDef({ ...base, checksums: { type: 'sum8' } }).join(), /配列/);
  assert.match(validateDef({ ...base, checksums: [{ type: 'sum16le', from: 0, to: 5, at: 8, store: 'u16le' }] }).join(), /偶数/);
  assert.match(validateDef({ ...base, checksums: [{ type: 'sum8', from: 0, to: 8, at: 0x10, store: 'u16le' }] }).join(), /フィールド v と重なって/);
  assert.deepEqual(validateDef({ ...base, checksums: [{ type: 'sum16le', from: 0, to: 8, at: 8, store: 'u16le' }] }), []);
});
