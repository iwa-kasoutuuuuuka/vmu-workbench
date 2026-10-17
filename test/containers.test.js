import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vmu, BLOCK_SIZE } from '../src/vmu.js';
import {
  CONTAINERS, PS1_CARD_SIZE, PS1_BLOCK_SIZE, ps1Directory, ps1FindSave, ps1ReadSave, ps1WriteSave,
} from '../src/containers.js';
import {
  validateDef, matches, openView, resolveViewFields, readField, setFields, checksumStatus, applyChecksums, CHECKSUMS,
} from '../src/structdef.js';
import { applyEdit } from '../src/edit.js';
import { loadDefs } from '../src/defs-node.js';

const rle = CONTAINERS['bleem-mc'];

/** PS1 カードを作る: saves = [{name, slots:[...], fill}] (slots の順にチェーン) */
function makeCard(saves) {
  const card = new Uint8Array(PS1_CARD_SIZE);
  card[0] = 0x4d;
  card[1] = 0x43;
  for (let s = 1; s <= 15; s++) {
    card[s * 128] = 0xa0;
    card[s * 128 + 8] = 0xff;
    card[s * 128 + 9] = 0xff;
  }
  for (const { name, slots, fill } of saves) {
    slots.forEach((slot, i) => {
      const d = slot * 128;
      card[d] = i === 0 ? 0x51 : i === slots.length - 1 ? 0x53 : 0x52;
      const next = i + 1 < slots.length ? slots[i + 1] - 1 : 0xffff;
      card[d + 8] = next & 0xff;
      card[d + 9] = next >> 8;
      if (i === 0) {
        const size = slots.length * PS1_BLOCK_SIZE;
        card[d + 4] = size & 0xff;
        card[d + 5] = (size >> 8) & 0xff;
        for (let k = 0; k < name.length; k++) card[d + 10 + k] = name.charCodeAt(k);
      }
      card.fill(fill + i, slot * PS1_BLOCK_SIZE, (slot + 1) * PS1_BLOCK_SIZE);
    });
  }
  return card;
}

function testSave() {
  // MSX 風: 先頭 "SC"、0x20C からランキング (スコア u32 + 名前 3 + 1 バイト)、0x92E に u16le のバイト和
  const card = makeCard([{ name: 'BASLUS-01212', slots: [2], fill: 0 }, { name: 'BASLUS-99999', slots: [5, 3], fill: 0x10 }]);
  const base = 2 * PS1_BLOCK_SIZE;
  card.set([0x53, 0x43], base);
  card.set([0x88, 0xa3, 0x01, 0, 0x41, 0x50, 0x45, 0], base + 0x20c); // 1 位: 107400 APE
  let sum = 0;
  for (let i = 0; i < 0x92e; i++) sum += card[base + i];
  card[base + 0x92e] = sum & 0xff;
  card[base + 0x92f] = (sum >> 8) & 0xff;
  return card;
}

test('RLE の往復と bleem2 互換の出力', () => {
  const card = testSave();
  const enc = rle.encode(card);
  assert.deepEqual([...enc.subarray(0, 4)], [0x4d, 0x43, 0x31, 0]);
  assert.deepEqual(rle.decode(enc), card);
  // 255 を超える連続は分割される
  assert.equal(enc[4], 1); // "M"
  assert.equal(rle.decode(Uint8Array.of(0x58, 0, 0, 0)), null); // 識別子違い
  assert.equal(rle.decode(enc.subarray(0, 100)), null); // 途中で切れている
});

test('PS1 ディレクトリと複数ブロックのチェーン', () => {
  const card = testSave();
  assert.deepEqual(ps1Directory(card).map((s) => [s.slot, s.name]), [[2, 'BASLUS-01212'], [5, 'BASLUS-99999']]);
  const multi = ps1FindSave(card, '99999');
  assert.deepEqual(multi.blocks, [5, 3]); // 連続していないチェーン
  const bytes = ps1ReadSave(card, multi);
  assert.equal(bytes.length, 2 * PS1_BLOCK_SIZE);
  assert.equal(bytes[0], 0x10);
  assert.equal(bytes[PS1_BLOCK_SIZE], 0x11);
  bytes[PS1_BLOCK_SIZE] = 0x99;
  const card2 = ps1WriteSave(card, multi, bytes);
  assert.equal(card2[3 * PS1_BLOCK_SIZE], 0x99); // 2 ブロック目はスロット 3
  assert.equal(card[3 * PS1_BLOCK_SIZE], 0x11); // 元は変えない
  assert.equal(ps1FindSave(card, 'NOPE'), null);
});

test('チェックサム関数', () => {
  const b = Uint8Array.of(1, 2, 3, 0xff);
  assert.equal(CHECKSUMS.sum8(b), 0x105);
  assert.equal(CHECKSUMS.xor8(b), 1 ^ 2 ^ 3 ^ 0xff);
  assert.equal(CHECKSUMS.sum16le(b), 0x0201 + 0xff03);
  assert.equal(CHECKSUMS.sum16be(b), 0x0102 + 0x03ff);
});

const { defs } = loadDefs();
const msx = defs.find((d) => d.id === 'msx-ps1-bleem');

function vmuWithCard(card, name = 'BLEEMMC') {
  const vmu = Vmu.format();
  vmu.writeFile(name, rle.encode(card));
  return vmu;
}

test('MSX 定義: コンテナを開いて読み書き + チェックサム更新', () => {
  assert.ok(msx);
  const vmu = vmuWithCard(testSave());
  const e = vmu.find('BLEEMMC');
  const data = vmu.readFile(e);
  assert.equal(matches(msx, e, data), true);
  const view = openView(msx, e, data);
  assert.match(view.label, /BASLUS-01212/);
  assert.equal(checksumStatus(msx, view.bytes, view.base)[0].ok, true);
  const f = (name) => resolveViewFields(msx, view).find((x) => x.name === name);
  assert.equal(readField(view.bytes, f('ランキング 名前[0]')), 'APE');
  assert.equal(readField(view.bytes, f('ランキング スコア[0]')), 107400);
  assert.equal(f('ランキング スコア[0]').offset, 0x20c); // スコアが名前の前 (ゲームの画面で確認)
  assert.equal(f('ランキング 名前[0]').offset, 0x210);
  // 解放フラグ (ゲームで確認: 0x208 / 0x20A の u16 が 0 以外で解放)
  assert.equal(f('COMBAT SCHOOL 解放').offset, 0x208);
  assert.equal(f('ANOTHER MISSION 解放').offset, 0x20a);
  const unlocked = setFields(data, msx, e, { 'COMBAT SCHOOL 解放': '解放' });
  const vu = openView(msx, e, unlocked);
  assert.deepEqual([...vu.bytes.subarray(0x208, 0x20a)], [0xff, 0x00]);
  assert.equal(checksumStatus(msx, vu.bytes, vu.base)[0].ok, true);

  applyEdit(vmu, e, setFields(data, msx, e, { 'ランキング 名前[0]': 'DCV', 'ランキング スコア[0]': 99999 }));
  const e2 = vmu.find('BLEEMMC');
  const v2 = openView(msx, e2, vmu.readFile(e2));
  assert.equal(readField(v2.bytes, f('ランキング 名前[0]')), 'DCV');
  assert.equal(readField(v2.bytes, f('ランキング スコア[0]')), 99999);
  assert.equal(checksumStatus(msx, v2.bytes, v2.base)[0].ok, true);
  // 他のセーブは変わらない
  const other = ps1FindSave(rle.decode(vmu.readFile(e2)), '99999');
  assert.equal(ps1ReadSave(rle.decode(vmu.readFile(e2)), other)[0], 0x10);

  // fixChecksums=false なら不一致のまま
  const nofix = setFields(data, msx, e, { 'ランキング スコア[0]': 1 }, { fixChecksums: false });
  const v3 = openView(msx, e, nofix);
  assert.equal(checksumStatus(msx, v3.bytes, v3.base)[0].ok, false);
});

test('セーブが無いカード・別ファイル名には一致しない', () => {
  const vmu = vmuWithCard(makeCard([]));
  const e = vmu.find('BLEEMMC');
  assert.equal(matches(msx, e, vmu.readFile(e)), false);
  const vmu2 = vmuWithCard(testSave(), 'OTHER');
  const e2 = vmu2.find('OTHER');
  assert.equal(matches(msx, e2, vmu2.readFile(e2)), false);
});

test('圧縮後に大きくなったら置き換え、空きが無ければ何も変えない', () => {
  // ほぼ 0 のカード → 値をばらばらにすると RLE が大きくなる
  const card = makeCard([{ name: 'BASLUS-01212', slots: [1], fill: 0 }]);
  const def = {
    id: 'grow', title: 'grow', match: { fileName: '^BLEEMMC$' }, container: { type: 'bleem-mc', ps1Save: '^BASLUS' },
    base: 'file', fields: [{ name: 'raw', offset: 0, type: 'bytes', length: 1024 }],
  };
  assert.deepEqual(validateDef(def), []);
  const noisy = Array.from({ length: 1024 }, (_, i) => ((i * 37) & 0xff).toString(16).padStart(2, '0')).join('');

  const vmu = vmuWithCard(card);
  const e = vmu.find('BLEEMMC');
  const edited = setFields(vmu.readFile(e), def, e, { raw: noisy });
  assert.ok(Math.ceil(edited.length / BLOCK_SIZE) > e.sizeBlocks);
  const { resized } = applyEdit(vmu, e, edited);
  assert.equal(resized, true);
  assert.ok(vmu.find('BLEEMMC').sizeBlocks > e.sizeBlocks);
  assert.deepEqual(vmu.check(), []);

  // 空きを埋めてから同じ編集 → エラーで元のまま
  const full = vmuWithCard(card);
  const ef = full.find('BLEEMMC');
  full.writeFile('FILLER', new Uint8Array(full.freeBlocks().length * BLOCK_SIZE));
  const before = full.toBytes();
  assert.throws(() => applyEdit(full, ef, setFields(full.readFile(ef), def, ef, { raw: noisy })), /空き容量不足/);
  assert.deepEqual(full.toBytes(), before);
});

test('コンテナ・チェックサム定義の検証', () => {
  const errs = validateDef({
    id: 'x', title: 'x', match: { fileName: 'X' }, base: 'data', container: { type: 'zip', ps1Save: '(' },
    checksums: [{ type: 'md5', store: 's16le', from: 10, to: 5, at: 0 }, { type: 'sum8', store: 'u16le', from: 0, to: 10, at: 4 }],
    fields: [{ name: 'a', offset: 0, type: 'u8' }],
  }).join('\n');
  for (const s of ['container.type', 'base は "file"', 'ps1Save', 'checksums\\[0\\]: type', '符号なし', 'from < to', '重なって']) {
    assert.match(errs, new RegExp(s), s);
  }
});

test('非コンテナ定義でもチェックサムを適用できる', () => {
  const def = {
    id: 'c', title: 'c', match: { fileName: '^C$' }, base: 'file',
    checksums: [{ type: 'xor8', from: 0, to: 4, at: 4, store: 'u8' }],
    fields: [{ name: 'v', offset: 0, type: 'u32le' }],
  };
  const vmu = Vmu.format();
  const e = vmu.writeFile('C', new Uint8Array(8));
  const out = setFields(vmu.readFile(e), def, e, { v: '0x01020304' });
  assert.equal(out[4], 1 ^ 2 ^ 3 ^ 4);
  const b = Uint8Array.from(out);
  b[0] = 0;
  assert.equal(applyChecksums(def, b, 0)[0].bytes[0], 1 ^ 2 ^ 3);
});
