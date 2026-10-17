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

/**
 * ブザー (P1.7) の波形を記録しながら動かす。返り値の edges は [秒, 0/1] の変化点
 * (runScript と同じ keys を受け付ける)
 */
export function recordAudio(emu, opts = {}) {
  const edges = [[emu.time, emu.p17]];
  const prev = emu.onAudio;
  emu.onAudio = (t, level) => edges.push([t, level]);
  const start = emu.time;
  try {
    runScript(emu, opts);
  } finally {
    emu.onAudio = prev;
  }
  return { start, end: emu.time, edges };
}

/** 変化点を PCM (16bit モノラル) にする。各サンプルの区間で H だった割合を振幅にする (箱型フィルタ) */
export function edgesToPcm({ start, end, edges }, sampleRate = 22050, volume = 0.25) {
  const n = Math.max(0, Math.floor((end - start) * sampleRate));
  const pcm = new Int16Array(n);
  let e = 0;
  let level = edges[0]?.[1] ?? 0;
  for (let i = 0; i < n; i++) {
    const t0 = start + i / sampleRate;
    const t1 = t0 + 1 / sampleRate;
    let high = 0;
    let t = t0;
    while (e + 1 < edges.length && edges[e + 1][0] < t1) {
      const te = Math.max(t0, edges[e + 1][0]);
      if (level) high += te - t;
      t = te;
      e++;
      level = edges[e][1];
    }
    if (level) high += t1 - t;
    // 直流分を除くため -1〜1 の矩形波にする (H の割合 0〜1 → -1〜1)
    pcm[i] = Math.round((high * sampleRate * 2 - 1) * volume * 32767);
  }
  // 無音 (ずっと L) は 0 に
  if (edges.length <= 1 && !level) pcm.fill(0);
  return pcm;
}

/** PCM を WAV ファイルのバイト列に */
export function pcmToWav(pcm, sampleRate = 22050) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  pcm.forEach((x, i) => v.setInt16(44 + i * 2, x, true));
  return new Uint8Array(buf);
}

/**
 * 変化点から鳴っている音の並び (周波数と長さ) を求める。立ち上がりの間隔を周期とし、同じ周期が続く区間をまとめる
 * @returns {{t: number, dur: number, hz: number, note: string, cents: number}[]} note は平均律 (A4 = 440Hz) で一番近い音名
 */
export function audioNotes({ edges }, { minDur = 0.02 } = {}) {
  const rises = edges.filter(([, l]) => l === 1).map(([t]) => t);
  const out = [];
  for (let i = 1; i < rises.length; i++) {
    const period = rises[i] - rises[i - 1];
    const last = out[out.length - 1];
    if (period > 0.1 || period <= 0) continue; // 10Hz 未満は音の切れ目、0 は同じ瞬間に何度も書いたもの
    // 直前の周期と 1% 以内で、途切れずに続いていれば同じ音 (時刻の足し算は誤差が溜まるので添字で続きを見る)
    if (last && last.end === i - 1 && Math.abs(last.period - period) / period < 0.01) {
      last.dur += period;
      last.end = i;
    } else out.push({ t: rises[i - 1], dur: period, period, end: i });
  }
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return out.filter((n) => n.dur >= minDur).map(({ t, dur, period }) => {
    const hz = 1 / period;
    const midi = 69 + 12 * Math.log2(hz / 440);
    const r = Math.round(midi);
    return { t, dur, hz, note: `${NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`, cents: Math.round((midi - r) * 100) };
  });
}
