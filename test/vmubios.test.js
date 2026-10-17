// 実物の VMU BIOS を使う検証。BIOS は同梱しないので .emu/vmu/vmu_bios_jp.bin が無ければ飛ばす
// (D:\DC\Sega - VMU\vmu_bios_jp.bin を .emu/vmu/ にコピーすると動く。MAME の jp1004 と同じ SHA1 のもので確認)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Vmu, FILE_GAME } from '../src/vmu.js';
import { VmuEmulator, LCD_W } from '../src/vmuemu.js';
import { buildGame, flashFrom, biosAutoStart, runScript, parseKeys, flashChanges } from '../src/vmugame.js';

const BIOS = new URL('../.emu/vmu/vmu_bios_jp.bin', import.meta.url);
const bios = existsSync(BIOS) ? readFileSync(BIOS) : null;
const skip = bios ? false : 'BIOS (.emu/vmu/vmu_bios_jp.bin) が無いので省略';

test('P7: 電池は十分 (bit1)、Dreamcast には挿していない (bit0)', () => {
  const emu = new VmuEmulator({});
  assert.equal(emu.read(0x15c) & 3, 0x02);
  emu.batteryGood = false;
  assert.equal(emu.read(0x15c) & 3, 0x00);
});

test('BIOS: 時計の設定画面から GAME でデモを起動し、操作できる', { skip }, () => {
  const vmu = Vmu.format();
  vmu.writeFile('HELLO', buildGame(readFileSync(new URL('../examples/hello-vmu.s', import.meta.url), 'utf8')).bytes, { type: FILE_GAME, headerOffset: 1 });
  const emu = new VmuEmulator({ flash: flashFrom(vmu.toBytes()), rom: bios });
  emu.runFor(4);
  assert.equal(emu.codeBank, 'rom');
  assert.ok(emu.lcd().pixels.some((p) => p), 'BIOS が画面を出す (時計の設定)');
  const fresh = new VmuEmulator({ flash: flashFrom(vmu.toBytes()), rom: bios });
  assert.equal(biosAutoStart(fresh), true);
  assert.equal(fresh.stopReason, null);
  runScript(fresh, { seconds: 2, keys: parseKeys('0.2:down,0.9:') });
  const px = fresh.lcd().pixels;
  const first = px.indexOf(1);
  assert.deepEqual({ x: first % LCD_W, y: Math.floor(first / LCD_W) }, { x: 16, y: 5 });
  assert.equal(fresh.lcd().icons.game, true);
});

test('BIOS のフラッシュ書き込みでセーブされ、書き戻したイメージで続きから数える', { skip }, () => {
  const vmu = Vmu.format();
  vmu.writeFile('COUNTER', buildGame(readFileSync(new URL('../examples/save-counter.s', import.meta.url), 'utf8')).bytes, { type: FILE_GAME, headerOffset: 1 });
  let flash = flashFrom(vmu.toBytes());
  for (const expected of [1, 2, 3]) {
    const before = Uint8Array.from(flash);
    const emu = new VmuEmulator({ flash, rom: bios });
    assert.equal(biosAutoStart(emu, { clock: new Date(2026, 9, 17, 12, 0) }), true);
    emu.runFor(1);
    assert.equal(emu.flash[0x600], expected, `${expected} 回目`);
    assert.equal(emu.xram[0][6], 0, 'BIOS の書き込み結果 = 成功');
    const ch = flashChanges(before, emu.flash, Vmu);
    assert.deepEqual(ch, { blocks: [3], files: ['COUNTER'], system: false });
    assert.deepEqual(new Vmu(Uint8Array.from(emu.flash)).check(), []);
    flash = emu.flash;
  }
});

test('BIOS の時計: 合わせた日時から進む', { skip }, () => {
  const emu = new VmuEmulator({ flash: flashFrom(Vmu.format().toBytes()), rom: bios });
  biosAutoStart(emu, { launch: false, clock: new Date(2026, 9, 17, 23, 59, 30) });
  emu.runFor(45);
  const r = emu.ram[0];
  assert.deepEqual([(r[0x17] << 8) | r[0x18], r[0x19], r[0x1a], r[0x1b], r[0x1c]], [2026, 10, 18, 0, 0], '日付をまたぐ');
});

// 市販ソフトのおまけミニゲーム (D:\DC\Sega - VMU、同梱しない) がセーブし、起動し直すとそれを読むか
const GAMES_DIR = 'D:/DC/Sega - VMU/';
const SAVE_GAMES = ['MarvelVsCapcom2', 'PowerStoneMini', 'TechRomancerMini', 'ChaoAdventure2'];
const haveGames = bios && SAVE_GAMES.every((g) => existsSync(`${GAMES_DIR}${g}.vms`));
test('市販ミニゲーム: 遊んで MODE で終えるとセーブし、起動し直すとセーブを読む', { skip: haveGames ? false : 'BIOS か D:/DC/Sega - VMU のゲームが無いので省略' }, () => {
  const clock = new Date(2026, 9, 17, 12);
  for (const g of SAVE_GAMES) {
    const raw = readFileSync(`${GAMES_DIR}${g}.vms`);
    const data = new Uint8Array(Math.ceil(raw.length / 512) * 512);
    data.set(raw);
    const vmu = Vmu.format();
    vmu.writeFile('GAME', data, { type: FILE_GAME, headerOffset: 1 });
    const e1 = new VmuEmulator({ flash: vmu.toBytes(), rom: bios });
    assert.equal(biosAutoStart(e1, { clock }), true, g);
    const before = Uint8Array.from(e1.flash);
    e1.runFor(2);
    for (const k of ['a', 'b', 'a', 'right', 'a', 'left', 'a', 'up', 'a', 'down', 'a', 'b', 'a', 'mode']) {
      e1.setButtons([k]);
      e1.runFor(0.15);
      e1.setButtons([]);
      e1.runFor(0.8);
    }
    e1.runFor(2);
    const changed = new Set();
    for (let i = 0; i < before.length; i++) if (before[i] !== e1.flash[i]) changed.add(i);
    assert.ok(changed.size > 0, `${g}: セーブした`);
    assert.deepEqual(new Vmu(Uint8Array.from(e1.flash)).check(), [], `${g}: イメージは正常`);
    const e2 = new VmuEmulator({ flash: Uint8Array.from(e1.flash), rom: bios });
    let read = 0;
    e2.onFlashRead = (a) => { if (e2.flashEntries > 0 && changed.has(a)) read++; };
    assert.equal(biosAutoStart(e2, { clock }), true);
    e2.runFor(3);
    assert.ok(read >= changed.size / 2, `${g}: 書いた ${changed.size} バイトのうち ${read} 回読んだ`);
  }
});
