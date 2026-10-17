// 数値型の定義 (HEXエディタのインスペクタと構造定義で共有)
export const NUM_TYPES = {
  u8: { size: 1, get: (v, o) => v.getUint8(o), set: (v, o, x) => v.setUint8(o, x), min: 0, max: 0xff },
  s8: { size: 1, get: (v, o) => v.getInt8(o), set: (v, o, x) => v.setInt8(o, x), min: -0x80, max: 0x7f },
  u16le: { size: 2, get: (v, o) => v.getUint16(o, true), set: (v, o, x) => v.setUint16(o, x, true), min: 0, max: 0xffff },
  u16be: { size: 2, get: (v, o) => v.getUint16(o, false), set: (v, o, x) => v.setUint16(o, x, false), min: 0, max: 0xffff },
  s16le: { size: 2, get: (v, o) => v.getInt16(o, true), set: (v, o, x) => v.setInt16(o, x, true), min: -0x8000, max: 0x7fff },
  s16be: { size: 2, get: (v, o) => v.getInt16(o, false), set: (v, o, x) => v.setInt16(o, x, false), min: -0x8000, max: 0x7fff },
  u32le: { size: 4, get: (v, o) => v.getUint32(o, true), set: (v, o, x) => v.setUint32(o, x, true), min: 0, max: 0xffffffff },
  u32be: { size: 4, get: (v, o) => v.getUint32(o, false), set: (v, o, x) => v.setUint32(o, x, false), min: 0, max: 0xffffffff },
  s32le: { size: 4, get: (v, o) => v.getInt32(o, true), set: (v, o, x) => v.setInt32(o, x, true), min: -0x80000000, max: 0x7fffffff },
  s32be: { size: 4, get: (v, o) => v.getInt32(o, false), set: (v, o, x) => v.setInt32(o, x, false), min: -0x80000000, max: 0x7fffffff },
};

/** "123" / "-5" / "0x1F" / "-0x10" → 整数 (不正なら NaN) */
export function parseInteger(text) {
  const t = String(text).trim();
  const neg = t.startsWith('-');
  const body = neg ? t.slice(1) : t;
  const abs = /^0x[0-9a-f]+$/i.test(body) ? parseInt(body.slice(2), 16) : /^\d+$/.test(body) ? Number(body) : NaN;
  return neg ? -abs : abs;
}
