import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'dcvmu-hist-'));
process.env.DCVMU_HISTORY_DIR = join(work, 'history');
const { backup, listHistory, resolveImageSpec, restore } = await import('../src/history-node.js');
after(() => rmSync(work, { recursive: true, force: true }));

test('バックアップ・一覧・@番号・復元', () => {
  const img = join(work, 'a.bin');
  writeFileSync(img, 'v1');
  backup(img, 'first');
  writeFileSync(img, 'v2');
  backup(img, 'second');
  writeFileSync(img, 'v3');
  const h = listHistory(img);
  assert.deepEqual(h.map((v) => [v.id, v.note]), [[1, 'first'], [2, 'second']]);
  assert.equal(readFileSync(resolveImageSpec(`${img}@1`), 'utf8'), 'v1');
  assert.equal(resolveImageSpec(img), img);
  assert.throws(() => resolveImageSpec(`${img}@9`), /版 9/);
  const r = restore(img, 1);
  assert.equal(readFileSync(img, 'utf8'), 'v1');
  assert.equal(readFileSync(r.backup.path, 'utf8'), 'v3'); // 戻す前の状態も残る
  assert.equal(backup(join(work, 'none.bin')), null);
});

test('CLI: 書き換えのたびに自動バックアップ、履歴の版は書き換え不可', () => {
  const img = join(work, 'cli.bin');
  writeFileSync(img, readFileSync(join(ROOT, 'test/fixtures/sample.bin')));
  const run = (...args) => spawnSync(process.execPath, ['cli.js', ...args], { cwd: ROOT, encoding: 'utf8', env: process.env });
  assert.equal(run('set', img, 'DCVMU_SAVE01', '所持金=1').status, 0);
  assert.equal(run('delete', img, 'DCVMU_ONE').status, 0);
  const hist = run('history', img);
  assert.match(hist.stdout, /1 .*set/);
  assert.match(hist.stdout, /2 .*delete/);
  const ro = run('set', `${img}@1`, 'DCVMU_SAVE01', '所持金=2');
  assert.equal(ro.status, 1);
  assert.match(ro.stderr, /書き換えられません/);
  assert.equal(existsSync(`${img}@1`), false);
  const diff = run('diff', `${img}@1`, img, 'DCVMU_SAVE01');
  assert.match(diff.stdout, /所持金/);
});
