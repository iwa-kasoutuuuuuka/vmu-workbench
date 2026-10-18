import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { buildGame } from '../src/vmugame.js';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = '.emu/work/mcp-test';

// MCP サーバーを実際に起動して stdio の JSON-RPC で話す
const server = spawn(process.execPath, ['mcp/server.js'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
createInterface({ input: server.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});
let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
async function call(name, args) {
  const res = await rpc('tools/call', { name, arguments: args });
  const text = res.result.content[0].text;
  return { isError: res.result.isError, text, json: res.result.isError ? null : (() => { try { return JSON.parse(text); } catch { return text; } })() };
}
after(() => {
  server.kill();
  rmSync(`${ROOT}/${OUT}`, { recursive: true, force: true });
});

const IMG = 'test/fixtures/sample.bin';

test('initialize と tools/list', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'dc-vmu');
  assert.ok(init.result.capabilities.tools);
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const list = await rpc('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  for (const n of ['vmu_list', 'vmu_fields', 'vmu_diff', 'vmu_find', 'vmu_scan', 'vmu_set', 'vmu_patch', 'vmu_variants', 'vmu_def_save', 'vmu_bleem_run']) {
    assert.ok(names.includes(n), n);
  }
  assert.ok(list.result.tools.every((t) => t.inputSchema?.type === 'object'));
  const bad = await rpc('nope', {});
  assert.equal(bad.error.code, -32601);
});

test('vmu_list / vmu_fields', async () => {
  const l = await call('vmu_list', { image: IMG });
  assert.equal(l.isError, false);
  const save = l.json.files.find((f) => f.name === 'DCVMU_SAVE01');
  assert.deepEqual(save.defs, ['dcvmu-test']);
  assert.equal(save.crc, 'ok');
  const f = await call('vmu_fields', { image: IMG, file: 'DCVMU_SAVE01' });
  const money = f.json.groups.flatMap((g) => g.fields).find((x) => x.name === '所持金');
  assert.equal(money.value, '1500');
  assert.ok(Array.isArray(f.json.uncovered));
});

test('vmu_find (複数セーブの値の対応) と vmu_diff', async () => {
  const s = await call('vmu_set', { image: IMG, file: 'DCVMU_SAVE01', assignments: { 所持金: 4321 }, out: `${OUT}/money.bin` });
  assert.equal(s.isError, false);
  assert.equal(s.json.out.replace(/\\/g, '/'), `${OUT}/money.bin`);
  const hits = await call('vmu_find', { images: [IMG, `${OUT}/money.bin`], file: 'DCVMU_SAVE01', values: [1500, 4321] });
  // どちらの値も 16bit に収まるので u16le でも一致する
  assert.deepEqual(hits.json.hits.map((h) => [h.offset, h.type]), [['0x0280', 'u16le'], ['0x0280', 'u32le']]);
  assert.deepEqual(hits.json.hits[0].labels, ['所持金']);
  const d = await call('vmu_diff', { a: IMG, b: `${OUT}/money.bin`, file: 'DCVMU_SAVE01' });
  assert.ok(d.json.diffs.some((x) => x.labels.includes('所持金')));
});

test('vmu_patch / vmu_variants はチェックサム・CRC を更新し入力を変えない', async () => {
  const v = await call('vmu_variants', {
    image: IMG, file: 'DCVMU_SAVE01', outDir: `${OUT}/v`,
    variants: [{ name: 'a', patches: [{ offset: 0x280, hex: 'FF' }] }, { name: 'b', patches: [{ offset: 0x290, fill: '41', length: 4 }] }],
  });
  assert.equal(v.isError, false);
  assert.equal(v.json.length, 2);
  assert.ok(v.json.every((x) => x.crc !== null));
  const l = await call('vmu_list', { image: `${OUT}/v/a.bin` });
  assert.equal(l.json.files.find((f) => f.name === 'DCVMU_SAVE01').crc, 'ok');
  const dump = await call('vmu_dump', { image: `${OUT}/v/b.bin`, file: 'DCVMU_SAVE01', offset: 0x290, length: 16 });
  assert.match(dump.text, /41 41 41 41/);
  const orig = await call('vmu_fields', { image: IMG, file: 'DCVMU_SAVE01' });
  assert.equal(orig.json.groups.flatMap((g) => g.fields).find((x) => x.name === '所持金').value, '1500');
});

test('書き込み先はプロジェクト内のみ・不正な入力はエラー', async () => {
  const outside = await call('vmu_set', { image: IMG, file: 'DCVMU_SAVE01', assignments: { 所持金: 1 }, out: join(tmpdir(), 'vmuwb-outside.bin') }); // どの OS でもプロジェクトの外になる絶対パス
  assert.equal(outside.isError, true);
  assert.match(outside.text, /プロジェクトのフォルダ/);
  const missing = await call('vmu_fields', { image: IMG, file: 'NOPE' });
  assert.equal(missing.isError, true);
  const badDef = await call('vmu_def_validate', { def: { id: 'x', title: 'x', match: {}, fields: [] } });
  assert.ok(badDef.json.errors.length > 0);
});

test('vmu_scan と vmu_def_validate', async () => {
  const s = await call('vmu_scan', { image: IMG, file: 'DCVMU_SAVE01' });
  assert.ok(s.json.strings.some((x) => x.text.includes('SONIC')));
  const v = await call('vmu_def_validate', {
    def: { id: 'tmp', title: 't', match: { fileName: '^DCVMU_SAVE01$' }, base: 'data', fields: [{ name: 'm', offset: 0, type: 'u32le' }] },
    image: IMG, file: 'DCVMU_SAVE01',
  });
  assert.deepEqual(v.json.errors, []);
  assert.deepEqual(v.json.sample, ['m = 1500']);
  assert.equal(existsSync(`${ROOT}/defs/tmp.json`), false); // validate は保存しない
});

test('エージェント向けの設定・手順書', async () => {
  const { readFileSync } = await import('node:fs');
  // Claude Code 用と Antigravity 用の skill は同じ内容に保つ
  assert.equal(readFileSync(`${ROOT}/.claude/skills/vmu-save-analysis/SKILL.md`, 'utf8'), readFileSync(`${ROOT}/.agent/skills/vmu-save-analysis/SKILL.md`, 'utf8'));
  for (const f of ['.mcp.json', 'mcp/antigravity.mcp.json']) {
    const cfg = JSON.parse(readFileSync(`${ROOT}/${f}`, 'utf8'));
    // 設定の絶対パスはこの PC 用 (D:/DC_VMU)。どこに clone しても通るよう、mcp/server.js を指していることだけ確かめる
    const script = cfg.mcpServers['dc-vmu'].args[0].replace(/\\/g, '/');
    assert.match(script, /(^|\/)mcp\/server\.js$/, `${f}: ${script}`);
    assert.ok(existsSync(`${ROOT}/mcp/server.js`));
  }
});

test('不正な JSON-RPC・バッチでも落ちない', async () => {
  const replies = [];
  const got = new Promise((resolve) => {
    const onLine = (line) => {
      const msg = JSON.parse(line);
      if (Array.isArray(msg) || msg.id === null) {
        replies.push(msg);
        if (replies.length === 2) resolve();
      }
    };
    createInterface({ input: server.stdout }).on('line', onLine);
  });
  server.stdin.write('null\n');
  server.stdin.write(`${JSON.stringify([{ jsonrpc: '2.0', id: 900, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }])}\n`);
  await got;
  assert.equal(replies.find((r) => !Array.isArray(r)).error.code, -32600);
  const batch = replies.find(Array.isArray);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].id, 900);
  const alive = await rpc('ping', {});
  assert.deepEqual(alive.result, {});
});

test('書き込み先の制限とパッチの検証', async () => {
  for (const out of ['src/vmu.js', 'defs/x.bin', 'test/fixtures/sample.bin', `${OUT}/x.json`]) {
    const r = await call('vmu_patch', { image: IMG, file: 'DCVMU_SAVE01', patches: [{ offset: 0x280, hex: 'FF' }], out });
    assert.equal(r.isError, true, out);
  }
  const noOffset = await call('vmu_patch', { image: IMG, file: 'DCVMU_SAVE01', patches: [{ hex: 'FF' }], out: `${OUT}/p.bin` });
  assert.match(noOffset.text, /offset/);
  const noLen = await call('vmu_patch', { image: IMG, file: 'DCVMU_SAVE01', patches: [{ offset: 0, fill: 'FF' }], out: `${OUT}/p.bin` });
  assert.match(noLen.text, /length/);
  assert.equal(existsSync(`${ROOT}/${OUT}/p.bin`), false);
});

test('vmu_run_game: デモのミニゲームを動かして LCD を返す', async () => {
  mkdirSync(`${ROOT}/${OUT}`, { recursive: true });
  writeFileSync(`${ROOT}/${OUT}/hello.vms`, buildGame(readFileSync(`${ROOT}/examples/hello-vmu.s`, 'utf8')).bytes);
  const r = await call('vmu_run_game', { image: `${OUT}/hello.vms`, seconds: 1, keys: '0.3:right,0.6:', png: `${OUT}/lcd.png` });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.lcdOn, true);
  assert.match(r.json.lcd.split('\n')[4], /^\.{24}#{8}\.{16}$/);
  assert.equal(r.json.state.stopReason, null);
  assert.ok(existsSync(`${ROOT}/${OUT}/lcd.png`));
  const bad = await call('vmu_run_game', { image: `${OUT}/hello.vms`, png: 'src/x.png' });
  assert.equal(bad.isError, true);
  const badKey = await call('vmu_run_game', { image: `${OUT}/hello.vms`, keys: '1:jump' });
  assert.match(badKey.text, /知らないボタン/);
});
