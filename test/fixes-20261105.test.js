// 2026-11-05 の総点検で見つかった不具合の再発防止
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { createInterface } from 'node:readline';
import { Vmu, FILE_GAME, VmuError, decodeTimestamp } from '../src/vmu.js';
import { editVms } from '../src/vmsedit.js';
import { applyEdit } from '../src/edit.js';
import { buildGame } from '../src/vmugame.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORK = '.emu/work/fixes-test';

test('ミニゲームの説明文を変えてもプログラム (アイコンより後ろ) が消えない', () => {
  const game = buildGame(readFileSync(`${ROOT}/examples/hello-vmu.s`, 'utf8')).bytes;
  const vmu = Vmu.format();
  vmu.writeFile('HELLO', game, { type: FILE_GAME, headerOffset: 1 });
  const e = vmu.find('HELLO');
  const before = vmu.readFile(e);
  const edited = editVms(before, e, { description: 'CHANGED' });
  applyEdit(vmu, e, edited);
  const after = vmu.readFile(vmu.find('HELLO'));
  assert.equal(after.length, before.length);
  assert.deepEqual(after.subarray(0x500), before.subarray(0x500)); // プログラム本体
  assert.notDeepEqual(after.subarray(0x200, 0x210), before.subarray(0x200, 0x210)); // 説明文は変わった
  // コマ数を変えるとプログラムの位置がずれるので止める
  const frames = Array.from({ length: 2 }, () => new Uint8Array(32 * 32));
  assert.throws(() => editVms(before, e, { frames }), /コマ数は変えられません/);
});

test('並べ替え: 同じ名前を 2 回渡しても、同名のファイルが 2 つあっても、ファイルを消さない・重ねない', () => {
  let vmu = Vmu.format();
  vmu.writeFile('A', new Uint8Array(600));
  vmu.writeFile('B', new Uint8Array(100));
  vmu.reorder(['A', 'A']);
  assert.deepEqual(vmu.list().map((e) => e.name), ['A', 'B']);
  assert.deepEqual(vmu.check(), []);

  vmu = Vmu.format();
  vmu.writeFile('A', new Uint8Array(100));
  vmu.writeFile('B', new Uint8Array(100));
  vmu.data[vmu.dirEntryOffsets()[1] + 4] = 0x41; // 壊れたイメージ: B を A に
  vmu.reorder(['A']);
  assert.equal(vmu.list().length, 2);
});

test('FAT チェーンがディレクトリなどのシステム領域を指していたら、検出して書き換えない', () => {
  const vmu = Vmu.format();
  vmu.writeFile('A', new Uint8Array(1024).fill(0x11));
  const e = vmu.find('A');
  vmu.setFat(e.firstBlock, 253); // 2 ブロック目をディレクトリのブロックに付け替える (サイズは 2 のまま)
  vmu.setFat(253, 0xfffa);
  assert.match(vmu.check().join('\n'), /システムのブロック|システム領域/);
  const dir = vmu.data.slice(253 * 512, 254 * 512);
  assert.throws(() => applyEdit(vmu, vmu.find('A'), new Uint8Array(1024).fill(0xee), { fixCrc: false }), VmuError);
  assert.deepEqual(vmu.data.slice(253 * 512, 254 * 512), dir);
});

test('ルートブロックの FAT・ディレクトリの位置が壊れていたら、わかるエラーにする', () => {
  let vmu = Vmu.format();
  vmu.view.setUint16(255 * 512 + 0x4a, 5, true);
  assert.throws(() => vmu.list(), VmuError);
  assert.match(vmu.check().join('\n'), /ディレクトリの位置/);
  vmu = Vmu.format();
  vmu.view.setUint16(255 * 512 + 0x46, 400, true);
  assert.throws(() => vmu.freeBlocks(), VmuError);
});

test('BCD としては正しくても範囲外の日時 (0 月・13 月・25 時) は null', () => {
  assert.equal(decodeTimestamp(Uint8Array.of(0x20, 0x26, 0x00, 0x00, 0, 0, 0, 0)), null);
  assert.equal(decodeTimestamp(Uint8Array.of(0x20, 0x26, 0x13, 0x01, 0, 0, 0, 0)), null);
  assert.equal(decodeTimestamp(Uint8Array.of(0x20, 0x26, 0x11, 0x05, 0x25, 0, 0, 0)), null);
});

test('GUI サーバー: .emu (大文字でも)・.git を出さない、壊れた URL で落ちない、localhost 以外の Host を断る', async () => {
  const port = 18700 + Math.floor(Math.random() * 500);
  const srv = spawn(process.execPath, ['serve.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve) => srv.stdout.once('data', resolve));
    const get = (path, host) => new Promise((resolve) => {
      const q = request({ host: '127.0.0.1', port, path, headers: host ? { Host: host } : {} }, (r) => { r.resume(); resolve(r.statusCode); });
      q.on('error', (err) => resolve(err.code));
      q.end();
    });
    assert.equal(await get('/'), 200);
    assert.equal(await get('/.EMU/emu.cfg'), 403);
    assert.equal(await get('/.emu/emu.cfg'), 403);
    assert.equal(await get('/.Git/config'), 403);
    assert.equal(await get('/%E0%A4%A'), 400);
    assert.equal(await get('/', 'evil.example'), 403);
    assert.equal(await get('/app.js'), 200); // まだ動いている
  } finally {
    srv.kill();
  }
});

test('MCP: バッチの処理中に来た別の要求の応答がバッチに混ざらない / "x.bin#0" を x.bin に書かない', async () => {
  const srv = spawn(process.execPath, ['mcp/server.js'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  const waiters = [];
  createInterface({ input: srv.stdout }).on('line', (l) => { lines.push(JSON.parse(l)); waiters.splice(0).forEach((w) => w()); });
  const until = async (pred) => { while (!pred()) await new Promise((r) => waiters.push(r)); };
  const send = (m) => srv.stdin.write(`${JSON.stringify(m)}\n`);
  try {
    send([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vmu_list', arguments: { image: 'test/fixtures/sample.bin' } } }]);
    send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await until(() => lines.length >= 2);
    const single = lines.find((m) => !Array.isArray(m));
    const batch = lines.find((m) => Array.isArray(m));
    assert.equal(single?.id, 2);
    assert.deepEqual(batch.map((m) => m.id), [1]);

    mkdirSync(`${ROOT}/${WORK}`, { recursive: true });
    copyFileSync(`${ROOT}/test/fixtures/sample.bin`, `${ROOT}/${WORK}/s.bin`);
    const orig = readFileSync(`${ROOT}/${WORK}/s.bin`);
    for (const [id, spec] of [[3, 's.bin#0']]) {
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'vmu_patch', arguments: {
        image: `${WORK}/${spec}`, file: 'DCVMU_SAVE01', patches: [{ offset: 0, hex: 'FF' }], out: `${WORK}/s.bin` } } });
      await until(() => lines.some((m) => m.id === id));
      const res = lines.find((m) => m.id === id).result;
      assert.equal(res.isError, true, spec);
      assert.match(res.content[0].text, /上書きできません/, spec);
    }
    assert.deepEqual(readFileSync(`${ROOT}/${WORK}/s.bin`), orig);
  } finally {
    srv.kill();
    rmSync(`${ROOT}/${WORK}`, { recursive: true, force: true });
  }
});
