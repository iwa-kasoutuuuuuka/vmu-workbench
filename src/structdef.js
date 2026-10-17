// タイトル別の構造定義: セーブデータのオフセットに名前と型を付けて値を読み書きする
//
// 定義 (JSON) の例:
// {
//   "id": "my-game",                    // 一意なID
//   "title": "ゲーム名",
//   "match": { "appId": "^MYGAME$", "fileName": "^MYGAME_", "description": "..." },  // 正規表現。書いた条件すべてに一致
//   "base": "data",                     // オフセットの基準: "data" = VMSデータ部の先頭 (既定) / "file" = ファイル先頭
//   "fields": [
//     { "name": "所持金", "offset": "0x10", "type": "u32le", "max": 999999 },
//     { "name": "難易度", "offset": 4, "type": "u8", "enum": { "0": "Easy", "1": "Normal" } },
//     { "name": "クリア", "offset": 5, "type": "u8", "flags": { "0": "ステージ1", "1": "ステージ2" } },
//     { "name": "名前", "offset": "0x20", "type": "string", "length": 8 },
//     { "name": "アイテム", "offset": "0x40", "type": "u8", "count": 10, "stride": 1, "group": "持ち物" }
//   ]
// }
import { NUM_TYPES, parseInteger } from './types.js';
import { parseHeader, headerPosition } from './vms.js';
import { CONTAINERS, ps1FindSave, ps1ReadSave, ps1WriteSave } from './containers.js';

export const FIELD_TYPES = [...Object.keys(NUM_TYPES), 'bool', 'string', 'bytes'];
const MATCH_KEYS = ['appId', 'fileName', 'description'];

const toInt = (v) => (typeof v === 'number' ? v : parseInteger(v));
const isIntType = (type) => type in NUM_TYPES;

let sjisDecoder;
function decodeSjis(bytes) {
  try {
    sjisDecoder ??= new TextDecoder('shift_jis');
    return sjisDecoder.decode(bytes);
  } catch {
    return String.fromCharCode(...bytes);
  }
}

export function fieldSize(f) {
  if (isIntType(f.type)) return NUM_TYPES[f.type].size;
  if (f.type === 'bool') return 1;
  return toInt(f.length);
}

/** 定義の検証。問題点の配列を返す (空なら正常) */
export function validateDef(def) {
  const errors = [];
  if (!def || typeof def !== 'object') return ['定義がオブジェクトではありません'];
  if (typeof def.id !== 'string' || !def.id) errors.push('id がありません');
  if (typeof def.title !== 'string' || !def.title) errors.push('title がありません');
  if (def.base !== undefined && !['data', 'file'].includes(def.base)) errors.push(`base は "data" か "file": ${def.base}`);
  const match = def.match ?? {};
  if (!MATCH_KEYS.some((k) => match[k])) errors.push(`match に ${MATCH_KEYS.join(' / ')} のいずれかが必要です`);
  for (const k of Object.keys(match)) {
    if (!MATCH_KEYS.includes(k)) errors.push(`match.${k} は未対応のキーです`);
    else {
      try {
        new RegExp(match[k]);
      } catch {
        errors.push(`match.${k} の正規表現が不正です: ${match[k]}`);
      }
    }
  }
  if (!Array.isArray(def.fields) || def.fields.length === 0) {
    errors.push('fields がありません');
    return errors;
  }
  const names = new Set();
  def.fields.forEach((f, i) => {
    const at = `fields[${i}]${f?.name ? ` (${f.name})` : ''}`;
    if (!f?.name) errors.push(`${at}: name がありません`);
    else if (names.has(f.name)) errors.push(`${at}: name が重複しています`);
    names.add(f?.name);
    if (!FIELD_TYPES.includes(f?.type)) {
      errors.push(`${at}: type が不正です (${FIELD_TYPES.join(', ')})`);
      return;
    }
    const off = toInt(f.offset);
    if (!Number.isInteger(off) || off < 0) errors.push(`${at}: offset が不正です: ${f.offset}`);
    if (['string', 'bytes'].includes(f.type)) {
      const len = toInt(f.length);
      if (!Number.isInteger(len) || len < 1) errors.push(`${at}: ${f.type} には length (1以上) が必要です`);
    }
    if ((f.enum || f.flags) && !isIntType(f.type)) errors.push(`${at}: enum / flags は整数型のみ`);
    if (f.flags && Object.keys(f.flags).some((b) => !(Number(b) >= 0 && Number(b) < NUM_TYPES[f.type]?.size * 8))) {
      errors.push(`${at}: flags のビット番号が型の範囲外です`);
    }
    if (f.encoding && !['ascii', 'sjis'].includes(f.encoding)) errors.push(`${at}: encoding は ascii / sjis`);
    if (f.count !== undefined && !(Number.isInteger(f.count) && f.count >= 1)) errors.push(`${at}: count は1以上の整数`);
    if (f.stride !== undefined && !(toInt(f.stride) >= fieldSize(f))) errors.push(`${at}: stride はフィールドサイズ以上`);
    for (const k of ['min', 'max']) {
      if (f[k] !== undefined && !Number.isInteger(toInt(f[k]))) errors.push(`${at}: ${k} が不正です`);
    }
  });
  if (def.container !== undefined) {
    const c = def.container;
    if (!CONTAINERS[c?.type]) errors.push(`container.type は ${Object.keys(CONTAINERS).join(' / ')}`);
    if (def.base === 'data') errors.push('container を使う定義では base は "file" (コンテナ内データの先頭) のみ');
    if (c?.ps1Save !== undefined) {
      try {
        new RegExp(c.ps1Save);
      } catch {
        errors.push(`container.ps1Save の正規表現が不正です: ${c.ps1Save}`);
      }
    }
  }
  if (def.checksums !== undefined && !Array.isArray(def.checksums)) errors.push('checksums は配列で書いてください');
  const fieldSpans = (Array.isArray(def.fields) ? def.fields : []).flatMap((f) => {
    const size = FIELD_TYPES.includes(f?.type) ? fieldSize(f) : NaN;
    const count = f?.count ?? 1;
    const stride = f?.stride !== undefined ? toInt(f.stride) : size;
    return Array.from({ length: Number.isInteger(count) ? count : 0 }, (_, k) => ({ name: f.name, start: toInt(f.offset) + k * stride, size }));
  });
  (Array.isArray(def.checksums) ? def.checksums : []).forEach((cs, i) => {
    const at = `checksums[${i}]${cs?.name ? ` (${cs.name})` : ''}`;
    if (!CHECKSUMS[cs?.type]) errors.push(`${at}: type は ${Object.keys(CHECKSUMS).join(' / ')}`);
    if (!NUM_TYPES[cs?.store] || NUM_TYPES[cs.store].min < 0) errors.push(`${at}: store は符号なし整数型 (u8 / u16le / u32le など)`);
    const [from, to, atOff] = [cs?.from, cs?.to, cs?.at].map(toInt);
    if (![from, to, atOff].every((n) => Number.isInteger(n) && n >= 0)) errors.push(`${at}: from / to / at が不正です`);
    else if (from >= to) errors.push(`${at}: from < to である必要があります`);
    else {
      if (NUM_TYPES[cs.store] && atOff < to && atOff + NUM_TYPES[cs.store].size > from) {
        errors.push(`${at}: 格納位置 (at) が計算範囲 (from〜to) と重なっています`);
      }
      if (/^sum16/.test(cs.type) && (to - from) % 2) errors.push(`${at}: ${cs.type} の範囲 (from〜to) は偶数バイトにしてください`);
      const size = NUM_TYPES[cs.store]?.size ?? 0;
      const hit = fieldSpans.find((f) => f.start < atOff + size && atOff < f.start + f.size);
      if (hit) errors.push(`${at}: 格納位置がフィールド ${hit.name} と重なっています (書き込んだ値がチェックサムで上書きされます)`);
    }
  });
  return errors;
}

// ---- チェックサム (タイトル独自) ----
// 範囲 [from, to) は基準位置からの相対。結果は store 型のビット幅で切り詰めて at に格納する。
export const CHECKSUMS = {
  sum8: (b) => b.reduce((s, x) => s + x, 0),
  xor8: (b) => b.reduce((s, x) => s ^ x, 0),
  sum16le: (b) => {
    let s = 0;
    for (let i = 0; i + 1 < b.length; i += 2) s += b[i] | (b[i + 1] << 8);
    return s;
  },
  sum16be: (b) => {
    let s = 0;
    for (let i = 0; i + 1 < b.length; i += 2) s += (b[i] << 8) | b[i + 1];
    return s;
  },
};

function checksumInfo(cs, bytes, base) {
  const t = NUM_TYPES[cs.store];
  const from = base + toInt(cs.from);
  const to = base + toInt(cs.to);
  const at = base + toInt(cs.at);
  if (to > bytes.length || at + t.size > bytes.length) return { name: cs.name ?? cs.type, inRange: false };
  const actual = CHECKSUMS[cs.type](bytes.subarray(from, to)) % 2 ** (t.size * 8);
  const stored = t.get(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), at);
  return { name: cs.name ?? cs.type, inRange: true, at, size: t.size, stored, actual, ok: stored === actual, store: cs.store };
}

/** 定義の全チェックサムの状態 */
export function checksumStatus(def, bytes, base) {
  return (def.checksums ?? []).map((cs) => checksumInfo(cs, bytes, base));
}

/** チェックサムを再計算して書き込む (bytes を直接変更)。書き込んだ [{at, bytes}] を返す */
export function applyChecksums(def, bytes, base) {
  const writes = [];
  for (const cs of def.checksums ?? []) {
    const info = checksumInfo(cs, bytes, base);
    if (!info.inRange) continue;
    const view = new DataView(new ArrayBuffer(info.size));
    NUM_TYPES[cs.store].set(view, 0, info.actual);
    const b = new Uint8Array(view.buffer);
    bytes.set(b, info.at);
    writes.push({ at: info.at, bytes: b });
  }
  return writes;
}

/**
 * 定義から見たデータ (ビュー) を開く
 *   container 無し: bytes = VMU ファイルそのもの
 *   container 有り: bytes = コンテナを展開した中身 (ps1Save 指定時はそのセーブのブロックを連結したもの)
 * @returns {{bytes: Uint8Array, base: number, container: string|null, label: string,
 *            pack: (bytes: Uint8Array) => Uint8Array} | null}  開けない (形式違い・セーブ無し) なら null
 *   pack: ビューの bytes を VMU ファイルのバイト列に戻す
 */
export function openView(def, entry, data) {
  if (!def.container) {
    const h = headerOf(entry, data);
    return {
      bytes: data,
      base: def.base === 'file' ? 0 : h?.dataOffset ?? 0,
      container: null,
      label: def.base === 'file' ? 'ファイル先頭' : 'データ部',
      pack: (bytes) => bytes,
    };
  }
  const c = CONTAINERS[def.container.type];
  const inner = c?.decode(data);
  if (!inner) return null;
  if (def.container.ps1Save === undefined) {
    return { bytes: inner, base: 0, container: def.container.type, label: c.label, pack: (bytes) => c.encode(bytes) };
  }
  const save = ps1FindSave(inner, def.container.ps1Save);
  if (!save) return null;
  return {
    bytes: ps1ReadSave(inner, save),
    base: 0,
    container: def.container.type,
    label: `${c.label} / ${save.name} (ブロック ${save.blocks.join(',')})`,
    save,
    pack: (bytes) => c.encode(ps1WriteSave(inner, save, bytes)),
  };
}

function headerOf(entry, data) {
  const h = parseHeader(data, headerPosition(entry));
  return h?.valid ? h : null;
}

/** ファイルが定義の match 条件に一致するか */
export function matches(def, entry, data) {
  const match = def.match ?? {};
  if (!MATCH_KEYS.some((k) => match[k])) return false;
  const h = headerOf(entry, data);
  const subject = { appId: h?.appId ?? '', description: h?.description ?? '', fileName: entry.name };
  if (!MATCH_KEYS.every((k) => !match[k] || new RegExp(match[k]).test(subject[k]))) return false;
  return !def.container || openView(def, entry, data) !== null;
}

export function findDefs(defs, entry, data) {
  return defs.filter((d) => matches(d, entry, data));
}

/** オフセットの基準位置 (ビューの先頭からのバイト位置) */
export function baseOffset(def, entry, data) {
  return openView(def, entry, data)?.base ?? 0;
}

/**
 * 配列を展開し、ビュー先頭からの絶対オフセットを付けたフィールド一覧。
 * 値の読み書きは openView(...).bytes に対して行う (container 無しならファイルそのもの)。
 */
export function resolveFields(def, entry, data) {
  const view = openView(def, entry, data);
  if (!view) return [];
  return resolveViewFields(def, view);
}

export function resolveViewFields(def, view) {
  const { base } = view;
  const data = view.bytes;
  const out = [];
  for (const f of def.fields) {
    const size = fieldSize(f);
    const count = f.count ?? 1;
    const stride = f.stride !== undefined ? toInt(f.stride) : size;
    for (let i = 0; i < count; i++) {
      const offset = base + toInt(f.offset) + i * stride;
      out.push({
        ...f,
        name: count > 1 ? `${f.name}[${i}]` : f.name,
        baseName: f.name,
        relOffset: toInt(f.offset) + i * stride,
        offset,
        size,
        inRange: offset + size <= data.length,
      });
    }
  }
  return out;
}

/** group ごとにまとめる (グループの並びは定義内での初出順) */
export function groupFields(fields) {
  const groups = new Map();
  for (const f of fields) {
    const g = f.group ?? '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(f);
  }
  return [...groups].map(([group, list]) => ({ group, fields: list }));
}

/** フィールドの値を読む: 整数 → number, bool → boolean, string → string, bytes → Uint8Array */
export function readField(data, f) {
  if (!f.inRange) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (isIntType(f.type)) return NUM_TYPES[f.type].get(view, f.offset);
  if (f.type === 'bool') return data[f.offset] !== 0;
  const bytes = data.slice(f.offset, f.offset + f.size);
  if (f.type === 'bytes') return bytes;
  const end = bytes.indexOf(0);
  const body = end >= 0 ? bytes.subarray(0, end) : bytes;
  return (f.encoding === 'sjis' ? decodeSjis(body) : String.fromCharCode(...body)).replace(/ +$/, '');
}

/** 表示用の文字列 (enum ラベル・フラグ名を含む) */
export function formatField(f, value) {
  if (value === undefined) return '(範囲外)';
  if (f.type === 'bytes') return [...value].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  if (f.enum) return f.enum[value] !== undefined ? `${f.enum[value]} (${value})` : `? (${value})`;
  if (f.flags) {
    const on = Object.entries(f.flags).filter(([bit]) => (value >>> Number(bit)) & 1).map(([, label]) => label);
    return `${on.length ? on.join(', ') : 'なし'} (0x${value.toString(16)})`;
  }
  return String(value);
}

/** 入力値 → 書き込むバイト列。不正な値は例外 */
export function encodeField(f, input) {
  const name = f.name;
  if (isIntType(f.type)) {
    const t = NUM_TYPES[f.type];
    let value = typeof input === 'number' ? input : parseInteger(input);
    if (Number.isNaN(value) && f.enum) {
      const hit = Object.entries(f.enum).find(([, label]) => label === String(input).trim());
      if (hit) value = Number(hit[0]);
    }
    const min = f.min !== undefined ? toInt(f.min) : t.min;
    const max = f.max !== undefined ? toInt(f.max) : t.max;
    if (!Number.isInteger(value)) throw new Error(`${name}: 整数を入力してください: ${input}`);
    if (value < min || value > max) throw new Error(`${name}: ${min}〜${max} の範囲で入力してください`);
    const view = new DataView(new ArrayBuffer(t.size));
    t.set(view, 0, value);
    return new Uint8Array(view.buffer);
  }
  if (f.type === 'bool') {
    const s = String(input).trim().toLowerCase();
    if (!['true', 'false', '1', '0'].includes(s)) throw new Error(`${name}: true / false で入力してください`);
    return Uint8Array.of(s === 'true' || s === '1' ? 1 : 0);
  }
  if (f.type === 'bytes') {
    const hex = String(input).replace(/0x/gi, '').replace(/[\s,]/g, '');
    if (hex.length !== f.size * 2 || /[^0-9a-f]/i.test(hex)) throw new Error(`${name}: ${f.size} バイトの16進で入力してください`);
    return Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
  }
  // string
  if (f.encoding === 'sjis') throw new Error(`${name}: Shift_JIS 文字列の書き込みは未対応です`);
  const s = String(input);
  if (/[^\x20-\x7e]/.test(s)) throw new Error(`${name}: 半角英数記号のみ入力できます`);
  if (s.length > f.size) throw new Error(`${name}: ${f.size} 文字以内で入力してください`);
  const out = new Uint8Array(f.size).fill(f.pad !== undefined ? toInt(f.pad) : 0);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * フィールドに値を書き込んだ VMU ファイルのバイト列を返す
 * (定義にチェックサムがあれば再計算、コンテナなら再格納まで行う。サイズが変わることがある)
 * @param {Object<string, *>} assignments { フィールド名: 値 } (配列要素は "名前[2]")
 * @param {{fixChecksums?: boolean}} opts
 */
export function setFields(data, def, entry, assignments, { fixChecksums = true } = {}) {
  const view = openView(def, entry, data);
  if (!view) throw new Error(`${entry.name}: 定義 ${def.id} のコンテナ/セーブを開けません`);
  const fields = resolveViewFields(def, view);
  const out = Uint8Array.from(view.bytes);
  for (const [name, value] of Object.entries(assignments)) {
    const f = fields.find((x) => x.name === name);
    if (!f) throw new Error(`フィールドがありません: ${name}`);
    if (!f.inRange) throw new Error(`${name}: ファイル範囲外です`);
    out.set(encodeField(f, value), f.offset);
  }
  if (fixChecksums) applyChecksums(def, out, view.base);
  return view.pack(out);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 選択中のファイル用に空の定義を作る (appId があればそれで、無ければファイル名で一致させる) */
export function newDefFor(entry, data) {
  const h = headerOf(entry, data);
  const match = h?.appId ? { appId: `^${escapeRe(h.appId)}$` } : { fileName: `^${escapeRe(entry.name)}$` };
  return {
    id: (h?.appId || entry.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'new-def',
    title: h?.description || entry.name,
    match,
    base: h ? 'data' : 'file',
    fields: [],
  };
}
