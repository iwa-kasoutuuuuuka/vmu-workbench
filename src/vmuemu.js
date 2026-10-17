// VMU (ビジュアルメモリ) のエミュレーター: Sanyo LC86K 系 CPU + タイマー + 割り込み + LCD + ボタン + ブザー
//
// 参照した資料:
//   命令セット・アドレッシング: https://mc.pp.se/dc/vms/cpu.html (Marcus Comstedt)
//   SFR・LCD・ポート:           https://mc.pp.se/dc/vms/sfr.html
//   割り込み要因・タイマー・ベースタイマー・EXT/FPR・フラグ計算の挙動: MAME src/devices/cpu/lc8670 (BSD-3)
// BIOS (ROM) は同梱しない。生の 64KB ダンプを渡せば BIOS ごと動かし、無ければゲームを直接起動する
// (ゲームが BIOS を呼んだら stopReason = 'bios' で止まる)。

export const LCD_W = 48;
export const LCD_H = 32;
export const ROM_SIZE = 0x10000;
export const FLASH_SIZE = 0x20000;

// P3 のボタン (0 = 押している)
export const BUTTONS = { up: 0, down: 1, left: 2, right: 3, a: 4, b: 5, mode: 6, sleep: 7 };

// 割り込みベクタ (MAME の要因番号 0〜10 に対応)
const VECTORS = [0x00, 0x03, 0x0b, 0x13, 0x1b, 0x23, 0x2b, 0x33, 0x3b, 0x43, 0x4b];
const IRQ = { int0: 1, int1: 2, t0l: 3, base: 4, t0h: 5, t1: 6, p3: 10 };

// SFR (0x100 からのオフセット)
const ACC = 0x00, PSW = 0x01, B = 0x02, C = 0x03, TRL = 0x04, TRH = 0x05, SP = 0x06, PCON = 0x07, IE = 0x08;
const EXT = 0x0d, OCR = 0x0e;
const T0CNT = 0x10, T0PRR = 0x11, T0L = 0x12, T0LR = 0x13, T0H = 0x14, T0HR = 0x15;
const T1CNT = 0x18, T1LC = 0x1a, T1L = 0x1b, T1HC = 0x1c, T1H = 0x1d;
const MCR = 0x20, XBNK = 0x25, VCCR = 0x27, P1 = 0x44, P1DDR = 0x45, P1FCR = 0x46, P3 = 0x4c, P3DDR = 0x4d, P3INT = 0x4e, FPR = 0x54, P7 = 0x5c;
const VSEL = 0x63, VRMAD1 = 0x64, VRMAD2 = 0x65, VTRBF = 0x66, BTCR = 0x7f;

// 命令ごとのサイクル数 (資料の表)
const CYCLES = new Uint8Array(256).fill(1);
for (const [ops, c] of [
  [[0x01, 0x80, 0x90], 2], [[0x10, 0x11], 4], [[0x20, 0x21, 0x22, 0x23, 0xa0, 0xb0, 0xc1, 0x50, 0x51], 2],
  [[0x30, 0x40], 7], [[0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47], 2],
  [[0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x60, 0x61, 0x70, 0x71], 2],
]) for (const o of ops) CYCLES[o] = c;
for (let o = 0; o < 256; o++) {
  const lo = o & 0x0f;
  if (lo >= 8 && [0x0, 0x1, 0x2, 0x3].includes(o >> 4)) CYCLES[o] = 2; // CALL / JMP a12
  if (lo >= 8 && [0x4, 0x5, 0x6, 0x7, 0x8, 0x9].includes(o >> 4)) CYCLES[o] = 2; // BPC / BP / BN
}

const parity = (v) => {
  let p = 0;
  for (let x = v; x; x >>= 1) p ^= x & 1;
  return p;
};
const s8 = (v) => (v & 0x80 ? v - 0x100 : v);

/** BIOS ダンプとして使えそうか (先頭がジャンプ命令か) */
export function looksLikeBios(rom) {
  if (!rom || rom.length < ROM_SIZE) return false;
  const op = rom[0];
  return op === 0x21 || op === 0x01 || op === 0x11 || (op & 0xe8) === 0x28; // JMPF / BR / BRF / JMP a12
}

export class VmuEmulator {
  /**
   * @param {{flash?: Uint8Array, rom?: Uint8Array|null}} opts
   *   flash: 128KB の VMU イメージ (ミニゲームはブロック 0 から)。書き込みはこの配列に反映される
   */
  constructor({ flash, rom = null } = {}) {
    this.flash = flash ?? new Uint8Array(FLASH_SIZE);
    if (this.flash.length !== FLASH_SIZE) throw new Error('フラッシュ (VMU イメージ) は 128KB です');
    this.rom = rom && rom.length >= ROM_SIZE ? rom.subarray(0, ROM_SIZE) : null;
    this.reset();
  }

  reset() {
    this.ram = [new Uint8Array(256), new Uint8Array(256)];
    this.sfr = new Uint8Array(128);
    this.xram = [new Uint8Array(0x80), new Uint8Array(0x80), new Uint8Array(0x80)];
    this.wram = new Uint8Array(512);
    this.pc = 0;
    this.cycles = 0;
    this.time = 0; // 経過秒
    this.irqFlag = 0;
    this.inIrq = 0;
    this.afterReti = false;
    this.buttons = 0xff; // 全部離している
    this.batteryGood ??= true;
    this.t0pre = 0;
    this.t0 = [0, 0];
    this.t1 = [0, 0];
    this.t1cmp = 0; // T1LC の比較値 (書き込みがそのまま入るとは限らない。MAME の lc8670 と同じ条件で取り込む)
    this.pulse = 0; // タイマー 1 のパルス出力
    this.p17 = 0; // スピーカー = P1 bit7 の端子 = ((P1 | (パルス & P1FCR)) & P1DDR) の bit7 (MAME の update_port1 と同じ)
    this.baseAcc = 0; // 32768Hz の端数
    this.baseCount = 0;
    this.flashCmd = 0;
    this.flashWrites = 0;
    this.flashEntries = 0;
    this.stopReason = null;
    this.sfr[P1FCR] = 0xbf;
    this.sfr[P3INT] = 0xfd;
    this.sfr[0x5f] = 0xc0; // ISL
    this.sfr[VSEL] = 0xfc;
    this.sfr[BTCR] = 0x41;
    if (this.rom) {
      this.codeBank = 'rom';
      this.sfr[EXT] = 0;
    } else {
      // BIOS 無し: ゲームを直接起動 (BIOS がゲーム起動前に行う設定に合わせる)
      this.codeBank = 'flash';
      this.sfr[EXT] = 1;
      this.sfr[SP] = 0x7f;
      this.sfr[PSW] = 0x02; // RAMBK0 = 1 (ゲーム用バンク)
      this.sfr[OCR] = 0xa3; // 32kHz サブクロック ÷6
      this.sfr[P3] = 0xff;
    }
  }

  // ---- 時間 ----

  /** 1 サイクルの秒数を決めるクロック (Hz) */
  get cycleRate() {
    const ocr = this.sfr[OCR];
    const div = ocr & 0x80 ? 6 : 12;
    if (ocr & 0x20) return 32768 / div; // サブクロック
    if (ocr & 0x10) return 6000000 / div; // メインクロック (Dreamcast に挿したとき)
    return 600000 / div; // RC 発振
  }

  // ---- メモリ ----

  codeByte(addr) {
    addr &= 0xffff;
    if (this.codeBank === 'rom') return this.rom ? this.rom[addr] : 0;
    return this.flash[addr];
  }

  fetch() {
    const b = this.codeByte(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return b;
  }

  get ramBank() {
    return (this.sfr[PSW] >> 1) & 1;
  }

  read(addr) {
    addr &= 0x1ff;
    if (addr < 0x100) return this.ram[this.ramBank][addr];
    if (addr >= 0x180) return this.xram[this.sfr[XBNK] & 3][addr - 0x180] ?? 0;
    const r = addr - 0x100;
    switch (r) {
      case PSW: return (this.sfr[PSW] & 0xfe) | parity(this.sfr[ACC]);
      case T0L: return this.t0[0];
      case T0H: return this.t0[1];
      case T1L: return this.t1[0];
      case T1H: return this.t1[1];
      // P7: bit1 = 電池の電圧が十分 (MAME svmu の p7_r と同じ)、bit0 = Dreamcast に挿している (単体動作なので 0)
      case P7: return (this.batteryGood ? 0x02 : 0) | (this.sfr[P7] & ~0x03 & 0xff);
      case P1DDR: case P1FCR: return 0xff; // 書き込み専用 (MAME と同じく読むと 0xff)
      case P3: return (this.sfr[P3] & this.sfr[P3DDR]) | (this.buttons & ~this.sfr[P3DDR] & 0xff);
      case VTRBF: {
        const a = ((this.sfr[VRMAD2] & 1) << 8) | this.sfr[VRMAD1];
        const v = this.wram[a];
        if (this.sfr[VSEL] & 0x10) this.bumpVrmad();
        return v;
      }
      default: return this.sfr[r];
    }
  }

  bumpVrmad() {
    const a = ((((this.sfr[VRMAD2] & 1) << 8) | this.sfr[VRMAD1]) + 1) & 0x1ff;
    this.sfr[VRMAD1] = a & 0xff;
    this.sfr[VRMAD2] = a >> 8;
  }

  write(addr, v) {
    addr &= 0x1ff;
    v &= 0xff;
    if (addr < 0x100) {
      this.ram[this.ramBank][addr] = v;
      return;
    }
    if (addr >= 0x180) {
      this.xram[this.sfr[XBNK] & 3][addr - 0x180] = v;
      return;
    }
    const r = addr - 0x100;
    switch (r) {
      case T0L: case T0H: return; // カウンタは読み出し専用 (リロード値は T0LR / T0HR)
      case T1L: this.sfr[T1L] = v; return; // 書き込みはリロード値 T1LR
      case T1H: this.sfr[T1H] = v; return; // 書き込みはリロード値 T1HR
      case T0CNT:
        if ((v & 0x40) && !(this.sfr[T0CNT] & 0x40)) this.t0[0] = this.sfr[T0LR];
        if ((v & 0x80) && !(this.sfr[T0CNT] & 0x80)) this.t0[1] = this.sfr[T0HR];
        break;
      case T1CNT:
        // 止まっている間はリロード値を読み込んでおく (MAME と同じ)。bit4 = 比較値を T1LC から取り込む
        if (!(v & 0x40)) this.t1[0] = this.sfr[T1L];
        if (!(v & 0x80)) this.t1[1] = this.sfr[T1H];
        if (v & 0x10) this.t1cmp = this.sfr[T1LC];
        break;
      case T1LC:
        if ((this.sfr[T1CNT] & 0x10) || !(this.sfr[T1CNT] & 0x40)) this.t1cmp = v;
        break;
      case VTRBF: {
        this.wram[((this.sfr[VRMAD2] & 1) << 8) | this.sfr[VRMAD1]] = v;
        if (this.sfr[VSEL] & 0x10) this.bumpVrmad();
        return;
      }
      default: break;
    }
    this.sfr[r] = v;
    if (r === P1 || r === P1DDR || r === P1FCR) this.updateSpeaker();
  }

  // 間接アドレス @Ri: PSW の IRBK でセル (0-3 / 4-7 / 8-B / C-F) を選び、R2/R3 は SFR 側 (bit8 = 1)
  ind(i) {
    const cell = ((this.sfr[PSW] >> 3) & 3) * 4 + i;
    return ((i & 2) << 7) | this.ram[this.ramBank][cell];
  }

  push(v) {
    this.sfr[SP] = (this.sfr[SP] + 1) & 0xff;
    this.ram[0][this.sfr[SP]] = v & 0xff; // スタックは常にバンク 0
  }

  pop() {
    const v = this.ram[0][this.sfr[SP]];
    this.sfr[SP] = (this.sfr[SP] - 1) & 0xff;
    return v;
  }

  pushPc(pc) {
    this.push(pc & 0xff); // 下位を先に
    this.push(pc >> 8);
  }

  popPc() {
    const hi = this.pop();
    return (hi << 8) | this.pop();
  }

  setFlag(mask, on) {
    this.sfr[PSW] = on ? this.sfr[PSW] | mask : this.sfr[PSW] & ~mask;
  }

  get cy() {
    return this.sfr[PSW] >> 7;
  }

  // ---- 算術 ----

  add(d, carry) {
    const a = this.sfr[ACC];
    const c = carry ? this.cy : 0;
    const res = a + d + c;
    this.setFlag(0x80, res > 0xff);
    this.setFlag(0x40, (a & 0xf) + (d & 0xf) + c > 0xf);
    this.setFlag(0x04, ((a ^ res) & (d ^ res) & 0x80) !== 0);
    this.sfr[ACC] = res & 0xff;
  }

  sub(d, carry) {
    const a = this.sfr[ACC];
    const c = carry ? this.cy : 0;
    const res = a - d - c;
    this.setFlag(0x80, res < 0);
    this.setFlag(0x40, (a & 0xf) - (d & 0xf) - c < 0);
    this.setFlag(0x04, ((a ^ d) & (a ^ res) & 0x80) !== 0);
    this.sfr[ACC] = res & 0xff;
  }

  branch(cond, rel) {
    if (cond) this.pc = (this.pc + s8(rel)) & 0xffff;
  }

  /** JMPF: EXT bit0 でコードのバンク (0 = ROM/BIOS, 1 = フラッシュ) を切り替える */
  jumpFar(target) {
    const bank = this.sfr[EXT] & 1 ? 'flash' : 'rom';
    if (bank === 'flash' && this.codeBank === 'rom') this.flashEntries++; // BIOS → ゲーム (起動・BIOS 呼び出しからの復帰)
    this.codeBank = bank;
    this.pc = target;
    if (this.codeBank === 'rom' && !this.rom) this.stop('bios', `BIOS が必要です (ゲームが BIOS の 0x${target.toString(16).padStart(4, '0')} を呼びました)`);
  }

  stop(reason, message) {
    this.stopReason = reason;
    this.stopMessage = message;
  }

  /** フラッシュへの書き込み (STF): AA→5555, 55→2AAA, A0→5555 の後の 128 バイトだけ受け付ける */
  flashWrite(addr, v) {
    const a = addr & 0xffff;
    if (this.flashCmd === 3) {
      this.flash[addr] = v;
      if (++this.flashWrites >= 128) this.flashCmd = 0;
      return;
    }
    if (this.flashCmd === 0 && a === 0x5555 && v === 0xaa) this.flashCmd = 1;
    else if (this.flashCmd === 1 && a === 0x2aaa && v === 0x55) this.flashCmd = 2;
    else if (this.flashCmd === 2 && a === 0x5555 && v === 0xa0) {
      this.flashCmd = 3;
      this.flashWrites = 0;
    } else this.flashCmd = 0;
  }

  // ---- 1 命令 ----

  step() {
    if (this.stopReason) return 0;
    if (this.sfr[PCON] & 1) { // HALT: 命令を止めて周辺だけ進める
      this.tick(1);
      this.checkIrq();
      return 1;
    }
    const pc0 = this.pc;
    const op = this.fetch();
    const hi = op >> 4;
    const lo = op & 0x0f;
    const d9 = () => ((op & 1) << 8) | this.fetch();
    const bitAddr = () => ((op & 0x10) << 4) | this.fetch();
    const ri = op & 3;

    if (lo >= 8 && hi <= 3) { // CALL / JMP a12
      const a12 = ((op & 0x10) << 7) | ((op & 7) << 8) | this.fetch();
      const target = (this.pc & 0xf000) | a12;
      if (hi <= 1) this.pushPc(this.pc);
      this.pc = target;
    } else if (lo >= 8) { // ビット命令
      const bit = op & 7;
      const mask = 1 << bit;
      const group = hi & 0xe;
      const addr = bitAddr();
      if (group === 0xe || group === 0xc || group === 0xa) { // SET1 / CLR1 / NOT1
        const v = this.read(addr);
        this.write(addr, group === 0xe ? v | mask : group === 0xc ? v & ~mask : v ^ mask);
      } else { // BPC / BP / BN
        const rel = this.fetch();
        const v = this.read(addr);
        if (group === 0x4) {
          if (v & mask) {
            this.write(addr, v & ~mask);
            this.branch(true, rel);
          }
        } else this.branch(group === 0x6 ? (v & mask) !== 0 : (v & mask) === 0, rel);
      }
    } else {
      const operand = () => (lo === 1 ? this.fetch() : lo <= 3 ? this.read(d9()) : this.read(this.ind(ri)));
      switch (hi) {
        case 0x0:
          if (lo === 0) break; // NOP
          if (lo === 1) this.branch(true, this.fetch()); // BR
          else if (lo <= 3) this.sfr[ACC] = this.read(d9()); // LD d9
          else this.sfr[ACC] = this.read(this.ind(ri)); // LD @Ri
          break;
        case 0x1:
          if (lo <= 1) { // CALLR / BRF r16
            const r16 = this.fetch() | (this.fetch() << 8);
            if (lo === 0) this.pushPc(this.pc);
            this.pc = (this.pc - 1 + r16) & 0xffff;
          } else if (lo <= 3) this.write(d9(), this.sfr[ACC]); // ST d9
          else this.write(this.ind(ri), this.sfr[ACC]); // ST @Ri
          break;
        case 0x2:
          if (lo <= 1) { // CALLF / JMPF a16
            const a16 = (this.fetch() << 8) | this.fetch();
            if (lo === 0) {
              this.pushPc(this.pc);
              this.pc = a16;
            } else this.jumpFar(a16);
          } else if (lo <= 3) { // MOV #i8,d9
            const a = d9();
            this.write(a, this.fetch());
          } else this.write(this.ind(ri), this.fetch()); // MOV #i8,@Rj
          break;
        case 0x3: case 0x4: { // MUL / DIV / BE / BNE
          if (lo === 0) {
            const v = (this.sfr[ACC] << 8) | this.sfr[C];
            if (hi === 3) {
              const res = v * this.sfr[B];
              this.sfr[B] = (res >> 16) & 0xff;
              this.sfr[ACC] = (res >> 8) & 0xff;
              this.sfr[C] = res & 0xff;
              this.setFlag(0x04, res > 0xffff);
            } else if (this.sfr[B] === 0) {
              this.sfr[ACC] = 0xff;
              this.sfr[C] = 0xff;
              this.setFlag(0x04, true);
            } else {
              const q = Math.floor(v / this.sfr[B]);
              this.sfr[B] = v % this.sfr[B];
              this.sfr[ACC] = (q >> 8) & 0xff;
              this.sfr[C] = q & 0xff;
              this.setFlag(0x04, false);
            }
            this.setFlag(0x80, false);
            break;
          }
          let x;
          let y;
          if (lo === 1) {
            x = this.sfr[ACC];
            y = this.fetch();
          } else if (lo <= 3) {
            x = this.sfr[ACC];
            y = this.read(d9());
          } else {
            x = this.read(this.ind(ri));
            y = this.fetch();
          }
          const rel = this.fetch();
          this.setFlag(0x80, x < y);
          this.branch(hi === 3 ? x === y : x !== y, rel);
          break;
        }
        case 0x5:
          if (lo === 0) { // LDF
            const fa = ((this.sfr[FPR] & 1) << 16) | (this.sfr[TRH] << 8) | this.sfr[TRL];
            this.sfr[ACC] = this.flash[fa];
            this.onFlashRead?.(fa); // 解析用 (セーブを読み直しているかの確認など)
          }
          else if (lo === 1) this.flashWrite(((this.sfr[FPR] & 1) << 16) | (this.sfr[TRH] << 8) | this.sfr[TRL], this.sfr[ACC]); // STF
          else { // DBNZ
            const a = lo <= 3 ? d9() : this.ind(ri);
            const rel = this.fetch();
            const v = (this.read(a) - 1) & 0xff;
            this.write(a, v);
            this.branch(v !== 0, rel);
          }
          break;
        case 0x6:
          if (lo <= 1) this.push(this.read(d9())); // PUSH
          else {
            const a = lo <= 3 ? d9() : this.ind(ri);
            this.write(a, this.read(a) + 1); // INC
          }
          break;
        case 0x7:
          if (lo <= 1) {
            const a = d9();
            this.write(a, this.pop()); // POP
          } else {
            const a = lo <= 3 ? d9() : this.ind(ri);
            this.write(a, this.read(a) - 1); // DEC
          }
          break;
        case 0x8:
          if (lo === 0) this.branch(this.sfr[ACC] === 0, this.fetch()); // BZ
          else this.add(operand(), false);
          break;
        case 0x9:
          if (lo === 0) this.branch(this.sfr[ACC] !== 0, this.fetch()); // BNZ
          else this.add(operand(), true);
          break;
        case 0xa:
          if (lo === 0) this.pc = this.popPc(); // RET
          else this.sub(operand(), false);
          break;
        case 0xb:
          if (lo === 0) { // RETI
            this.pc = this.popPc();
            if (this.inIrq > 0) this.inIrq--;
            this.afterReti = true;
          } else this.sub(operand(), true);
          break;
        case 0xc:
          if (lo === 0) { // ROR
            const a = this.sfr[ACC];
            this.sfr[ACC] = ((a >> 1) | (a << 7)) & 0xff;
          } else if (lo === 1) { // LDC
            const ca = (((this.sfr[TRH] << 8) | this.sfr[TRL]) + this.sfr[ACC]) & 0xffff;
            this.sfr[ACC] = this.codeByte(ca);
            if (this.codeBank === 'flash') this.onFlashRead?.(ca); // フラッシュ側で動くゲームは自分のデータを LDC で読む
          } else { // XCH
            const a = lo <= 3 ? d9() : this.ind(ri);
            const v = this.read(a);
            this.write(a, this.sfr[ACC]);
            this.sfr[ACC] = v;
          }
          break;
        case 0xd:
          if (lo === 0) { // RORC
            const a = this.sfr[ACC];
            const c = this.cy;
            this.setFlag(0x80, a & 1);
            this.sfr[ACC] = (a >> 1) | (c << 7);
          } else this.sfr[ACC] |= operand();
          break;
        case 0xe:
          if (lo === 0) { // ROL
            const a = this.sfr[ACC];
            this.sfr[ACC] = ((a << 1) | (a >> 7)) & 0xff;
          } else this.sfr[ACC] &= operand();
          break;
        case 0xf:
          if (lo === 0) { // ROLC
            const a = this.sfr[ACC];
            const c = this.cy;
            this.setFlag(0x80, a & 0x80);
            this.sfr[ACC] = ((a << 1) | c) & 0xff;
          } else this.sfr[ACC] ^= operand();
          break;
        default:
          this.stop('opcode', `未定義の命令 0x${op.toString(16)} (PC 0x${pc0.toString(16)})`);
      }
    }
    const c = CYCLES[op];
    this.tick(c);
    if (this.afterReti) this.afterReti = false; // RETI の直後の 1 命令は割り込みを受けない
    else this.checkIrq();
    return c;
  }

  // ---- 周辺 ----

  raise(n) {
    this.irqFlag |= 1 << n;
  }

  checkIrq() {
    if (!this.irqFlag || !(this.sfr[IE] & 0x80) || this.inIrq) return;
    for (let n = 0; n < VECTORS.length; n++) {
      if (!(this.irqFlag & (1 << n))) continue;
      this.irqFlag &= ~(1 << n);
      this.sfr[PCON] &= ~1; // HALT を解除
      this.pushPc(this.pc);
      this.inIrq++;
      this.pc = VECTORS[n];
      // 割り込みはその時点のコードのバンクで受ける (BIOS 無しならフラッシュのゲームのベクタ)
      return;
    }
  }

  tick(cycles) {
    this.cycles += cycles;
    this.time += cycles / this.cycleRate;
    const s = this.sfr;
    // タイマー 0 (プリスケーラ経由)
    if (s[T0CNT] & 0xc0) {
      this.t0pre += cycles;
      const period = 256 - s[T0PRR];
      while (this.t0pre >= period) {
        this.t0pre -= period;
        this.tickTimer0();
      }
    }
    // タイマー 1 (サイクルごと)
    if (s[T1CNT] & 0xc0) for (let i = 0; i < cycles; i++) this.tickTimer1();
    // ベースタイマー (32768Hz の水晶で動く)
    if (s[BTCR] & 0x40) {
      this.baseAcc += (cycles * 32768) / this.cycleRate;
      while (this.baseAcc >= 1) {
        this.baseAcc -= 1;
        this.baseCount = (this.baseCount + 1) & 0x3fff;
        const bt1 = s[BTCR] & 0x80 ? 64 : 256;
        if (this.baseCount % bt1 === 0) {
          s[BTCR] |= 0x08;
          if (s[BTCR] & 0x04) this.raise(IRQ.base);
        }
        if (this.baseCount === 0) { // 0.5 秒
          s[BTCR] |= 0x02;
          if (s[BTCR] & 0x01) this.raise(IRQ.base);
        }
      }
    }
  }

  tickTimer0() {
    const s = this.sfr;
    if (s[T0CNT] & 0x20) { // 16bit
      if (!(s[T0CNT] & 0x40)) return;
      if (++this.t0[0] > 0xff) {
        this.t0[0] = 0;
        if (++this.t0[1] > 0xff) {
          this.t0[0] = s[T0LR];
          this.t0[1] = s[T0HR];
          s[T0CNT] |= 0x08;
          if (s[T0CNT] & 0x04) this.raise(IRQ.t0h);
        }
      }
      return;
    }
    if ((s[T0CNT] & 0x40) && ++this.t0[0] > 0xff) {
      this.t0[0] = s[T0LR];
      s[T0CNT] |= 0x02;
      if (s[T0CNT] & 0x01) this.raise(IRQ.t0l);
    }
    if ((s[T0CNT] & 0x80) && ++this.t0[1] > 0xff) {
      this.t0[1] = s[T0HR];
      s[T0CNT] |= 0x08;
      if (s[T0CNT] & 0x04) this.raise(IRQ.t0h);
    }
  }

  tickTimer1() {
    const s = this.sfr;
    if (s[T1CNT] & 0x20) { // 16bit
      if (!(s[T1CNT] & 0x40)) return;
      if (++this.t1[0] > 0xff) {
        this.t1[0] = 0;
        if (++this.t1[1] > 0xff) {
          this.t1[0] = s[T1L];
          this.t1[1] = s[T1H];
          s[T1CNT] |= 0x08;
          if (s[T1CNT] & 0x04) this.raise(IRQ.t1);
        }
      }
      return;
    }
    if (s[T1CNT] & 0x40) {
      // 8bit: 比較値と一致で P1.7 を H、桁あふれで L (= ブザーの矩形波。周期 256 - T1LR、H の長さ 256 - T1LC)
      const next = this.t1[0] + 1;
      if (next === this.t1cmp) this.setPulse(1);
      if (next > 0xff) {
        this.t1[0] = s[T1L];
        this.setPulse(0);
        s[T1CNT] |= 0x02;
        if (s[T1CNT] & 0x01) this.raise(IRQ.t1);
      } else this.t1[0] = next;
    }
    if ((s[T1CNT] & 0x80) && ++this.t1[1] > 0xff) {
      this.t1[1] = s[T1H];
      s[T1CNT] |= 0x08;
      if (s[T1CNT] & 0x04) this.raise(IRQ.t1);
    }
  }

  /** ボタンの状態を設定 (pressed: Set か配列でボタン名) */
  setButtons(pressed) {
    const set = new Set(pressed);
    let v = 0xff;
    for (const [name, bit] of Object.entries(BUTTONS)) if (set.has(name)) v &= ~(1 << bit);
    const newly = this.buttons & ~v; // 押された瞬間のビット
    this.buttons = v;
    if (newly && (this.sfr[P3INT] & 0x01)) {
      this.sfr[P3INT] |= 0x02;
      this.raise(IRQ.p3);
    }
    if (newly && (this.sfr[PCON] & 2)) this.sfr[PCON] &= ~2; // HOLD 解除
  }

  /** 指定秒数ぶん実行する (止まったら stopReason が入る) */
  // 経過時間は命令ごとに「サイクル数 / その時のクロック」で積み上げる (BIOS は途中で RC ⇔ サブクロックを切り替えるため)
  runFor(seconds, maxCycles = 50_000_000) {
    const target = this.time + seconds;
    const limit = this.cycles + maxCycles;
    while (this.time < target && this.cycles < limit && !this.stopReason) {
      if (this.sfr[PCON] & 2) { // HOLD: ボタンで解除されるまで止まる (時間だけ進める)
        this.time = target;
        break;
      }
      this.step();
    }
  }

  /** LCD の画素 (48x32、1 = 点灯) と下部アイコン */
  lcd() {
    const px = new Uint8Array(LCD_W * LCD_H);
    for (let y = 0; y < LCD_H; y++) {
      const bank = this.xram[y >> 4];
      const line = y & 15;
      const base = (line >> 1) * 0x10 + (line & 1) * 6;
      for (let x = 0; x < LCD_W; x++) px[y * LCD_W + x] = (bank[base + (x >> 3)] >> (7 - (x & 7))) & 1;
    }
    const icons = this.xram[2];
    return {
      pixels: px,
      on: (this.sfr[VCCR] & 0x80) !== 0 && (this.sfr[MCR] & 0x08) !== 0,
      icons: { file: !!(icons[1] & 0x40), game: !!(icons[2] & 0x10), clock: !!(icons[3] & 0x02), flash: !!(icons[4] & 0x01) },
    };
  }

  /** ブザー: タイマー 1 (下位) の矩形波の周波数 (Hz)。鳴っていなければ 0 */
  beeper() {
    const s = this.sfr;
    // 比較値に届かない (T1LC <= T1LR) と H にならないので鳴らない
    if (!(s[T1CNT] & 0x40) || (s[T1CNT] & 0x20) || this.t1cmp <= s[T1L]) return 0;
    if (!(s[P1DDR] & 0x80) || !(s[P1FCR] & 0x80) || (s[P1] & 0x80)) return 0; // 端子に出ていない / P1 で H に固定
    return this.cycleRate / (256 - s[T1L]);
  }

  /** スピーカー (P1.7 の端子) の変化を onAudio(秒, 0/1) で知らせる (波形の書き出し用)。ゲームは P1 を直接書いて鳴らすこともある */
  setPulse(level) {
    this.pulse = level;
    this.updateSpeaker();
  }

  updateSpeaker() {
    const s = this.sfr;
    const level = (((s[P1] | ((this.pulse ? 0x80 : 0) & s[P1FCR])) & s[P1DDR]) >> 7) & 1;
    if (level === this.p17) return;
    this.p17 = level;
    this.onAudio?.(this.time, level);
  }

  /**
   * 状態の保存 (実機の「電池で中身を保ったまま電源を切る」に相当)。JSON にできるオブジェクトを返す。
   * フラッシュは withFlash のときだけ含める (イメージ側で持つ場合は不要)。ROM (BIOS) は含めない
   */
  saveState({ withFlash = false } = {}) {
    const b64 = (a) => {
      let s = '';
      for (let i = 0; i < a.length; i += 0x2000) s += String.fromCharCode(...a.subarray(i, i + 0x2000)); // 128KB を一度に展開すると引数が多すぎる
      return btoa(s);
    };
    const st = {
      format: 'dcvmu-vmuemu-state', version: 1, hasRom: !!this.rom,
      ram: this.ram.map(b64), sfr: b64(this.sfr), xram: this.xram.map(b64), wram: b64(this.wram),
      pc: this.pc, cycles: this.cycles, time: this.time, irqFlag: this.irqFlag, inIrq: this.inIrq, afterReti: this.afterReti,
      buttons: this.buttons, batteryGood: this.batteryGood, t0pre: this.t0pre, t0: [...this.t0], t1: [...this.t1],
      baseAcc: this.baseAcc, baseCount: this.baseCount, flashCmd: this.flashCmd, flashWrites: this.flashWrites,
      flashEntries: this.flashEntries, codeBank: this.codeBank, t1cmp: this.t1cmp, p17: this.p17, pulse: this.pulse,
    };
    if (withFlash) st.flash = b64(this.flash);
    return st;
  }

  /** saveState の結果を読み込む (フラッシュを含んでいればそれも戻す) */
  loadState(st) {
    if (st?.format !== 'dcvmu-vmuemu-state' || st.version !== 1) throw new Error('エミュレーターの状態ファイルではありません');
    if (st.hasRom && !this.rom) throw new Error('この状態は BIOS ありで保存されています。BIOS を指定してください');
    const un = (s, len) => {
      const a = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      if (a.length !== len) throw new Error('状態ファイルが壊れています');
      return a;
    };
    this.ram = st.ram.map((x) => un(x, 256));
    this.sfr = un(st.sfr, 128);
    this.xram = st.xram.map((x) => un(x, 0x80));
    this.wram = un(st.wram, 512);
    if (st.flash) this.flash.set(un(st.flash, FLASH_SIZE));
    for (const k of ['pc', 'cycles', 'time', 'irqFlag', 'inIrq', 'afterReti', 'buttons', 'batteryGood', 't0pre', 'baseAcc', 'baseCount', 'flashCmd', 'flashWrites', 'flashEntries', 'codeBank']) this[k] = st[k];
    this.t1cmp = st.t1cmp ?? 0;
    this.p17 = st.p17 ?? 0;
    this.pulse = st.pulse ?? 0;
    this.t0 = [...st.t0];
    this.t1 = [...st.t1];
    this.stopReason = null;
    this.stopMessage = undefined;
  }

  /** デバッグ用の状態 */
  state() {
    return {
      pc: this.pc, bank: this.codeBank, acc: this.sfr[ACC], psw: this.read(0x101), sp: this.sfr[SP], b: this.sfr[B], c: this.sfr[C],
      cycles: this.cycles, stopReason: this.stopReason, stopMessage: this.stopMessage,
    };
  }
}
