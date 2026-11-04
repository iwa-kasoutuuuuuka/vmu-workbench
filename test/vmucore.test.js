// dc/savemgr/vmucore.c (Dreamcast 本体で動くセーブマネージャの VMU 処理) が src/vmu.js と同じ結果になるか比べる。
// PC 用にビルドした dc/savemgr/host/vmucore_host に同じ操作をさせ、結果と 128KB のイメージを照合する。
// C コンパイラ (gcc) が無ければ飛ばす。VMUCORE_CC で指定できる (例: C:/DreamSDK/mingw64/bin/gcc.exe)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vmu, FILE_DATA, FILE_GAME, BLOCK_SIZE, encodeTimestamp } from '../src/vmu.js';
import { parseHeader, headerPosition, crcRangeValid, calcCrc, updateCrc, toDci, fromDci } from '../src/vms.js';

const SEEDS = Number(process.env.VMUCORE_SEEDS) || 80;   // 多めに試すとき: VMUCORE_SEEDS=2000
const SEED_FROM = Number(process.env.VMUCORE_SEED_FROM) || 1;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'dc', 'savemgr');

function findCompiler() {
  const candidates = [process.env.VMUCORE_CC, 'gcc', 'cc', 'C:/DreamSDK/mingw64/bin/gcc.exe', 'C:/msys64/mingw64/bin/gcc.exe'];
  for (const cc of candidates.filter(Boolean)) {
    const env = { ...process.env };
    if (cc.includes('/')) env.PATH = path.dirname(cc) + path.delimiter + env.PATH;
    const r = spawnSync(cc, ['--version'], { env, encoding: 'utf8' });
    if (r.status === 0) return { cc, env };
  }
  return null;
}

const compiler = findCompiler();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vmucore-'));
let hostExe = null;
let fileCounter = 0;

function build() {
  if (hostExe) return hostExe;
  const exe = path.join(work, process.platform === 'win32' ? 'vmucore_host.exe' : 'vmucore_host');
  const r = spawnSync(compiler.cc, ['-O1', '-Wall', '-Wextra', '-Werror', '-std=c99', '-o', exe,
    path.join(srcDir, 'host', 'vmucore_host.c'), path.join(srcDir, 'vmucore.c')], { env: compiler.env, encoding: 'utf8' });
  assert.equal(r.status, 0, `vmucore のビルドに失敗:\n${r.stderr}`);
  hostExe = exe;
  return exe;
}

test.after(() => fs.rmSync(work, { recursive: true, force: true }));

// ---- 乱数と操作の生成 ----

function rng(seed) {
  let x = seed >>> 0 || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  return { int: (n) => next() % n, pick: (a) => a[next() % a.length], chance: (p) => next() % 1000 < p * 1000 };
}

const hex = (b) => Buffer.from(b).toString('hex');
const hexName = (n) => Buffer.from(n, 'latin1').toString('hex') || '-';
const NAMES = ['SAVE01', 'SAVE02', 'SONICADV_INT', 'BLEEMMC', 'A', 'GAME', 'X_Y Z', 'LONGNAME1234', 'SAVE01  '];

function randomTs(r) {
  return encodeTimestamp(new Date(1999 + r.int(30), r.int(12), 1 + r.int(28), r.int(24), r.int(60), r.int(60)));
}

// VMS ヘッダ付きのデータ (CRC が正しいもの・壊れたもの・ヘッダ風でないもの)
function randomData(r, blocks, hdrBlock) {
  const len = blocks * BLOCK_SIZE - (r.chance(0.5) ? r.int(BLOCK_SIZE) : 0);
  const d = Uint8Array.from({ length: Math.max(1, len) }, () => r.int(256));
  const at = hdrBlock * BLOCK_SIZE;
  if (d.length >= at + 0x80 && r.chance(0.7)) {
    const v = new DataView(d.buffer);
    const text = (off, n, s) => { d.fill(0x20, at + off, at + off + n); for (let i = 0; i < s.length; i++) d[at + off + i] = s.charCodeAt(i); };
    text(0, 16, `DESC ${r.int(1000)}`);
    text(0x10, 32, `LONG DESCRIPTION ${r.int(1000)}`);
    text(0x30, 16, 'APPID');
    v.setUint16(at + 0x40, r.int(5), true);      // アイコン 0〜4 枚 (1〜3 が正しい)
    v.setUint16(at + 0x42, r.int(20), true);
    v.setUint16(at + 0x44, r.int(5), true);      // アイキャッチ 0〜4
    v.setUint32(at + 0x48, r.int(d.length), true);
    if (r.chance(0.6)) {
      const h = parseHeader(d, at);
      if (h && crcRangeValid(d, h)) updateCrc(d, h);
    }
  }
  return d;
}

function randomOps(r, count) {
  const ops = [{ op: 'format', ts: randomTs(r) }];
  for (let i = 0; i < count; i++) {
    const k = r.int(100);
    if (k < 45) {
      const game = r.chance(0.15);
      const blocks = r.chance(0.1) ? 40 + r.int(120) : 1 + r.int(game ? 24 : 16);
      const hdr = game ? 1 : 0;
      ops.push({ op: 'write', name: game && r.chance(0.5) ? 'GAME' : r.pick(NAMES), type: game ? FILE_GAME : FILE_DATA,
        prot: r.chance(0.2) ? 1 : 0, hdr, ow: r.chance(0.5) ? 1 : 0, ts: randomTs(r), data: randomData(r, blocks, hdr) });
    } else if (k < 65) ops.push({ op: 'delete', name: r.pick(NAMES).trim() });
    else if (k < 72) ops.push({ op: 'defrag' });
    else if (k < 80) ops.push({ op: 'reorder', pickSeed: r.int(1 << 30) });
    else if (k < 90) ops.push({ op: 'crc', name: r.pick(NAMES).trim() });
    else if (k < 95) ops.push({ op: 'dci', name: r.pick(NAMES).trim() });
    else ops.push({ op: 'undci', name: r.pick(NAMES).trim() });
  }
  return ops;
}

// ---- JS 側で同じ操作をする ----

function errCode(err) {
  const m = String(err.message);
  const table = [[/ファイル名/, -2], [/空のファイル/, -3], [/既に存在/, -4], [/ゲームファイルは1つ/, -5], [/連続領域/, -6],
    [/空き容量不足/, -7], [/ディレクトリに空き/, -8], [/整合性/, -11], [/FATチェーン/, -9]];
  for (const [re, c] of table) if (re.test(m)) return c;
  return `unknown(${m})`;
}

function tmpFile(bytes) {
  const p = path.join(work, `d${fileCounter++}.bin`);
  if (bytes) fs.writeFileSync(p, bytes);
  return p;
}

// JS で実行して { lines (C に渡す命令), results (期待する結果), dciFiles } を作る
function runJs(vmu, ops) {
  const lines = [];
  const results = [];
  const dciChecks = [];
  for (const o of ops) {
    try {
      if (o.op === 'format') {
        const v = Vmu.format();
        v.data.set(o.ts, 255 * BLOCK_SIZE + 0x30);
        vmu.data.set(v.data);
        lines.push(`format ${hex(o.ts)}`);
        results.push('ok 0');
      } else if (o.op === 'write') {
        lines.push(`write ${hexName(o.name)} ${o.type.toString(16)} ${o.prot} ${o.hdr} ${o.ow} ${hex(o.ts)} ${tmpFile(o.data)}`);
        const e = vmu.writeFile(o.name, o.data, { type: o.type, copyProtected: !!o.prot, headerOffset: o.hdr, overwrite: !!o.ow, timestamp: o.ts });
        results.push(`ok ${e.slot}`);
      } else if (o.op === 'delete') {
        lines.push(`delete ${hexName(o.name)}`);
        const e = vmu.find(o.name);
        if (!e) { results.push('err -10'); continue; }
        vmu.deleteFile(e);
        results.push('ok 0');
      } else if (o.op === 'defrag') {
        lines.push('defrag');
        vmu.defragment();
        results.push('ok 0');
      } else if (o.op === 'reorder') {
        const r = rng(o.pickSeed);
        const list = vmu.list();
        const chosen = [];
        for (const e of list) if (r.chance(0.5)) chosen.push(e);
        chosen.sort(() => 0).reverse();
        // 同名ファイルがあると名前では区別できないので、名前が重複しないときだけ並べ替える
        const names = chosen.map((e) => e.name);
        if (new Set(list.map((e) => e.name)).size !== list.length) { lines.push('reorder'); vmu.reorder([]); results.push('ok 0'); continue; }
        lines.push(`reorder ${chosen.map((e) => e.slot).join(' ')}`);
        vmu.reorder(names);
        results.push('ok 0');
      } else if (o.op === 'crc') {
        lines.push(`crc ${hexName(o.name)}`);
        const e = vmu.find(o.name);
        if (!e) { results.push('err -10'); continue; }
        const file = vmu.readFile(e);
        const h = parseHeader(file, headerPosition(e));
        if (!h) { results.push('ok nohdr'); continue; }
        const range = crcRangeValid(file, h);
        results.push(`ok ${h.valid ? 1 : 0} ${range ? 1 : 0} ${h.crc} ${range ? calcCrc(file, h) : 0} ${h.description}|${h.longDescription}|${h.appId}`);
      } else if (o.op === 'dci') {
        const out = tmpFile(null);
        lines.push(`dci ${hexName(o.name)} ${out}`);
        const e = vmu.find(o.name);
        if (!e) { results.push('err -10'); continue; }
        const dci = toDci(e, vmu.readFile(e));
        dciChecks.push({ out, dci });
        results.push(`ok ${dci.length}`);
      } else if (o.op === 'undci') {
        // 今あるファイルを DCI にして、別の名前で書き戻す
        const e = vmu.find(o.name);
        if (!e) { lines.push('nop'); results.push('ok 0'); continue; }
        const raw = toDci(e, vmu.readFile(e));
        raw.set([0x43, 0x4f, 0x50, 0x59, 0, 0, 0, 0, 0, 0, 0, 0], 4);   // 名前を COPY に
        lines.push(`undci ${tmpFile(raw)}`);
        const d = fromDci(raw);
        const ne = vmu.writeFile(d.name, d.data, { type: d.type, copyProtected: d.copyProtected, headerOffset: d.headerOffset, timestamp: d.timestamp });
        results.push(`ok ${ne.slot}`);
      }
    } catch (err) {
      results.push(`err ${errCode(err)}`);
    }
  }
  return { lines, results, dciChecks };
}

function jsSummary(vmu) {
  const list = vmu.list();
  const frag = new Set(vmu.fragmented().map((e) => e.slot));
  const out = [`list ${list.length} free ${vmu.freeBlocks().length}`];
  for (const e of list) {
    out.push(`file ${e.slot} ${hexName(e.name)} ${e.type.toString(16).padStart(2, '0')} ${e.copyProtected ? 1 : 0} ${e.firstBlock} ${e.sizeBlocks} ${frag.has(e.slot) ? 1 : 0} ${hex(e.raw.subarray(16, 24))}`);
  }
  const codes = vmu.check().map((m) => (/フォーマット識別子/.test(m) ? 1 : /ルートの位置/.test(m) ? 2 : /同名/.test(m) ? 3
    : /サイズ不一致/.test(m) ? 4 : /重複/.test(m) ? 5 : 6));
  return { out, codes };
}

function runC(input, lines) {
  const exe = build();
  const inPath = input ? tmpFile(input) : '-';
  const outPath = tmpFile(null);
  const r = spawnSync(exe, [inPath, outPath], { input: lines.join('\n') + '\n', encoding: 'utf8', env: compiler.env });
  assert.equal(r.status, 0, `vmucore_host が失敗: ${r.stderr}`);
  const all = r.stdout.trim().split(/\r?\n/);
  const listAt = all.findIndex((l) => l.startsWith('list '));
  const checkAt = all.findIndex((l) => l.startsWith('check '));
  return {
    results: all.slice(0, listAt),
    summary: all.slice(listAt, checkAt),
    codes: all.filter((l) => l.startsWith('prob ')).map((l) => Number(l.split(' ')[1])),
    image: new Uint8Array(fs.readFileSync(outPath)),
  };
}

function compare(label, input, vmu, ops) {
  const before = vmu.toBytes();
  const js = runJs(vmu, ops);
  const c = runC(input ?? null, js.lines);
  for (let i = 0; i < js.results.length; i++) {
    // VMS の説明が ASCII でないとき (乱数のヘッダ) は、JS は Shift-JIS として読み C はバイトのままなので数値だけ比べる
    const nonAscii = /^ok \d \d/.test(js.results[i]) && /[^ -~]/.test(js.results[i]);
    const cut = (s) => (nonAscii ? String(s).split(' ').slice(0, 5).join(' ') : s);
    assert.equal(cut(c.results[i]), cut(js.results[i]), `${label}: 命令 ${i + 1} (${js.lines[i]?.slice(0, 60)}) の結果が違う`);
  }
  const s = jsSummary(vmu);
  assert.deepEqual(c.summary, s.out, `${label}: ファイル一覧が違う`);
  assert.deepEqual(c.codes, s.codes, `${label}: 検査の結果が違う`);
  for (const { out, dci } of js.dciChecks) assert.deepEqual(new Uint8Array(fs.readFileSync(out)), dci, `${label}: DCI が違う`);
  const diff = c.image.findIndex((b, i) => b !== vmu.data[i]);
  assert.equal(diff, -1, `${label}: イメージが違う (最初の違い ${diff} = ブロック ${diff >> 9} の +0x${(diff & 511).toString(16)})`);
  return before;
}

// ---- テスト ----

test('vmucore: ランダムな操作列で vmu.js と同じイメージになる', { skip: !compiler && 'C コンパイラが無い' }, () => {
  for (let seed = SEED_FROM; seed <= SEEDS; seed++) {
    const r = rng(seed * 7919);
    const vmu = new Vmu(new Uint8Array(128 * 1024));
    compare(`seed ${seed}`, null, vmu, randomOps(r, 30 + r.int(40)));
  }
});

test('vmucore: 容量いっぱい・ディレクトリいっぱい', { skip: !compiler && 'C コンパイラが無い' }, () => {
  const r = rng(42);
  const ops = [{ op: 'format', ts: randomTs(r) }];
  // 1 ブロックのファイルを 210 個 (ディレクトリ 208 件・空き 200 ブロックを超える)
  for (let i = 0; i < 210; i++) {
    ops.push({ op: 'write', name: `F${i}`, type: FILE_DATA, prot: 0, hdr: 0, ow: 0, ts: randomTs(r), data: randomData(r, 1, 0) });
  }
  ops.push({ op: 'delete', name: 'F5' }, { op: 'delete', name: 'F100' }, { op: 'defrag' });
  ops.push({ op: 'write', name: 'GAME', type: FILE_GAME, prot: 0, hdr: 1, ow: 0, ts: randomTs(r), data: randomData(r, 2, 1) });
  compare('full', null, new Vmu(new Uint8Array(128 * 1024)), ops);
});

test('vmucore: 壊れたイメージの検査・削除・書き込みも vmu.js と同じ', { skip: !compiler && 'C コンパイラが無い' }, () => {
  for (let seed = SEED_FROM; seed <= SEEDS; seed++) {
    const r = rng(seed * 104729);
    const vmu = new Vmu(new Uint8Array(128 * 1024));
    runJs(vmu, randomOps(r, 25));
    // FAT・ディレクトリ・ルートを少し壊す
    const n = 1 + r.int(6);
    for (let i = 0; i < n; i++) {
      const where = r.int(10);
      if (where < 5) vmu.data[254 * BLOCK_SIZE + r.int(400)] = r.pick([0xfa, 0xfc, 0xff, r.int(256), 0]);
      else if (where < 9) {
        const off = (253 - r.int(2)) * BLOCK_SIZE + r.int(16) * 32;
        vmu.data[off + r.pick([0, 2, 3, 24, 4])] = r.pick([0x33, 0xcc, r.int(256), 0]);
      } else vmu.data[255 * BLOCK_SIZE + r.pick([0, 0x44, 0x45])] = r.int(256);
    }
    const corrupted = vmu.toBytes();
    const ops = [];
    for (let i = 0; i < 8; i++) {
      const k = r.int(4);
      if (k === 0) ops.push({ op: 'delete', name: r.pick(NAMES).trim() });
      else if (k === 1) ops.push({ op: 'defrag' });
      else if (k === 2) ops.push({ op: 'crc', name: r.pick(NAMES).trim() });
      else ops.push({ op: 'write', name: `N${i}`, type: FILE_DATA, prot: 0, hdr: 0, ow: 1, ts: randomTs(r), data: randomData(r, 1 + r.int(4), 0) });
    }
    compare(`corrupt ${seed}`, corrupted, vmu, ops);
  }
});

test('vmucore: fixroot (ルートの位置が 0 の古いイメージ)', { skip: !compiler && 'C コンパイラが無い' }, () => {
  const vmu = Vmu.format();
  vmu.view.setUint16(255 * BLOCK_SIZE + 0x44, 0, true);
  const input = vmu.toBytes();
  const before = jsSummary(vmu).codes;
  assert.deepEqual(before, [2]);
  const fixed = vmu.fixRoot();
  const c = runC(input, ['fixroot']);
  assert.equal(c.results[0], `ok ${fixed ? 1 : 0}`);
  assert.deepEqual(c.image, vmu.data);
});
