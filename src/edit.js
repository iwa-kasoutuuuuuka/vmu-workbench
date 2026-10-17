// セーブデータ改造: バイト書き換え・差分・CRC自動更新
import { parseHeader, headerPosition, calcCrc, updateCrc, crcRangeValid } from './vms.js';
import { BLOCK_SIZE, FILE_GAME, VmuError } from './vmu.js';

/**
 * ファイルのCRC状態
 * @returns {{status: 'ok'|'ng'|'none'|'broken', stored?: number, actual?: number}}
 *   none: VMSヘッダ無し / broken: ヘッダのデータ長がファイルを超えている
 */
export function crcStatus(data, entry) {
  const h = parseHeader(data, headerPosition(entry));
  if (!h?.valid) return { status: 'none' };
  if (!crcRangeValid(data, h)) return { status: 'broken', stored: h.crc };
  const actual = calcCrc(data, h);
  return { status: actual === h.crc ? 'ok' : 'ng', stored: h.crc, actual };
}

/**
 * 編集済みデータをVMU上のファイルへ書き戻す (サイズは元ファイル以下)。
 * fixCrc=true でVMSヘッダがあればCRCを再計算して書き込む。
 * 大きくなった場合は同じスロット・属性・日時のまま置き換える (空きが足りなければ何も変えない)。
 * @returns {{crc: number|null, resized: boolean, entry: object}} 更新後のCRC (更新しなかった場合 null) と更新後のエントリ
 */
export function applyEdit(vmu, entry, edited, { fixCrc = true } = {}) {
  const data = Uint8Array.from(edited);
  let crc = null;
  if (fixCrc) {
    const h = parseHeader(data, headerPosition(entry));
    if (h && crcRangeValid(data, h)) crc = updateCrc(data, h);
  }
  const blocksNeeded = Math.ceil(data.length / BLOCK_SIZE);
  if (blocksNeeded <= entry.sizeBlocks) {
    vmu.replaceFileData(entry, data);
    return { crc, resized: false, entry };
  }
  // 大きくなった (圧縮コンテナなど): 空きを確認してから同じスロットで置き換える。足りなければ何も変えない
  if (entry.type === FILE_GAME) throw new VmuError('ミニゲームファイルは大きくできません');
  const extra = blocksNeeded - entry.sizeBlocks;
  const free = vmu.freeBlocks().length;
  if (extra > free) throw new VmuError(`空き容量不足: あと ${extra} ブロック必要ですが空きは ${free} ブロックです`);
  return { crc, resized: true, entry: vmu.rewriteFile(entry, data) };
}

/** バイト列パッチ: [{offset, bytes}] を適用したコピーを返す */
export function patchBytes(data, patches) {
  const out = Uint8Array.from(data);
  for (const { offset, bytes } of patches) {
    if (offset < 0 || offset + bytes.length > out.length) {
      throw new RangeError(`パッチ範囲がファイル外です: 0x${offset.toString(16)} (+${bytes.length})`);
    }
    out.set(bytes, offset);
  }
  return out;
}

/** "FF 00 1a" / "ff001a" → Uint8Array */
export function parseHexBytes(text) {
  const hex = text.replace(/0x/gi, '').replace(/[\s,]/g, '');
  if (!hex || hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new Error(`HEX文字列が不正です: "${text}"`);
  return Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
}

/** 2つのバイト列の差分を連続範囲で返す: [{offset, before, after}] */
export function diffBytes(a, b) {
  const ranges = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    const start = i;
    while (i < n && a[i] !== b[i]) i++;
    ranges.push({ offset: start, before: a.slice(start, i), after: b.slice(start, i) });
  }
  return ranges;
}

/** ファイル内の領域区分 (HEXエディタの色分け用) */
export function regions(data, entry) {
  const h = parseHeader(data, headerPosition(entry));
  if (!h?.valid) return [{ start: 0, end: data.length, kind: 'data', label: 'データ' }];
  const list = [];
  if (h.offset > 0) list.push({ start: 0, end: h.offset, kind: 'program', label: 'プログラム' });
  list.push({ start: h.offset, end: h.offset + 0x46, kind: 'header', label: 'ヘッダ' });
  list.push({ start: h.offset + 0x46, end: h.offset + 0x48, kind: 'crc', label: 'CRC' });
  list.push({ start: h.offset + 0x48, end: h.iconsOffset, kind: 'header', label: 'ヘッダ' });
  if (h.eyecatchOffset > h.iconsOffset) list.push({ start: h.iconsOffset, end: h.eyecatchOffset, kind: 'icon', label: 'アイコン' });
  if (h.dataOffset > h.eyecatchOffset) list.push({ start: h.eyecatchOffset, end: h.dataOffset, kind: 'eyecatch', label: 'アイキャッチ' });
  const dataEnd = Math.min(data.length, h.dataOffset + h.dataSize);
  list.push({ start: h.dataOffset, end: dataEnd, kind: 'data', label: 'データ' });
  if (dataEnd < data.length) list.push({ start: dataEnd, end: data.length, kind: 'pad', label: '余白' });
  return list;
}
