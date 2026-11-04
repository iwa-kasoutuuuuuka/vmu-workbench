#!/usr/bin/env node
// vmutransfer ROM の Flycast 検証結果を確かめる
//   node scripts/verify-transfer.js <A1 の元> <A2 の後> <書き戻したイメージ> <A1 の後> [--quiet]
//   COPY:    A2 の後 == A1 の元   (A1 を丸ごと読んで A2 に書けたか = 読み出し経路)
//   RESTORE: A1 の後 == 書き戻したイメージ (ブロック書き込み経路)
//
// 違うブロックだけ書くことの確認 (scripts/vmu_transfer.ps1 -Test の 2 回目) 用:
//   node scripts/verify-transfer.js --flip <元> <出力> <ブロック>...   指定ブロックの 1 バイトを反転したイメージを作る
//   node scripts/verify-transfer.js --invert <元> <出力>               全バイトを反転したイメージを作る
//   node scripts/verify-transfer.js --written <名前> <前> <期待> <後> [--quiet]
//     <後> は Flycast が VMU を読み込んだ直後に「期待」の反転で上書きしたファイル。Flycast は書かれたブロックの
//     バイトだけをファイルに書くので、期待と同じブロック = ROM が書いた、反転のまま = 書かなかった、と分かる。
//     書いたブロックが「前」と「期待」で違うブロックとちょうど同じなら OK
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Vmu } from '../src/vmu.js';

const BLOCK = 512;
const quiet = process.argv.includes('--quiet');
const args = process.argv.slice(2).filter((a) => a !== '--quiet');
const read = (p) => (existsSync(p) ? readFileSync(p) : null);
const log = (s) => quiet || console.log(s);
const block = (buf, b) => buf.subarray(b * BLOCK, b * BLOCK + BLOCK);
const list = (blocks) => (blocks.length ? `${blocks.slice(0, 20).join(', ')}${blocks.length > 20 ? ' ...' : ''}` : 'なし');

function compare(label, actual, expected) {
  if (!actual || !expected) {
    log(`${label}: ファイルがありません`);
    return false;
  }
  if (actual.equals(expected)) {
    const files = new Vmu(new Uint8Array(actual)).list().map((e) => e.name);
    log(`${label}: 一致 (${files.length} ファイル: ${files.join(', ')})`);
    return true;
  }
  const blocks = [];
  for (let b = 0; b < 256; b++) if (!block(actual, b).equals(block(expected, b))) blocks.push(b);
  log(`${label}: 不一致 (ブロック ${list(blocks)})`);
  return false;
}

function written(label, before, expected, after) {
  if (!before || !after || !expected) {
    log(`${label}: ファイルがありません`);
    return false;
  }
  const want = [], wrote = [], bad = [];
  for (let b = 0; b < 256; b++) {
    const e = block(expected, b), a = block(after, b);
    if (!block(before, b).equals(e)) want.push(b);
    if (a.equals(e)) wrote.push(b);
    else if (!a.every((v, i) => v === (~e[i] & 0xff))) bad.push(b);
  }
  const ok = bad.length === 0 && wrote.join() === want.join();
  log(`${label}: 書いたブロック ${wrote.length} (${list(wrote)}) / 違っていたブロック ${want.length} (${list(want)})` +
      (bad.length ? ` / 中身がおかしいブロック ${list(bad)}` : '') + (ok ? ' — OK' : ' — NG'));
  return ok;
}

if (args[0] === '--flip') {
  const img = Buffer.from(readFileSync(args[1]));
  for (const b of args.slice(3).map(Number)) img[b * BLOCK + 0x100] ^= 0xff;   // 0x100: ルートブロックでも未使用の場所
  writeFileSync(args[2], img);
} else if (args[0] === '--invert') {
  writeFileSync(args[2], Buffer.from(readFileSync(args[1]).map((v) => ~v & 0xff)));
} else if (args[0] === '--written') {
  process.exitCode = written(args[1], read(args[2]), read(args[3]), read(args[4])) ? 0 : 1;
} else {
  const [origA1, afterA2, restore, afterA1] = args;
  const copyOk = compare('COPY A1→A2', read(afterA2), read(origA1));
  const restoreOk = compare('RESTORE →A1', read(afterA1), read(restore));
  log(copyOk && restoreOk ? 'PASS' : 'FAIL');
  process.exitCode = copyOk && restoreOk ? 0 : 1;
}
