// vmucheck ROM の結果 (VMUCHECK) と VMU Workbench のパーサ結果を突き合わせる
// 使い方: node scripts/verify-emu.js <実行前.bin> <実行後.bin>
import { readFileSync } from 'node:fs';
import { Vmu, FILE_GAME } from '../src/vmu.js';
import { crcStatus } from '../src/edit.js';
import { crc32 } from '../src/crc32.js';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('usage: node scripts/verify-emu.js <before.bin> <after.bin>');
  process.exit(1);
}

const before = new Vmu(readFileSync(beforePath));
const after = new Vmu(readFileSync(afterPath));
const failures = [];
const fail = (msg) => failures.push(msg);
const ok = (msg) => console.log(`  OK   ${msg}`);

const reportEntry = after.find('VMUCHECK');
if (!reportEntry) {
  console.error('FAIL: VMUCHECK がありません (ROMが動作していない可能性)');
  process.exit(2);
}
const reportText = new TextDecoder().decode(after.readFile(reportEntry)).replace(/\0.*$/s, '');
console.log('--- VMUCHECK (Dreamcast側の結果) ---');
console.log(reportText.trimEnd());
console.log('--- 突き合わせ ---');

const lines = reportText.split('\n');
if (lines[0] !== 'VMUCHECK 1' || !lines.includes('END')) fail('レポートの形式が不正');

// 1. 空き容量
const free = Number(lines.find((l) => l.startsWith('FREE '))?.split(' ')[1]);
if (free === before.freeBlocks().length) ok(`空きブロック数 ${free}`);
else fail(`空きブロック数: DC=${free}, Workbench=${before.freeBlocks().length}`);

// 2. VMU Workbench が書いたファイルを Dreamcast が同じ内容で読めるか
const dcFiles = new Map(lines.filter((l) => l.startsWith('FILE ')).map((l) => {
  const [, name, size, crc] = l.split(' ');
  return [name, { size: Number(size), crc }];
}));
for (const e of before.list()) {
  const dc = dcFiles.get(e.name);
  const data = before.readFile(e);
  const crc = crc32(data).toString(16).padStart(8, '0');
  if (!dc) fail(`${e.name}: Dreamcast側で見つからない`);
  else if (dc.size !== data.length || dc.crc !== crc) fail(`${e.name}: 内容不一致 DC=${dc.size}/${dc.crc} Workbench=${data.length}/${crc}`);
  else ok(`${e.name} (${data.length} bytes, crc ${crc})`);
  dcFiles.delete(e.name);
}
for (const name of dcFiles.keys()) fail(`${name}: VMU Workbench のファイル一覧に無いファイルをDreamcastが検出`);

// 2b. VMSヘッダのCRC判定が Dreamcast (KOS vmu_pkg_parse) と一致するか
const pkg = new Map(lines.filter((l) => l.startsWith('PKG ')).map((l) => l.split(' ').slice(1)));
for (const e of before.list()) {
  const s = crcStatus(before.readFile(e), e).status;
  if (s === 'none' || e.type === FILE_GAME) continue; // ヘッダ無し・ゲームは対象外
  const expect = s === 'ok' ? 'OK' : 'NG';
  if (pkg.get(e.name) === expect) ok(`${e.name} CRC判定 ${expect} (Workbench: ${s})`);
  else fail(`${e.name}: CRC判定不一致 DC=${pkg.get(e.name)} Workbench=${s}`);
}
// 3. Dreamcast (KOS) が書いたファイルを VMU Workbench が正しく読めるか
const kos = after.find('VMUKOS');
const expected = Uint8Array.from({ length: 512 * 3 - 100 }, (_, i) => (i * 13 + 7) & 0xff);
if (!kos) fail('VMUKOS: KOSが書いたファイルが見つからない');
else if (!expected.every((b, i) => after.readFile(kos)[i] === b)) fail('VMUKOS: 内容不一致');
else ok(`VMUKOS (KOSが書き込んだ ${kos.sizeBlocks} ブロック) を正しく読めた`);

// 4. 実行後イメージの整合性
const problems = after.check();
if (problems.length) problems.forEach((p) => fail(`整合性: ${p}`));
else ok('実行後イメージの整合性チェック');

if (failures.length) {
  failures.forEach((f) => console.log(`  FAIL ${f}`));
  console.log(`\nFAIL (${failures.length}件)`);
  process.exit(1);
}
console.log('\nPASS');
