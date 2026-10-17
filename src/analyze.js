// セーブデータ解析の補助関数 (CLI / MCP サーバーから使う)
import { NUM_TYPES } from './types.js';
import { diffBytes } from './edit.js';

const SEARCH_TYPES = ['u8', 'u16le', 'u16be', 'u32le', 'u32be'];
const hex2 = (b) => b.toString(16).padStart(2, '0');

function readAt(bytes, offset, type) {
  const t = NUM_TYPES[type];
  if (offset + t.size > bytes.length) return undefined;
  return t.get(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset);
}

/**
 * 既知の値を探す。複数セーブを渡すと「各セーブで同じ位置にそれぞれの値が入っている」位置だけを返す
 * (例: 1 回目のスコア 1200、2 回目 3400 → 両方を満たすオフセットと型)。
 * @param {Uint8Array[]} saves
 * @param {number[]} values  saves と同じ順の値
 * @returns {{offset: number, type: string}[]}
 */
export function correlateValues(saves, values, types = SEARCH_TYPES) {
  if (saves.length !== values.length || saves.length === 0) throw new Error('セーブと値の数を揃えてください');
  const hits = [];
  const len = Math.min(...saves.map((s) => s.length));
  for (const type of types) {
    const t = NUM_TYPES[type];
    for (let o = 0; o + t.size <= len; o++) {
      if (saves.every((s, i) => readAt(s, o, type) === values[i])) hits.push({ offset: o, type });
    }
  }
  return hits;
}

/** 文字列 (ASCII) を探す */
export function findText(bytes, text) {
  const pat = [...text].map((c) => c.charCodeAt(0));
  const hits = [];
  for (let o = 0; o + pat.length <= bytes.length; o++) {
    if (pat.every((c, i) => bytes[o + i] === c)) hits.push(o);
  }
  return hits;
}

/** 印字可能な ASCII の並び */
export function scanStrings(bytes, minLength = 3) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= bytes.length; i++) {
    const printable = i < bytes.length && bytes[i] >= 0x20 && bytes[i] < 0x7f;
    if (printable && start < 0) start = i;
    if (!printable && start >= 0) {
      if (i - start >= minLength) out.push({ offset: start, text: String.fromCharCode(...bytes.subarray(start, i)) });
      start = -1;
    }
  }
  return out;
}

/** 同じ値が続く領域 (未使用・初期値の領域の目安) */
export function scanRuns(bytes, minLength = 16) {
  const out = [];
  for (let i = 0; i < bytes.length;) {
    let j = i + 1;
    while (j < bytes.length && bytes[j] === bytes[i]) j++;
    if (j - i >= minLength) out.push({ offset: i, length: j - i, value: bytes[i] });
    i = j;
  }
  return out;
}

/**
 * 繰り返し構造 (レコード長) の候補: 同じ文字列が一定間隔で並ぶ場所から推定する
 * @returns {{stride: number, count: number, first: number, sample: string}[]}
 */
export function guessRecords(bytes, minCount = 4, maxStride = 0x100) {
  const strings = scanStrings(bytes, 3).filter((s) => s.text.length <= 16);
  const at = new Map(strings.map((s) => [s.offset, s.text]));
  const runs = [];
  for (let stride = 4; stride <= maxStride; stride++) {
    const visited = new Set();
    for (const s of strings) {
      if (visited.has(s.offset)) continue;
      let count = 0;
      for (let o = s.offset; at.has(o); o += stride) {
        visited.add(o);
        count++;
      }
      if (count >= minCount) runs.push({ stride, count, first: s.offset, sample: s.text });
    }
  }
  // 小さい周期の並びに含まれる倍数周期の候補は除く
  const kept = runs.filter((r) => !runs.some((q) => q !== r && q.stride < r.stride && r.stride % q.stride === 0
    && r.first >= q.first && (r.first - q.first) % q.stride === 0
    && r.first + r.stride * (r.count - 1) <= q.first + q.stride * (q.count - 1)));
  return kept.sort((a, b) => b.count - a.count || a.first - b.first).slice(0, 12);
}

/** 16 進ダンプ (テキスト) */
export function hexDump(bytes, offset = 0, length = 256) {
  const lines = [];
  const end = Math.min(bytes.length, offset + length);
  for (let o = offset - (offset % 16); o < end; o += 16) {
    const row = [];
    let asc = '';
    for (let k = 0; k < 16; k++) {
      const p = o + k;
      if (p < offset || p >= end) {
        row.push('  ');
        asc += ' ';
      } else {
        row.push(hex2(bytes[p]));
        asc += bytes[p] >= 0x20 && bytes[p] < 0x7f ? String.fromCharCode(bytes[p]) : '.';
      }
    }
    lines.push(`${o.toString(16).padStart(4, '0')}  ${row.slice(0, 8).join(' ')}  ${row.slice(8).join(' ')}  ${asc}`);
  }
  return lines.join('\n');
}

/**
 * 差分にフィールド名・チェックサム名を付ける
 * @param fields resolveViewFields の結果 (無ければ [])
 * @param sums checksumStatus の結果 (無ければ [])
 */
export function labeledDiff(a, b, fields = [], sums = []) {
  return diffBytes(a, b).map((d) => {
    const start = d.offset;
    const end = d.offset + d.after.length;
    const labels = [
      ...fields.filter((f) => f.offset < end && f.offset + f.size > start).map((f) => f.name),
      ...sums.filter((c) => c.inRange && c.at < end && c.at + c.size > start).map((c) => c.name),
    ];
    return { offset: d.offset, before: d.before, after: d.after, labels };
  });
}

/**
 * 複数のセーブ (時系列順) で各バイトが何回変わったか。ゲームの進行で変わる場所 (スコア・回数など) を探す
 * @returns {{changes: Uint16Array, length: number, compared: number}}  changes[i] = 隣り合うセーブ間で i が変わった回数
 */
export function byteVariability(saves) {
  if (saves.length < 2) throw new Error('比べるセーブを 2 つ以上指定してください');
  const length = Math.min(...saves.map((s) => s.length));
  const changes = new Uint16Array(length);
  for (let k = 1; k < saves.length; k++) {
    for (let i = 0; i < length; i++) if (saves[k][i] !== saves[k - 1][i]) changes[i]++;
  }
  return { changes, length, compared: saves.length - 1 };
}

/** 変化したバイトを連続範囲にまとめ、変化回数の多い順に返す */
export function hotRanges(changes, { min = 1, gap = 0 } = {}) {
  const ranges = [];
  for (let i = 0; i < changes.length; i++) {
    if (changes[i] < min) continue;
    let j = i;
    let max = changes[i];
    let sum = 0;
    while (j < changes.length && (changes[j] >= min || (gap && changes.slice(j, j + gap + 1).some((c) => c >= min)))) {
      max = Math.max(max, changes[j]);
      sum += changes[j];
      j++;
    }
    while (j > i && changes[j - 1] < min) j--; // 末尾の隙間は含めない
    ranges.push({ start: i, end: j, max, sum });
    i = j;
  }
  return ranges.sort((a, b) => b.max - a.max || b.sum - a.sum || a.start - b.start);
}

/** 定義のフィールドに含まれない (未解析の) 範囲 */
export function uncoveredRanges(length, fields, sums = [], minLength = 1) {
  const covered = new Uint8Array(length);
  for (const f of fields) if (f.inRange) covered.fill(1, f.offset, f.offset + f.size);
  for (const c of sums) if (c.inRange) covered.fill(1, c.at, c.at + c.size);
  const out = [];
  for (let i = 0; i < length;) {
    if (covered[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < length && !covered[j]) j++;
    if (j - i >= minLength) out.push({ start: i, end: j });
    i = j;
  }
  return out;
}
