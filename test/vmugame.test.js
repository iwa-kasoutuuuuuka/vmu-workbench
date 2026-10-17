// デモ ミニゲームをアセンブル → VMU イメージに書き込み → エミュレーターで動かして画面を確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Vmu, FILE_GAME } from '../src/vmu.js';
import { parseHeader, calcCrc } from '../src/vms.js';
import { buildGame, flashFrom, parseKeys, runScript, lcdText, lcdRgba, recordAudio, audioNotes, edgesToPcm, pcmToWav, VmuEmulator } from '../src/vmugame.js';
import { assemble } from '../src/vmuasm.js';
import { LCD_W } from '../src/vmuemu.js';

const source = readFileSync(new URL('../examples/hello-vmu.s', import.meta.url), 'utf8');

/** 8x8 ブロックの左上 (列バイト bx, 行 y) が点灯していて周りが消えているか */
function blockAt(lcd) {
  const lit = [];
  for (let i = 0; i < lcd.pixels.length; i++) if (lcd.pixels[i]) lit.push(i);
  if (lit.length !== 64) return { count: lit.length };
  return { count: 64, x: lit[0] % LCD_W, y: Math.floor(lit[0] / LCD_W) };
}

test('デモをアセンブルするとヘッダと CRC が入る', () => {
  const { bytes, header, labels } = buildGame(source);
  assert.equal(bytes.length % 512, 0);
  assert.ok(header);
  assert.equal(header.description, 'HELLO VMU');
  assert.equal(header.iconCount, 1);
  assert.equal(parseHeader(bytes, 0x200).crc, calcCrc(bytes, parseHeader(bytes, 0x200)));
  assert.equal(labels.main, 0x500);
});

test('VMU イメージに入れたデモが動き、十字キーでブロックが動く', () => {
  const vmu = Vmu.format ? Vmu.format() : new Vmu();
  const { bytes } = buildGame(source);
  vmu.writeFile('HELLO', bytes, { type: FILE_GAME, headerOffset: 1 });
  const entry = vmu.find('HELLO');
  assert.equal(entry.firstBlock, 0, 'ミニゲームはブロック 0 から');

  const emu = new VmuEmulator({ flash: flashFrom(vmu.toBytes()) });
  runScript(emu, { seconds: 0.5 });
  assert.equal(emu.stopReason, null, emu.stopMessage);
  let lcd = emu.lcd();
  assert.ok(lcd.on);
  assert.deepEqual(blockAt(lcd), { count: 64, x: 16, y: 4 });

  // 右を押して離す → 1 列 (8 ドット) 右へ。下を押して離す → 1 行下へ
  runScript(emu, { seconds: 1, keys: parseKeys('0.1:right,0.4:,0.6:down,0.9:') });
  lcd = emu.lcd();
  assert.deepEqual(blockAt(lcd), { count: 64, x: 24, y: 5 });
  assert.match(lcdText(lcd).split('\n')[5], /^\.{24}#{8}\.{16}$/);
  const img = lcdRgba(lcd, 2);
  assert.equal(img.width, 96);
  assert.equal(img.rgba.length, 96 * 64 * 4);
});

test('キー操作の書式', () => {
  assert.deepEqual(parseKeys('1.5:,1:right+A'), [{ t: 1, buttons: ['right', 'a'] }, { t: 1.5, buttons: [] }]);
  assert.throws(() => parseKeys('1:jump'), /知らないボタン/);
  assert.throws(() => parseKeys('x'), /書式/);
  assert.throws(() => flashFrom(new Uint8Array(0x20001)), /128KB/);
});

test('状態の保存と復元: 続きから同じように動く (フラッシュ込み)', () => {
  const vmu = Vmu.format();
  vmu.writeFile('HELLO', buildGame(source).bytes, { type: FILE_GAME, headerOffset: 1 });
  const a = new VmuEmulator({ flash: flashFrom(vmu.toBytes()) });
  runScript(a, { seconds: 1, keys: parseKeys('0.2:right,0.5:') });
  const saved = JSON.parse(JSON.stringify(a.saveState({ withFlash: true })));
  const b = new VmuEmulator({ flash: new Uint8Array(0x20000) });
  b.loadState(saved);
  assert.deepEqual(b.flash, a.flash);
  for (const e of [a, b]) runScript(e, { seconds: 1, keys: parseKeys('0.1:down,0.4:') });
  assert.deepEqual(b.lcd().pixels, a.lcd().pixels);
  assert.equal(b.cycles, a.cycles);
  assert.throws(() => b.loadState({ format: 'x' }), /状態ファイルではありません/);
  assert.throws(() => new VmuEmulator({}).loadState({ ...saved, hasRom: true }), /BIOS/);
});

test('音: タイマー 1 のパルスがスピーカー (P1.7) に出る。周期 = 256 - T1LR、H の長さ = 256 - T1LC (MAME lc8670 と同じ)', () => {
  // BIOS 無しはサブクロック 32768/6 = 5461Hz。T1LR = 200 → 56 サイクル周期 (97.5Hz)、T1LC = 228 → H は 28 サイクル
  const prog = (ddr) => assemble(`
    mov #${ddr},p1ddr
    mov #200,t1lr
    mov #228,t1lc
    mov #0x50,t1cnt
  l: br l`).bytes;
  const run = (ddr) => {
    const flash = new Uint8Array(0x20000);
    flash.set(prog(ddr));
    const emu = new VmuEmulator({ flash });
    return recordAudio(emu, { seconds: 1 });
  };
  const rec = run(0x80);
  const notes = audioNotes(rec);
  assert.equal(notes.length, 1);
  assert.ok(Math.abs(notes[0].hz - 5461.33 / 56) < 0.1, `${notes[0].hz}Hz`);
  const e = rec.edges.slice(10, 14);
  const high = e[0][1] === 1 ? e[1][0] - e[0][0] : e[2][0] - e[1][0];
  assert.ok(Math.abs(high * 5461.33 - 28) < 0.5, `H ${high * 5461.33} サイクル`);
  const pcm = edgesToPcm(rec, 22050);
  assert.ok(Math.abs(pcm.length - 22050) < 10); // 命令の切れ目までなのでわずかに長い
  assert.ok(pcm.some((x) => x > 1000) && pcm.some((x) => x < -1000));
  assert.equal(pcmToWav(pcm).length, 44 + pcm.length * 2);
  // P1DDR の bit7 が 0 (入力) なら端子に出ないので無音
  assert.equal(run(0x00).edges.length, 1);
});

test('音: P1 を直接書いても鳴る (ソフトで矩形波を作るゲーム用)', () => {
  const flash = new Uint8Array(0x20000);
  flash.set(assemble(`
    mov #0x80,p1ddr
    mov #0x3f,p1fcr     ; bit7 = 0: パルスではなく P1 の値を出す
  l: not1 p1,7
    br l`).bytes);
  const rec = recordAudio(new VmuEmulator({ flash }), { seconds: 0.5 });
  assert.ok(rec.edges.length > 100);
});
