// Node 用の最小限の PNG 読み書き (依存なし、node:zlib を使用)
// 書き出し: 8bit RGBA。読み込み: 8bit の グレー/RGB/パレット/グレー+α/RGBA、インターレース無し。
import { deflateSync, inflateSync } from 'node:zlib';

const SIG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodePng(rgba, width, height) {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8bit RGBA
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const parts = [SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function decodePng(bytes) {
  if (!SIG.every((b, i) => bytes[i] === b)) throw new Error('PNG ではありません');
  let o = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (o < bytes.length) {
    const len = v.getUint32(o);
    const t = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
    const d = bytes.subarray(o + 8, o + 8 + len);
    if (t === 'IHDR') {
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      [depth, type] = [d[8], d[9]];
      interlace = d[12];
    } else if (t === 'PLTE') palette = d;
    else if (t === 'tRNS') trns = d;
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
    o += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error('8bit・インターレース無しの PNG のみ読めます');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels) throw new Error(`未対応の PNG 形式です (color type ${type})`);
  const raw = inflateSync(Buffer.concat(idat.map((x) => Buffer.from(x))));
  const stride = width * channels;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0;
      let p = line[x];
      if (f === 1) p += a;
      else if (f === 2) p += b;
      else if (f === 3) p += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = p & 0xff;
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = px.subarray(i * channels, (i + 1) * channels);
    let c;
    if (type === 6) c = s;
    else if (type === 2) c = [s[0], s[1], s[2], 255];
    else if (type === 0) c = [s[0], s[0], s[0], 255];
    else if (type === 4) c = [s[0], s[0], s[0], s[1]];
    else c = [palette[s[0] * 3], palette[s[0] * 3 + 1], palette[s[0] * 3 + 2], trns?.[s[0]] ?? 255];
    rgba.set(c, i * 4);
  }
  return { rgba, width, height };
}
