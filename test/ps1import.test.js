import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Vmu } from '../src/vmu.js';
import { CONTAINERS, PS1_CARD_SIZE, PS1_BLOCK_SIZE } from '../src/containers.js';
import { replaceFit, assertFits } from '../src/edit.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'dcvmu-ps1imp-'));
const env = { ...process.env, DCVMU_HISTORY_DIR: join(work, 'history') };
after(() => rmSync(work, { recursive: true, force: true }));
const rle = CONTAINERS['bleem-mc'];
const run = (...args) => spawnSync(process.execPath, ['cli.js', ...args], { cwd: ROOT, encoding: 'utf8', env });

/** saves 個のセーブ (1 ブロックずつ、RLE で縮まない値) を入れた PS1 カード */
function makeCard(saves) {
  const card = new Uint8Array(PS1_CARD_SIZE);
  card[0] = 0x4d;
  card[1] = 0x43;
  let x = 12345;
  for (let s = 1; s <= 15; s++) {
    const d = s * 128;
    card[d + 8] = 0xff;
    card[d + 9] = 0xff;
    if (s > saves) {
      card[d] = 0xa0;
      continue;
    }
    card[d] = 0x51;
    card[d + 5] = PS1_BLOCK_SIZE >> 8;
    const name = `BASLUS-0000${s}`;
    for (let k = 0; k < name.length; k++) card[d + 10 + k] = name.charCodeAt(k);
    for (let i = 0; i < PS1_BLOCK_SIZE; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      card[s * PS1_BLOCK_SIZE + i] = x >>> 24;
    }
  }
  return card;
}

/** 3 ブロックの BLEEMMC (空のカード) があり、空きが free ブロックの VMU を作ってファイルに書く */
function setup(name, card, free, { withFile = true } = {}) {
  const vmu = Vmu.format();
  if (withFile) vmu.writeFile('BLEEMMC', rle.encode(makeCard(0)));
  const fill = vmu.freeBlocks().length - free;
  if (fill > 0) vmu.writeFile('FILLER', new Uint8Array(fill * 512));
  assert.equal(vmu.freeBlocks().length, free);
  const img = join(work, `${name}.bin`);
  const mcr = join(work, `${name}.mcr`);
  writeFileSync(img, vmu.toBytes());
  writeFileSync(mcr, card);
  return { img, mcr };
}

const card = makeCard(2);
const needed = Math.ceil(rle.encode(card).length / 512);
const current = Math.ceil(rle.encode(makeCard(0)).length / 512);

test('ps1-import: 空き + 今のファイルにちょうど入る', () => {
  const { img, mcr } = setup('exact', card, needed - current);
  const r = run('ps1-import', img, 'BLEEMMC', mcr);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`${needed} ブロック使用`));
  assert.match(r.stdout, /空き: 0 \/ 200 ブロック/);
  const vmu = new Vmu(readFileSync(img));
  const e = vmu.find('BLEEMMC');
  assert.equal(e.sizeBlocks, needed);
  assert.deepEqual(rle.decode(vmu.readFile(e)), card);
  assert.deepEqual(vmu.check(), []);
});

test('ps1-import: 大きくなった分を空きに広げる', () => {
  const { img, mcr } = setup('grow', card, needed - current + 5);
  const r = run('ps1-import', img, 'BLEEMMC', mcr);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /空き: 5 \/ 200 ブロック/);
  const vmu = new Vmu(readFileSync(img));
  assert.equal(vmu.find('BLEEMMC').sizeBlocks, needed);
  assert.deepEqual(rle.decode(vmu.readFile(vmu.find('BLEEMMC'))), card);
});

test('ps1-import: 入らなければエラーで止まり、イメージも履歴も変えない', () => {
  const { img, mcr } = setup('full', card, needed - current - 1);
  const before = readFileSync(img);
  const r = run('ps1-import', img, 'BLEEMMC', mcr);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`${needed} ブロック必要ですが、使えるのは ${needed - 1} ブロック`));
  assert.match(r.stderr, /あと 1 ブロック空けてください/);
  assert.deepEqual(readFileSync(img), before);
  assert.doesNotMatch(run('history', img).stdout, /ps1-import/);

  // 新しく作る場合 (今のファイルなし) も同じ
  const n = setup('new', card, needed - 1, { withFile: false });
  const before2 = readFileSync(n.img);
  const r2 = run('ps1-import', n.img, 'BLEEMMC', n.mcr);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, new RegExp(`使えるのは ${needed - 1} ブロック \\(空き ${needed - 1}\\)`));
  assert.deepEqual(readFileSync(n.img), before2);
});

test('replaceFit / assertFits: 空き + 置き換えるファイルのブロックで判定', () => {
  const vmu = Vmu.format();
  const e = vmu.writeFile('A', new Uint8Array(512 * 3));
  vmu.writeFile('B', new Uint8Array(512 * (vmu.freeBlocks().length - 2)));
  assert.deepEqual(replaceFit(vmu, e, 512 * 5), { needed: 5, current: 3, free: 2, available: 5, fits: true });
  assert.equal(replaceFit(vmu, null, 512 * 3).fits, false);
  assert.throws(() => assertFits(vmu, e, 512 * 5 + 1), /A には 6 ブロック必要ですが、使えるのは 5 ブロック \(空き 2 \+ 今の A 3\)/);
  assert.throws(() => assertFits(vmu, e, 512 * 201), /VMU 全体/);
});
