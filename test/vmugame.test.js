// デモ ミニゲームをアセンブル → VMU イメージに書き込み → エミュレーターで動かして画面を確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Vmu, FILE_GAME } from '../src/vmu.js';
import { parseHeader, calcCrc } from '../src/vms.js';
import { buildGame, flashFrom, parseKeys, runScript, lcdText, lcdRgba, VmuEmulator } from '../src/vmugame.js';
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
