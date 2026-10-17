// コンテナ形式: VMU ファイルの中に別形式のデータが入っている場合の展開・再格納
//
// bleem-mc: bleem2 (Dreamcast 上の PS1 エミュレーター) が PS1 メモリーカード 128KB を
//           RLE 圧縮して保存したファイル (BLEEMMC)。形式は "MC1\0" + (個数1〜255, 値) の繰り返し。
//           展開後は PS1 メモリーカードの生イメージ (8KB × 16 ブロック、ブロック 0 がディレクトリ)。

export const PS1_CARD_SIZE = 128 * 1024;
export const PS1_BLOCK_SIZE = 8192;
const PS1_FRAME = 128;

function rleDecode(data) {
  if (data.length < 4 || data[0] !== 0x4d || data[1] !== 0x43 || data[2] !== 0x31) return null; // "MC1"
  const card = new Uint8Array(PS1_CARD_SIZE);
  let pos = 0;
  for (let i = 4; i + 1 < data.length && pos < PS1_CARD_SIZE; i += 2) {
    const cnt = Math.min(data[i], PS1_CARD_SIZE - pos);
    card.fill(data[i + 1], pos, pos + cnt);
    pos += cnt;
  }
  return pos === PS1_CARD_SIZE ? card : null;
}

/** bleem2 memcard.c の mc_save() と同じ出力 */
function rleEncode(card) {
  const out = [0x4d, 0x43, 0x31, 0x00];
  for (let i = 0; i < card.length;) {
    const v = card[i];
    let cnt = 1;
    while (i + cnt < card.length && card[i + cnt] === v && cnt < 255) cnt++;
    out.push(cnt, v);
    i += cnt;
  }
  return Uint8Array.from(out);
}

export const CONTAINERS = {
  'bleem-mc': { label: 'bleem2 PS1 メモリーカード (RLE)', decode: rleDecode, encode: rleEncode },
};

/** PS1 カードのディレクトリ (使用中の先頭ブロックのみ) */
export function ps1Directory(card) {
  const list = [];
  for (let slot = 1; slot <= 15; slot++) {
    const d = card.subarray(slot * PS1_FRAME, (slot + 1) * PS1_FRAME);
    if (d[0] !== 0x51) continue; // 0x51 = 使用中の先頭ブロック
    const size = d[4] | (d[5] << 8) | (d[6] << 16);
    const name = String.fromCharCode(...d.subarray(10, 30)).replace(/\0.*$/, '');
    list.push({ slot, name, size, offset: slot * PS1_BLOCK_SIZE });
  }
  return list;
}

/** ファイル名 (例 "BASLUS-01212...") が正規表現に一致する最初のセーブ */
export function ps1FindSave(card, pattern) {
  const re = new RegExp(pattern);
  const save = ps1Directory(card).find((s) => re.test(s.name));
  return save ? { ...save, blocks: ps1Chain(card, save.slot) } : null;
}

/** ディレクトリの次ブロック (+0x08, u16 = 次のスロット-1, 0xFFFF で終端) をたどる */
export function ps1Chain(card, firstSlot) {
  const slots = [];
  for (let slot = firstSlot; slot >= 1 && slot <= 15 && !slots.includes(slot);) {
    slots.push(slot);
    const d = slot * PS1_FRAME;
    const next = card[d + 8] | (card[d + 9] << 8);
    if (next === 0xffff) break;
    slot = next + 1;
  }
  return slots;
}

/** セーブのブロックを連結して返す */
export function ps1ReadSave(card, save) {
  const out = new Uint8Array(save.blocks.length * PS1_BLOCK_SIZE);
  save.blocks.forEach((slot, i) => out.set(card.subarray(slot * PS1_BLOCK_SIZE, (slot + 1) * PS1_BLOCK_SIZE), i * PS1_BLOCK_SIZE));
  return out;
}

/** 連結したセーブをカードへ書き戻したコピーを返す */
export function ps1WriteSave(card, save, bytes) {
  const out = Uint8Array.from(card);
  save.blocks.forEach((slot, i) => out.set(bytes.subarray(i * PS1_BLOCK_SIZE, (i + 1) * PS1_BLOCK_SIZE), slot * PS1_BLOCK_SIZE));
  return out;
}
