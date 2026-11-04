// dc/savemgr/httpd.c (Dreamcast 本体の HTTP サーバ) を PC 用にビルドし (host/http_host.c がファイルを VMU として見せる)、
// API の答えが vmu.js と同じか、src/dcclient.js と node cli.js dc ... で読めるかを確かめる。
// C コンパイラが無ければ飛ばす (VMUCORE_CC で指定できる)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vmu, FILE_GAME, IMAGE_SIZE } from '../src/vmu.js';
import { parseHeader, headerPosition, crcRangeValid, calcCrc, updateCrc, toDci } from '../src/vms.js';
import { crc32 } from '../src/crc32.js';
import { DcClient, DcError } from '../src/dcclient.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'dc', 'savemgr');

function findCompiler() {
  for (const cc of [process.env.VMUCORE_CC, 'gcc', 'cc', 'C:/DreamSDK/mingw64/bin/gcc.exe', 'C:/msys64/mingw64/bin/gcc.exe'].filter(Boolean)) {
    const env = { ...process.env };
    if (cc.includes('/')) env.PATH = path.dirname(cc) + path.delimiter + env.PATH;
    if (spawnSync(cc, ['--version'], { env }).status === 0) return { cc, env };
  }
  return null;
}
const compiler = findCompiler();
const skip = !compiler && 'C コンパイラが無い';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'savemgr-http-'));
const vmuDir = path.join(work, 'vmu');
fs.mkdirSync(vmuDir);
let server = null;
let base = '';

// ---- テスト用の VMU ----
// A1: make-test-image.js (コピー禁止・断片化・アイコン 3 枚・CRC 不一致) + Shift-JIS の説明 + 空白入りの名前 + ミニゲーム
const a1Path = path.join(vmuDir, 'a1.bin');
spawnSync(process.execPath, [path.join(root, 'scripts', 'make-test-image.js'), a1Path]);
const a1 = new Vmu(fs.readFileSync(a1Path));
{
  const f = new Uint8Array(0x80 + 512 + 100);
  const sj = Buffer.from([0x83, 0x5c, 0x83, 0x6a, 0x83, 0x62, 0x83, 0x4e]);   // ソニック (2 バイト目に 0x5C)
  f.fill(0x20, 0, 0x30);
  f.set(sj, 0);
  f.set(Buffer.from('JAPANESE DESC'), 0x10);
  new DataView(f.buffer).setUint16(0x40, 1, true);
  new DataView(f.buffer).setUint32(0x48, 100, true);
  updateCrc(f, parseHeader(f));
  a1.writeFile('SJIS SAVE', f, { date: new Date(2026, 10, 3, 12, 34, 56) });
  const game = new Uint8Array(512 * 3);
  game.set(f.subarray(0, 0x80 + 512), 512);
  a1.writeFile('GAMEFILE', game, { type: FILE_GAME, headerOffset: 1 });
  fs.writeFileSync(a1Path, a1.toBytes());
}
// A2: 未フォーマット (0 埋め)、B1: 大きさ違い (読めない)、ほかは挿さっていない
fs.writeFileSync(path.join(vmuDir, 'a2.bin'), new Uint8Array(IMAGE_SIZE));
fs.writeFileSync(path.join(vmuDir, 'b1.bin'), new Uint8Array(1000));

async function startServer() {
  if (server) return;
  const inc = path.join(work, 'inc');
  fs.mkdirSync(inc, { recursive: true });
  // mkwww.py と同じ形の www.h (Python が無くてもテストできるように JS で作る)
  const page = fs.readFileSync(path.join(src, 'www', 'index.html'));
  fs.writeFileSync(path.join(inc, 'www.h'), `static const unsigned char www_index[] = {${[...page].join(',')}};\nstatic const unsigned int www_index_len = ${page.length};\n`);
  const exe = path.join(work, process.platform === 'win32' ? 'http_host.exe' : 'http_host');
  const libs = process.platform === 'win32' ? ['-lws2_32'] : [];
  const r = spawnSync(compiler.cc, ['-O1', '-Wall', '-Wextra', '-Werror', '-std=gnu99', '-I', inc, '-o', exe,
    path.join(src, 'host', 'http_host.c'), path.join(src, 'httpd.c'), path.join(src, 'vmucore.c'), ...libs], { env: compiler.env, encoding: 'utf8' });
  assert.equal(r.status, 0, `ビルドに失敗:\n${r.stderr}`);
  server = spawn(exe, [vmuDir, '0'], { env: compiler.env });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    server.stdout.on('data', (d) => {
      out += d;
      const m = /LISTENING (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    server.on('exit', (c) => reject(new Error(`サーバが終了 (${c})`)));
    setTimeout(() => reject(new Error('サーバが起動しない')), 10000);
  });
  base = `127.0.0.1:${port}`;
}

test.after(() => {
  if (server) server.kill();
  fs.rmSync(work, { recursive: true, force: true });
});

test('httpd: /api/info がスロットの様子を返す', { skip }, async () => {
  await startServer();
  const info = await new DcClient(base).info();
  assert.equal(info.app, 'savemgr');
  const s = Object.fromEntries(info.slots.map((x) => [x.slot, x]));
  assert.equal(info.slots.length, 8);
  assert.equal(s.a1.present, true);
  assert.equal(s.a1.formatted, true);
  assert.equal(s.a1.free, a1.freeBlocks().length);
  assert.equal(s.a1.files, a1.list().length);
  assert.equal(s.a1.etag, crc32(a1.data).toString(16).padStart(8, '0'));
  assert.equal(s.a1.volume, Buffer.from(a1.data.subarray(255 * 512 + 0x30, 255 * 512 + 0x38)).toString('hex'));
  assert.equal(s.a2.formatted, false);
  assert.equal(s.b1.readable, false);
  assert.equal(s.b2.present, false);
});

test('httpd: ファイル一覧が vmu.js と同じ', { skip }, async () => {
  await startServer();
  const list = await new DcClient(base).list('A1');
  const expected = a1.list();
  assert.equal(list.files.length, expected.length);
  assert.equal(list.free, a1.freeBlocks().length);
  const frag = new Set(a1.fragmented().map((e) => e.slot));
  for (const [i, e] of expected.entries()) {
    const f = list.files[i];
    assert.equal(f.name, e.name);
    assert.equal(f.dirSlot, e.slot);
    assert.equal(f.type, e.type === FILE_GAME ? 'game' : 'data');
    assert.equal(f.protected, e.copyProtected);
    assert.equal(f.blocks, e.sizeBlocks);
    assert.equal(f.firstBlock, e.firstBlock);
    assert.equal(f.fragmented, frag.has(e.slot));
    const ts = e.timestamp;
    const p = (n) => String(n).padStart(2, '0');
    assert.equal(f.date, `${ts.getFullYear()}-${p(ts.getMonth() + 1)}-${p(ts.getDate())}T${p(ts.getHours())}:${p(ts.getMinutes())}:${p(ts.getSeconds())}`);
    const data = a1.readFile(e);
    const h = parseHeader(data, headerPosition(e));
    assert.equal(f.header, !!(h && h.valid), e.name);
    if (f.header) {
      assert.equal(f.desc, h.description, e.name);
      assert.equal(f.longDesc, h.longDescription, e.name);
      assert.equal(f.icons, h.iconCount);
      assert.equal(f.crc, crcRangeValid(data, h) ? (calcCrc(data, h) === h.crc ? 'ok' : 'bad') : 'none', e.name);
    }
  }
  assert.equal(list.files.find((f) => f.name === 'SJIS SAVE').desc, 'ソニック');
  assert.equal(list.files.find((f) => f.name === 'DCVMU_BADCRC').crc, 'bad');
  assert.equal(list.files.find((f) => f.name === 'GAMEFILE').header, true);
});

test('httpd: イメージとファイル (raw / dci) がバイト単位で同じ', { skip }, async () => {
  await startServer();
  const dc = new DcClient(base);
  const img = await dc.image('a1');
  assert.deepEqual(img.bytes, a1.data);
  assert.equal(img.etag, crc32(a1.data).toString(16).padStart(8, '0'));
  for (const e of a1.list()) {
    const raw = await dc.file('a1', e.name, 'raw');
    assert.deepEqual(raw.bytes, a1.readFile(e), e.name);
    const dci = await dc.file('a1', e.name, 'dci');
    assert.deepEqual(dci.bytes, toDci(e, a1.readFile(e)), e.name);
  }
});

test('httpd: エラーと HEAD / OPTIONS / 書き込みの拒否', { skip }, async () => {
  await startServer();
  const dc = new DcClient(base);
  await assert.rejects(dc.list('b2'), (e) => e instanceof DcError && e.status === 404);
  await assert.rejects(dc.list('b1'), (e) => e.status === 503);
  await assert.rejects(dc.file('a1', 'NOPE'), (e) => e.status === 404);
  await assert.rejects(dc.json('/api/vmu/z9'), (e) => e.status === 404);
  const put = await fetch(`http://${base}/api/vmu/a1/image`, { method: 'PUT', body: 'x' });
  assert.equal(put.status, 405);
  const head = await fetch(`http://${base}/api/vmu/a1/image`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(IMAGE_SIZE));
  const opt = await fetch(`http://${base}/api/info`, { method: 'OPTIONS' });
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('access-control-allow-origin'), '*');
  const unformatted = await dc.list('a2');
  assert.equal(unformatted.formatted, false);
  const check = await dc.check('a1');
  assert.equal(check.count, a1.check().length);
});

test('httpd: 簡易 Web ページ', { skip }, async () => {
  await startServer();
  const r = await fetch(`http://${base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.equal(await r.text(), fs.readFileSync(path.join(src, 'www', 'index.html'), 'utf8'));
});

test('cli: dc info / list / pull / backup', { skip }, async () => {
  await startServer();
  const run = (...a) => {
    const r = spawnSync(process.execPath, [path.join(root, 'cli.js'), 'dc', ...a, '--host', base], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  assert.match(run('info'), /A1 +空き/);
  assert.match(run('list', 'a1'), /SJIS SAVE.*ソニック/);
  const out = path.join(work, 'pulled.bin');
  run('pull', 'a1', out);
  assert.deepEqual(new Uint8Array(fs.readFileSync(out)), a1.data);
  const dci = path.join(work, 'one.dci');
  run('pull', 'a1', 'SJIS SAVE', dci);
  const e = a1.find('SJIS SAVE');
  assert.deepEqual(new Uint8Array(fs.readFileSync(dci)), toDci(e, a1.readFile(e)));
  const bdir = path.join(work, 'backup');
  assert.match(run('backup', bdir), /2 個保存しました/);   // A1 と、読める未フォーマットの A2
  assert.match(run('backup', bdir), /前回と同じ/);
  const folders = fs.readdirSync(bdir).sort();
  assert.deepEqual(folders, ['vmu_20260101_120000', 'vmu_unknown']);
  const files = fs.readdirSync(path.join(bdir, folders[0]));
  assert.equal(files.length, 1);
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(bdir, folders[0], files[0]))), a1.data);
  // つながらないとき
  const r = spawnSync(process.execPath, [path.join(root, 'cli.js'), 'dc', 'info', '--host', '127.0.0.1:1'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /つながりません/);
});
