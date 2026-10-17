import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Vmu } from '../src/vmu.js';
import { CONTAINERS, PS1_CARD_SIZE, PS1_BLOCK_SIZE } from '../src/containers.js';
import { lookupTitle, ps1Saves } from '../src/titles.js';
import { loadTitles } from '../src/titles-node.js';
import { byteVariability, hotRanges } from '../src/analyze.js';

const db = loadTitles();
const sample = new Vmu(readFileSync(new URL('./fixtures/sample.bin', import.meta.url)));

test('タイトル DB は読めて、正規表現が正しい', () => {
  assert.ok(db.vmu.length > 0);
  for (const t of [...db.vmu, ...db.ps1]) {
    assert.ok(t.title && t.source, JSON.stringify(t));
    for (const re of Object.values(t.match)) new RegExp(re);
  }
});

test('タイトルの推定: DB → VMS ヘッダ → 不明', () => {
  const e = sample.find('DCVMU_SAVE01');
  assert.equal(lookupTitle(e, sample.readFile(e), db).title, 'DC_VMU: テスト用セーブ');
  // DB に無い名前でも VMS ヘッダから
  const vmu = Vmu.format();
  const other = vmu.writeFile('OTHERGAME', sample.readFile(e));
  const t = lookupTitle(other, vmu.readFile(other), db);
  assert.equal(t.title, 'DC_VMU TEST SAVE');
  assert.match(t.source, /VMS ヘッダ/);
  const raw = vmu.writeFile('RAW', new Uint8Array(10));
  assert.equal(lookupTitle(raw, vmu.readFile(raw), db).title, null);
});

test('bleem2 の PS1 カードは中のセーブ名・タイトルを出す', () => {
  const card = new Uint8Array(PS1_CARD_SIZE);
  card.set([0x4d, 0x43]);
  const d = 128;
  card[d] = 0x51;
  card[d + 8] = 0xff;
  card[d + 9] = 0xff;
  card.set([...'BASLUS-01212'].map((c) => c.charCodeAt(0)), d + 10);
  card.set([0x53, 0x43, 0x11, 0x01, 0x82, 0x6c], PS1_BLOCK_SIZE); // "SC" + Ｍ
  const vmu = Vmu.format();
  const e = vmu.writeFile('BLEEMMC', CONTAINERS['bleem-mc'].encode(card));
  const t = lookupTitle(e, vmu.readFile(e), db);
  assert.equal(t.title, 'bleem2: PS1 メモリーカード (RLE 圧縮)');
  assert.equal(t.detail, 'METAL SLUG X (USA)');
  assert.equal(ps1Saves(card, db)[0].saveTitle, 'Ｍ');
});

test('変化ヒートマップ', () => {
  const a = Uint8Array.of(0, 0, 0, 0, 0, 0);
  const b = Uint8Array.of(1, 0, 0, 5, 5, 0);
  const c = Uint8Array.of(2, 0, 0, 5, 6, 0);
  const v = byteVariability([a, b, c]);
  assert.deepEqual([...v.changes], [2, 0, 0, 1, 2, 0]);
  assert.equal(v.compared, 2);
  const r = hotRanges(v.changes);
  // 最大回数が同じなら合計の多い範囲が先
  assert.deepEqual(r.map((x) => [x.start, x.end, x.max]), [[3, 5, 2], [0, 1, 2]]);
  assert.deepEqual(hotRanges(v.changes, { min: 2 }).map((x) => [x.start, x.end]), [[0, 1], [4, 5]]);
  assert.throws(() => byteVariability([a]), /2 つ以上/);
});
