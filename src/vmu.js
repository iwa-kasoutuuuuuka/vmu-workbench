// Dreamcast VMU (Visual Memory Unit) フラッシュイメージ操作
// 128KB = 512バイト × 256ブロック
//   ブロック255      : ルートブロック
//   ブロック254      : FAT
//   ブロック253〜241 : ディレクトリ (13ブロック, 1エントリ32バイト)
//   ブロック0〜199   : ユーザー領域

export const BLOCK_SIZE = 512;
export const BLOCK_COUNT = 256;
export const IMAGE_SIZE = BLOCK_SIZE * BLOCK_COUNT;
export const DIR_ENTRY_SIZE = 32;

export const FAT_FREE = 0xfffc;
export const FAT_END = 0xfffa;

export const FILE_NONE = 0x00;
export const FILE_DATA = 0x33;
export const FILE_GAME = 0xcc;

const ROOT_BLOCK = 255;
const NAME_LENGTH = 12;

const toBcd = (n) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
const fromBcd = (b) => (b >> 4) * 10 + (b & 0x0f);

// 8バイトBCDタイムスタンプ: 世紀, 年, 月, 日, 時, 分, 秒, 曜日(0=月曜)
export function decodeTimestamp(bytes) {
  if (bytes.every((b) => b === 0)) return null;
  const year = fromBcd(bytes[0]) * 100 + fromBcd(bytes[1]);
  const d = new Date(2000, 0, 1, fromBcd(bytes[4]), fromBcd(bytes[5]), fromBcd(bytes[6]));
  d.setFullYear(year, fromBcd(bytes[2]) - 1, fromBcd(bytes[3])); // new Date(y<100) は 1900 年代になるため
  return d;
}

export function encodeTimestamp(date) {
  const y = date.getFullYear();
  return Uint8Array.of(
    toBcd(Math.floor(y / 100)), toBcd(y % 100),
    toBcd(date.getMonth() + 1), toBcd(date.getDate()),
    toBcd(date.getHours()), toBcd(date.getMinutes()), toBcd(date.getSeconds()),
    toBcd((date.getDay() + 6) % 7),
  );
}

export class VmuError extends Error {}

export class Vmu {
  constructor(bytes) {
    if (bytes.length !== IMAGE_SIZE) {
      throw new VmuError(`VMUイメージは${IMAGE_SIZE}バイトである必要があります (実際: ${bytes.length})`);
    }
    this.data = Uint8Array.from(bytes);
    this.view = new DataView(this.data.buffer);
  }

  /** 新品のフォーマット済みイメージを作成 */
  static format({ date = new Date() } = {}) {
    const vmu = new Vmu(new Uint8Array(IMAGE_SIZE));
    const r = ROOT_BLOCK * BLOCK_SIZE;
    vmu.data.fill(0x55, r, r + 16);
    vmu.data.set(encodeTimestamp(date), r + 0x30);
    vmu.view.setUint16(r + 0x44, ROOT_BLOCK, true); // ルートの位置。0 だと実機の BIOS は「システムガ コワレテイマス」(MAME svmu も 255 を書く)
    vmu.view.setUint16(r + 0x46, 254, true); // FAT位置
    vmu.view.setUint16(r + 0x48, 1, true);   // FATサイズ
    vmu.view.setUint16(r + 0x4a, 253, true); // ディレクトリ位置
    vmu.view.setUint16(r + 0x4c, 13, true);  // ディレクトリサイズ
    vmu.view.setUint16(r + 0x50, 200, true); // ユーザーブロック数

    for (let b = 0; b < BLOCK_COUNT; b++) vmu.setFat(b, FAT_FREE);
    vmu.setFat(ROOT_BLOCK, FAT_END);
    vmu.setFat(254, FAT_END);
    for (let b = 253; b > 241; b--) vmu.setFat(b, b - 1);
    vmu.setFat(241, FAT_END);
    return vmu;
  }

  toBytes() {
    return Uint8Array.from(this.data);
  }

  // ---- ルートブロック ----

  get root() {
    const r = ROOT_BLOCK * BLOCK_SIZE;
    const u16 = (o) => this.view.getUint16(r + o, true);
    const d = this.data;
    return {
      formatted: d.subarray(r, r + 16).every((b) => b === 0x55),
      customColor: d[r + 0x10] === 1,
      color: { b: d[r + 0x11], g: d[r + 0x12], r: d[r + 0x13], a: d[r + 0x14] },
      timestamp: decodeTimestamp(d.subarray(r + 0x30, r + 0x38)),
      fatBlock: u16(0x46),
      fatSize: u16(0x48),
      dirBlock: u16(0x4a),
      dirSize: u16(0x4c),
      iconShape: u16(0x4e),
      userBlocks: u16(0x50),
      rootBlock: u16(0x44),
    };
  }

  // ---- FAT ----

  fatOffset(block) {
    return this.root.fatBlock * BLOCK_SIZE + block * 2;
  }

  getFat(block) {
    return this.view.getUint16(this.fatOffset(block), true);
  }

  setFat(block, value) {
    this.view.setUint16(this.fatOffset(block), value, true);
  }

  /** ブロックチェーンを辿る (ループ・範囲外を検出) */
  chain(firstBlock, maxBlocks = BLOCK_COUNT) {
    const blocks = [];
    const seen = new Set();
    let b = firstBlock;
    while (b !== FAT_END) {
      if (b >= BLOCK_COUNT || seen.has(b) || blocks.length >= maxBlocks) {
        throw new VmuError(`FATチェーンが壊れています (ブロック ${b})`);
      }
      seen.add(b);
      blocks.push(b);
      b = this.getFat(b);
      if (b === FAT_FREE) throw new VmuError('FATチェーンが未使用ブロックを指しています');
    }
    return blocks;
  }

  freeBlocks() {
    const free = [];
    for (let b = 0; b < this.root.userBlocks; b++) {
      if (this.getFat(b) === FAT_FREE) free.push(b);
    }
    return free;
  }

  // ---- ディレクトリ ----

  dirEntryOffsets() {
    const { dirBlock, dirSize } = this.root;
    const offsets = [];
    for (let i = 0; i < dirSize; i++) {
      const base = (dirBlock - i) * BLOCK_SIZE;
      for (let e = 0; e < BLOCK_SIZE / DIR_ENTRY_SIZE; e++) {
        offsets.push(base + e * DIR_ENTRY_SIZE);
      }
    }
    return offsets;
  }

  parseDirEntry(offset, slot) {
    const d = this.data;
    const u16 = (o) => this.view.getUint16(offset + o, true);
    const nameBytes = d.subarray(offset + 4, offset + 4 + NAME_LENGTH);
    return {
      slot,
      type: d[offset],
      copyProtected: d[offset + 1] === 0xff,
      firstBlock: u16(2),
      name: String.fromCharCode(...nameBytes).replace(/[\0 ]+$/, ''),
      timestamp: decodeTimestamp(d.subarray(offset + 16, offset + 24)),
      sizeBlocks: u16(24),
      headerOffset: u16(26),
      raw: d.slice(offset, offset + DIR_ENTRY_SIZE),
    };
  }

  /** 使用中のファイル一覧 */
  list() {
    return this.dirEntryOffsets()
      .map((off, slot) => this.parseDirEntry(off, slot))
      .filter((e) => e.type !== FILE_NONE);
  }

  find(name) {
    const n = String(name ?? '').replace(/ +$/, '');
    return this.list().find((e) => e.name === n) ?? null;
  }

  readFile(entry) {
    const blocks = this.chain(entry.firstBlock, entry.sizeBlocks);
    const out = new Uint8Array(blocks.length * BLOCK_SIZE);
    blocks.forEach((b, i) => out.set(this.data.subarray(b * BLOCK_SIZE, (b + 1) * BLOCK_SIZE), i * BLOCK_SIZE));
    return out;
  }

  /** 失敗したらイメージを元に戻す (途中まで書き換えた状態を残さない) */
  transaction(fn) {
    const backup = this.data.slice();
    try {
      return fn();
    } catch (err) {
      this.data.set(backup);
      throw err;
    }
  }

  /** ファイル名を正規化 (末尾の空白は保存時に区別できないので除く) */
  static normalizeName(name) {
    const n = String(name ?? '').replace(/ +$/, '');
    if (!n || n.length > NAME_LENGTH || /[^\x20-\x7e]/.test(n)) {
      throw new VmuError(`ファイル名は1〜${NAME_LENGTH}文字のASCIIである必要があります: "${name}"`);
    }
    return n;
  }

  /** 空きブロックを割り当てる (ゲームはブロック0から連続、データは実機同様に上から) */
  allocate(sizeBlocks, type) {
    if (type === FILE_GAME) {
      const blocks = Array.from({ length: sizeBlocks }, (_, i) => i);
      if (blocks.some((b) => b >= this.root.userBlocks || this.getFat(b) !== FAT_FREE)) {
        throw new VmuError('ゲームファイル用の連続領域 (ブロック0〜) が空いていません');
      }
      return blocks;
    }
    const free = this.freeBlocks().reverse();
    if (free.length < sizeBlocks) {
      throw new VmuError(`空き容量不足: ${sizeBlocks}ブロック必要, 空き${free.length}ブロック`);
    }
    return free.slice(0, sizeBlocks);
  }

  /** データをブロックに書き、FAT をつなぐ */
  placeData(bytes, blocks) {
    const padded = new Uint8Array(blocks.length * BLOCK_SIZE);
    padded.set(bytes);
    blocks.forEach((b, i) => {
      this.data.set(padded.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE), b * BLOCK_SIZE);
      this.setFat(b, i + 1 < blocks.length ? blocks[i + 1] : FAT_END);
    });
  }

  /**
   * ファイルを書き込む。
   * ゲームファイルはブロック0から連続配置が必要 (VMUのミニゲーム実行のため)。
   * overwrite で同名ファイルを置き換える (容量不足などで失敗したら元のファイルは残る)。
   * timestamp に 8 バイトの BCD を渡すとそのまま使う (コピーで日時を変えないため)。
   */
  writeFile(name, bytes, {
    type = FILE_DATA, copyProtected = false, date = new Date(), headerOffset = 0, overwrite = false, timestamp = null,
  } = {}) {
    name = Vmu.normalizeName(name);
    const sizeBlocks = Math.ceil(bytes.length / BLOCK_SIZE);
    if (sizeBlocks === 0) throw new VmuError('空のファイルは書き込めません');
    return this.transaction(() => {
      const existing = this.find(name);
      if (existing) {
        if (!overwrite) throw new VmuError(`同名のファイルが既に存在します: ${name}`);
        this.deleteFile(existing);
      }
      if (type === FILE_GAME && this.list().some((e) => e.type === FILE_GAME)) {
        throw new VmuError('ゲームファイルは1つしか置けません');
      }
      const blocks = this.allocate(sizeBlocks, type);
      const slotOffset = this.dirEntryOffsets().find((off) => this.data[off] === FILE_NONE);
      if (slotOffset === undefined) throw new VmuError('ディレクトリに空きがありません');
      this.placeData(bytes, blocks);

      const e = new Uint8Array(DIR_ENTRY_SIZE);
      const ev = new DataView(e.buffer);
      e[0] = type;
      e[1] = copyProtected ? 0xff : 0x00;
      ev.setUint16(2, blocks[0], true);
      for (let i = 0; i < name.length; i++) e[4 + i] = name.charCodeAt(i);
      e.set(timestamp ? timestamp.subarray(0, 8) : encodeTimestamp(date), 16);
      ev.setUint16(24, sizeBlocks, true);
      ev.setUint16(26, headerOffset, true);
      this.data.set(e, slotOffset);
      return this.parseDirEntry(slotOffset, this.dirEntryOffsets().indexOf(slotOffset));
    });
  }

  /**
   * 指定したエントリ (スロット) のファイルを、属性・日時・ディレクトリ位置を保ったまま別サイズのデータに置き換える。
   * 失敗したら何も変えない。新しいエントリを返す。
   */
  rewriteFile(entry, bytes) {
    const sizeBlocks = Math.ceil(bytes.length / BLOCK_SIZE);
    if (sizeBlocks === 0) throw new VmuError('空のファイルは書き込めません');
    return this.transaction(() => {
      const off = this.dirEntryOffsets()[entry.slot];
      const raw = this.data.slice(off, off + DIR_ENTRY_SIZE);
      this.deleteFile(entry);
      const blocks = this.allocate(sizeBlocks, entry.type);
      this.placeData(bytes, blocks);
      const v = new DataView(raw.buffer);
      v.setUint16(2, blocks[0], true);
      v.setUint16(24, sizeBlocks, true);
      this.data.set(raw, off);
      return this.parseDirEntry(off, entry.slot);
    });
  }

  /**
   * 壊れていても辿れるところまでのブロック (ループ・範囲外・未使用で止まる)。
   * 他のファイルが使っているブロックに入り込んだら止める。
   */
  chainSafe(firstBlock, exclude = new Set()) {
    const blocks = [];
    const seen = new Set();
    for (let b = firstBlock; b < this.root.userBlocks && !seen.has(b) && !exclude.has(b);) {
      seen.add(b);
      blocks.push(b);
      const next = this.getFat(b);
      if (next === FAT_END || next === FAT_FREE) break;
      b = next;
    }
    return blocks;
  }

  /** 読める範囲で読む (壊れたファイルでも一覧表示や削除ができるように)。読めなければ null */
  tryReadFile(entry) {
    try {
      return this.readFile(entry);
    } catch {
      return null;
    }
  }

  deleteFile(entry) {
    // 壊れたチェーンでも消せるように辿れる範囲で解放する。他のファイルのブロックは解放しない
    const others = new Set();
    for (const e of this.list()) {
      if (e.slot !== entry.slot) this.chainSafe(e.firstBlock).forEach((b) => others.add(b));
    }
    for (const b of this.chainSafe(entry.firstBlock, others)) {
      this.setFat(b, FAT_FREE);
      this.data.fill(0, b * BLOCK_SIZE, (b + 1) * BLOCK_SIZE);
    }
    const off = this.dirEntryOffsets()[entry.slot];
    this.data.fill(0, off, off + DIR_ENTRY_SIZE);
  }

  /** 既存ファイルの中身を同サイズで差し替える (改造用) */
  replaceFileData(entry, bytes) {
    const blocks = this.chain(entry.firstBlock, entry.sizeBlocks);
    if (bytes.length > blocks.length * BLOCK_SIZE) {
      throw new VmuError('元のファイルサイズを超えています');
    }
    const padded = new Uint8Array(blocks.length * BLOCK_SIZE);
    padded.set(bytes);
    blocks.forEach((b, i) => this.data.set(padded.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE), b * BLOCK_SIZE));
  }

  /** 連続していない (断片化した) ファイルの一覧 */
  fragmented() {
    return this.list().filter((e) => {
      const blocks = this.chainSafe(e.firstBlock);
      return blocks.some((b, i) => i > 0 && Math.abs(b - blocks[i - 1]) !== 1);
    });
  }

  /**
   * 断片化を解消する: ゲームはブロック0から、データファイルはディレクトリ順に上から連続して詰め直す。
   * ディレクトリのエントリ (名前・属性・日時・並び) はそのまま。壊れたファイルがあると中止する。
   */
  defragment() {
    const problems = this.check();
    if (problems.length) throw new VmuError(`整合性に問題があるため中止しました: ${problems.join(' / ')}`);
    return this.transaction(() => {
      const files = this.list().map((e) => ({ e, data: this.readFile(e) }));
      for (let b = 0; b < this.root.userBlocks; b++) {
        this.setFat(b, FAT_FREE);
        this.data.fill(0, b * BLOCK_SIZE, (b + 1) * BLOCK_SIZE);
      }
      files.sort((a, b) => (b.e.type === FILE_GAME) - (a.e.type === FILE_GAME));
      for (const { e, data } of files) {
        const blocks = this.allocate(e.sizeBlocks, e.type);
        this.placeData(data, blocks);
        const off = this.dirEntryOffsets()[e.slot];
        this.view.setUint16(off + 2, blocks[0], true);
      }
      return this.list();
    });
  }

  /**
   * ディレクトリの並び (BIOS のファイル画面での表示順) を変える。names に並べたい順のファイル名。
   * 書かれていないファイルはその後ろに元の順で並ぶ。データの位置は変えない。
   */
  reorder(names) {
    const list = this.list();
    for (const n of names) if (!list.some((e) => e.name === n)) throw new VmuError(`ファイルがありません: ${n}`);
    const ordered = [...names.map((n) => list.find((e) => e.name === n)), ...list.filter((e) => !names.includes(e.name))];
    const offsets = this.dirEntryOffsets();
    for (const off of offsets) this.data.fill(0, off, off + DIR_ENTRY_SIZE);
    ordered.forEach((e, i) => this.data.set(e.raw, offsets[i]));
    return this.list();
  }

  /** 整合性チェック。問題点の配列を返す */
  /** ルートブロックの「ルートの位置」を 255 にする (以前の版 (DC_VMU) が作ったイメージの修正用)。直したら true */
  fixRoot() {
    if (!this.root.formatted || this.root.rootBlock === ROOT_BLOCK) return false;
    this.view.setUint16(ROOT_BLOCK * BLOCK_SIZE + 0x44, ROOT_BLOCK, true);
    return true;
  }

  check() {
    const problems = [];
    if (!this.root.formatted) problems.push('ルートブロックのフォーマット識別子がありません');
    else if (this.root.rootBlock !== ROOT_BLOCK) {
      problems.push(`ルートブロックの「ルートの位置」(0x44) が ${this.root.rootBlock} です (255 でないと VMU 本体の BIOS がファイル画面で「システムガ コワレテイマス」と表示。fixroot で直せます)`);
    }
    const owner = new Map();
    const names = new Map();
    for (const e of this.list()) {
      if (names.has(e.name)) problems.push(`${e.name}: 同名のファイルが複数あります (スロット ${names.get(e.name)} と ${e.slot})`);
      names.set(e.name, e.slot);
      try {
        const blocks = this.chain(e.firstBlock, BLOCK_COUNT);
        if (blocks.length !== e.sizeBlocks) {
          problems.push(`${e.name}: サイズ不一致 (ディレクトリ ${e.sizeBlocks}, FAT ${blocks.length})`);
        }
        for (const b of blocks) {
          if (owner.has(b)) problems.push(`${e.name}: ブロック${b}が${owner.get(b)}と重複`);
          owner.set(b, e.name);
        }
      } catch (err) {
        problems.push(`${e.name}: ${err.message}`);
      }
    }
    return problems;
  }
}
