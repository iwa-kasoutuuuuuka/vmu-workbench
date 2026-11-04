// node cli.js dc ... — Dreamcast 本体のセーブマネージャから BBA で読む (Node 専用)
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DcClient, DcError, DC_DEFAULT_HOST, normalizeSlot } from './dcclient.js';
import { dcmSwap, isDcmName } from './formats.js';
import { Vmu } from './vmu.js';

const padW = (s, width) => s + ' '.repeat(Math.max(0, width - [...s].reduce((w, c) => w + (c.charCodeAt(0) > 0xff ? 2 : 1), 0)));
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const sha1 = (b) => createHash('sha1').update(b).digest('hex');

/** VMU の識別名: フォーマット日時 (ルートブロック) から。VMU には固有の番号がないため */
export function volumeName(volumeHex) {
  const v = volumeHex || '';
  if (!/^[0-9a-f]{16}$/.test(v) || /^0+$/.test(v)) return 'vmu_unknown';
  return `vmu_${v.slice(0, 4)}${v.slice(4, 6)}${v.slice(6, 8)}_${v.slice(8, 14)}`;
}

function slotLine(s) {
  if (!s.present) return `${s.slot.toUpperCase()}  --`;
  if (!s.readable) return `${s.slot.toUpperCase()}  読めません`;
  if (!s.formatted) return `${s.slot.toUpperCase()}  未フォーマット`;
  return `${s.slot.toUpperCase()}  空き ${String(s.free).padStart(3)} ブロック  ファイル ${s.files}  識別名 ${volumeName(s.volume)}`;
}

/** 保管庫へ。同じフォルダの最新と同じ中身なら書かない。書いたパス (書かなければ null) */
export function storeBackup(dir, volume, slot, bytes, now = new Date()) {
  const folder = join(dir, volumeName(volume));
  mkdirSync(folder, { recursive: true });
  const prev = readdirSync(folder).filter((f) => /^\d{8}_\d{6}_[a-d][12]\.bin$/.test(f)).sort().pop();
  if (prev && sha1(readFileSync(join(folder, prev))) === sha1(bytes)) return null;
  const file = join(folder, `${stamp(now)}_${slot}.bin`);
  writeFileSync(file, bytes);
  return file;
}

export async function runDc(sub, args, { host } = {}) {
  const dc = new DcClient(host || DC_DEFAULT_HOST);
  switch (sub) {
    case 'info': {
      const info = await dc.info();
      console.log(`${dc.base}  セーブマネージャ v${info.version}${info.dcload ? '  (dcload から起動)' : ''}`);
      for (const s of info.slots) console.log(`  ${slotLine(s)}`);
      return;
    }
    case 'list': {
      const slot = normalizeSlot(args[0]);
      const list = await dc.list(slot);
      if (!list.formatted) { console.log(`${slot.toUpperCase()}: フォーマットされていません`); return; }
      for (const f of list.files) {
        const flags = `${f.type === 'game' ? 'GAME' : 'DATA'} ${f.protected ? 'P' : ' '}`;
        const desc = f.header ? `${f.desc}  ${f.longDesc}`.trim() : '(ヘッダ無し)';
        const crc = f.crc === 'bad' ? '  CRC NG' : '';
        console.log(`${padW(f.name, 12)} ${flags} ${String(f.blocks).padStart(3)}blk  ${(f.date || '').replace('T', ' ')}  ${desc}${crc}${f.readable ? '' : '  (壊れている)'}`);
      }
      console.log(`空き: ${list.free} ブロック`);
      return;
    }
    case 'pull': {
      const slot = normalizeSlot(args[0]);
      if (args.length === 2) {
        const out = args[1];
        const { bytes, etag } = await dc.image(slot);
        new Vmu(bytes);   // 128KB か確かめる
        writeFileSync(out, isDcmName(out) ? dcmSwap(bytes) : bytes);
        console.log(`${slot.toUpperCase()} → ${out} (128KB, 版 ${etag})`);
        return;
      }
      if (args.length !== 3) throw new DcError('使い方: dc pull <スロット> <out.bin> または dc pull <スロット> <名前> <out>');
      const [, name, out] = args;
      const fmt = /\.dci$/i.test(out) ? 'dci' : 'raw';
      const { bytes } = await dc.file(slot, name, fmt);
      writeFileSync(out, bytes);
      console.log(`${slot.toUpperCase()} の ${name} → ${out} (${bytes.length} バイト、${fmt === 'dci' ? 'DCI' : 'VMS の中身'})`);
      return;
    }
    case 'backup': {
      const dir = args[0] || 'dc-backup';
      const info = await dc.info();
      let saved = 0;
      for (const s of info.slots) {
        if (!s.present || !s.readable) continue;
        const { bytes } = await dc.image(s.slot);
        const file = storeBackup(dir, s.volume, s.slot, bytes);
        console.log(`${s.slot.toUpperCase()}: ${file ? `→ ${file}` : `前回と同じなので保存しません (${join(dir, volumeName(s.volume))})`}`);
        if (file) saved++;
      }
      if (!info.slots.some((s) => s.present)) console.log('VMU が挿さっていません');
      else console.log(`${saved} 個保存しました`);
      return;
    }
    default:
      throw new DcError('dc のあとに info / list / pull / backup のどれかを書いてください (node cli.js で使い方)');
  }
}

