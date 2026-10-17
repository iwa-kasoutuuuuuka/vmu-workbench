// DC_VMU GUI — 2つのVMUイメージを並べて編集・コピーする
import { Vmu, FILE_GAME, BLOCK_SIZE, IMAGE_SIZE } from './src/vmu.js';
import { parseHeader, headerPosition, iconToRgba, toDci, fromDci } from './src/vms.js';
import { crcStatus, applyEdit } from './src/edit.js';
import { HexEditor } from './hexeditor.js';
import { StructPanel, loadBuiltinDefs } from './structpanel.js';
import { addSnapshot, listSnapshots, getSnapshot, deleteSnapshot } from './history.js';
import { parseVmi, buildVmi, splitPages, replacePage, dcmSwap, isDcmName } from './src/formats.js';
import { openIconEditor } from './iconeditor.js';
import { openEmulator } from './emupanel.js';
import { byteVariability } from './src/analyze.js';
import { lookupTitle } from './src/titles.js';

let titlesDb = { vmu: [], ps1: [] };
fetch('titles/titles.json').then((r) => r.json()).then((db) => {
  titlesDb = db;
  panes.forEach((p) => p.render());
}).catch(() => {});

const statusEl = document.getElementById('status');
const fileInput = document.getElementById('file-input');
const panes = [];

function setStatus(msg, error = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', error);
}

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickFile(accept) {
  return pickFiles(accept, false).then((files) => files[0] ?? null);
}

function pickFiles(accept, multiple = true) {
  return new Promise((resolve) => {
    fileInput.accept = accept;
    fileInput.multiple = multiple;
    fileInput.value = '';
    fileInput.onchange = () => resolve([...fileInput.files]);
    fileInput.click();
  });
}

const readBytes = async (file) => new Uint8Array(await file.arrayBuffer());
const fmtDate = (d) => (d ? d.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '-');

function drawIcon(canvas, rgba) {
  canvas.width = 32;
  canvas.height = 32;
  canvas.getContext('2d').putImageData(new ImageData(rgba, 32, 32), 0, 0);
}

// アイコンアニメーション: animSpeed はフレーム数 (1/60秒) 単位
let tick = 0;
setInterval(() => {
  tick++;
  document.querySelectorAll('canvas[data-frames]').forEach((c) => {
    const frames = JSON.parse(c.dataset.frames);
    if (frames.length < 2) return;
    const speed = Math.max(1, Number(c.dataset.speed) || 10);
    const idx = Math.floor((tick * 100) / (speed * 1000 / 60)) % frames.length;
    if (c.dataset.idx !== String(idx)) {
      c.dataset.idx = idx;
      drawIcon(c, iconCache.get(c.dataset.key)[idx]);
    }
  });
}, 100);
const iconCache = new Map();

function iconCanvas(file, header, cls, key) {
  const c = document.createElement('canvas');
  c.className = cls;
  if (!header?.valid) return c;
  const frames = Array.from({ length: header.iconCount }, (_, i) => iconToRgba(file, header, i));
  iconCache.set(key, frames);
  Object.assign(c.dataset, { key, frames: JSON.stringify(frames.map((_, i) => i)), speed: header.animSpeed });
  drawIcon(c, frames[0]);
  return c;
}

class Pane {
  constructor(label) {
    this.label = label;
    this.vmu = null;
    this.fileName = '';
    this.selected = null;
    this.dirty = false;
    this.el = document.getElementById('pane-tpl').content.firstElementChild.cloneNode(true);
    this.el.querySelector('.slot').textContent = label;
    this.$ = (sel) => this.el.querySelector(sel);
    this.el.querySelector('.blockmap').append(...Array.from({ length: 200 }, () => document.createElement('i')));
    this.hex = new HexEditor({
      onApply: (data, fixCrc) => this.run(() => this.applyHex(data, fixCrc)),
      onRender: () => this.struct?.render(),
      onHeat: () => this.run(() => this.showHeat()),
    });
    this.struct = new StructPanel(this.hex, { onApplyFile: (data) => this.run(() => this.applyFile(data)) });
    this.$('.hexwrap').append(this.struct.root, this.hex.root);

    this.el.querySelector('.toolbar').addEventListener('click', (ev) => {
      const act = ev.target.dataset?.act;
      if (act) this.run(() => this[`act_${act.replace('-', '_')}`]());
    });
    this.$('tbody').addEventListener('click', (ev) => {
      const tr = ev.target.closest('tr');
      if (tr && tr.dataset.name !== this.selected && this.confirmHexDiscard()) {
        this.selected = tr.dataset.name;
        this.render();
      }
    });
    this.el.addEventListener('dragover', (ev) => { ev.preventDefault(); this.el.classList.add('dragover'); });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('dragover'));
    this.el.addEventListener('drop', (ev) => {
      ev.preventDefault();
      this.el.classList.remove('dragover');
      const files = [...ev.dataTransfer.files];
      if (files.length) this.run(() => this.loadFiles(files));
    });
  }

  get other() {
    return panes.find((p) => p !== this);
  }

  async run(fn) {
    try {
      await fn();
    } catch (err) {
      setStatus(`${this.label}: ${err.message}`, true);
      console.error(err);
    }
    this.render();
  }

  /**
   * ドロップ・選択されたファイルを処理する:
   * VMU イメージ (128KB、または 128KB を連結した複数ページ) は開く。
   * .vmi は同時に渡された .vms と組にして取り込む。それ以外 (.dci / .vms など) は取り込む
   */
  async loadFiles(files) {
    const items = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: await readBytes(f) })));
    const image = items.length === 1 && items[0].bytes.length % IMAGE_SIZE === 0 && items[0].bytes.length > 0
      && !/\.(vms|dci|vmi)$/i.test(items[0].name);
    if (image) {
      this.openImageBytes(items[0].bytes, items[0].name);
      return;
    }
    if (!this.vmu) throw new Error('先にVMUイメージを開くか新規作成してください');
    const used = new Set();
    for (const vmi of items.filter((x) => /\.vmi$/i.test(x.name))) {
      const info = parseVmi(vmi.bytes);
      const base = vmi.name.replace(/\.vmi$/i, '').toLowerCase();
      const vms = items.find((x) => /\.vms$/i.test(x.name)
        && [info.resourceName.toLowerCase(), base].includes(x.name.replace(/\.vms$/i, '').toLowerCase()));
      if (!vms) throw new Error(`${vmi.name} と対になる ${info.resourceName}.VMS も一緒に選んでください`);
      used.add(vmi).add(vms);
      this.importVmi(info, vms.bytes);
    }
    for (const x of items.filter((i) => !used.has(i))) this.importBytes(x.bytes, x.name);
  }

  /** VMU イメージを開く。複数ページならページを選ぶ */
  openImageBytes(fileBytes, name, page = null, { decoded = false } = {}) {
    const bytes = isDcmName(name) && !decoded ? dcmSwap(fileBytes) : fileBytes; // .dcm は 4 バイトごとに反転して保存されている
    if (bytes.length === IMAGE_SIZE) {
      if (this.loadImage(bytes, name)) this.container = null;
      return;
    }
    const pages = splitPages(bytes);
    if (!pages) throw new Error(`VMU イメージではありません (${bytes.length} バイト)`);
    let n = page;
    if (n === null) {
      const ans = prompt(`${name} は ${pages.length} ページのイメージです。開くページ (0〜${pages.length - 1})`, '0');
      if (ans === null) return;
      n = Number(ans);
    }
    if (!Number.isInteger(n) || n < 0 || n >= pages.length) throw new Error(`ページは 0〜${pages.length - 1} で指定してください`);
    if (this.loadImage(pages[n], `${name}#${n}`)) this.container = { name, bytes: Uint8Array.from(bytes), page: n, count: pages.length };
  }

  /** 複数ページのイメージで別のページへ切り替える (今のページの編集は保持) */
  switchPage(n) {
    const c = this.container;
    c.bytes = replacePage(c.bytes, c.page, this.vmu.toBytes());
    const wasDirty = this.dirty;
    this.dirty = false;
    this.openImageBytes(c.bytes, c.name, n, { decoded: true });
    this.dirty = wasDirty;
  }

  importVmi(info, data) {
    const name = info.fileName;
    const exists = !!this.vmu.find(name);
    if (exists && !confirm(`${name} は既に存在します。上書きしますか？`)) return;
    this.vmu.writeFile(name, data, {
      type: info.type, copyProtected: info.copyProtected, headerOffset: info.type === FILE_GAME ? 1 : 0,
      date: info.date ?? new Date(), overwrite: exists,
    });
    this.selected = name;
    this.dirty = true;
    setStatus(`${name} (${info.description}) を取り込みました${info.checksumOk ? '' : ' — 警告: VMI のチェックサム不一致'}`, !info.checksumOk);
  }

  loadImage(bytes, name, { snapshot = true } = {}) {
    if ((this.dirty || this.hex.dirty) && !confirm(`${this.label} の未保存の変更を破棄しますか？`)) return false;
    this.vmu = new Vmu(bytes);
    this.fileName = name;
    this.selected = null;
    this.dirty = false;
    // 以前の DC_VMU が作ったイメージはルートの位置 (0x44) が 0 で、VMU 本体の BIOS が「システムガ コワレテイマス」と表示する
    if (this.vmu.root.formatted && this.vmu.root.rootBlock !== 255 && confirm(`${name} はルートブロックの「ルートの位置」が 255 ではありません (VMU 本体ではファイル画面が壊れていると表示されます)。直しますか？`)) {
      this.vmu.fixRoot();
      this.dirty = true;
    }
    const problems = this.vmu.check();
    setStatus(problems.length ? `${name}: 警告 ${problems.join(' / ')}` : `${name} を読み込みました${this.dirty ? ' (ルートの位置を修正、未保存)' : ''}`, problems.length > 0);
    if (snapshot) addSnapshot(name, this.vmu.toBytes(), '読み込み');
    return true;
  }

  importBytes(bytes, fileName) {
    let name;
    let opts = {};
    let data = bytes;
    if (/\.dci$/i.test(fileName)) {
      const d = fromDci(bytes);
      ({ name, data } = d);
      opts = { type: d.type, copyProtected: d.copyProtected, headerOffset: d.headerOffset, timestamp: d.timestamp };
    } else {
      name = prompt('VMU上のファイル名 (12文字以内の英数字)', fileName.replace(/\.[^.]*$/, '').toUpperCase().slice(0, 12));
      if (!name) return;
      // 先頭にヘッダが無く 0x200 にある .vms はミニゲーム (割り込みベクタの後ろにヘッダ)
      if (!parseHeader(bytes, 0)?.valid && parseHeader(bytes, BLOCK_SIZE)?.valid && confirm(`${fileName} はミニゲームのようです。ミニゲーム (GAME) として追加しますか？`)) {
        opts = { type: FILE_GAME, headerOffset: 1 };
      }
    }
    const exists = !!this.vmu.find(name);
    if (exists && !confirm(`${name} は既に存在します。上書きしますか？`)) return;
    this.vmu.writeFile(name, data, { ...opts, overwrite: exists });
    this.selected = name;
    this.dirty = true;
    setStatus(`${name} を追加しました`);
  }

  entry() {
    return this.selected && this.vmu?.find(this.selected);
  }

  async act_open() {
    const file = await pickFile('.bin,.vmu,.vmm,.dcm,*');
    if (file) this.openImageBytes(await readBytes(file), file.name);
  }

  act_new() {
    if (this.loadImage(Vmu.format().toBytes(), `new_vmu_${this.label}.bin`)) this.container = null;
  }

  act_save() {
    const bytes = this.vmu.toBytes();
    if (this.container) {
      // 複数ページ: 今のページを書き戻した全体を保存
      this.container.bytes = replacePage(this.container.bytes, this.container.page, bytes);
      download(isDcmName(this.container.name) ? dcmSwap(this.container.bytes) : this.container.bytes, this.container.name);
    } else {
      download(isDcmName(this.fileName) ? dcmSwap(bytes) : bytes, this.fileName || 'vmu.bin');
    }
    addSnapshot(this.fileName || 'vmu.bin', bytes, '保存');
    this.dirty = false;
    setStatus(`${this.fileName} を保存しました (履歴にも残しました)`);
  }

  async act_snapshot() {
    const note = prompt('スナップショットのメモ (任意)', '手動') ?? null;
    if (note === null) return;
    const added = await addSnapshot(this.fileName || 'vmu.bin', this.vmu.toBytes(), note || '手動');
    setStatus(added ? '現在の状態を履歴に残しました' : '直前の履歴と同じ内容なので残しませんでした');
  }

  /** 履歴の一覧ダイアログ */
  async act_history() {
    const name = this.fileName || 'vmu.bin';
    const list = await listSnapshots(name);
    const dlg = document.createElement('dialog');
    dlg.className = 'history';
    const closeDlg = () => {
      dlg.close();
      dlg.remove();
    };
    const rows = list.map((v) => {
      const tr = document.createElement('tr');
      const td = (t) => Object.assign(document.createElement('td'), { textContent: t });
      const btn = (text, fn) => {
        const b = Object.assign(document.createElement('button'), { textContent: text, type: 'button' });
        b.addEventListener('click', () => this.run(async () => { await fn(); }));
        return b;
      };
      const actions = document.createElement('td');
      actions.append(
        btn('開く', async () => {
          const snap = await getSnapshot(v.id);
          if (this.loadImage(snap.bytes, name, { snapshot: false })) {
            setStatus(`履歴の版 (${new Date(v.time).toLocaleString('ja-JP')}) を開きました。保存すると現在の状態になります`);
            closeDlg();
          }
        }),
        btn(`${this.other.label} に開いて比較`, async () => {
          const snap = await getSnapshot(v.id);
          if (this.other.loadImage(snap.bytes, `${name} (履歴 ${new Date(v.time).toLocaleString('ja-JP')})`, { snapshot: false })) {
            this.other.render();
            closeDlg();
          }
        }),
        btn('削除', async () => {
          if (!confirm('この履歴を削除しますか？')) return;
          await deleteSnapshot(v.id);
          tr.remove();
        }),
      );
      tr.append(td(new Date(v.time).toLocaleString('ja-JP')), td(v.note), actions);
      return tr;
    });
    const close = Object.assign(document.createElement('button'), { textContent: '閉じる', type: 'button' });
    close.addEventListener('click', closeDlg);
    const table = document.createElement('table');
    table.append(...rows);
    dlg.append(
      Object.assign(document.createElement('h2'), { textContent: `履歴: ${name}` }),
      list.length ? table : Object.assign(document.createElement('p'), { textContent: '履歴はありません (読み込み・保存のたびにブラウザ内に残ります)' }),
      close,
    );
    dlg.addEventListener('close', () => dlg.remove()); // Esc で閉じた場合
    document.body.append(dlg);
    dlg.showModal();
  }

  async act_import() {
    const files = await pickFiles('.dci,.vms,.vmi,.bin,*');
    if (files.length) await this.loadFiles(files);
  }

  act_export_vmi() {
    const e = this.entry();
    const data = this.vmu.readFile(e);
    const resourceName = (prompt('VMS のファイル名 (拡張子なし、8 文字まで)', e.name.slice(0, 8)) ?? '').toUpperCase().slice(0, 8);
    if (!resourceName) return;
    download(buildVmi(e, data, { resourceName }), `${resourceName}.VMI`);
    download(data, `${resourceName}.VMS`);
    setStatus(`${resourceName}.VMI と ${resourceName}.VMS を書き出しました`);
  }

  act_export() {
    const e = this.entry();
    download(this.vmu.readFile(e), `${e.name}.vms`);
  }

  act_export_dci() {
    const e = this.entry();
    download(toDci(e, this.vmu.readFile(e)), `${e.name}.dci`);
  }

  act_copy() {
    const e = this.entry();
    const dst = this.other;
    if (!dst?.vmu) throw new Error('コピー先のVMUを開くか新規作成してください');
    if (e.copyProtected && !confirm(`${e.name} はコピー禁止ファイルです。コピーしますか？`)) return;
    const overwrite = dst.vmu.find(e.name) && confirm(`コピー先に ${e.name} があります。上書きしますか？`);
    if (dst.vmu.find(e.name) && !overwrite) return;
    // 日時は BCD のまま写す (再エンコードで値が変わらないように)。容量不足なら上書き先は消えない
    dst.vmu.writeFile(e.name, this.vmu.readFile(e), {
      type: e.type, copyProtected: e.copyProtected, headerOffset: e.headerOffset,
      timestamp: e.raw.subarray(16, 24), overwrite: true,
    });
    dst.dirty = true;
    dst.selected = e.name;
    dst.render();
    setStatus(`${e.name} を ${dst.label} へコピーしました`);
  }

  act_delete() {
    const e = this.entry();
    if (!confirm(`${e.name} を削除しますか？`)) return;
    this.vmu.deleteFile(e);
    this.selected = null;
    this.dirty = true;
    setStatus(`${e.name} を削除しました`);
  }

  moveBy(delta) {
    const names = this.vmu.list().map((f) => f.name);
    const i = names.indexOf(this.selected);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= names.length) return;
    [names[i], names[j]] = [names[j], names[i]];
    this.vmu.reorder(names);
    this.dirty = true;
    setStatus(`${this.selected} を${delta < 0 ? '上' : '下'}へ移動しました (BIOS のファイル画面の並び)`);
  }

  act_move_up() {
    this.moveBy(-1);
  }

  act_move_down() {
    this.moveBy(1);
  }

  act_defrag() {
    const frag = this.vmu.fragmented().map((f) => f.name);
    if (!frag.length) {
      setStatus('断片化したファイルはありません');
      return;
    }
    if (!this.confirmHexDiscard()) return;
    this.vmu.defragment();
    this.dirty = true;
    setStatus(`詰め直しました: ${frag.join(', ')}`);
  }

  act_run_game() {
    const game = this.vmu.list().find((f) => f.type === FILE_GAME);
    if (!game) setStatus('ミニゲーム (GAME) がありません。BIOS を指定すれば BIOS から起動できます');
    else if (game.firstBlock !== 0) setStatus(`${game.name} がブロック 0 から始まっていません (VMU では起動できない配置です)`);
    openEmulator({
      flash: this.vmu.toBytes(),
      title: game ? `${game.name} ${parseHeader(this.vmu.readFile(game), headerPosition(game))?.description ?? ''}` : this.fileName,
      // ゲームのセーブを書き戻す (反映前の状態はブラウザ内の履歴に残す)
      onWriteBack: (bytes) => this.run(() => {
        if (!this.confirmHexDiscard()) return;
        addSnapshot(this.fileName, this.vmu.toBytes(), 'エミュレーターのセーブを反映する前');
        this.vmu = new Vmu(bytes);
        this.dirty = true;
        setStatus(`エミュレーターのセーブを ${this.fileName} に反映しました (未保存)`);
      }),
    });
  }

  render() {
    const has = !!this.vmu;
    const e = has ? this.entry() : null;
    this.$('.filename').textContent = has ? `${this.fileName}${this.dirty ? ' *' : ''}` : '(未読込)';
    this.renderPageSelect();
    this.$('.free').textContent = has ? `空き ${this.vmu.freeBlocks().length} / ${this.vmu.root.userBlocks}` : '';
    const files = has ? this.vmu.list() : [];
    const idx = e ? files.findIndex((f) => f.name === e.name) : -1;
    const enable = {
      save: has, import: has, export: !!e, 'export-dci': !!e, 'export-vmi': !!e, copy: !!e && !!this.other?.vmu, delete: !!e,
      snapshot: has, history: has, 'move-up': idx > 0, 'move-down': idx >= 0 && idx < files.length - 1, defrag: has, 'run-game': has,
    };
    for (const [act, on] of Object.entries(enable)) this.$(`[data-act="${act}"]`).disabled = !on;
    this.$('.copy').textContent = this.label === 'A' ? 'コピー → B' : '← コピー A';

    // ブロックマップ
    const cells = this.$('.blockmap').children;
    const hl = new Set(e ? this.vmu.chainSafe(e.firstBlock) : []);
    const free = new Set(has ? this.vmu.freeBlocks() : []);
    [...cells].forEach((c, b) => {
      c.className = has && !free.has(b) ? 'used' : '';
      if (hl.has(b)) c.classList.add('hl');
    });

    // ファイル一覧
    const tbody = this.$('tbody');
    tbody.replaceChildren();
    for (const f of has ? this.vmu.list() : []) {
      const data = this.vmu.tryReadFile(f); // 壊れたファイルでも一覧に出し、削除できるようにする
      const h = data && parseHeader(data, headerPosition(f));
      const tr = document.createElement('tr');
      tr.dataset.name = f.name;
      tr.classList.toggle('selected', f.name === this.selected);
      const td = (text, cls = '') => Object.assign(document.createElement('td'), { textContent: text, className: cls });
      const iconTd = document.createElement('td');
      if (data) iconTd.append(iconCanvas(data, h, 'icon', `${this.label}:${f.name}`));
      tr.classList.toggle('broken', !data);
      tr.append(iconTd, td(f.name, 'name'), td(!data ? '(壊れている)' : h?.valid ? h.description : '(ヘッダ無し)'),
        td(`${f.sizeBlocks}${f.type === FILE_GAME ? ' GAME' : ''}`), td(fmtDate(f.timestamp)));
      tbody.append(tr);
    }

    this.syncHex(e);

    // 詳細
    const detail = this.$('.detail');
    detail.replaceChildren();
    if (!e) return;
    const data = this.vmu.tryReadFile(e);
    const h = data && parseHeader(data, headerPosition(e));
    const dl = document.createElement('dl');
    const row = (k, v, cls = '') => {
      dl.append(Object.assign(document.createElement('dt'), { textContent: k }),
        Object.assign(document.createElement('dd'), { textContent: v, className: cls }));
    };
    const t = lookupTitle(e, data, titlesDb);
    if (t.title) {
      dl.append(Object.assign(document.createElement('dt'), { textContent: 'タイトル' }),
        Object.assign(document.createElement('dd'), { textContent: `${t.title}${t.detail ? ` — ${t.detail}` : ''}`, title: `根拠: ${t.source}` }));
    }
    row('種類', e.type === FILE_GAME ? 'ミニゲーム' : 'データ');
    row('コピー', e.copyProtected ? '禁止' : '可');
    row('サイズ', `${e.sizeBlocks} ブロック (${e.sizeBlocks * BLOCK_SIZE} バイト)`);
    row('ブロック', this.vmu.chainSafe(e.firstBlock).join(', '));
    if (!data) {
      row('状態', `壊れている: ${this.vmu.check().filter((p) => p.startsWith(`${e.name}:`)).join(' / ') || 'FAT チェーンを読めません'} (削除はできます)`, 'crc-ng');
    }
    if (h?.valid) {
      row('説明 (VMU)', h.description);
      row('説明 (DC)', h.longDescription);
      row('作成アプリ', h.appId);
      row('アイコン', `${h.iconCount} 枚 / 速度 ${h.animSpeed}`);
      row('データ長', `${h.dataSize} バイト`);
      const s = crcStatus(data, e);
      row('CRC', {
        ok: `${s.stored?.toString(16)} (一致)`,
        ng: `${s.stored?.toString(16)} (計算値 ${s.actual?.toString(16)} — 不一致)`,
        broken: 'データ長がファイルを超えています',
      }[s.status], s.status === 'ok' ? '' : 'crc-ng');
      detail.append(iconCanvas(data, h, 'big', `${this.label}:${e.name}:big`));
      const edit = Object.assign(document.createElement('button'), { textContent: 'アイコン・説明を編集', type: 'button', className: 'ie-open' });
      edit.addEventListener('click', () => this.run(() => {
        if (!this.confirmHexDiscard()) return;
        openIconEditor({ entry: e, data, onApply: (file) => this.run(() => this.applyFile(file)) });
      }));
      detail.append(edit);
    }
    detail.prepend(dl);
  }

  /** 複数ページのイメージならページの選択欄を出す */
  renderPageSelect() {
    let sel = this.$('.pagesel-pane');
    if (!this.container) {
      sel?.remove();
      return;
    }
    if (!sel) {
      sel = Object.assign(document.createElement('select'), { className: 'pagesel-pane', title: 'ページ (128KB ごと)' });
      sel.addEventListener('change', () => this.run(() => this.switchPage(Number(sel.value))));
      this.$('.filename').after(sel);
    }
    sel.replaceChildren(...Array.from({ length: this.container.count }, (_, i) => Object.assign(document.createElement('option'), {
      value: i, textContent: `ページ ${i}`, selected: i === this.container.page,
    })));
  }

  /** HEXエディタを選択中ファイルに合わせる (未適用の編集中は維持) */
  syncHex(e) {
    if (!e) {
      this.hex.clear();
      this.hexVmu = null;
      return;
    }
    const data = this.vmu.tryReadFile(e);
    if (!data) {
      this.hex.clear();
      this.hexVmu = null;
      return;
    }
    const sameFile = this.hex.entry?.name === e.name && this.hexVmu === this.vmu;
    // 未適用の編集は、元にしたファイルの中身が変わっていない場合だけ残す (上書き追加・コピーで差し替わったら読み直す)
    const unchanged = sameFile && data.length === this.hex.original.length && data.every((b, i) => b === this.hex.original[i]);
    if (this.hex.dirty && unchanged) return;
    if (this.hex.dirty && sameFile) setStatus(`${e.name} の中身が変わったため、未適用の HEX 編集を破棄しました`, true);
    this.hex.load(e, data);
    this.hexVmu = this.vmu;
  }

  applyHex(data, fixCrc) {
    const e = this.entry();
    const { crc } = applyEdit(this.vmu, e, data, { fixCrc });
    this.dirty = true;
    this.hex.load(e, this.vmu.readFile(e));
    setStatus(`${e.name} に変更を適用しました${crc !== null ? ` (CRC → ${crc.toString(16).padStart(4, '0')})` : ''}。保存でイメージに書き出されます`);
  }

  /** 構造定義 (コンテナ形式) で書き換えたファイル全体を適用 */
  applyFile(data) {
    const e = this.entry();
    const { resized, entry: after } = applyEdit(this.vmu, e, data);
    this.dirty = true;
    this.hex.load(after, this.vmu.readFile(after));
    setStatus(`${e.name} に変更を適用しました${resized ? ` (サイズ ${e.sizeBlocks} → ${after.sizeBlocks} ブロック)` : ''}。保存でイメージに書き出されます`);
  }

  /** ブラウザ内の履歴 (スナップショット) から、選択中ファイルのバイトごとの変化回数を求めて HEX に色で出す */
  async showHeat() {
    const e = this.entry();
    const versions = [];
    for (const v of (await listSnapshots(this.fileName || 'vmu.bin')).reverse()) { // 古い順
      try {
        const snap = await getSnapshot(v.id);
        const img = new Vmu(snap.bytes);
        const f = img.find(e.name);
        const data = f && img.tryReadFile(f);
        if (data) versions.push(data);
      } catch { /* 読めない版は飛ばす */ }
    }
    versions.push(this.vmu.readFile(e));
    if (versions.length < 2) {
      setStatus('比べる履歴がありません (「記録」や保存で履歴を増やしてから使います)', true);
      return;
    }
    const { changes, compared } = byteVariability(versions);
    const count = changes.filter((c) => c > 0).length;
    this.hex.setHeat({ changes, compared, note: `履歴 ${versions.length} 版で比較: ${count} バイトが変化` });
    setStatus(`${e.name}: 履歴 ${versions.length} 版を比べ、変化したバイトを色で表示しました (濃いほどよく変わる)`);
  }

  /** 未適用のHEX編集があれば破棄してよいか確認 */
  confirmHexDiscard() {
    return !this.hex.dirty || confirm(`${this.hex.entry.name} の未適用の変更を破棄しますか？`);
  }
}

for (const label of ['A', 'B']) {
  const p = new Pane(label);
  panes.push(p);
  document.getElementById('panes').append(p.el);
}
panes.forEach((p) => p.render());
loadBuiltinDefs();
window.addEventListener('beforeunload', (ev) => {
  if (panes.some((p) => p.dirty || p.hex.dirty)) ev.preventDefault();
});
setStatus('VMUイメージ (.bin, Flycast の vmu_save_A1.bin 等) を開いてください');
