// VMS ヘッダの編集: 説明文・アイコン (16 色パレット + 32x32 4bpp × 1〜3 コマ)・アニメ速度
// アイコンのコマ数を変えるとファイルサイズが変わるため、ヘッダ/アイコン/アイキャッチ/データを組み直す。
import { parseHeader, headerPosition, HEADER_SIZE, ICON_SIZE, argb4444ToRgba, rgbaToArgb4444, updateCrc } from './vms.js';

export const ICON_W = 32;
export const ICON_H = 32;

function textBytes(text, length) {
  const s = String(text ?? '');
  if (/[^\x20-\x7e]/.test(s)) throw new Error(`説明文は半角英数記号のみ入力できます: ${s}`);
  if (s.length > length) throw new Error(`説明文は ${length} 文字以内です: ${s}`);
  const out = new Uint8Array(length).fill(0x20); // KOS (vmu_pkg_build) と同じく空白で埋める
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** アイコンを読む: { palette: number[16] (ARGB4444), frames: Uint8Array[] (1024 個のパレット番号), animSpeed } */
export function readIcons(file, entry) {
  const h = parseHeader(file, headerPosition(entry));
  if (!h?.valid) return null;
  const frames = [];
  for (let f = 0; f < h.iconCount; f++) {
    const base = h.iconsOffset + f * ICON_SIZE;
    const px = new Uint8Array(ICON_W * ICON_H);
    for (let i = 0; i < ICON_SIZE; i++) {
      px[i * 2] = file[base + i] >> 4;
      px[i * 2 + 1] = file[base + i] & 0x0f;
    }
    frames.push(px);
  }
  return { palette: [...h.palette], frames, animSpeed: h.animSpeed };
}

/**
 * VMS ヘッダを書き換えたファイルを返す (CRC 更新済み)。
 * @param changes { description?, longDescription?, palette?, frames?, animSpeed? }
 *   frames を渡すとコマ数 (1〜3) も変わり、ファイルサイズが変わることがある
 */
export function editVms(file, entry, changes) {
  const h = parseHeader(file, headerPosition(entry));
  if (!h?.valid) throw new Error('VMS ヘッダがありません (アイコン・説明を持たないファイルです)');
  const head = file.slice(0, h.offset); // ゲームファイルのプログラム部分
  const header = file.slice(h.offset, h.offset + HEADER_SIZE);
  const eyecatch = file.slice(h.eyecatchOffset, h.dataOffset);
  const data = file.slice(h.dataOffset, Math.min(file.length, h.dataOffset + h.dataSize));
  let icons = file.slice(h.iconsOffset, h.eyecatchOffset);
  const v = new DataView(header.buffer);

  if (changes.description !== undefined) header.set(textBytes(changes.description, 16), 0x00);
  if (changes.longDescription !== undefined) header.set(textBytes(changes.longDescription, 32), 0x10);
  if (changes.animSpeed !== undefined) {
    if (!Number.isInteger(changes.animSpeed) || changes.animSpeed < 0 || changes.animSpeed > 0xffff) throw new Error('アニメ速度は 0〜65535');
    v.setUint16(0x42, changes.animSpeed, true);
  }
  if (changes.palette !== undefined) {
    if (changes.palette.length !== 16) throw new Error('パレットは 16 色です');
    changes.palette.forEach((c, i) => v.setUint16(0x60 + i * 2, c & 0xffff, true));
  }
  if (changes.frames !== undefined) {
    const n = changes.frames.length;
    if (n < 1 || n > 3) throw new Error('アイコンは 1〜3 コマです');
    icons = new Uint8Array(n * ICON_SIZE);
    changes.frames.forEach((px, f) => {
      if (px.length !== ICON_W * ICON_H) throw new Error(`コマ ${f + 1} の画素数が ${ICON_W}x${ICON_H} ではありません`);
      for (let i = 0; i < ICON_SIZE; i++) icons[f * ICON_SIZE + i] = ((px[i * 2] & 0x0f) << 4) | (px[i * 2 + 1] & 0x0f);
    });
    v.setUint16(0x40, n, true);
  }

  // 組み直し: [プログラム][ヘッダ][アイコン][アイキャッチ][データ] を 512 バイト単位に
  const body = head.length + HEADER_SIZE + icons.length + eyecatch.length + data.length;
  const out = new Uint8Array(Math.ceil(body / 512) * 512);
  let o = 0;
  for (const part of [head, header, icons, eyecatch, data]) {
    out.set(part, o);
    o += part.length;
  }
  updateCrc(out, parseHeader(out, h.offset));
  return out;
}

/** アイコンの 1 コマを RGBA (32x32x4) に */
export function frameToRgba(palette, px) {
  const pal = palette.map(argb4444ToRgba);
  const out = new Uint8ClampedArray(ICON_W * ICON_H * 4);
  px.forEach((c, i) => out.set(pal[c], i * 4));
  return out;
}

/**
 * RGBA 画像 (幅 32×コマ数, 高さ 32) を 16 色パレットとコマに変換する。
 * ARGB4444 に丸めた色の出現数で上位を選び、残りは最も近い色に寄せる (透明は 1 色にまとめる)。
 */
export function rgbaToIcons(rgba, width, height) {
  if (height !== ICON_H || width % ICON_W || width / ICON_W < 1 || width / ICON_W > 3) {
    throw new Error(`アイコン画像は 高さ ${ICON_H}、幅 ${ICON_W}〜${ICON_W * 3} (32 の倍数) にしてください (実際 ${width}x${height})`);
  }
  const n = width / ICON_W;
  const colors = new Uint16Array(width * height);
  const count = new Map();
  for (let i = 0; i < width * height; i++) {
    const p = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]];
    const c = p[3] < 0x40 ? 0x0000 : rgbaToArgb4444(p);
    colors[i] = c;
    count.set(c, (count.get(c) ?? 0) + 1);
  }
  const palette = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([c]) => c);
  while (palette.length < 16) palette.push(0x0000);
  const dist = (a, b) => {
    const x = argb4444ToRgba(a);
    const y = argb4444ToRgba(b);
    return (x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2 + 2 * (x[3] - y[3]) ** 2;
  };
  const cache = new Map();
  const nearest = (c) => {
    if (!cache.has(c)) {
      let best = 0;
      palette.forEach((p, i) => {
        if (dist(c, p) < dist(c, palette[best])) best = i;
      });
      cache.set(c, best);
    }
    return cache.get(c);
  };
  const frames = Array.from({ length: n }, (_, f) => {
    const px = new Uint8Array(ICON_W * ICON_H);
    for (let y = 0; y < ICON_H; y++) {
      for (let x = 0; x < ICON_W; x++) px[y * ICON_W + x] = nearest(colors[y * width + f * ICON_W + x]);
    }
    return px;
  });
  return { palette, frames, exact: count.size <= 16 };
}

/** コマを横に並べた RGBA (幅 32×コマ数) */
export function iconsToStrip(icons) {
  const n = icons.frames.length;
  const out = new Uint8ClampedArray(ICON_W * n * ICON_H * 4);
  icons.frames.forEach((px, f) => {
    const rgba = frameToRgba(icons.palette, px);
    for (let y = 0; y < ICON_H; y++) {
      out.set(rgba.subarray(y * ICON_W * 4, (y + 1) * ICON_W * 4), (y * ICON_W * n + f * ICON_W) * 4);
    }
  });
  return { rgba: out, width: ICON_W * n, height: ICON_H };
}
