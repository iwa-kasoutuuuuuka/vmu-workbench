// タイトルの推定: タイトル DB (titles/titles.json) → VMS ヘッダの作成アプリ ID・説明 → (bleem2 の PS1 カードなら) 中のセーブ
import { parseHeader, headerPosition } from './vms.js';
import { CONTAINERS, ps1Directory, PS1_BLOCK_SIZE } from './containers.js';

let sjis;
function decodeSjis(bytes) {
  const end = bytes.indexOf(0);
  const b = end >= 0 ? bytes.subarray(0, end) : bytes;
  try {
    sjis ??= new TextDecoder('shift_jis');
    return sjis.decode(b).trim();
  } catch {
    return String.fromCharCode(...b).trim();
  }
}

function test(match = {}, subject) {
  const keys = Object.keys(match);
  return keys.length > 0 && keys.every((k) => new RegExp(match[k]).test(subject[k] ?? ''));
}

/** PS1 メモリーカード内のセーブ (名前・セーブ自身のタイトル・DB のタイトル) */
export function ps1Saves(card, db = {}) {
  return ps1Directory(card).map((s) => {
    const blk = card.subarray(s.offset, s.offset + PS1_BLOCK_SIZE);
    const saveTitle = blk[0] === 0x53 && blk[1] === 0x43 ? decodeSjis(blk.subarray(4, 68)) : '';
    const hit = (db.ps1 ?? []).find((t) => test(t.match, { fileName: s.name }));
    return { name: s.name, saveTitle, title: hit?.title ?? null, source: hit?.source ?? null };
  });
}

/**
 * ファイルのタイトルを推定する
 * @returns {{title: string|null, source: string, detail?: string, ps1?: object[]}}
 */
export function lookupTitle(entry, data, db = {}) {
  const h = data ? parseHeader(data, headerPosition(entry)) : null;
  const subject = { fileName: entry.name, appId: h?.valid ? h.appId : '', description: h?.valid ? h.description : '' };
  const hit = (db.vmu ?? []).find((t) => test(t.match, subject));
  const result = hit ? { title: hit.title, source: `タイトル DB (${hit.source})` } : null;
  // bleem2 の PS1 カードなら中のセーブも
  const card = data ? CONTAINERS['bleem-mc'].decode(data) : null;
  if (card) {
    const saves = ps1Saves(card, db);
    const detail = saves.map((s) => s.title || s.saveTitle || s.name).join(' / ');
    return { ...(result ?? { title: 'PS1 メモリーカード (bleem2)', source: 'RLE 形式から判定' }), detail: detail || '(セーブなし)', ps1: saves };
  }
  if (result) return result;
  if (h?.valid && (h.appId || h.longDescription)) {
    return { title: h.longDescription || h.description, source: `VMS ヘッダ (作成アプリ: ${h.appId || '不明'})` };
  }
  return { title: null, source: '不明 (タイトル DB に無く、VMS ヘッダも無い)' };
}
