// VMU (LC86K) 用の小さなアセンブラ。命令の符号化は https://mc.pp.se/dc/vms/cpu.html のコード欄に従う
//
//   ラベル:        start:
//   命令:          mov #0x12, acc / ld b / st @r2 / add #1 / set1 p3int,1 / bp acc,3,label / be #5,label
//                  be @r0,#5,label / dbnz c,label / call x / jmp x / callf x / jmpf x / callr x / brf x / br x
//   疑似命令:      .org 0x200 / .byte 1,2,"text" / .word 0x1234 (下位→上位) / .fill n,v / .equ NAME,value
//   数値:          0x1f / $1f / 31 / 'A'  式は 名前+数 / 名前-数 / 名前>>8 / 名前&0xff 程度
// SFR は名前で書ける (acc, psw, b, c, trl, trh, sp, pcon, ie, ip, ext, ocr, t0cnt, ..., p3, xbnk, vccr, mcr, btcr ...)

export const SFR_NAMES = {
  acc: 0x100, psw: 0x101, b: 0x102, c: 0x103, trl: 0x104, trh: 0x105, sp: 0x106, pcon: 0x107, ie: 0x108, ip: 0x109,
  ext: 0x10d, ocr: 0x10e, t0con: 0x110, t0cnt: 0x110, t0prr: 0x111, t0l: 0x112, t0lr: 0x113, t0h: 0x114, t0hr: 0x115,
  t1cnt: 0x118, t1lc: 0x11a, t1l: 0x11b, t1lr: 0x11b, t1hc: 0x11c, t1h: 0x11d, t1hr: 0x11d, mcr: 0x120, stad: 0x122,
  cnr: 0x123, tdr: 0x124, xbnk: 0x125, vccr: 0x127, scon0: 0x130, sbuf0: 0x131, sbr: 0x132, scon1: 0x134, sbuf1: 0x135,
  p1: 0x144, p1ddr: 0x145, p1fcr: 0x146, p3: 0x14c, p3ddr: 0x14d, p3int: 0x14e, fpr: 0x154, p7: 0x15c, i01cr: 0x15d,
  i23cr: 0x15e, isl: 0x15f, vsel: 0x163, vrmad1: 0x164, vrmad2: 0x165, vtrbf: 0x166, vlreg: 0x167, btcr: 0x17f,
  xram: 0x180,
};

const SIMPLE = { nop: 0x00, mul: 0x30, div: 0x40, ret: 0xa0, reti: 0xb0, ror: 0xc0, ldc: 0xc1, rorc: 0xd0, rol: 0xe0, rolc: 0xf0, ldf: 0x50, stf: 0x51 };
// 演算系: #i8 / d9 / @Ri の基本オペコード (#i8 = base+1, d9 = base+2|d8, @Ri = base+4+i)
const ALU = { add: 0x80, addc: 0x90, sub: 0xa0, subc: 0xb0, or: 0xd0, and: 0xe0, xor: 0xf0 };
const BITOP = { set1: 0xe8, clr1: 0xc8, not1: 0xa8, bp: 0x68, bn: 0x88, bpc: 0x48 };

export class AsmError extends Error {}

function splitArgs(s) {
  const out = [];
  let cur = '';
  let q = null;
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * アセンブルする
 * @returns {{bytes: Uint8Array, labels: Object<string, number>, size: number}}
 */
export function assemble(source, { size = 0 } = {}) {
  const lines = source.split(/\r?\n/).map((l, i) => ({ n: i + 1, text: l.replace(/;.*$/, '').trim() }));
  const symbols = { ...SFR_NAMES };
  let out = new Map();

  const value = (expr, pass, line) => {
    const e = expr.trim().toLowerCase();
    const m = /^(.+?)\s*(>>|&|\+|-)\s*(.+)$/.exec(e);
    if (m && !/^'.'$/.test(e)) {
      const a = value(m[1], pass, line);
      const b = value(m[3], pass, line);
      return m[2] === '>>' ? a >> b : m[2] === '&' ? a & b : m[2] === '+' ? a + b : a - b;
    }
    if (/^0x[0-9a-f]+$/.test(e)) return parseInt(e.slice(2), 16);
    if (/^\$[0-9a-f]+$/.test(e)) return parseInt(e.slice(1), 16);
    if (/^\d+$/.test(e)) return Number(e);
    if (/^'.'$/.test(expr.trim())) return expr.trim().charCodeAt(1);
    if (e in symbols) return symbols[e];
    if (pass === 1) return 0; // 前方参照
    throw new AsmError(`${line.n} 行: 未定義の名前 "${expr}"`);
  };

  for (const pass of [1, 2]) {
    let pc = 0;
    out = new Map();
    const emit = (...bytes) => {
      for (const b of bytes) out.set(pc++, b & 0xff);
    };
    for (const line of lines) {
      let text = line.text;
      if (!text) continue;
      const lab = /^([A-Za-z_][\w.]*):\s*(.*)$/.exec(text);
      if (lab) {
        if (pass === 1) {
          if (lab[1].toLowerCase() in symbols && !(lab[1].toLowerCase() in SFR_NAMES)) throw new AsmError(`${line.n} 行: ラベル "${lab[1]}" が重複`);
          symbols[lab[1].toLowerCase()] = pc;
        }
        text = lab[2];
        if (!text) continue;
      }
      const sp = text.search(/\s/);
      const op = (sp < 0 ? text : text.slice(0, sp)).toLowerCase();
      const args = sp < 0 ? [] : splitArgs(text.slice(sp + 1));
      const v = (a) => value(a, pass, line);
      const isImm = (a) => a?.startsWith('#');
      const isInd = (a) => /^@r[0-3]$/i.test(a ?? '');
      const ri = (a) => Number(a[2]);
      const d9 = (a) => {
        const x = v(a);
        if (pass === 2 && (x < 0 || x > 0x1ff)) throw new AsmError(`${line.n} 行: d9 アドレスが範囲外 (${a})`);
        return x & 0x1ff;
      };
      const rel8 = (a, len) => {
        const target = v(a);
        const r = target - (pc + len);
        if (pass === 2 && (r < -128 || r > 127)) throw new AsmError(`${line.n} 行: 分岐先が遠すぎます (${a}、${r})`);
        return r & 0xff;
      };
      const need = (n) => {
        if (args.length !== n) throw new AsmError(`${line.n} 行: ${op} のオペランドは ${n} 個です`);
      };
      try {
        if (op === '.org') {
          pc = v(args[0]);
        } else if (op === '.equ') {
          if (pass === 1) symbols[args[0].toLowerCase()] = v(args[1]);
        } else if (op === '.byte') {
          for (const a of args) {
            if (/^".*"$/.test(a)) for (const ch of a.slice(1, -1)) emit(ch.charCodeAt(0));
            else emit(v(a));
          }
        } else if (op === '.word') {
          for (const a of args) {
            const x = v(a);
            emit(x & 0xff, x >> 8);
          }
        } else if (op === '.fill') {
          const n = v(args[0]);
          for (let i = 0; i < n; i++) emit(v(args[1] ?? '0'));
        } else if (op in SIMPLE) {
          need(0);
          emit(SIMPLE[op]);
        } else if (op in ALU) {
          need(1);
          const a = args[0];
          if (isImm(a)) emit(ALU[op] + 1, v(a.slice(1)));
          else if (isInd(a)) emit(ALU[op] + 4 + ri(a));
          else {
            const x = d9(a);
            emit(ALU[op] + 2 + (x >> 8), x & 0xff);
          }
        } else if (op === 'ld' || op === 'st' || op === 'inc' || op === 'dec' || op === 'xch') {
          need(1);
          const base = { ld: 0x00, st: 0x10, inc: 0x60, dec: 0x70, xch: 0xc0 }[op];
          const a = args[0];
          if (isInd(a)) emit(base + 4 + ri(a));
          else {
            const x = d9(a);
            emit(base + 2 + (x >> 8), x & 0xff);
          }
        } else if (op === 'push' || op === 'pop') {
          need(1);
          const x = d9(args[0]);
          emit((op === 'push' ? 0x60 : 0x70) + (x >> 8), x & 0xff);
        } else if (op === 'mov') {
          need(2);
          if (!isImm(args[0])) throw new AsmError(`${line.n} 行: mov の 1 つ目は #即値です`);
          const i8 = v(args[0].slice(1));
          if (isInd(args[1])) emit(0x24 + ri(args[1]), i8);
          else {
            const x = d9(args[1]);
            emit(0x22 + (x >> 8), x & 0xff, i8);
          }
        } else if (op in BITOP) {
          const branch = op === 'bp' || op === 'bn' || op === 'bpc';
          need(branch ? 3 : 2);
          const x = d9(args[0]);
          const bit = v(args[1]);
          if (bit < 0 || bit > 7) throw new AsmError(`${line.n} 行: ビット番号は 0〜7`);
          const opc = BITOP[op] | ((x >> 8) << 4) | bit;
          if (branch) emit(opc, x & 0xff, rel8(args[2], 3));
          else emit(opc, x & 0xff);
        } else if (op === 'call' || op === 'jmp') {
          need(1);
          const t = v(args[0]);
          if (pass === 2 && (t & 0xf000) !== ((pc + 2) & 0xf000)) throw new AsmError(`${line.n} 行: ${op} の飛び先は同じ 4KB 内 (callf / jmpf を使ってください)`);
          emit((op === 'call' ? 0x08 : 0x28) | (((t >> 11) & 1) << 4) | ((t >> 8) & 7), t & 0xff);
        } else if (op === 'callf' || op === 'jmpf') {
          need(1);
          const t = v(args[0]);
          emit(op === 'callf' ? 0x20 : 0x21, (t >> 8) & 0xff, t & 0xff);
        } else if (op === 'callr' || op === 'brf') {
          need(1);
          const r = (v(args[0]) - (pc + 3) + 1) & 0xffff; // 次の命令 - 1 からの相対
          emit(op === 'callr' ? 0x10 : 0x11, r & 0xff, r >> 8);
        } else if (op === 'br' || op === 'bz' || op === 'bnz') {
          need(1);
          emit({ br: 0x01, bz: 0x80, bnz: 0x90 }[op], rel8(args[0], 2));
        } else if (op === 'be' || op === 'bne') {
          const base = op === 'be' ? 0x30 : 0x40;
          if (args.length === 3) { // @Rj,#i8,r8
            if (!isInd(args[0]) || !isImm(args[1])) throw new AsmError(`${line.n} 行: ${op} @Rj,#i8,label の形です`);
            emit(base + 4 + ri(args[0]), v(args[1].slice(1)), rel8(args[2], 3));
          } else {
            need(2);
            if (isImm(args[0])) emit(base + 1, v(args[0].slice(1)), rel8(args[1], 3));
            else {
              const x = d9(args[0]);
              emit(base + 2 + (x >> 8), x & 0xff, rel8(args[1], 3));
            }
          }
        } else if (op === 'dbnz') {
          need(2);
          if (isInd(args[0])) emit(0x54 + ri(args[0]), rel8(args[1], 2));
          else {
            const x = d9(args[0]);
            emit(0x52 + (x >> 8), x & 0xff, rel8(args[1], 3));
          }
        } else {
          throw new AsmError(`${line.n} 行: 知らない命令 "${op}"`);
        }
      } catch (err) {
        if (err instanceof AsmError) throw err;
        throw new AsmError(`${line.n} 行: ${err.message}`);
      }
    }
  }
  const end = Math.max(size, ...[...out.keys()].map((a) => a + 1), 0);
  const bytes = new Uint8Array(end);
  for (const [a, b] of out) bytes[a] = b;
  const labels = Object.fromEntries(Object.entries(symbols).filter(([k]) => !(k in SFR_NAMES)));
  return { bytes, labels, size: end };
}
