#!/usr/bin/env node
// vmutransfer ROM の Flycast 検証結果を確かめる
//   node scripts/verify-transfer.js <A1 の元> <A2 の後> <書き戻したイメージ> <A1 の後> [--quiet]
//   COPY:    A2 の後 == A1 の元   (A1 を丸ごと読んで A2 に書けたか = 読み出し経路)
//   RESTORE: A1 の後 == 書き戻したイメージ (ブロック書き込み経路)
import { readFileSync, existsSync } from 'node:fs';
import { Vmu } from '../src/vmu.js';

const quiet = process.argv.includes('--quiet');
const [origA1, afterA2, restore, afterA1] = process.argv.slice(2).filter((a) => a !== '--quiet');
const read = (p) => (existsSync(p) ? readFileSync(p) : null);
const log = (s) => quiet || console.log(s);

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
  for (let b = 0; b < 256; b++) if (!actual.subarray(b * 512, b * 512 + 512).equals(expected.subarray(b * 512, b * 512 + 512))) blocks.push(b);
  log(`${label}: 不一致 (ブロック ${blocks.slice(0, 20).join(', ')}${blocks.length > 20 ? ' ...' : ''})`);
  return false;
}

const copyOk = compare('COPY A1→A2', read(afterA2), read(origA1));
const restoreOk = compare('RESTORE →A1', read(afterA1), read(restore));
log(copyOk && restoreOk ? 'PASS' : 'FAIL');
process.exitCode = copyOk && restoreOk ? 0 : 1;
