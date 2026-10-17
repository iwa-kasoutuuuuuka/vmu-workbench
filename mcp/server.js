#!/usr/bin/env node
// DC_VMU MCP サーバー: Claude Code / Antigravity などの AI エージェントから
// VMU イメージとセーブデータを解析・改造・エミュレーター検証するためのツールを提供する。
// 依存パッケージ無し (MCP の stdio トランスポート = 1 行 1 JSON-RPC メッセージ)。
//
//   node mcp/server.js        (エージェントが起動する。手で動かすものではない)
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Vmu, FILE_GAME, IMAGE_SIZE } from '../src/vmu.js';
import { splitPages, dcmSwap, isDcmName } from '../src/formats.js';
import { readIcons, editVms, rgbaToIcons, iconsToStrip } from '../src/vmsedit.js';
import { encodePng, decodePng } from '../src/png-node.js';
import { parseHeader, headerPosition } from '../src/vms.js';
import { crcStatus, applyEdit, parseHexBytes } from '../src/edit.js';
import {
  validateDef, findDefs, openView, resolveViewFields, readField, formatField, setFields, groupFields,
  checksumStatus, applyChecksums,
} from '../src/structdef.js';
import { loadDefs, DEFS_DIR } from '../src/defs-node.js';
import { listHistory, resolveImageSpec } from '../src/history-node.js';
import { lookupTitle } from '../src/titles.js';
import { flashFrom, parseKeys, runScript, lcdText, lcdRgba, biosAutoStart, flashChanges, recordAudio, audioNotes, VmuEmulator } from '../src/vmugame.js';
import { looksLikeBios } from '../src/vmuemu.js';
import { loadTitles } from '../src/titles-node.js';
import {
  correlateValues, findText, scanStrings, scanRuns, guessRecords, hexDump, labeledDiff, uncoveredRanges, byteVariability, hotRanges,
} from '../src/analyze.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = join(ROOT, '.emu', 'work');
const VERSION = '0.1.0';
const hex = (n, w = 4) => `0x${n.toString(16).padStart(w, '0')}`;
const bytesHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

// ---- パスと読み込み ----

const absPath = (p) => (isAbsolute(p) ? resolve(p) : resolve(ROOT, p));

const PROTECTED_DIRS = ['src', 'mcp', 'defs', 'test', 'scripts', 'emu', 'node_modules', '.claude', '.agent', '.git'];

/**
 * 書き込み先の制限 (D:\DC やソースを誤って書き換えないため):
 * DC_VMU フォルダ内の .bin のみ。コード・定義のフォルダと、入力に使ったイメージは不可
 */
function outPath(p, fallbackName, inputs = []) {
  const target = absPath(p ?? join(WORK, fallbackName));
  const rel = relative(ROOT, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`書き込み先は DC_VMU フォルダ内にしてください: ${target}`);
  if (!/\.bin$/i.test(target)) throw new Error(`書き込み先は .bin ファイルにしてください: ${rel}`);
  const top = rel.split(/[\\/]/)[0].toLowerCase();
  if (PROTECTED_DIRS.includes(top)) throw new Error(`${top}/ には書き込めません (.emu/work/ などを使ってください)`);
  if (inputs.some((i) => i && absPath(i).toLowerCase() === target.toLowerCase())) {
    throw new Error('入力のイメージは上書きできません (out に別のパスを指定してください)');
  }
  mkdirSync(dirname(target), { recursive: true });
  return target;
}

/** "path@番号" (CLI が残した履歴の版) と "path#ページ" (128KB を連結した複数ページのファイル) も読める */
function loadImage(path) {
  const m = /^(.*)#(\d+)$/.exec(path);
  const file = m && !existsSync(absPath(path)) ? m[1] : path;
  const rawBytes = readFileSync(resolveImageSpec(absPath(file)));
  const bytes = isDcmName(file.replace(/@\d+$/, '')) ? dcmSwap(rawBytes) : rawBytes; // Nexus の .dcm
  if (bytes.length === IMAGE_SIZE) return new Vmu(bytes);
  const pages = splitPages(bytes);
  if (!pages) return new Vmu(bytes); // サイズ違いのエラー
  if (!m) throw new Error(`${pages.length} ページのイメージです。"${path}#0" のようにページを指定してください`);
  const page = pages[Number(m[2])];
  if (!page) throw new Error(`ページは 0〜${pages.length - 1} です`);
  return new Vmu(page);
}

function pickDef(entry, data, defArg) {
  if (defArg && typeof defArg === 'object') return defArg;
  const { defs } = loadDefs();
  if (typeof defArg === 'string') {
    const byId = defs.find((d) => d.id === defArg);
    if (byId) return byId;
    if (existsSync(absPath(defArg))) return JSON.parse(readFileSync(absPath(defArg), 'utf8'));
    throw new Error(`定義が見つかりません: ${defArg}`);
  }
  return findDefs(defs, entry, data)[0] ?? null;
}

/**
 * セーブを開く。定義が一致すればコンテナを展開したビュー、無ければファイルそのもの
 * @returns {{vmu, entry, data, def, view, fields, sums}}
 */
function openSave({ image, file, def: defArg, raw = false }) {
  const vmu = loadImage(image);
  const entry = vmu.find(file);
  if (!entry) throw new Error(`ファイルがありません: ${file} (vmu_list で確認)`);
  const data = vmu.readFile(entry);
  const def = raw ? null : pickDef(entry, data, defArg);
  const view = def ? openView(def, entry, data) : null;
  if (def && !view) throw new Error(`定義 ${def.id} でコンテナ/セーブを開けません`);
  const v = view ?? { bytes: data, base: 0, container: null, label: 'ファイルそのもの (定義なし)', pack: (b) => b };
  return {
    vmu, entry, data, def, view: v,
    fields: def ? resolveViewFields(def, v) : [],
    sums: def ? checksumStatus(def, v.bytes, v.base) : [],
  };
}

function writeImage(vmu, path) {
  writeFileSync(path, vmu.toBytes());
  return relative(ROOT, path);
}

/** ビューのバイト列を VMU に戻して保存 (チェックサム・CRC 更新) */
function commitView(s, bytes, { out, fixChecksums = true, fallbackName, image }) {
  const path = outPath(out, fallbackName, [image]);
  if (fixChecksums && s.def) applyChecksums(s.def, bytes, s.view.base);
  const { crc, resized } = applyEdit(s.vmu, s.entry, s.view.pack(bytes));
  return { out: writeImage(s.vmu, path), crc, resized };
}

const checksumsText = (sums) => sums.map((c) => (c.inRange
  ? `${c.name}: 格納 ${hex(c.stored)} / 計算 ${hex(c.actual)} ${c.ok ? '一致' : '不一致'}`
  : `${c.name}: 範囲外`));

// ---- ツール ----

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const IMG = str('VMU イメージ (128KB .bin) のパス。相対パスは DC_VMU フォルダ基準。"パス@番号" で CLI の履歴の版、"パス#n" で複数ページのファイルのページ');
const FILE = str('VMU 上のファイル名 (例 BLEEMMC, SONIC2___S01)');
const DEF = str('構造定義の id (defs/) または JSON ファイルのパス。省略時は一致する定義を自動選択');
const OUT = str('書き込み先 (DC_VMU フォルダ内)。省略時は .emu/work/ に作る。入力イメージは上書きしない');

const tools = {
  vmu_list: {
    description: 'VMU イメージのファイル一覧 (名前・種類・ブロック数・VMS ヘッダの説明・CRC 状態・一致する構造定義)。',
    inputSchema: S({ image: IMG }, ['image']),
    run({ image }) {
      const vmu = loadImage(image);
      const { defs } = loadDefs();
      const titles = loadTitles();
      const files = vmu.list().map((e) => {
        const data = vmu.tryReadFile(e);
        if (!data) return { name: e.name, type: e.type === FILE_GAME ? 'game' : 'data', blocks: e.sizeBlocks, broken: true };
        const h = parseHeader(data, headerPosition(e));
        return {
          name: e.name, type: e.type === FILE_GAME ? 'game' : 'data', blocks: e.sizeBlocks,
          copyProtected: e.copyProtected, timestamp: e.timestamp?.toISOString() ?? null,
          description: h?.valid ? h.description : null, appId: h?.valid ? h.appId : null,
          crc: crcStatus(data, e).status, defs: findDefs(defs, e, data).map((d) => d.id),
          title: (({ title, source, detail }) => ({ title, source, detail }))(lookupTitle(e, data, titles)),
        };
      });
      return { freeBlocks: vmu.freeBlocks().length, problems: vmu.check(), files };
    },
  },

  vmu_defs: {
    description: 'defs/ の構造定義の一覧 (id・タイトル・一致条件・コンテナ・項目数) と検証エラー。',
    inputSchema: S({}),
    run() {
      const { defs, errors } = loadDefs();
      return {
        defsDir: relative(ROOT, DEFS_DIR),
        defs: defs.map((d) => ({ id: d.id, title: d.title, match: d.match, container: d.container ?? null, fields: d.fields.length, checksums: (d.checksums ?? []).length, source: d.source })),
        errors,
      };
    },
  },

  vmu_fields: {
    description: '構造定義で名前付きフィールドの値を読む (コンテナは展開済み)。チェックサムの状態と、定義で覆われていない未解析範囲も返す。',
    inputSchema: S({ image: IMG, file: FILE, def: DEF }, ['image', 'file']),
    run(args) {
      const s = openSave(args);
      if (!s.def) throw new Error('一致する構造定義がありません。vmu_scan / vmu_dump で調べ、vmu_def_save で定義を作ってください');
      return {
        def: s.def.id, base: s.view.label,
        groups: groupFields(s.fields).map((g) => ({
          group: g.group,
          fields: g.fields.map((f) => ({ name: f.name, offset: hex(f.offset), type: f.type, value: formatField(f, readField(s.view.bytes, f)), note: f.note })),
        })),
        checksums: checksumsText(s.sums),
        uncovered: uncoveredRanges(s.view.bytes.length, s.fields, s.sums, 4).map((r) => `${hex(r.start)}-${hex(r.end)}`),
      };
    },
  },

  vmu_dump: {
    description: 'セーブ (定義があればコンテナ展開後) の 16 進ダンプ。offset/length はビュー先頭からのバイト位置。',
    inputSchema: S({ image: IMG, file: FILE, offset: num('開始位置 (既定 0)'), length: num('バイト数 (既定 256, 最大 4096)'), def: DEF, raw: { type: 'boolean', description: 'true で定義を使わずファイルの生データ' } }, ['image', 'file']),
    run(args) {
      const s = openSave(args);
      const offset = args.offset ?? 0;
      const length = Math.min(args.length ?? 256, 4096);
      return `${s.view.label} (全 ${s.view.bytes.length} バイト)\n${hexDump(s.view.bytes, offset, length)}`;
    },
  },

  vmu_diff: {
    description: '2 つの VMU イメージで同名ファイルの差分。定義があればコンテナを展開して比べ、差分位置にフィールド名を付ける。ゲームで状態を変えた前後のセーブを比べて値の位置を探すのに使う。',
    inputSchema: S({ a: IMG, b: IMG, file: FILE, def: DEF, raw: { type: 'boolean' } }, ['a', 'b', 'file']),
    run({ a, b, file, def, raw }) {
      const sa = openSave({ image: a, file, def, raw });
      const sb = openSave({ image: b, file, def: sa.def ?? undefined, raw: raw || !sa.def });
      const diffs = labeledDiff(sa.view.bytes, sb.view.bytes, sa.fields, sa.sums);
      return {
        base: sa.view.label, count: diffs.length,
        diffs: diffs.slice(0, 200).map((d) => ({ offset: hex(d.offset), length: d.after.length, before: bytesHex(d.before.subarray(0, 32)), after: bytesHex(d.after.subarray(0, 32)), labels: d.labels })),
        truncated: diffs.length > 200,
      };
    },
  },

  vmu_find: {
    description: '既知の値の位置を探す。images と values を同じ数だけ渡すと、各セーブの同じ位置にそれぞれの値が入っている箇所だけを返す (例: スコア 1200 のセーブと 3400 のセーブ)。text を渡すと ASCII 文字列を探す。',
    inputSchema: S({
      images: { type: 'array', items: { type: 'string' }, description: 'VMU イメージのパス (1 つ以上)' },
      file: FILE, values: { type: 'array', items: { type: 'number' }, description: 'images と同じ順の値' },
      text: str('探す ASCII 文字列 (values の代わり)'), def: DEF,
      types: { type: 'array', items: { type: 'string' }, description: '探す型 (既定 u8,u16le,u16be,u32le,u32be)' },
    }, ['images', 'file']),
    run({ images, file, values, text, def, types }) {
      const saves = images.map((image) => openSave({ image, file, def }));
      if (text) return { base: saves[0].view.label, offsets: findText(saves[0].view.bytes, text).map((o) => hex(o)) };
      if (!values) throw new Error('values か text を指定してください');
      const hits = correlateValues(saves.map((s) => s.view.bytes), values, types);
      const label = (o) => saves[0].fields.filter((f) => f.offset <= o && o < f.offset + f.size).map((f) => f.name);
      return { base: saves[0].view.label, count: hits.length, hits: hits.slice(0, 100).map((h) => ({ offset: hex(h.offset), type: h.type, labels: label(h.offset) })) };
    },
  },

  vmu_scan: {
    description: 'セーブの構造の手がかりを自動で探す: ASCII 文字列、同じ値が続く領域、繰り返しレコード (周期と件数) の候補、定義で未解析の範囲。',
    inputSchema: S({ image: IMG, file: FILE, def: DEF, from: num('調べる開始位置 (既定 0)') }, ['image', 'file']),
    run(args) {
      const s = openSave(args);
      const from = args.from ?? 0;
      const sub = s.view.bytes.subarray(from);
      const shift = (o) => hex(o + from);
      return {
        base: s.view.label, length: s.view.bytes.length,
        strings: scanStrings(sub, 3).slice(0, 80).map((x) => ({ offset: shift(x.offset), text: x.text })),
        runs: scanRuns(sub, 16).slice(0, 40).map((r) => ({ offset: shift(r.offset), length: r.length, value: hex(r.value, 2) })),
        records: guessRecords(sub).map((r) => ({ first: shift(r.first), stride: r.stride, count: r.count, sample: r.sample })),
        uncovered: s.def ? uncoveredRanges(s.view.bytes.length, s.fields, s.sums, 4).map((r) => `${hex(r.start)}-${hex(r.end)}`) : null,
      };
    },
  },

  vmu_set: {
    description: '構造定義のフィールドに値を書き込んだ新しい VMU イメージを作る (チェックサム・CRC 自動更新、コンテナは再格納)。',
    inputSchema: S({
      image: IMG, file: FILE, def: DEF, out: OUT,
      assignments: { type: 'object', description: '{ "フィールド名": 値 } 配列要素は "名前[2]"、enum は表示名でも可', additionalProperties: true },
      fixChecksums: { type: 'boolean', description: 'false でチェックサムを更新しない (対照実験用)' },
    }, ['image', 'file', 'assignments']),
    run({ image, file, def, out, assignments, fixChecksums = true }) {
      const s = openSave({ image, file, def });
      if (!s.def) throw new Error('一致する構造定義がありません (vmu_patch ならバイト単位で書き換え可能)');
      const path = outPath(out, `set_${Date.now()}.bin`, [image]);
      const edited = setFields(s.data, s.def, s.entry, assignments, { fixChecksums });
      const { crc, resized } = applyEdit(s.vmu, s.entry, edited);
      return { out: writeImage(s.vmu, path), crc, resized };
    },
  },

  vmu_patch: {
    description: 'セーブ (定義があればコンテナ展開後) のバイトを書き換えた新しい VMU イメージを作る。定義のチェックサムと VMS の CRC を自動更新。',
    inputSchema: S({
      image: IMG, file: FILE, def: DEF, out: OUT, raw: { type: 'boolean' },
      patches: { type: 'array', items: S({ offset: num('ビュー先頭からの位置'), hex: str('書き込むバイト (例 "FF 00")'), fill: str('fill 用の 1 バイト (例 "FF")'), length: num('fill の長さ') }), description: '[{offset, hex}] または [{offset, fill, length}]' },
      fixChecksums: { type: 'boolean' },
    }, ['image', 'file', 'patches']),
    run({ image, file, def, out, raw, patches, fixChecksums = true }) {
      const s = openSave({ image, file, def, raw });
      const bytes = Uint8Array.from(s.view.bytes);
      if (!Array.isArray(patches) || !patches.length) throw new Error('patches を 1 つ以上指定してください');
      for (const p of patches) {
        if (!Number.isInteger(p.offset) || p.offset < 0) throw new Error(`offset は 0 以上の整数で指定してください: ${p.offset}`);
        let data;
        if (p.fill !== undefined) {
          if (!Number.isInteger(p.length) || p.length < 1) throw new Error('fill には length (1 以上の整数) が必要です');
          data = new Uint8Array(p.length).fill(parseHexBytes(p.fill)[0]);
        } else if (typeof p.hex === 'string') {
          data = parseHexBytes(p.hex);
        } else {
          throw new Error('各パッチには hex か fill + length が必要です');
        }
        if (p.offset + data.length > bytes.length) throw new Error(`範囲外: ${hex(p.offset)} + ${data.length} (全 ${bytes.length} バイト)`);
        bytes.set(data, p.offset);
      }
      return commitView(s, bytes, { out, fixChecksums, fallbackName: `patch_${Date.now()}.bin`, image });
    },
  },

  vmu_variants: {
    description: '候補の範囲をそれぞれ書き換えた VMU イメージを一度に作る (フラグ探しの総当たり用)。各候補は patches と同じ形式。作ったイメージを vmu_bleem_run や vmu_emu_verify で試す。',
    inputSchema: S({
      image: IMG, file: FILE, def: DEF, outDir: str('出力フォルダ (DC_VMU フォルダ内、既定 .emu/work/variants)'),
      variants: { type: 'array', items: S({ name: str('候補名 (ファイル名になる)'), patches: { type: 'array', items: { type: 'object' } } }, ['name', 'patches']) },
    }, ['image', 'file', 'variants']),
    run({ image, file, def, outDir, variants }) {
      const dir = outDir ?? join(WORK, 'variants');
      return variants.map((v) => ({
        name: v.name,
        ...tools.vmu_patch.run({ image, file, def, patches: v.patches, out: join(dir, `${v.name}.bin`) }),
      }));
    },
  },

  vmu_heatmap: {
    description: '同じファイルの複数のセーブ (古い順) で、各バイトが何回変わったかを集計し、よく変わる範囲を返す (定義があればコンテナ展開後・フィールド名付き)。ゲームを少しずつ進めながら取ったセーブを渡すと、スコアやカウンタの位置が分かる。',
    inputSchema: S({ images: { type: 'array', items: { type: 'string' }, description: 'VMU イメージ (古い順に 2 つ以上)' }, file: FILE, def: DEF, raw: { type: 'boolean' } }, ['images', 'file']),
    run({ images, file, def, raw }) {
      if (!Array.isArray(images) || images.length < 2) throw new Error('images を 2 つ以上指定してください');
      const saves = images.map((image) => openSave({ image, file, def, raw }));
      const { changes, compared } = byteVariability(saves.map((s) => s.view.bytes));
      const ranges = hotRanges(changes);
      const label = (r) => [...saves[0].fields.filter((f) => f.offset < r.end && f.offset + f.size > r.start).map((f) => f.name),
        ...saves[0].sums.filter((c) => c.inRange && c.at < r.end && c.at + c.size > r.start).map((c) => c.name)];
      return {
        base: saves[0].view.label, compared, count: ranges.length,
        ranges: ranges.slice(0, 60).map((r) => ({ start: hex(r.start), end: hex(r.end - 1), maxChanges: r.max, labels: label(r) })),
      };
    },
  },

  vmu_vms_edit: {
    description: 'VMS ヘッダの説明文 (VMU 用 16 文字 / DC 用 32 文字、半角)、アニメ速度、アイコン (PNG: 高さ 32、幅 32/64/96 = 1〜3 コマ、16 色に減色) を書き換えた新しいイメージを作る (CRC 更新)。exportPng を指定するとアイコンを PNG に書き出すだけ。',
    inputSchema: S({
      image: IMG, file: FILE, out: OUT,
      description: str('VMU 用の説明 (16 文字まで)'), longDescription: str('Dreamcast 用の説明 (32 文字まで)'),
      animSpeed: num('アイコンのアニメ速度'), iconPng: str('アイコンにする PNG のパス'),
      exportPng: str('アイコンを書き出す PNG のパス (DC_VMU フォルダ内)'),
    }, ['image', 'file']),
    run({ image, file, out, description, longDescription, animSpeed, iconPng, exportPng }) {
      const vmu = loadImage(image);
      const entry = vmu.find(file);
      if (!entry) throw new Error(`ファイルがありません: ${file}`);
      const data = vmu.readFile(entry);
      if (exportPng) {
        const target = absPath(exportPng);
        const rel = relative(ROOT, target);
        if (rel.startsWith('..') || isAbsolute(rel) || !/\.png$/i.test(target) || PROTECTED_DIRS.includes(rel.split(/[\\/]/)[0].toLowerCase())) {
          throw new Error('exportPng は DC_VMU フォルダ内 (.emu/work/ など) の .png にしてください');
        }
        const icons = readIcons(data, entry);
        if (!icons) throw new Error('VMS ヘッダ (アイコン) がありません');
        const strip = iconsToStrip(icons);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, encodePng(strip.rgba, strip.width, strip.height));
        return { png: relative(ROOT, target), frames: icons.frames.length, animSpeed: icons.animSpeed };
      }
      const changes = {};
      if (description !== undefined) changes.description = description;
      if (longDescription !== undefined) changes.longDescription = longDescription;
      if (animSpeed !== undefined) changes.animSpeed = animSpeed;
      let exact = true;
      if (iconPng) {
        const img = decodePng(readFileSync(absPath(iconPng)));
        const icons = rgbaToIcons(img.rgba, img.width, img.height);
        Object.assign(changes, { palette: icons.palette, frames: icons.frames });
        exact = icons.exact;
      }
      if (!Object.keys(changes).length) throw new Error('変更内容 (description / longDescription / animSpeed / iconPng) を指定してください');
      const path = outPath(out, `vms_${Date.now()}.bin`, [image]);
      const { resized, entry: after } = applyEdit(vmu, entry, editVms(data, entry, changes), { fixCrc: false });
      return { out: writeImage(vmu, path), resized, blocks: after.sizeBlocks, reducedColors: !exact };
    },
  },

  vmu_history: {
    description: 'CLI がイメージを書き換える前に残した履歴 (版番号・日時・実行したコマンド) の一覧。各ツールの image に "パス@番号" を渡すと過去の版を読める (vmu_diff で版同士を比べるなど)。',
    inputSchema: S({ image: IMG }, ['image']),
    run({ image }) {
      const versions = listHistory(absPath(image));
      return { image, versions: versions.map((v) => ({ spec: `${image}@${v.id}`, time: v.time, note: v.note })) };
    },
  },

  vmu_defrag: {
    description: '断片化したファイルを連続に詰め直した新しい VMU イメージを作る (名前・属性・日時・並びは保つ)。order を渡すとディレクトリの並び (BIOS の表示順) も変える。',
    inputSchema: S({ image: IMG, out: OUT, order: { type: 'array', items: { type: 'string' }, description: '先頭に並べたいファイル名 (省略可)' } }, ['image']),
    run({ image, out, order }) {
      const vmu = loadImage(image);
      const path = outPath(out, `defrag_${Date.now()}.bin`, [image]);
      const fragmented = vmu.fragmented().map((e) => e.name);
      vmu.defragment();
      if (order?.length) vmu.reorder(order);
      return { out: writeImage(vmu, path), fragmented, order: vmu.list().map((e) => e.name) };
    },
  },

  vmu_run_game: {
    description: 'VMU ミニゲームを内蔵の LC86K エミュレーターで動かし、LCD を文字 (# = 点灯) で返す。キー操作を時刻付きで与えられる。BIOS 無しではゲームを直接起動し、ゲームが BIOS を呼んだ時点で止まる (stopReason: bios)。',
    inputSchema: S({
      image: str('128KB の VMU イメージ (ミニゲームはブロック 0 から) か、ミニゲーム単体の .vms のパス'),
      seconds: num('動かす秒数 (既定 2、最大 60)'),
      keys: str('キー操作 "秒:ボタン+ボタン,..." (例 "1:right,1.5:,2:a")。ボタンは up down left right a b mode sleep、空で全部離す'),
      png: str('LCD を保存する .png (DC_VMU フォルダ内、.emu/work/ など。省略可)'),
      bios: str('64KB の生の VMU BIOS ダンプ (省略可。例 .emu/vmu/vmu_bios_jp.bin)'),
      boot: { type: 'boolean', description: 'bios 指定時、時計の設定を済ませて GAME からミニゲームを起動してから keys を実行する (既定 true)' },
      out: str('実行後のフラッシュ (ゲームのセーブを含む VMU イメージ) を保存する .bin (DC_VMU フォルダ内。省略可)'),
      clock: str('boot 時に BIOS の時計を合わせる日時 (例 "2026-10-17T12:00"。既定は今の時刻)'),
    }, ['image']),
    run({ image, seconds = 2, keys, png, bios, boot = true, out, clock }) {
      if (!(seconds > 0 && seconds <= 60)) throw new Error('seconds は 0〜60');
      let rom = null;
      if (bios) {
        rom = readFileSync(absPath(bios));
        if (!looksLikeBios(rom)) throw new Error('BIOS は 64KB の生のダンプを指定してください');
      }
      const raw = readFileSync(resolveImageSpec(absPath(image)));
      const emu = new VmuEmulator({ flash: flashFrom(isDcmName(image.replace(/@\d+$/, '')) ? dcmSwap(raw) : raw), rom });
      const before = Uint8Array.from(emu.flash);
      const when = clock ? new Date(clock) : new Date();
      if (Number.isNaN(when.getTime())) throw new Error(`clock の日時が読めません: ${clock}`);
      const booted = rom && boot ? biosAutoStart(emu, { clock: when }) : null;
      const rec = recordAudio(emu, { seconds, keys: parseKeys(keys) });
      const st = emu.state();
      const lcd = emu.lcd();
      const result = { lcdOn: lcd.on, lcd: lcdText(lcd), icons: lcd.icons, beeperHz: Math.round(emu.beeper()), state: st };
      if (booted !== null) result.biosBoot = booted ? 'ミニゲームを起動' : 'BIOS から起動できなかった';
      result.flashChanges = flashChanges(before, emu.flash, Vmu);
      // 鳴った音 (スピーカー = P1.7 の波形から): 時刻・周波数・長さ・音名
      result.sound = audioNotes(rec).filter((n) => n.hz >= 20 && n.hz <= 20000).slice(0, 50)
        .map((n) => ({ t: +(n.t - rec.start).toFixed(3), hz: +n.hz.toFixed(1), ms: Math.round(n.dur * 1000), note: n.note }));
      if (out) {
        const path = outPath(out, `run_${Date.now()}.bin`, [image]);
        writeFileSync(path, emu.flash);
        result.out = relative(ROOT, path);
      }
      if (png) {
        const target = absPath(png);
        const rel = relative(ROOT, target);
        if (rel.startsWith('..') || isAbsolute(rel) || !/\.png$/i.test(target) || PROTECTED_DIRS.includes(rel.split(/[\\/]/)[0].toLowerCase())) {
          throw new Error('png は DC_VMU フォルダ内 (.emu/work/ など) の .png にしてください');
        }
        const img = lcdRgba(lcd, 4);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, encodePng(img.rgba, img.width, img.height));
        result.png = relative(ROOT, target);
      }
      return result;
    },
  },

  vmu_def_validate: {
    description: '構造定義 (JSON オブジェクト) を検証し、指定イメージがあれば一致判定と値の読み取りも試す。',
    inputSchema: S({ def: { type: 'object', description: '構造定義 (README の形式)' }, image: IMG, file: FILE }, ['def']),
    run({ def, image, file }) {
      const errors = validateDef(def);
      if (errors.length || !image || !file) return { errors };
      const s = openSave({ image, file, def });
      return { errors, base: s.view.label, sample: s.fields.slice(0, 20).map((f) => `${f.name} = ${formatField(f, readField(s.view.bytes, f))}`), checksums: checksumsText(s.sums) };
    },
  },

  vmu_def_save: {
    description: '構造定義を defs/<id>.json に保存する (検証に通ったものだけ)。既存の定義を変える場合は overwrite: true。',
    inputSchema: S({ def: { type: 'object' }, overwrite: { type: 'boolean' } }, ['def']),
    run({ def, overwrite = false }) {
      const errors = validateDef(def);
      if (errors.length) throw new Error(`定義が不正です: ${errors.join(' / ')}`);
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(def.id)) throw new Error('id は英小文字・数字・. _ - のみ');
      const path = join(DEFS_DIR, `${def.id}.json`);
      if (existsSync(path) && !overwrite) throw new Error(`${def.id}.json は既にあります (overwrite: true で上書き)`);
      const { source, ...clean } = def;
      writeFileSync(path, `${JSON.stringify(clean, null, 2)}\n`);
      return { saved: relative(ROOT, path) };
    },
  },

  vmu_emu_verify: {
    description: 'Flycast + KallistiOS 検証 ROM で DC_VMU の VMU 読み書きが Dreamcast と一致するかを検証する (npm run verify:emu, 1〜2 分)。',
    inputSchema: S({}),
    async run() {
      const r = await runProcess('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts', 'emu_verify.ps1')], 300000);
      return { exitCode: r.code, pass: r.code === 0, output: r.output.split('\n').filter((l) => /OK|FAIL|PASS|FREE|PKG/.test(l)).join('\n') };
    },
  },

  vmu_bleem_run: {
    description: 'VMU イメージを bleem2 (Dreamcast 上の PS1 エミュ) + Flycast で起動し、PS1 ゲームの画面を撮る (PS1 セーブ BLEEMMC がゲームに受理されるかの確認用)。keyAt でキー送信 (例 "105:DOWN")。画面ファイルのパスを返すので、画像として開いて確認する。数十秒〜数分かかり、実行中は Flycast のウィンドウが表示される。',
    inputSchema: S({ image: IMG, tag: str('結果フォルダ名 (.emu/out/bleem_<tag>)'), seconds: num('実行秒数 (既定 52 = カード読み込み結果まで)'), startAt: num('撮影開始秒'), interval: num('撮影間隔秒 (既定 2)'), keyAt: str('"秒:キー,..." (Flycast 既定キー: 矢印/ENTER/X/C/D/S)') }, ['image', 'tag']),
    async run({ image, tag, seconds = 52, startAt = 0, interval = 2, keyAt = '' }) {
      if (!/^[\w-]+$/.test(tag)) throw new Error('tag は英数字・_ - のみ');
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts', 'emu_bleem_card.ps1'),
        '-Image', absPath(image), '-Tag', tag, '-Seconds', String(seconds), '-StartAt', String(startAt), '-Interval', String(interval)];
      if (keyAt) args.push('-KeyAt', keyAt);
      const r = await runProcess('powershell', args, (seconds + 60) * 1000);
      const dir = join(ROOT, '.emu', 'out', `bleem_${tag}`);
      const shots = existsSync(dir) ? readdirSync(dir).filter((n) => /_w\d\.png$/.test(n)).sort().map((n) => join(dir, n)) : [];
      return { exitCode: r.code, dir: relative(ROOT, dir), shots, log: r.output.trim().split('\n').slice(-10) };
    },
  },
};

function runProcess(cmd, args, timeoutMs) {
  return new Promise((done) => {
    const p = spawn(cmd, args, { cwd: ROOT, windowsHide: true });
    let output = '';
    p.stdout.on('data', (d) => { output += d; });
    p.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      done({ code, output });
    });
  });
}

// ---- MCP (JSON-RPC 2.0 over stdio) ----

const INSTRUCTIONS = `DC_VMU: Dreamcast VMU イメージとセーブデータの解析・改造ツール。
解析の基本手順: vmu_list でファイルと一致する定義を確認 → vmu_fields / vmu_scan / vmu_dump で中身を見る →
ゲームで状態を変えた前後のイメージを vmu_diff で比べる / 既知の値を vmu_find で探す →
仮説を vmu_variants や vmu_set で作り、vmu_bleem_run (PS1) や vmu_emu_verify でゲーム/実機ドライバに受理されるか確認 →
確認できた項目を vmu_def_save で defs/ に保存 (推定の項目は名前に ? を付け、note に根拠を書く)。
書き込み系のツールは入力イメージを上書きせず、DC_VMU フォルダ内 (既定 .emu/work/) に新しいイメージを作る。`;

let send = (msg) => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

function textResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], isError };
}

async function handle(msg) {
  if (Array.isArray(msg)) {
    // バッチ: まとめて処理し、応答 (通知以外) を配列で返す
    const replies = [];
    const orig = send;
    send = (m) => replies.push(m);
    try {
      for (const m of msg) await handle(m);
    } finally {
      send = orig;
    }
    if (replies.length) send(replies);
    return;
  }
  if (!msg || typeof msg !== 'object') {
    send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // 通知 (notifications/initialized など) は応答しない
  try {
    switch (method) {
      case 'initialize':
        return send({ jsonrpc: '2.0', id, result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'dc-vmu', version: VERSION },
          instructions: INSTRUCTIONS,
        } });
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: {
          tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
        } });
      case 'tools/call': {
        const tool = tools[params?.name];
        if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${params?.name}` } });
        try {
          return send({ jsonrpc: '2.0', id, result: textResult(await tool.run(params.arguments ?? {})) });
        } catch (err) {
          return send({ jsonrpc: '2.0', id, result: textResult(`エラー: ${err.message}`, true) });
        }
      }
      default:
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (err) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
  }
}

export { tools, handle };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    handle(msg).catch((err) => send({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: err.message } }));
  });
}
