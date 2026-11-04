// dc/savemgr (Dreamcast 本体で動くセーブマネージャ) を Flycast で自動確認する。
//
//   node scripts/savemgr-test.js [--keep] [--no-build]
//
// 1. テスト用の VMU を 2 つ作る (A1 = make-test-image.js + ミニゲーム、A2 = 別の中身)
// 2. 操作の命令を romdisk/auto に書いて CDI を作る (DreamSDK のシェルで make cdi)
// 3. .emu/ の Flycast (H:\DC\flycast-memcard から写す) で起動し、命令が終わるまで待つ
// 4. Flycast の VMU ファイルが、同じ操作を vmu.js でしたときと同じかを比べる。画面を .emu/out/savemgr/*.png に保存
//
// --keep: 終わっても Flycast を閉じない (画面を自分で触って確かめるとき)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vmu, FILE_GAME } from '../src/vmu.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'dc', 'savemgr');
const emu = path.join(root, '.emu');
const outDir = path.join(emu, 'out', 'savemgr');
const data = path.join(emu, 'data');
const flycastSrc = process.env.FLYCAST_SRC || 'H:\\DC\\flycast-memcard';
const bash = process.env.DREAMSDK_BASH || 'C:\\DreamSDK\\usr\\bin\\bash.exe';
const keep = process.argv.includes('--keep');
const noBuild = process.argv.includes('--no-build');
const timeoutMs = 120000;
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(data, { recursive: true });

// ---- テスト用の VMU ----
const a1Path = path.join(outDir, 'a1_before.bin');
let r = spawnSync(process.execPath, [path.join(root, 'scripts', 'make-test-image.js'), a1Path], { encoding: 'utf8' });
if (r.status !== 0) throw new Error(r.stderr);
const a1 = new Vmu(fs.readFileSync(a1Path));
// ミニゲーム (例: examples/hello-vmu.s をアセンブルしたもの) をブロック 0 から
const gamePath = path.join(outDir, 'hello.vms');
r = spawnSync(process.execPath, [path.join(root, 'cli.js'), 'asm', path.join(root, 'examples', 'hello-vmu.s'), gamePath], { encoding: 'utf8' });
if (r.status !== 0) throw new Error(r.stderr);
a1.writeFile('HELLO', fs.readFileSync(gamePath), { type: FILE_GAME, headerOffset: 1 });
const a2 = Vmu.format({ date: new Date(2020, 0, 2, 3, 4, 5) });
a2.writeFile('OLD_A2_FILE', Uint8Array.from({ length: 3000 }, (_, i) => i & 0xff));

// ---- 命令と、vmu.js で同じことをした結果 ----
const script = [
  'check a1',
  'whole a1 a2',                 // A2 = A1 からコピー禁止のファイルを除いたもの
  'delete a2 DCVMU_ONE',
  'copy a1 DCVMU_FRAG a2',       // コピー禁止 → 書かない
  'copy a1 DCVMU_ONE a2',
  'defrag a2',
  'undo a2',                     // 整理を取り消す
  'format a2',
  'undo a2',                     // 初期化を取り消す
  'delete a1 DCVMU_MID',
  'check a2',
  'select a1',
  'wait 1500',
  // 画面の確認 (それぞれ 2.5 秒。テストが 1 秒ごとに撮る)
  'show file',
  'down 5',                      // DCVMU_ICON3 (アイコン 3 枚)
  'show info',
  'show hex',
  'show vmu',
  'show check',
  'show net',
  'wait 500',
];
const expectA2 = new Vmu(a1.toBytes());
for (const e of expectA2.list()) if (e.copyProtected) expectA2.deleteFile(e);
expectA2.deleteFile(expectA2.find('DCVMU_ONE'));
{
  const src = a1.find('DCVMU_ONE');
  expectA2.writeFile(src.name, a1.readFile(src), { type: src.type, copyProtected: src.copyProtected, headerOffset: src.headerOffset, timestamp: src.raw.subarray(16, 24) });
}
const expectA1 = new Vmu(a1.toBytes());
expectA1.deleteFile(expectA1.find('DCVMU_MID'));
const expectResults = ['check a1 -> 0', 'whole a1 a2 -> ', 'delete a2 DCVMU_ONE -> ', 'copy a1 DCVMU_FRAG a2 -> 1',
  'copy a1 DCVMU_ONE a2 -> ', 'defrag a2 -> ', 'undo a2 -> ', 'format a2 -> ', 'undo a2 -> ', 'delete a1 DCVMU_MID -> ', 'check a2 -> 0'];

// ---- CDI を作る ----
const romdisk = path.join(srcDir, 'romdisk');
// テスト用は別の名前で作る (auto 入りの ROM を実機で起動すると本物の VMU に命令を実行してしまうため)
const cdi = path.join(srcDir, 'savemgr_test.cdi');
if (!noBuild) {
  fs.mkdirSync(romdisk, { recursive: true });
  fs.writeFileSync(path.join(romdisk, 'auto'), script.join('\n') + '\n');
  r = spawnSync(bash, ['--login', '-c', '/h/DC/tools/vmu-workbench/dc/savemgr/build.sh cdi TARGET=savemgr_test.elf CDI=savemgr_test.cdi'], {
    encoding: 'utf8', env: { ...process.env, MSYSTEM: 'MINGW64' },
  });
  fs.rmSync(path.join(romdisk, 'auto'), { force: true });
  if (r.status !== 0 || !fs.existsSync(cdi)) throw new Error(`CDI のビルドに失敗:\n${r.stdout}\n${r.stderr}`);
}

// ---- Flycast ----
const flycast = path.join(emu, 'flycast.exe');
if (!fs.existsSync(flycast)) fs.copyFileSync(path.join(flycastSrc, 'flycast.exe'), flycast);
for (const f of ['dc_boot.bin', 'dc_flash.bin', 'dc_nvmem.bin']) {
  if (!fs.existsSync(path.join(data, f))) fs.copyFileSync(path.join(flycastSrc, 'data', f), path.join(data, f));
}
let cfg = fs.readFileSync(path.join(flycastSrc, 'emu.cfg'), 'utf8');
const set = (key, value) => {
  const re = new RegExp(`^${key.replace(/\./g, '\\.')} = .*$`, 'm');
  cfg = re.test(cfg) ? cfg.replace(re, `${key} = ${value}`) : cfg + `\n${key} = ${value}\n`;
};
set('Dreamcast.BiosPath', data);
set('Dreamcast.VMUPath', data);
set('PerGameVmu', 'no');
set('DiscordPresence', 'no');
set('UploadCrashLogs', 'no');
set('FetchBoxart', 'no');
set('Debug.SerialConsoleEnabled', 'yes');
set('device1', '0');
set('device1.1', '1');
set('device1.2', '1');
set('device2', '0');      // B: コントローラー + VMU (B1 に結果の記録 SMGRLOG を書かせる)
set('device2.1', '1');
set('device2.2', '10');
fs.writeFileSync(path.join(emu, 'emu.cfg'), cfg);
const vmuA1 = path.join(data, 'vmu_save_A1.bin');
const vmuA2 = path.join(data, 'vmu_save_A2.bin');
fs.writeFileSync(vmuA1, a1.toBytes());
fs.writeFileSync(vmuA2, a2.toBytes());
const vmuB1 = path.join(data, 'vmu_save_B1.bin');
fs.writeFileSync(vmuB1, Vmu.format().toBytes());
fs.copyFileSync(path.join(outDir, 'a1_before.bin'), path.join(outDir, 'a1_before.bin'));
fs.writeFileSync(path.join(outDir, 'a2_before.bin'), a2.toBytes());

const child = spawn(flycast, [cdi], { cwd: emu, stdio: 'ignore' });
// 結果は B1 の SMGRLOG (Flycast のシリアル出力は別のコンソール窓に出て読めないため)
const readLog = () => {
  try {
    const v = new Vmu(fs.readFileSync(vmuB1));
    const e = v.find('SMGRLOG');
    return e ? Buffer.from(v.readFile(e)).toString('latin1').replace(/\0+$/, '') : '';
  } catch { return ''; }
};
// 画面は 1 秒ごとに撮る (この Flycast のウィンドウだけを PrintWindow で。前面には出さない)
for (const f of fs.readdirSync(outDir)) if (/^shot_\d+\.png$/.test(f)) fs.rmSync(path.join(outDir, f));
const capture = (file) => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  path.join(root, 'scripts', 'capture-window.ps1'), '-ProcessId', String(child.pid), '-Out', file], { encoding: 'utf8' });
let log = '';
let shots = 0;
const t0 = Date.now();
while (!/AUTO DONE/.test(log) && Date.now() - t0 < timeoutMs && child.exitCode === null) {
  await new Promise((res) => setTimeout(res, 300));
  if (Date.now() - t0 > 8000) capture(path.join(outDir, `shot_${String(++shots).padStart(2, '0')}.png`));
  log = readLog();
}
const done = /AUTO DONE/.test(log);
await new Promise((res) => setTimeout(res, 1000));
const shot = path.join(outDir, 'main.png');
capture(shot);
fs.writeFileSync(path.join(outDir, 'smgrlog.txt'), log);
if (!keep) {
  child.kill();
  await new Promise((res) => setTimeout(res, 800));
}

// ---- 照合 ----
const lines = log.split(/\r?\n/).filter((l) => /^(AUTO|CHECK|DIALOG)/.test(l));
console.log(lines.join('\n'));
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'OK  ' : 'NG  '} ${msg}`); if (!ok) fail++; };
check(done, '命令がすべて終わった (AUTO DONE)');
const autoLines = lines.filter((l) => l.startsWith('AUTO ') && l.includes('->')).map((l) => l.slice(5).replace(/\s+/g, ' '));
let at = 0;   // 結果は命令の順に探す (同じ命令が 2 回あるため)
for (const exp of expectResults) {
  const key = exp.split(' -> ')[0];
  const idx = autoLines.findIndex((l, i) => i >= at && (l.startsWith(key + ' ') || l.startsWith(key + '->')));
  if (idx >= 0) at = idx + 1;
  const got = idx >= 0 ? autoLines[idx] : null;
  const val = got ? Number(got.split('->')[1]) : NaN;
  const want = exp.split('-> ')[1];
  check(got && (want === '' ? val > 0 : val === Number(want)), `${exp.split(' -> ')[0]} → ${got ? got.split('->')[1].trim() : '(なし)'}`);
}
const gotA1 = new Uint8Array(fs.readFileSync(vmuA1));
const gotA2 = new Uint8Array(fs.readFileSync(vmuA2));
fs.writeFileSync(path.join(outDir, 'a1_after.bin'), gotA1);
fs.writeFileSync(path.join(outDir, 'a2_after.bin'), gotA2);
const firstDiff = (x, y) => x.findIndex((b, i) => b !== y[i]);
const d1 = firstDiff(gotA1, expectA1.data), d2 = firstDiff(gotA2, expectA2.data);
check(d1 < 0, `A1 が vmu.js の結果と一致${d1 < 0 ? '' : ` (最初の違い ブロック ${d1 >> 9} +0x${(d1 & 511).toString(16)})`}`);
check(d2 < 0, `A2 が vmu.js の結果と一致${d2 < 0 ? '' : ` (最初の違い ブロック ${d2 >> 9} +0x${(d2 & 511).toString(16)})`}`);
check(fs.existsSync(shot), `画面: ${shot}`);
console.log(fail ? `失敗 ${fail} 件` : 'すべて OK');
process.exit(fail ? 1 : 0);
