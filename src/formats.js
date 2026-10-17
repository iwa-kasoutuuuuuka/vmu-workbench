// 他のファイル形式
//
// VMI + VMS: ネットで配布されるセーブの形式。.VMS はファイルの中身そのもの、.VMI (108 バイト) が
//            VMU 上のファイル名・属性・日時・説明を持つ (https://mc.pp.se/dc/vms/vmi.html)。
// DCM:       Nexus メモリーカードのソフトが書き出すフラッシュ全体のダンプ。4 バイトごとにバイト順が逆
//            (https://mc.pp.se/dc/vms/flashmem.html)。4MB カードなら 128KB × 複数ページ
// 複数ページ: 128KB の VMU イメージを連結したファイル (大容量メモリーカードのダンプなど)。
//            どの製品の形式かは確認していないため、単純な連結として扱う。
import { IMAGE_SIZE, FILE_GAME, FILE_DATA } from './vmu.js';
import { parseHeader, headerPosition } from './vms.js';

export const VMI_SIZE = 108;
const SEGA = [0x53, 0x45, 0x47, 0x41];

let sjis;
function decodeText(bytes) {
  const end = bytes.indexOf(0);
  const b = end >= 0 ? bytes.subarray(0, end) : bytes;
  try {
    sjis ??= new TextDecoder('shift_jis');
    return sjis.decode(b).trimEnd();
  } catch {
    return String.fromCharCode(...b).trimEnd();
  }
}

function asciiBytes(text, length) {
  const out = new Uint8Array(length);
  [...String(text)].slice(0, length).forEach((c, i) => {
    const code = c.charCodeAt(0);
    out[i] = code < 0x7f ? code : 0x3f; // ASCII 以外は ?
  });
  return out;
}

/** チェックサム: リソース名の先頭 4 バイトと "SEGA" の AND (バイトごと) */
export function vmiChecksum(resourceNameBytes) {
  return Uint8Array.from(SEGA, (s, i) => (resourceNameBytes[i] ?? 0) & s);
}

/** VMI を読む */
export function parseVmi(bytes) {
  if (bytes.length < VMI_SIZE) throw new Error(`VMI は ${VMI_SIZE} バイトです (実際 ${bytes.length})`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, VMI_SIZE);
  const resource = bytes.subarray(0x50, 0x58);
  const mode = v.getUint16(0x64, true);
  const year = v.getUint16(0x44, true);
  const date = new Date(2000, 0, 1, bytes[0x48], bytes[0x49], bytes[0x4a]);
  date.setFullYear(year, bytes[0x46] - 1, bytes[0x47]);
  return {
    checksumOk: vmiChecksum(resource).every((c, i) => c === bytes[i]),
    description: decodeText(bytes.subarray(0x04, 0x24)),
    copyright: decodeText(bytes.subarray(0x24, 0x44)),
    date: year ? date : null,
    version: v.getUint16(0x4c, true),
    fileNumber: v.getUint16(0x4e, true),
    resourceName: decodeText(resource),
    fileName: decodeText(bytes.subarray(0x58, 0x64)),
    type: mode & 2 ? FILE_GAME : FILE_DATA,
    copyProtected: (mode & 1) === 1,
    size: v.getUint32(0x68, true),
  };
}

/**
 * VMU 上のファイルから VMI を作る
 * @param entry Vmu の dir エントリ
 * @param data ファイルの中身
 * @param resourceName .VMS のファイル名 (拡張子なし、8 文字以内)
 */
export function buildVmi(entry, data, { resourceName, description, copyright = '' } = {}) {
  const out = new Uint8Array(VMI_SIZE);
  const v = new DataView(out.buffer);
  const res = asciiBytes(resourceName ?? entry.name.slice(0, 8), 8);
  out.set(vmiChecksum(res), 0);
  if (description === undefined) {
    // VMS ヘッダの説明 (Shift_JIS のまま) を使う
    const h = parseHeader(data, headerPosition(entry));
    out.set(h?.valid ? data.subarray(h.offset + 0x10, h.offset + 0x30) : asciiBytes(entry.name, 32), 0x04);
  } else {
    out.set(asciiBytes(description, 32), 0x04);
  }
  out.set(asciiBytes(copyright, 32), 0x24);
  const d = entry.timestamp ?? new Date();
  v.setUint16(0x44, d.getFullYear(), true);
  out[0x46] = d.getMonth() + 1;
  out[0x47] = d.getDate();
  out[0x48] = d.getHours();
  out[0x49] = d.getMinutes();
  out[0x4a] = d.getSeconds();
  out[0x4b] = d.getDay();
  v.setUint16(0x4c, 0, true);
  v.setUint16(0x4e, 1, true);
  out.set(res, 0x50);
  out.set(asciiBytes(entry.name, 12), 0x58);
  v.setUint16(0x64, (entry.type === FILE_GAME ? 2 : 0) | (entry.copyProtected ? 1 : 0), true);
  v.setUint32(0x68, data.length, true);
  return out;
}

/** 128KB 単位で連結されたイメージをページに分ける。128KB の倍数でなければ null */
/** DCM ⇔ VMU イメージ (4 バイトごとのバイト順反転。往復とも同じ処理) */
export function dcmSwap(bytes) {
  if (bytes.length % 4) throw new Error(`DCM の長さが 4 の倍数ではありません (${bytes.length} バイト)`);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 4) {
    out[i] = bytes[i + 3];
    out[i + 1] = bytes[i + 2];
    out[i + 2] = bytes[i + 1];
    out[i + 3] = bytes[i];
  }
  return out;
}
export const isDcmName = (name) => /\.dcm$/i.test(name ?? '');

export function splitPages(bytes) {
  if (bytes.length === 0 || bytes.length % IMAGE_SIZE) return null;
  return Array.from({ length: bytes.length / IMAGE_SIZE }, (_, i) => bytes.slice(i * IMAGE_SIZE, (i + 1) * IMAGE_SIZE));
}

/** ページを書き戻した連結イメージを返す */
export function replacePage(bytes, page, imageBytes) {
  const out = Uint8Array.from(bytes);
  out.set(imageBytes, page * IMAGE_SIZE);
  return out;
}
