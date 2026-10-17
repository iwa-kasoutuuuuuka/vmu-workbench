// 構造定義パネル: 選択中ファイルの名前付きフィールドを表示・編集する
// 値の書き込みは HexEditor 経由 (元に戻す・変更表示・適用時のCRC自動更新を共有)。
// コンテナ形式 (bleem2 の PS1 メモリーカードなど) は展開した中身を表示し、変更はすぐイメージへ適用する。
import {
  FIELD_TYPES, validateDef, matches, readField, formatField, encodeField, groupFields, newDefFor, baseOffset,
  openView, resolveViewFields, setFields, applyChecksums, checksumStatus,
} from './src/structdef.js';
import { NUM_TYPES } from './src/types.js';

const WORK_KEY = 'dcvmu.workingDefs';
const KIND_LABEL = { builtin: '組込', user: '読込', working: '作業中' };

// 全ペイン共通の定義ストア
export const store = {
  builtin: [], // defs/*.json (サーバーから)
  user: [], // 画面から読み込んだ .json
  working: loadWorking(), // 画面で作成・編集中 (localStorage に保存)
  errors: [],
  listeners: new Set(),
  all() {
    return [
      ...this.working.map((def) => ({ kind: 'working', def })),
      ...this.user.map((def) => ({ kind: 'user', def })),
      ...this.builtin.map((def) => ({ kind: 'builtin', def })),
    ];
  },
  changed() {
    try {
      localStorage.setItem(WORK_KEY, JSON.stringify(this.working));
    } catch { /* 保存できなくても動作は継続 */ }
    this.listeners.forEach((fn) => fn());
  },
};

function loadWorking() {
  try {
    const list = JSON.parse(localStorage.getItem(WORK_KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function loadBuiltinDefs() {
  try {
    const res = await fetch('defs/index.json', { cache: 'no-store' });
    const { defs, errors } = await res.json();
    store.builtin = defs;
    store.errors = errors;
  } catch (err) {
    store.errors = [`defs の読み込みに失敗: ${err.message}`];
  }
  store.changed();
}

const keyOf = ({ kind, def }) => `${kind}:${def.id}`;
const bitsOf = (f) => NUM_TYPES[f.type].size * 8;
const toUnsigned = (f, v) => (v < 0 ? v + 2 ** bitsOf(f) : v);
const toSigned = (f, u) => (NUM_TYPES[f.type].min < 0 && u >= 2 ** (bitsOf(f) - 1) ? u - 2 ** bitsOf(f) : u);
const h4 = (n) => `0x${n.toString(16).padStart(4, '0')}`;

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter((c) => c !== null && c !== undefined));
  return e;
}

function button(text, onClick, props = {}) {
  const b = el('button', { textContent: text, type: 'button', ...props });
  b.addEventListener('click', onClick);
  return b;
}

function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  el('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class StructPanel {
  /**
   * @param {import('./hexeditor.js').HexEditor} hex
   * @param {{onApplyFile: (data: Uint8Array) => void}} handlers  コンテナ形式の書き換え結果 (VMU ファイル全体) を適用する
   */
  constructor(hex, { onApplyFile }) {
    this.hex = hex;
    this.onApplyFile = onApplyFile;
    this.choice = new Map(); // ファイル名 → 選択した定義キー
    this.message = '';
    this.form = { name: '', type: 'u8', length: '', count: '', group: '' };
    this.root = el('div', { className: 'struct' });
    store.listeners.add(() => this.render());
  }

  get entry() {
    return this.hex.entry;
  }

  /** このファイルに使える定義 (一致するもの) */
  candidates() {
    const { entry } = this;
    return store.all().filter((c) => matches(c.def, entry, this.hex.data));
  }

  current() {
    const list = this.candidates();
    const chosen = this.choice.get(this.entry.name);
    if (chosen === 'none') return null;
    return list.find((c) => keyOf(c) === chosen) ?? list[0] ?? null;
  }

  render() {
    if (!this.entry) {
      this.root.replaceChildren();
      return;
    }
    const list = this.candidates();
    const cur = this.current();

    // 定義の選択と操作
    const sel = el('select', { className: 'defsel' },
      ...list.map((c) => el('option', { value: keyOf(c), textContent: `${c.def.title} [${KIND_LABEL[c.kind]}]`, selected: c === cur })),
      el('option', { value: 'none', textContent: list.length ? '(使わない)' : '(一致する定義なし)', selected: !cur }));
    sel.addEventListener('change', () => {
      this.choice.set(this.entry.name, sel.value);
      this.message = '';
      this.render();
    });
    const fileInput = el('input', { type: 'file', accept: '.json', hidden: true });
    fileInput.addEventListener('change', () => this.importDef(fileInput.files[0]));
    const bar = el('div', { className: 'struct-bar' },
      el('strong', { textContent: '構造定義' }), sel,
      button('新規', () => this.createDef(), { title: 'このファイル用の新しい定義を作る' }),
      button('読込', () => fileInput.click(), { title: '定義ファイル (.json) を読み込む' }), fileInput,
      cur && cur.kind !== 'working' ? button('複製して編集', () => this.duplicate(cur.def)) : null,
      cur?.kind === 'working' ? button('書き出し', () => this.exportDef(cur.def), { title: 'defs/ に置くと組込定義になります' }) : null,
      cur?.kind === 'working' ? button('削除', () => this.removeWorking(cur.def), { className: 'danger' }) : null);

    const children = [bar];
    if (this.message) children.push(el('div', { className: 'struct-msg', textContent: this.message }));
    if (cur) {
      const problems = cur.def.fields.length ? validateDef(cur.def) : [];
      if (problems.length) children.push(el('div', { className: 'struct-msg', textContent: `定義の問題: ${problems.join(' / ')}` }));
      const view = openView(cur.def, this.entry, this.hex.data);
      if (!view) {
        children.push(el('div', { className: 'struct-msg', textContent: 'コンテナ/セーブを開けません (編集中の HEX が壊れている可能性)' }));
        this.root.replaceChildren(...children);
        return;
      }
      children.push(el('div', { className: 'struct-note', textContent:
        `${cur.def.note ? `${cur.def.note}  ` : ''}基準: ${view.label} (${h4(view.base)})` }));
      if (view.container) {
        children.push(el('div', { className: 'struct-note', textContent:
          'コンテナ形式のため、値の変更はすぐ VMU イメージに適用されます (HEX の元に戻すは使えません。「保存」で書き出し)。' }));
      }
      children.push(this.renderTable(cur, view));
      children.push(...this.renderChecksums(cur.def, view));
      if (cur.kind === 'working' && !view.container) children.push(this.renderAddForm(cur.def));
    }
    this.root.replaceChildren(...children);
  }

  renderChecksums(def, view) {
    return checksumStatus(def, view.bytes, view.base).map((c) => el('div', {
      className: `struct-cs ${c.inRange && c.ok ? '' : 'ng'}`,
      textContent: !c.inRange ? `${c.name}: 範囲外`
        : c.ok ? `${c.name}: 0x${c.stored.toString(16)} (一致) — 値を変えると自動更新されます`
          : `${c.name}: 格納値 0x${c.stored.toString(16)} / 計算値 0x${c.actual.toString(16)} — 不一致`,
    }));
  }

  renderTable(cur, view) {
    const data = view.bytes;
    const original = openView(cur.def, this.entry, this.hex.original)?.bytes ?? data;
    const fields = resolveViewFields(cur.def, view);
    const table = el('table', { className: 'struct-table' });
    if (!fields.length) {
      table.append(el('tr', {}, el('td', { textContent: 'フィールドがありません。HEX でカーソルを合わせて下のフォームから追加してください。' })));
      return table;
    }
    for (const { group, fields: list } of groupFields(fields)) {
      if (group) table.append(el('tr', { className: 'grp' }, el('th', { colSpan: 5, textContent: group })));
      for (const f of list) {
        const value = readField(data, f);
        const changed = f.inRange && data.subarray(f.offset, f.offset + f.size).some((b, i) => b !== original[f.offset + i]);
        const name = el('td', { className: view.container ? 'fname nolink' : 'fname', textContent: f.name,
          title: view.container ? 'コンテナ内のデータのため HEX 上の位置はありません' : 'クリックで HEX の該当位置へ' });
        if (!view.container) name.addEventListener('click', () => this.hex.select(f.offset, f.size));
        const tr = el('tr', { className: changed ? 'chg' : '' },
          name,
          el('td', { className: 'foff', textContent: `+${h4(f.relOffset)}`, title: `${view.container ? 'セーブ' : 'ファイル'}先頭から ${h4(f.offset)}` }),
          el('td', { className: 'ftype', textContent: f.type + (f.type === 'string' || f.type === 'bytes' ? `[${f.size}]` : '') }),
          el('td', { className: 'fval' }, f.inRange ? this.valueEditor(f, value, cur.def, view) : el('span', { textContent: '(範囲外)' })),
          el('td', {}, cur.kind === 'working'
            ? button('×', () => this.removeField(cur.def, f.baseName), { className: 'mini', title: `${f.baseName} を定義から削除` })
            : null));
        if (f.note) tr.title = f.note;
        table.append(tr);
      }
    }
    return table;
  }

  /** 型に応じた入力欄 */
  valueEditor(f, value, def, view) {
    const commit = (input) => {
      try {
        if (view.container) {
          // 展開 → 書き換え → チェックサム → 再格納 した VMU ファイルをそのまま適用。
          // 元にするのは適用済みの内容 (未適用の HEX 編集を黙って混ぜない)
          if (this.hex.dirty && !confirm('未適用の HEX 編集は破棄されます。続けますか？')) {
            this.render();
            return;
          }
          this.onApplyFile(setFields(this.hex.original, def, this.entry, { [f.name]: input }));
        } else {
          const bytes = encodeField(f, input);
          // チェックサムの更新も HEX エディタ経由で書く (元に戻す・変更表示が効く)
          const next = Uint8Array.from(this.hex.data);
          next.set(bytes, f.offset);
          const sums = applyChecksums(def, next, view.base);
          // フィールドとチェックサムは 1 回の「元に戻す」でまとめて戻る
          this.hex.writeGroup([{ offset: f.offset, bytes }, ...sums.map((w) => ({ offset: w.at, bytes: w.bytes }))]);
          this.hex.render();
        }
        this.message = '';
      } catch (err) {
        this.message = err.message;
        this.render();
      }
    };
    if (f.flags) {
      const bits = Object.entries(f.flags).map(([bit, label]) => {
        const cb = el('input', { type: 'checkbox', checked: Math.floor(toUnsigned(f, value) / 2 ** Number(bit)) % 2 === 1 });
        cb.addEventListener('change', () => {
          // 32bit でも符号に影響されないよう算術で扱う
          const u = toUnsigned(f, value);
          const mask = 2 ** Number(bit);
          const isSet = Math.floor(u / mask) % 2 === 1;
          const next = u + (cb.checked && !isSet ? mask : 0) - (!cb.checked && isSet ? mask : 0);
          commit(toSigned(f, next));
        });
        return el('label', { className: 'flag' }, cb, label);
      });
      return el('span', { className: 'flags' }, ...bits, el('span', { className: 'raw', textContent: `0x${toUnsigned(f, value).toString(16)}` }));
    }
    if (f.enum) {
      const known = Object.keys(f.enum).map(Number);
      const s = el('select', {},
        ...Object.entries(f.enum).map(([v, label]) => el('option', { value: v, textContent: `${label} (${v})`, selected: Number(v) === value })),
        known.includes(value) ? null : el('option', { value, textContent: `? (${value})`, selected: true }));
      s.addEventListener('change', () => commit(Number(s.value)));
      return s;
    }
    if (f.type === 'bool') {
      const cb = el('input', { type: 'checkbox', checked: value });
      cb.addEventListener('change', () => commit(cb.checked ? '1' : '0'));
      return cb;
    }
    const readOnly = f.type === 'string' && f.encoding === 'sjis';
    const text = f.type === 'bytes' ? formatField(f, value) : String(value);
    const input = el('input', { value: text, readOnly, size: f.type === 'string' ? Math.max(8, f.size) : 12, title: readOnly ? 'Shift_JIS 文字列は読み取りのみ' : 'Enter で書き込み' });
    input.addEventListener('change', () => commit(input.value));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') input.blur();
    });
    const extra = Number.isInteger(value) && value > 9 ? el('span', { className: 'raw', textContent: `0x${value.toString(16)}` }) : null;
    return el('span', {}, input, extra);
  }

  renderAddForm(def) {
    const base = baseOffset(def, this.entry, this.hex.data);
    const rel = this.hex.cursor - base;
    const bind = (key, props) => {
      const input = el(props.tag ?? 'input', { value: this.form[key], ...props });
      input.addEventListener('input', () => {
        this.form[key] = input.value;
      });
      return input;
    };
    const typeSel = bind('type', { tag: 'select' });
    typeSel.append(...FIELD_TYPES.map((t) => el('option', { value: t, textContent: t, selected: t === this.form.type })));
    return el('div', { className: 'addfield' },
      el('span', { textContent: `カーソル位置 (+${h4(Math.max(0, rel))}) に追加:` }),
      bind('name', { placeholder: '名前', size: 10 }),
      typeSel,
      bind('length', { placeholder: '長さ(文字列/bytes)', size: 6 }),
      bind('count', { placeholder: '個数', size: 4 }),
      bind('group', { placeholder: 'グループ', size: 8 }),
      button('追加', () => this.addField(def, rel), { disabled: rel < 0, title: rel < 0 ? '基準位置より前には追加できません' : '' }));
  }

  // ---- 定義の操作 ----

  saveWorking(def) {
    const i = store.working.findIndex((d) => d.id === def.id);
    if (i >= 0) store.working[i] = def;
    else store.working.unshift(def);
    this.choice.set(this.entry.name, `working:${def.id}`);
    store.changed();
  }

  createDef() {
    const def = newDefFor(this.entry, this.hex.data);
    let id = def.id;
    for (let n = 2; store.working.some((d) => d.id === id); n++) id = `${def.id}-${n}`;
    def.id = id;
    this.message = '新しい定義を作りました。HEX でカーソルを合わせてフィールドを追加してください。';
    this.saveWorking(def);
  }

  duplicate(def) {
    const copy = structuredClone(def);
    delete copy.source;
    this.message = `${def.title} を作業中の定義として複製しました`;
    this.saveWorking(copy);
  }

  async importDef(file) {
    if (!file) return;
    try {
      const def = JSON.parse(await file.text());
      const problems = validateDef(def);
      if (problems.length) throw new Error(problems.join(' / '));
      store.user = [def, ...store.user.filter((d) => d.id !== def.id)];
      this.choice.set(this.entry.name, `user:${def.id}`);
      this.message = matches(def, this.entry, this.hex.data) ? `${def.title} を読み込みました` : `${def.title} を読み込みました (このファイルには一致しません)`;
      store.changed();
    } catch (err) {
      this.message = `読み込み失敗: ${err.message}`;
      this.render();
    }
  }

  exportDef(def) {
    const problems = validateDef(def);
    if (problems.length && !confirm(`定義に問題があります:\n${problems.join('\n')}\n書き出しますか？`)) return;
    download(`${JSON.stringify(def, null, 2)}\n`, `${def.id}.json`);
    this.message = `${def.id}.json を書き出しました。defs/ に置くと組込定義として使えます`;
    this.render();
  }

  removeWorking(def) {
    if (!confirm(`作業中の定義 "${def.title}" を削除しますか？`)) return;
    store.working = store.working.filter((d) => d !== def);
    this.choice.delete(this.entry.name);
    store.changed();
  }

  addField(def, rel) {
    const { name, type, length, count, group } = this.form;
    const field = { name: name.trim(), offset: h4(rel), type };
    if (type === 'string' || type === 'bytes') field.length = Number(length);
    if (count.trim()) field.count = Number(count);
    if (group.trim()) field.group = group.trim();
    const next = { ...def, fields: [...def.fields, field] };
    const problems = validateDef(next).filter((p) => p.includes(`fields[${def.fields.length}]`));
    if (problems.length) {
      this.message = problems.join(' / ');
      this.render();
      return;
    }
    this.form.name = '';
    this.message = `${field.name} を追加しました`;
    this.saveWorking(next);
  }

  removeField(def, baseName) {
    this.saveWorking({ ...def, fields: def.fields.filter((f) => f.name !== baseName) });
  }
}
