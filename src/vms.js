// VMSセーブファイルヘッダ / アイコン / CRC / DCI 形式
import { BLOCK_SIZE, DIR_ENTRY_SIZE, FILE_GAME } from './vmu.js';

export const HEADER_SIZE = 0x80;
export const ICON_SIZE = 32 * 32 / 2; // 4bpp 32x32
const EYECATCH_SIZES = [0, 72 * 56 * 2, 512 + 72 * 56, 32 + 72 * 56 / 2];

const sjis = typeof TextDecoder !== 'undefined' ? (() => {
  try { return new TextDecoder('shift_jis'); } catch { return null; }
})() : null;

function decodeText(bytes) {
  const end = bytes.indexOf(0);
  const b = end >= 0 ? bytes.subarray(0, end) : bytes;
  return (sjis ? sjis.decode(b) : String.fromCharCode(...b)).trimEnd();
}

/** ファイル先頭からのヘッダ位置 (ゲームファイルはディレクトリのheaderOffsetブロック目) */
export function headerPosition(entry) {
  return entry.type === FILE_GAME ? entry.headerOffset * BLOCK_SIZE : 0;
}

export function parseHeader(file, offset = 0) {
  if (file.length < offset + HEADER_SIZE) return null;
  const v = new DataView(file.buffer, file.byteOffset + offset);
  const h = file.subarray(offset);
  const header = {
    offset,
    description: decodeText(h.subarray(0x00, 0x10)),
    longDescription: decodeText(h.subarray(0x10, 0x30)),
    appId: decodeText(h.subarray(0x30, 0x40)),
    iconCount: v.getUint16(0x40, true),
    animSpeed: v.getUint16(0x42, true),
    eyecatchType: v.getUint16(0x44, true),
    crc: v.getUint16(0x46, true),
    dataSize: v.getUint32(0x48, true),
    palette: Array.from({ length: 16 }, (_, i) => v.getUint16(0x60 + i * 2, true)),
  };
  // ヘッダ無しの生データファイル (KOSのO_META書き込み等) を誤認しないための目安
  header.valid = header.iconCount >= 1 && header.iconCount <= 3 && header.eyecatchType <= 3;
  header.iconsOffset = offset + HEADER_SIZE;
  header.eyecatchOffset = header.iconsOffset + header.iconCount * ICON_SIZE;
  header.dataOffset = header.eyecatchOffset + (EYECATCH_SIZES[header.eyecatchType] ?? 0);
  return header;
}

/** ARGB4444 → [r,g,b,a] (0-255) */
export function argb4444ToRgba(c) {
  return [((c >> 8) & 0xf) * 17, ((c >> 4) & 0xf) * 17, (c & 0xf) * 17, ((c >> 12) & 0xf) * 17];
}

export function rgbaToArgb4444([r, g, b, a]) {
  const q = (x) => Math.round(x / 17) & 0xf;
  return (q(a) << 12) | (q(r) << 8) | (q(g) << 4) | q(b);
}

/** アイコンをRGBA (32x32x4) で返す */
export function iconToRgba(file, header, index) {
  const base = header.iconsOffset + index * ICON_SIZE;
  const out = new Uint8ClampedArray(32 * 32 * 4);
  const pal = header.palette.map(argb4444ToRgba);
  for (let i = 0; i < ICON_SIZE; i++) {
    const byte = file[base + i];
    out.set(pal[byte >> 4], i * 8);
    out.set(pal[byte & 0xf], i * 8 + 4);
  }
  return out;
}

/** CRC計算範囲 (ヘッダ〜データ末尾) がファイル内に収まっているか */
export function crcRangeValid(file, header) {
  return header.valid && header.dataOffset + header.dataSize <= file.length;
}

/** VMSのCRC16 (CCITT, ヘッダのCRC欄を0として計算。KOS vmu_pkg_crc と同一) */
export function calcCrc(file, header) {
  const len = header.dataOffset - header.offset + header.dataSize;
  const bytes = file.slice(header.offset, header.offset + len);
  bytes[0x46] = 0;
  bytes[0x47] = 0;
  let n = 0;
  for (const b of bytes) {
    n ^= b << 8;
    for (let i = 0; i < 8; i++) n = n & 0x8000 ? ((n << 1) ^ 0x1021) & 0xffff : (n << 1) & 0xffff;
  }
  return n;
}

export function updateCrc(file, header) {
  const crc = calcCrc(file, header);
  new DataView(file.buffer, file.byteOffset).setUint16(header.offset + 0x46, crc, true);
  return crc;
}

// ---- DCI (Nexus / DreamCast Image) : ディレクトリエントリ32バイト + データ、4バイト単位でバイト順反転 ----

function swap32(bytes) {
  const out = Uint8Array.from(bytes);
  for (let i = 0; i + 3 < out.length; i += 4) {
    [out[i], out[i + 1], out[i + 2], out[i + 3]] = [out[i + 3], out[i + 2], out[i + 1], out[i]];
  }
  return out;
}

export function toDci(entry, fileData) {
  const out = new Uint8Array(DIR_ENTRY_SIZE + fileData.length);
  out.set(entry.raw);
  out.set(swap32(fileData), DIR_ENTRY_SIZE);
  return out;
}

/** DCIを {name, type, copyProtected, headerOffset, data} に分解 */
export function fromDci(bytes) {
  if (bytes.length < DIR_ENTRY_SIZE) throw new Error('DCI が短すぎます (ディレクトリエントリがありません)');
  const e = bytes.subarray(0, DIR_ENTRY_SIZE);
  const v = new DataView(e.buffer, e.byteOffset, DIR_ENTRY_SIZE);
  const sizeBlocks = v.getUint16(24, true);
  const need = DIR_ENTRY_SIZE + sizeBlocks * BLOCK_SIZE;
  if (sizeBlocks === 0 || bytes.length < need) {
    throw new Error(`DCI が途中で切れています (${sizeBlocks} ブロック分 ${need} バイト必要、実際 ${bytes.length} バイト)`);
  }
  const data = swap32(bytes.subarray(DIR_ENTRY_SIZE, need));
  return {
    type: e[0],
    copyProtected: e[1] === 0xff,
    name: String.fromCharCode(...e.subarray(4, 16)).replace(/[\0 ]+$/, ''),
    headerOffset: v.getUint16(26, true),
    timestamp: e.slice(16, 24),
    data,
  };
}
