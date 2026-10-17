// HEXエディタ (セーブデータ改造用)
// ・1ページ = 1ブロック (512バイト)。16進/ASCII 両方で直接入力
// ・変更箇所の強調、領域 (ヘッダ/CRC/アイコン/データ) の色分け、元に戻す
// ・カーソル位置の値インスペクタ (u8/u16/u32, LE/BE) と数値での書き込み
// ・CRC の状態を常時表示し、適用時に自動更新
import { BLOCK_SIZE } from './src/vmu.js';
import { crcStatus, regions, diffBytes } from './src/edit.js';
import { NUM_TYPES, parseInteger } from './src/types.js';

const ROW = 16;
const h2 = (n) => n.toString(16).padStart(2, '0');
const h4 = (n) => n.toString(16).padStart(4, '0');


function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

export class HexEditor {
  /**
   * @param {{onApply: (data: Uint8Array, fixCrc: boolean) => void, onRender?: () => void}} handlers
   *   onRender: 描画のたびに呼ばれる (構造定義パネルの値の更新用)
   */
  constructor({ onApply, onRender, onHeat }) {
    this.onApply = onApply;
    this.onRender = onRender;
    this.onHeat = onHeat; // 「変化」ボタン: 履歴から変化回数を求めて setHeat を呼ぶ
    this.highlight = null;
    this.heat = null;
    this.entry = null;
    this.root = el('div', { className: 'hexedit', tabIndex: 0 });
    this.root.addEventListener('keydown', (ev) => this.onKey(ev));
    this.root.addEventListener('click', (ev) => this.onClick(ev));
    this.root.addEventListener('change', (ev) => this.onChange(ev));
  }

  get dirty() {
    return !!this.entry && this.undo.length > 0 && diffBytes(this.original, this.data).length > 0;
  }

  /** ファイルを読み込む (同じファイルの再読込でもカーソル・ページは維持) */
  load(entry, bytes) {
    const same = this.entry?.name === entry.name;
    this.entry = entry;
    this.original = Uint8Array.from(bytes);
    this.data = Uint8Array.from(bytes);
    this.view = new DataView(this.data.buffer);
    this.regionList = regions(this.data, entry);
    this.undo = [];
    if (!same) {
      this.cursor = 0;
      this.nibble = 0;
      this.mode = 'hex';
      this.highlight = null;
      this.heat = null;
    }
    this.cursor = Math.min(this.cursor, this.data.length - 1);
    this.render();
  }

  clear() {
    this.entry = null;
    this.root.replaceChildren();
    this.onRender?.();
  }

  /** 外部 (構造定義パネル) からの書き込み。元に戻す履歴に積まれ、適用時にCRCも更新される */
  writeBytes(offset, bytes) {
    this.write(offset, bytes);
    this.render();
  }

  /** 変化回数 (byteVariability の結果) を設定して色で表示する。null で解除 */
  setHeat(heat) {
    this.heat = heat;
    this.render();
  }

  /** 範囲を強調表示してカーソルを移動 */
  select(offset, size) {
    this.cursor = Math.min(offset, this.data.length - 1);
    this.nibble = 0;
    this.highlight = { start: offset, end: offset + size };
    this.render();
  }

  get page() {
    return Math.floor(this.cursor / BLOCK_SIZE);
  }

  get pageCount() {
    return Math.ceil(this.data.length / BLOCK_SIZE);
  }

  regionAt(offset) {
    return this.regionList.find((r) => offset >= r.start && offset < r.end);
  }

  // ---- 編集 ----

  write(offset, bytes) {
    this.writeGroup([{ offset, bytes }]);
  }

  /** 複数箇所をまとめて書く (元に戻すは 1 回でまとめて戻る) */
  writeGroup(changes) {
    const record = [];
    for (const { offset, bytes } of changes) {
      const old = this.data.slice(offset, offset + bytes.length);
      if (old.every((b, i) => b === bytes[i])) continue;
      record.push({ offset, old });
      this.data.set(bytes, offset);
    }
    if (record.length) this.undo.push(record);
  }

  undoLast() {
    const record = this.undo.pop();
    if (!record) return;
    for (const u of [...record].reverse()) this.data.set(u.old, u.offset);
    this.cursor = record[0].offset;
    this.nibble = 0;
  }

  move(delta) {
    this.cursor = Math.max(0, Math.min(this.data.length - 1, this.cursor + delta));
    this.nibble = 0;
  }

  onKey(ev) {
    if (!this.entry || ev.target.closest('input, select, button')) return;
    const k = ev.key;
    let handled = true;
    if ((ev.ctrlKey || ev.metaKey) && k.toLowerCase() === 'z') this.undoLast();
    else if (k === 'ArrowLeft') this.move(-1);
    else if (k === 'ArrowRight') this.move(1);
    else if (k === 'ArrowUp') this.move(-ROW);
    else if (k === 'ArrowDown') this.move(ROW);
    else if (k === 'PageUp') this.move(-BLOCK_SIZE);
    else if (k === 'PageDown') this.move(BLOCK_SIZE);
    else if (k === 'Home') this.move(-(this.cursor % ROW));
    else if (k === 'End') this.move(ROW - 1 - (this.cursor % ROW));
    else if (k === 'Tab') {
      this.mode = this.mode === 'hex' ? 'ascii' : 'hex';
      this.nibble = 0;
    } else if (this.mode === 'hex' && /^[0-9a-f]$/i.test(k) && !ev.ctrlKey && !ev.metaKey) {
      const v = parseInt(k, 16);
      const cur = this.data[this.cursor];
      this.write(this.cursor, Uint8Array.of(this.nibble === 0 ? (v << 4) | (cur & 0x0f) : (cur & 0xf0) | v));
      if (this.nibble === 0) this.nibble = 1;
      else this.move(1);
    } else if (this.mode === 'ascii' && k.length === 1 && k >= ' ' && k <= '~' && !ev.ctrlKey && !ev.metaKey) {
      this.write(this.cursor, Uint8Array.of(k.charCodeAt(0)));
      this.move(1);
    } else handled = false;
    if (handled) {
      ev.preventDefault();
      this.render();
    }
  }

  onClick(ev) {
    const cell = ev.target.closest('[data-off]');
    if (cell) {
      this.cursor = Number(cell.dataset.off);
      this.mode = cell.dataset.mode;
      this.nibble = 0;
      this.render();
      this.root.focus();
      return;
    }
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'prev') this.move(-BLOCK_SIZE);
    if (act === 'next') this.move(BLOCK_SIZE);
    if (act === 'undo') this.undoLast();
    if (act === 'discard') this.load(this.entry, this.original);
    if (act === 'goto') {
      const text = this.root.querySelector('.goto').value.trim().replace(/^0x/i, '');
      const v = /^[0-9a-f]+$/i.test(text) ? parseInt(text, 16) : NaN;
      if (v >= 0 && v < this.data.length) {
        this.cursor = v;
        this.nibble = 0;
      }
    }
    if (act === 'setnum') this.writeNumber();
    if (act === 'heat') {
      if (this.heat) this.heat = null;
      else if (this.onHeat) {
        this.onHeat();
        return;
      }
    }
    if (act === 'apply') {
      this.onApply(Uint8Array.from(this.data), this.root.querySelector('.fixcrc').checked);
      return;
    }
    this.render();
    this.root.focus();
  }

  onChange(ev) {
    if (ev.target.classList.contains('pagesel')) {
      this.cursor = Number(ev.target.value) * BLOCK_SIZE;
      this.nibble = 0;
      this.render();
    }
  }

  writeNumber() {
    const type = NUM_TYPES[this.root.querySelector('.numtype').value];
    const text = this.root.querySelector('.numval').value.trim();
    const value = parseInteger(text);
    if (!Number.isInteger(value) || value < type.min || value > type.max) {
      this.message = `値が範囲外です (${type.min}〜${type.max})`;
      return;
    }
    if (this.cursor + type.size > this.data.length) {
      this.message = 'ファイル末尾を超えます';
      return;
    }
    const tmp = new DataView(new ArrayBuffer(4));
    type.set(tmp, 0, value);
    this.write(this.cursor, new Uint8Array(tmp.buffer, 0, type.size));
    this.message = '';
  }

  // ---- 描画 ----

  render() {
    if (!this.entry) return;
    const prevType = this.root.querySelector('.numtype')?.value ?? 'u8';
    const prevFix = this.root.querySelector('.fixcrc')?.checked ?? true;
    const changed = new Set();
    for (const d of diffBytes(this.original, this.data)) {
      for (let i = 0; i < d.after.length; i++) changed.add(d.offset + i);
    }

    // ツールバー
    const pageSel = el('select', { className: 'pagesel', title: 'ブロック' },
      ...Array.from({ length: this.pageCount }, (_, p) => el('option', {
        value: p, selected: p === this.page,
        textContent: `ブロック ${p + 1}/${this.pageCount} (0x${h4(p * BLOCK_SIZE)}〜)`,
      })));
    const bar = el('div', { className: 'hex-bar' },
      el('button', { textContent: '◀', title: '前のブロック (PageUp)', disabled: this.page === 0 }),
      pageSel,
      el('button', { textContent: '▶', title: '次のブロック (PageDown)', disabled: this.page >= this.pageCount - 1 }),
      el('input', { className: 'goto', placeholder: 'オフセット (16進)', size: 10 }),
      el('button', { textContent: '移動' }),
      el('button', { textContent: this.heat ? '変化: 表示中' : '変化', title: 'このファイルの履歴 (スナップショット) 同士で、よく変わるバイトを色の濃さで表示', className: this.heat ? 'sel' : '' }),
      this.heat ? el('span', { className: 'heat-note', textContent: this.heat.note }) : '',
    );
    const [prev, , next, , gotoBtn, heatBtn] = bar.children;
    heatBtn.dataset.act = 'heat';
    prev.dataset.act = 'prev';
    next.dataset.act = 'next';
    gotoBtn.dataset.act = 'goto';

    // グリッド
    const start = this.page * BLOCK_SIZE;
    const end = Math.min(this.data.length, start + BLOCK_SIZE);
    const grid = el('div', { className: 'hex-grid' });
    for (let row = start; row < end; row += ROW) {
      const hexCells = [];
      const ascCells = [];
      for (let o = row; o < row + ROW; o++) {
        if (o >= end) {
          hexCells.push(el('span', { className: 'b empty', textContent: '  ' }));
          continue;
        }
        const b = this.data[o];
        const cls = ['b', `r-${this.regionAt(o)?.kind ?? 'data'}`];
        if (changed.has(o)) cls.push('chg');
        if (this.highlight && o >= this.highlight.start && o < this.highlight.end) cls.push('fld');
        const heat = this.heat && this.heat.changes[o] ? this.heat.changes[o] / this.heat.compared : 0;
        if (o === this.cursor) cls.push('cur', this.mode === 'hex' ? 'focus' : '');
        const hc = el('span', { className: cls.join(' '), textContent: h2(b) });
        if (heat) hc.style.boxShadow = `inset 0 0 0 20px rgba(232, 100, 12, ${0.15 + heat * 0.6})`;
        Object.assign(hc.dataset, { off: o, mode: 'hex' });
        if (o === this.cursor && this.mode === 'hex' && this.nibble === 1) hc.classList.add('half');
        const ac = el('span', {
          className: cls.filter((c) => c !== 'focus').join(' ') + (o === this.cursor && this.mode === 'ascii' ? ' focus' : ''),
          textContent: b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.',
        });
        Object.assign(ac.dataset, { off: o, mode: 'ascii' });
        hexCells.push(hc);
        ascCells.push(ac);
        if ((o & 7) === 7 && o + 1 < row + ROW) hexCells.push(el('span', { className: 'gap' }));
      }
      grid.append(el('div', { className: 'hex-row' },
        el('span', { className: 'addr', textContent: h4(row) }),
        el('span', { className: 'hex-cells' }, ...hexCells),
        el('span', { className: 'asc-cells' }, ...ascCells)));
    }

    // 凡例
    const kinds = [...new Map(this.regionList.map((r) => [r.kind, r.label])).entries()];
    const legend = el('div', { className: 'hex-legend' },
      ...kinds.map(([k, label]) => el('span', { className: `sw r-${k}`, textContent: label })),
      el('span', { className: 'sw chg', textContent: '変更' }));

    // インスペクタ
    const r = this.regionAt(this.cursor);
    const values = Object.entries(NUM_TYPES)
      .filter(([, t]) => this.cursor + t.size <= this.data.length)
      .map(([name, t]) => {
        const v = t.get(this.view, this.cursor);
        return el('span', { className: 'iv', textContent: `${name}: ${v}${name.startsWith('u') && t.size > 1 ? ` (0x${v.toString(16)})` : ''}` });
      });
    const numType = el('select', { className: 'numtype' },
      ...Object.keys(NUM_TYPES).map((n) => el('option', { value: n, textContent: n, selected: n === prevType })));
    const setBtn = el('button', { textContent: '書き込み' });
    setBtn.dataset.act = 'setnum';
    const inspector = el('div', { className: 'hex-inspector' },
      el('div', { textContent: `カーソル 0x${h4(this.cursor)} (${this.cursor})  ${r?.label ?? ''}  [${this.mode === 'hex' ? '16進入力' : 'ASCII入力'} — Tabで切替]` }),
      el('div', { className: 'ivs' }, ...values),
      el('div', { className: 'numset' }, numType, el('input', { className: 'numval', placeholder: '値 (10進 / 0x16進)', size: 14 }), setBtn,
        el('span', { className: 'msg', textContent: this.message ?? '' })));

    // CRC と適用
    const s = crcStatus(this.data, this.entry);
    // 状態ごとに必要な値だけを参照する (none では stored が無い)
    const crcText = {
      ok: () => `CRC: ${h4(s.stored)} (一致)`,
      ng: () => `CRC: 保存値 ${h4(s.stored)} / 計算値 ${h4(s.actual)} — 不一致`,
      broken: () => 'CRC: ヘッダのデータ長がファイルを超えています',
      none: () => 'CRC: VMSヘッダ無し (対象外)',
    }[s.status]();
    const fix = el('input', { type: 'checkbox', className: 'fixcrc', checked: prevFix, disabled: s.status === 'none' || s.status === 'broken' });
    const btn = (act, text, disabled) => {
      const b = el('button', { textContent: text, disabled });
      b.dataset.act = act;
      return b;
    };
    const footer = el('div', { className: 'hex-footer' },
      el('span', { className: `crc crc-${s.status}`, textContent: crcText }),
      el('label', {}, fix, ' 適用時にCRCを自動更新'),
      el('span', { className: 'chgcount', textContent: `変更 ${changed.size} バイト` }),
      btn('undo', '元に戻す', this.undo.length === 0),
      btn('discard', '破棄', changed.size === 0),
      btn('apply', '適用', changed.size === 0 && !(fix.checked && s.status === 'ng')));
    footer.lastChild.classList.add('primary');

    this.root.replaceChildren(bar, legend, grid, inspector, footer);
    this.onRender?.();
  }
}
