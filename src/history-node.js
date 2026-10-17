// Node 用: VMU イメージのバックアップと履歴
// イメージを書き換える前に .emu/history/<名前>-<パスのハッシュ>/ へ日時付きのコピーを残す。
// "イメージのパス@番号" で過去の版を指定できる (例: vmu.bin@3)。
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 保存先は環境変数 DCVMU_HISTORY_DIR で変えられる (テスト用)
export const HISTORY_DIR = process.env.DCVMU_HISTORY_DIR ?? fileURLToPath(new URL('../.emu/history/', import.meta.url));
const KEEP = 50; // 1 イメージあたりの保持数 (古いものから索引から外す)

function dirFor(imagePath) {
  const abs = resolve(imagePath);
  const hash = createHash('sha1').update(abs.toLowerCase()).digest('hex').slice(0, 8);
  return join(HISTORY_DIR, `${basename(abs).replace(/[^\w.-]/g, '_')}-${hash}`);
}

function readIndex(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  } catch {
    return { image: null, versions: [] };
  }
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..+/, '');

/** 現在のイメージを履歴に保存する (ファイルが無ければ何もしない)。保存した版の情報を返す */
export function backup(imagePath, note = '') {
  if (!existsSync(imagePath)) return null;
  const dir = dirFor(imagePath);
  mkdirSync(dir, { recursive: true });
  const index = readIndex(dir);
  index.image = resolve(imagePath);
  const id = (index.versions.at(-1)?.id ?? 0) + 1;
  const time = new Date();
  const file = `${String(id).padStart(4, '0')}-${stamp(time)}.bin`;
  copyFileSync(imagePath, join(dir, file));
  index.versions.push({ id, time: time.toISOString(), note, file });
  index.versions = index.versions.slice(-KEEP);
  writeFileSync(join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  return { id, time: time.toISOString(), note, path: join(dir, file) };
}

/** 履歴の一覧 (古い順) */
export function listHistory(imagePath) {
  const dir = dirFor(imagePath);
  return readIndex(dir).versions.map((v) => ({ ...v, path: join(dir, v.file) }));
}

/** "path@id" を実際のファイルパスに解決する。@ が無ければそのまま */
export function resolveImageSpec(spec) {
  const m = /^(.*)@(\d+)$/.exec(spec);
  if (!m || existsSync(spec)) return spec;
  const v = listHistory(m[1]).find((x) => x.id === Number(m[2]));
  if (!v) throw new Error(`履歴に ${m[1]} の版 ${m[2]} がありません (node cli.js history ${m[1]})`);
  return v.path;
}

/** 過去の版に戻す (戻す前の状態も履歴に残す) */
export function restore(imagePath, id) {
  const v = listHistory(imagePath).find((x) => x.id === Number(id));
  if (!v) throw new Error(`履歴に版 ${id} がありません`);
  const before = backup(imagePath, `restore ${id} の前`);
  copyFileSync(v.path, imagePath);
  return { restored: v, backup: before };
}
