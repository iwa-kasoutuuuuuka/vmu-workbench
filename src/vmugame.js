// ミニゲームの組み立てと、エミュレーターをスクリプトで動かすための補助 (CLI / MCP / GUI 共通)
import { assemble } from './vmuasm.js';
import { parseHeader, updateCrc } from './vms.js';
import { VmuEmulator, LCD_W, LCD_H, FLASH_SIZE, BUTTONS } from './vmuemu.js';

export const GAME_HEADER_OFFSET = 0x200;

/** アセンブルして 512 バイト単位に揃え、0x200 に VMS ヘッダがあれば CRC を入れる */
export function buildGame(source) {
  const { bytes, labels } = assemble(source);
  const out = new Uint8Array(Math.max(512, Math.ceil(bytes.length / 512) * 512));
  out.set(bytes);
  const h = parseHeader(out, GAME_HEADER_OFFSET);
  const header = h?.valid ? h : null;
  if (header) updateCrc(out, header);
  return { bytes: out, labels, header: header && parseHeader(out, GAME_HEADER_OFFSET) };
}

/** 128KB の VMU イメージならそのまま、ゲーム単体 (.vms) ならブロック 0 から置いたフラッシュを作る */
export function flashFrom(bytes) {
  if (bytes.length === FLASH_SIZE) return Uint8Array.from(bytes);
  if (bytes.length > FLASH_SIZE) throw new Error('128KB を超えています');
  const f = new Uint8Array(FLASH_SIZE);
  f.set(bytes);
  return f;
}

/**
 * キー操作の予定を読む: "1:right,1.5:,2:a+b" → 1 秒で右を押す、1.5 秒で全部離す、2 秒で A と B
 * @returns {{t: number, buttons: string[]}[]}
 */
export function parseKeys(spec) {
  if (!spec) return [];
  return spec.split(',').map((part) => {
    const m = /^\s*([\d.]+)\s*:\s*(.*?)\s*$/.exec(part);
    if (!m || !Number.isFinite(Number(m[1]))) throw new Error(`キー操作の書式は 秒:ボタン+ボタン です ("${part}")`);
    const buttons = m[2] ? m[2].toLowerCase().split('+').map((s) => s.trim()) : [];
    for (const b of buttons) if (!(b in BUTTONS)) throw new Error(`知らないボタン "${b}" (${Object.keys(BUTTONS).join(' / ')})`);
    return { t: Number(m[1]), buttons };
  }).sort((a, b) => a.t - b.t);
}

/** 予定どおりにボタンを押しながら seconds 秒動かす。止まったら途中で返る */
export function runScript(emu, { seconds = 2, keys = [] } = {}) {
  let t = 0;
  for (const k of [...keys, { t: seconds, buttons: null }]) {
    const until = Math.min(k.t, seconds);
    if (until > t) {
      emu.runFor(until - t);
      t = until;
    }
    if (emu.stopReason || k.buttons === null) break;
    emu.setButtons(k.buttons);
  }
  return emu.state();
}

/** LCD を文字で (# = 点灯) */
export function lcdText(lcd) {
  const rows = [];
  for (let y = 0; y < LCD_H; y++) {
    let s = '';
    for (let x = 0; x < LCD_W; x++) s += lcd.pixels[y * LCD_W + x] ? '#' : '.';
    rows.push(s);
  }
  return rows.join('\n');
}

/** LCD を RGBA に (VMU 風の緑がかった液晶色、scale 倍) */
export function lcdRgba(lcd, scale = 4) {
  const w = LCD_W * scale;
  const h = LCD_H * scale;
  const rgba = new Uint8Array(w * h * 4);
  const on = [0x10, 0x20, 0x40];
  const off = lcd.on ? [0x9a, 0xb8, 0x9a] : [0x80, 0x90, 0x80];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const lit = lcd.on && lcd.pixels[Math.floor(y / scale) * LCD_W + Math.floor(x / scale)];
      rgba.set([...(lit ? on : off), 255], (y * w + x) * 4);
    }
  }
  return { rgba, width: w, height: h };
}

export { VmuEmulator };

/**
 * BIOS の時計を合わせる。BIOS (jp1.004) は RAM バンク 0 の 0x17-0x18 = 年 (上位/下位)、0x19 = 月、0x1a = 日、0x1b = 時、
 * 0x1c = 分、0x1d = 秒 (2 進数) で時計を進め、0x10〜0x16 は設定画面用の BCD (世紀・年・月・日・時・分・秒)。
 * 資料が無いため、時計の設定画面で値を変えたときと時間を進めたときの RAM の変化から確かめた (CLOCK 画面に反映されることも確認)
 */
export function setBiosClock(emu, date) {
  const r = emu.ram[0];
  const y = date.getFullYear();
  const bcd = (n) => (Math.floor(n / 10) << 4) | (n % 10);
  r.set([y >> 8, y & 0xff, date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()], 0x17);
  r.set([bcd(Math.floor(y / 100)), bcd(y % 100), bcd(date.getMonth() + 1), bcd(date.getDate()), bcd(date.getHours()), bcd(date.getMinutes()), bcd(date.getSeconds())], 0x10);
}

/**
 * BIOS 付きで起動したエミュレーターを、時計の設定 (初期値のまま決定) → GAME → A でミニゲームの起動まで進める。
 * 実機と同じく BIOS が画面とボタンを処理するので、ボタンは BIOS が拾えるよう 0.6 秒ずつ押す
 * (起動の A だけは短く押す。押したままだと「A で終了」のゲームがすぐ BIOS に戻るため)。
 * clock (Date) を渡すと、設定のあと BIOS の時計をその日時に合わせる
 * @returns {boolean} ゲーム (フラッシュ側) に入れたか
 */
export function biosAutoStart(emu, { launch = true, clock = null } = {}) {
  if (!emu.rom) throw new Error('BIOS がありません');
  const press = (b, hold = 0.6) => {
    emu.setButtons([b]);
    emu.runFor(hold);
    emu.setButtons([]);
    emu.runFor(0.6);
  };
  emu.runFor(4); // 起動 → 「デンチヲ…」や時計の設定画面
  for (let i = 0; i < 5; i++) press('a'); // 年・月・日・時・分
  press('left'); // OK? → ハイ
  press('a');
  emu.runFor(1.5);
  if (clock) setBiosClock(emu, clock);
  if (!launch) return false;
  // MODE で GAME を選ぶ (選んでいるアイコンは点滅するので、A で入れたかで判断する)。
  // 起動直後に BIOS を呼ぶゲーム (Shenmue など) は判定の瞬間に ROM 側にいることがあるので、フラッシュに入った回数で見る
  const entries = emu.flashEntries;
  for (let i = 0; i < 4 && emu.flashEntries === entries && !emu.stopReason; i++) {
    press('mode');
    press('a', 0.05);
  }
  return emu.flashEntries > entries;
}

/**
 * エミュレーターで動かす前後のフラッシュを比べ、書き換わったブロックと、そのブロックを使っているファイルを返す
 * (ゲームのセーブがどこに書かれたかの確認・イメージへの書き戻し用)
 * @returns {{blocks: number[], files: string[], system: boolean}} system = FAT・ディレクトリ・ルートが変わった
 */
export function flashChanges(before, after, Vmu) {
  const blocks = [];
  for (let b = 0; b < 256; b++) {
    for (let i = b * 512; i < b * 512 + 512; i++) {
      if (before[i] !== after[i]) {
        blocks.push(b);
        break;
      }
    }
  }
  const files = new Set();
  let system = false;
  if (Vmu && blocks.length) {
    try {
      const vmu = new Vmu(Uint8Array.from(after));
      const owner = new Map();
      for (const e of vmu.list()) for (const b of vmu.chainSafe(e.firstBlock)) owner.set(b, e.name);
      for (const b of blocks) {
        if (owner.has(b)) files.add(owner.get(b));
        else if (b >= vmu.root.userBlocks) system = true;
      }
    } catch {
      system = true;
    }
  }
  return { blocks, files: [...files], system };
}
