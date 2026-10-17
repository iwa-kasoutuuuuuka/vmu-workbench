#!/usr/bin/env node
// VMU Workbench コマンドライン
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, extname, dirname, join } from 'node:path';
import { Vmu, FILE_GAME, IMAGE_SIZE } from './src/vmu.js';
import { parseVmi, buildVmi, splitPages, replacePage, dcmSwap, isDcmName } from './src/formats.js';
import { readIcons, editVms, rgbaToIcons, iconsToStrip } from './src/vmsedit.js';
import { encodePng, decodePng } from './src/png-node.js';
import { lookupTitle } from './src/titles.js';
import { loadTitles } from './src/titles-node.js';
import { byteVariability, hotRanges } from './src/analyze.js';
import { parseHeader, headerPosition, toDci, fromDci } from './src/vms.js';
import { crcStatus, applyEdit, patchBytes, parseHexBytes, diffBytes } from './src/edit.js';
import {
  validateDef, findDefs, readField, formatField, setFields, groupFields, openView, resolveViewFields, checksumStatus,
} from './src/structdef.js';
import { loadDefs } from './src/defs-node.js';
import { backup, listHistory, resolveImageSpec, restore } from './src/history-node.js';
import { buildGame, flashFrom, parseKeys, runScript, lcdText, lcdRgba, biosAutoStart, flashChanges, recordAudio, edgesToPcm, pcmToWav, audioNotes, VmuEmulator } from './src/vmugame.js';
import { looksLikeBios } from './src/vmuemu.js';

const CRC_LABEL = { ok: 'CRC OK', ng: 'CRC NG', broken: 'CRC範囲外', none: '' };
// 全角文字を幅2として右を埋める (表示の桁揃え用)
const padW = (s, width) => s + ' '.repeat(Math.max(0, width - [...s].reduce((w, c) => w + (c.charCodeAt(0) > 0xff ? 2 : 1), 0)));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');

const USAGE = `VMU Workbench — Dreamcast VMU エディタ

usage:
  node cli.js list    <vmu.bin>                 ファイル一覧
  node cli.js check   <vmu.bin>                 整合性チェック
  node cli.js fixroot <vmu.bin>                 ルートの位置 (0x44) を直す (2026-10-17 より前の版 (DC_VMU) で作ったイメージ用)
  node cli.js cat     <vmu.bin> <名前>          ファイル内容を標準出力へ
  node cli.js export  <vmu.bin> <名前> <out>    取り出し (.dci なら DCI、.vmi なら .vmi + .VMS、それ以外は生データ)
  node cli.js import  <vmu.bin> <file> [名前]   追加 (.dci / .vmi は名前等を自動取得。.vmi は対の .VMS を読む)
  --page <n>                                    128KB を連結した複数ページのイメージでページを選ぶ (既定 0)
  --game                                        (import) 生の .vms をミニゲームとして書き込む (ブロック 0 から)
  node cli.js delete  <vmu.bin> <名前>          削除
  node cli.js format  <out.bin>                 空のイメージを作成 (.dcm なら DCM 形式)
  node cli.js convert <in> <out>                .bin ⇔ .dcm (Nexus のダンプ。4 バイトごとにバイト順反転) の変換
  node cli.js title   <vmu.bin>                 タイトルの推定 (タイトル DB・VMS ヘッダ・PS1 セーブ) と根拠
  node cli.js heatmap <名前> <img1> <img2> ...  複数のセーブ (古い順) でよく変わる範囲 (定義があればフィールド名付き)
  node cli.js desc    <vmu.bin> <名前> <説明16> [説明32]  VMS ヘッダの説明文を書き換え (CRC 更新)
  node cli.js icon-export <vmu.bin> <名前> <out.png>     アイコン (コマを横に並べた PNG) を書き出し
  node cli.js icon-import <vmu.bin> <名前> <in.png> [速度]  PNG (高さ 32、幅 32〜96) からアイコンを置き換え
  node cli.js history <vmu.bin>                 履歴 (書き換えのたびに自動バックアップ) の一覧
  node cli.js restore <vmu.bin> <番号>          過去の版に戻す (戻す前の状態も残る)
                                                過去の版は <vmu.bin>@<番号> で他のコマンドに渡せる
  node cli.js asm     <src.s> <out.vms>         ミニゲームをアセンブル (0x200 に VMS ヘッダがあれば CRC を計算)
  node cli.js run     <vmu.bin|game.vms> [--seconds 2] [--keys "1:right,1.5:"] [--png lcd.png] [--bios rom.bin]
                                                ミニゲームをエミュレーターで動かして画面を表示 (ボタン: up down left
                                                right a b mode sleep)。BIOS 無しではゲームを直接起動し、BIOS を
                                                呼んだところで止まる。--bios を付けると BIOS から起動し、--boot で
                                                時計の設定を済ませて GAME からミニゲームを起動してから --keys を実行。
                                                ゲームのセーブ (フラッシュ書き込み) は --save out.bin で別ファイルに、
                                                --write で元のイメージに書き戻す (履歴にバックアップ)。
                                                --clock "2026-10-17 12:00" で BIOS の時計 (--boot の既定は今の時刻)、
                                                --suspend state.json で終了時の状態を保存、--resume state.json でその続きから。
                                                --wav out.wav でスピーカーの音を WAV に (鳴った音の一覧も表示)
  node cli.js defrag  <vmu.bin>                 断片化したファイルを詰め直す (名前・日時・並びは保つ)
  node cli.js reorder <vmu.bin> <名前> ...      ディレクトリの並び (BIOS の表示順) を変える
  node cli.js patch   <vmu.bin> <名前> <offset> <HEX> [--no-crc]
                                                バイト書き換え (例: patch v.bin SAVE 0x2a0 "FF 00")
                                                VMSヘッダがあればCRCを自動更新
  node cli.js fixcrc  <vmu.bin> <名前>          CRCを再計算して書き込み
  node cli.js diff    <a.bin> <b.bin> <名前> [--raw]
                                                2イメージ間で同名ファイルの差分を表示。構造定義が一致すれば
                                                コンテナを展開した中身を比べ、フィールド名を付ける

  構造定義 (defs/*.json。--def <file.json> で明示指定も可):
  node cli.js defs                              定義の一覧と検証
  node cli.js fields  <vmu.bin> <名前>          名前付きフィールドの値を表示
  node cli.js set     <vmu.bin> <名前> <フィールド>=<値> ... [--no-crc]
                                                値を書き込み (例: set v.bin SAVE 所持金=99999 "アイテム[0]=3")
                                                定義のチェックサムも自動更新 (--no-checksum で無効)`;

const argv = process.argv.slice(2);
const takeFlag = (flag, withValue = false) => {
  const i = argv.indexOf(flag);
  if (i < 0) return withValue ? null : false;
  const [, value] = argv.splice(i, withValue ? 2 : 1);
  if (withValue && (value === undefined || value.startsWith('--'))) {
    console.error(`エラー: ${flag} の後に値を指定してください`);
    process.exit(1);
  }
  return withValue ? value : true;
};
const defPath = takeFlag('--def', true);
const noCrc = takeFlag('--no-crc');
const noChecksum = takeFlag('--no-checksum');
const raw = takeFlag('--raw');
const page = takeFlag('--page', true);
const asGame = takeFlag('--game');
const seconds = takeFlag('--seconds', true);
const keys = takeFlag('--keys', true);
const pngOut = takeFlag('--png', true);
const biosPath = takeFlag('--bios', true);
const bootGame = takeFlag('--boot');
const saveOut = takeFlag('--save', true);
const writeBack = takeFlag('--write');
const clockArg = takeFlag('--clock', true);
const resumePath = takeFlag('--resume', true);
const suspendPath = takeFlag('--suspend', true);
const wavOut = takeFlag('--wav', true);
const [cmd, imagePath, ...args] = argv;

/** 使う構造定義を決める (--def 指定 > defs/ から自動一致) */
function pickDef(entry, data) {
  if (defPath) {
    const def = JSON.parse(readFileSync(defPath, 'utf8'));
    const problems = validateDef(def);
    if (problems.length) throw new Error(`定義が不正です:\n  ${problems.join('\n  ')}`);
    return def;
  }
  const { defs, errors } = loadDefs();
  errors.forEach((e) => console.error(`警告: ${e}`));
  const hits = findDefs(defs, entry, data);
  if (!hits.length) throw new Error(`${entry.name} に一致する構造定義がありません (defs/ に追加するか --def で指定)`);
  if (hits.length > 1) console.error(`複数の定義が一致: ${hits.map((d) => d.id).join(', ')} → ${hits[0].id} を使用`);
  return hits[0];
}
const WRITE_COMMANDS = ['fixroot', 'import', 'delete', 'patch', 'fixcrc', 'set', 'defrag', 'reorder', 'format', 'restore'];
if (WRITE_COMMANDS.includes(cmd) && /@\d+$/.test(imagePath ?? '') && !existsSync(imagePath)) {
  console.error('エラー: 履歴の版 (…@番号) は書き換えられません。restore で戻してから編集してください');
  process.exit(1);
}
/** イメージを読む。128KB の倍数のファイルは複数ページとして --page (既定 0) のページを開く */
/** イメージファイルを読む (.dcm は 4 バイトごとの反転を戻す) */
function readImageFile(spec) {
  const bytes = readFileSync(resolveImageSpec(spec));
  return isDcmName(spec.replace(/@\d+$/, '')) ? dcmSwap(bytes) : bytes;
}
function load() {
  const bytes = readImageFile(imagePath);
  if (bytes.length === IMAGE_SIZE) {
    if (page !== null && Number(page) !== 0) throw new Error('このイメージは 1 ページだけです');
    return new Vmu(bytes);
  }
  const pages = splitPages(bytes);
  if (!pages) return new Vmu(bytes); // サイズ違いのエラーメッセージを出す
  const n = Number(page ?? 0);
  if (!Number.isInteger(n) || n < 0 || n >= pages.length) throw new Error(`ページは 0〜${pages.length - 1} で指定してください (--page)`);
  if (page === null) console.error(`${pages.length} ページのイメージです。ページ 0 を開きます (--page で指定)`);
  return new Vmu(pages[n]);
}
/** イメージを書き換える前に履歴へバックアップしてから保存する (複数ページなら該当ページだけ置き換える) */
function saveImage(bytes) {
  if (/@\d+$/.test(imagePath) && !existsSync(imagePath)) throw new Error('履歴の版 (…@番号) は書き換えられません。restore で戻してから編集してください');
  let out = bytes;
  if (existsSync(imagePath)) {
    const current = readImageFile(imagePath);
    if (current.length > IMAGE_SIZE && splitPages(current)) out = replacePage(current, Number(page ?? 0), bytes);
  }
  backup(imagePath, argv.join(' '));
  writeFileSync(imagePath, isDcmName(imagePath) ? dcmSwap(out) : out);
}
/** VMI と対の .VMS を探す: リソース名.VMS (大文字小文字は問わない) → 同じ名前の .vms */
function findVms(vmiPath, resourceName) {
  const dir = dirname(vmiPath);
  const files = readdirSync(dir);
  const want = [`${resourceName}.vms`, `${basename(vmiPath, extname(vmiPath))}.vms`].map((n) => n.toLowerCase());
  for (const w of want) {
    const hit = files.find((f) => f.toLowerCase() === w);
    if (hit) return join(dir, hit);
  }
  throw new Error(`対になる .VMS が見つかりません (${resourceName}.VMS)`);
}
const need = (entry, name) => {
  if (!entry) throw new Error(`ファイルがありません: ${name}`);
  return entry;
};

try {
  switch (cmd) {
    case 'list': {
      const vmu = load();
      for (const e of vmu.list()) {
        const file = vmu.tryReadFile(e);
        const kind = e.type === FILE_GAME ? 'GAME' : 'DATA';
        const ts = e.timestamp ? e.timestamp.toLocaleString('ja-JP') : '-';
        if (!file) {
          console.log(`${e.name.padEnd(12)} ${kind} ${String(e.sizeBlocks).padStart(3)}blk   ${ts}  (壊れている: node cli.js check で詳細)`);
          continue;
        }
        const h = parseHeader(file, headerPosition(e));
        console.log(`${e.name.padEnd(12)} ${kind} ${String(e.sizeBlocks).padStart(3)}blk ${e.copyProtected ? 'P' : ' '} ${ts}  ${h?.valid ? h.description : '(ヘッダ無し)'}  ${CRC_LABEL[crcStatus(file, e).status]}`);
      }
      console.log(`空き: ${vmu.freeBlocks().length} / ${vmu.root.userBlocks} ブロック`);
      break;
    }
    case 'check': {
      const vmu = load();
      const problems = vmu.check();
      problems.forEach((p) => console.log(`NG: ${p}`));
      // CRC不一致はゲーム側で「壊れたデータ」扱いされうるため警告 (エラー扱いにはしない)
      for (const e of vmu.list()) {
        const data = vmu.tryReadFile(e);
        if (!data) continue; // 壊れたファイルは上の NG に出ている
        const s = crcStatus(data, e);
        if (s.status === 'ng') console.log(`警告: ${e.name}: CRC不一致 (保存値 ${s.stored.toString(16)}, 計算値 ${s.actual.toString(16)})`);
        if (s.status === 'broken') console.log(`警告: ${e.name}: ヘッダのデータ長がファイルサイズを超えています`);
      }
      console.log(problems.length ? `${problems.length}件の問題` : 'OK');
      process.exitCode = problems.length ? 1 : 0;
      break;
    }
    case 'cat': {
      const vmu = load();
      process.stdout.write(vmu.readFile(need(vmu.find(args[0]), args[0])));
      break;
    }
    case 'export': {
      const vmu = load();
      const e = need(vmu.find(args[0]), args[0]);
      const data = vmu.readFile(e);
      const ext = extname(args[1]).toLowerCase();
      if (ext === '.vmi') {
        // .vmi と同じ場所に .VMS (中身) を書く。リソース名は .vmi のファイル名 (8 文字まで)
        const resourceName = basename(args[1], extname(args[1])).toUpperCase().slice(0, 8);
        writeFileSync(args[1], buildVmi(e, data, { resourceName }));
        writeFileSync(join(dirname(args[1]), `${resourceName}.VMS`), data);
        console.log(`${args[1]} と ${resourceName}.VMS を書き出しました`);
      } else {
        writeFileSync(args[1], ext === '.dci' ? toDci(e, data) : data);
      }
      break;
    }
    case 'import': {
      const vmu = load();
      const bytes = readFileSync(args[0]);
      if (extname(args[0]).toLowerCase() === '.vmi') {
        const info = parseVmi(bytes);
        if (!info.checksumOk) console.error('警告: VMI のチェックサムが合いません');
        const vmsPath = findVms(args[0], info.resourceName);
        const data = readFileSync(vmsPath);
        if (info.size && info.size !== data.length) console.error(`警告: VMI のサイズ (${info.size}) と .VMS (${data.length}) が違います`);
        vmu.writeFile(args[1] ?? info.fileName, data, {
          type: info.type, copyProtected: info.copyProtected, headerOffset: info.type === FILE_GAME ? 1 : 0, date: info.date ?? new Date(),
        });
        console.log(`${info.fileName} (${info.description}) を ${basename(vmsPath)} から取り込みました`);
      } else if (extname(args[0]).toLowerCase() === '.dci') {
        const d = fromDci(bytes);
        vmu.writeFile(args[1] ?? d.name, d.data, { type: d.type, copyProtected: d.copyProtected, headerOffset: d.headerOffset, timestamp: d.timestamp });
      } else if (asGame) {
        if (!parseHeader(bytes, 0x200)?.valid) console.error('警告: 0x200 に VMS ヘッダがありません (BIOS のメニューに出ない可能性があります)');
        vmu.writeFile(args[1] ?? basename(args[0], extname(args[0])).toUpperCase().slice(0, 12), bytes, { type: FILE_GAME, headerOffset: 1 });
      } else {
        vmu.writeFile(args[1] ?? basename(args[0], extname(args[0])).toUpperCase().slice(0, 12), bytes);
      }
      saveImage(vmu.toBytes());
      break;
    }
    case 'delete': {
      const vmu = load();
      vmu.deleteFile(need(vmu.find(args[0]), args[0]));
      saveImage(vmu.toBytes());
      break;
    }
    case 'format':
      saveImage(Vmu.format().toBytes());
      break;
    case 'title': {
      const vmu = load();
      const db = loadTitles();
      for (const e of vmu.list()) {
        const t = lookupTitle(e, vmu.tryReadFile(e), db);
        console.log(`${e.name.padEnd(12)} ${t.title ?? '(不明)'}${t.detail ? ` — ${t.detail}` : ''}`);
        console.log(`${' '.repeat(13)}根拠: ${t.source}`);
      }
      break;
    }
    case 'heatmap': {
      // heatmap <ファイル名> <イメージ1> <イメージ2> [...]  (時系列順)
      const name = imagePath;
      const images = args;
      if (!name || images.length < 2) throw new Error('heatmap <ファイル名> <イメージ1> <イメージ2> [...]  (古い順に 2 つ以上)');
      const views = images.map((p) => {
        const v = new Vmu(readFileSync(resolveImageSpec(p)));
        const e = need(v.find(name), `${name} (${p})`);
        return { e, data: v.readFile(e) };
      });
      let def = null;
      try {
        def = raw ? null : pickDef(views[0].e, views[0].data);
      } catch {
        def = null;
      }
      const opened = def ? views.map((x) => openView(def, x.e, x.data)) : null;
      const bytes = opened?.every(Boolean) ? opened.map((o) => o.bytes) : views.map((x) => x.data);
      const fields = opened?.[0] ? resolveViewFields(def, opened[0]) : [];
      const sums = opened?.[0] ? checksumStatus(def, opened[0].bytes, opened[0].base) : [];
      if (opened?.[0]) console.log(`定義 ${def.id} で比較 (${opened[0].label})`);
      const { changes, compared } = byteVariability(bytes);
      const ranges = hotRanges(changes);
      for (const r of ranges.slice(0, 40)) {
        const labels = [...fields.filter((f) => f.offset < r.end && f.offset + f.size > r.start).map((f) => f.name),
          ...sums.filter((c) => c.inRange && c.at < r.end && c.at + c.size > r.start).map((c) => c.name)];
        const bar = '#'.repeat(Math.max(1, Math.round((r.max / compared) * 10)));
        console.log(`0x${r.start.toString(16).padStart(4, '0')}-0x${(r.end - 1).toString(16).padStart(4, '0')}  最大 ${r.max}/${compared} 回  ${bar.padEnd(10)}${labels.length ? `  [${labels.join(', ')}]` : ''}`);
      }
      console.log(ranges.length ? `${ranges.length} 範囲が変化 (${images.length} 個のイメージ、隣り合う ${compared} 組を比較)` : '変化なし');
      break;
    }
    case 'desc': {
      const [name, short, long] = args;
      if (!name || short === undefined) throw new Error('desc <vmu.bin> <名前> <VMU 用の説明 16 文字> [DC 用の説明 32 文字]');
      const vmu = load();
      const e = need(vmu.find(name), name);
      const out = editVms(vmu.readFile(e), e, { description: short, ...(long !== undefined ? { longDescription: long } : {}) });
      applyEdit(vmu, e, out, { fixCrc: false });
      saveImage(vmu.toBytes());
      console.log(`${name}: 説明を書き換えました (CRC 更新)`);
      break;
    }
    case 'icon-export': {
      const [name, outPng] = args;
      if (!name || !outPng) throw new Error('icon-export <vmu.bin> <名前> <out.png>  (コマを横に並べた PNG)');
      const vmu = load();
      const e = need(vmu.find(name), name);
      const icons = readIcons(vmu.readFile(e), e);
      if (!icons) throw new Error('VMS ヘッダ (アイコン) がありません');
      const strip = iconsToStrip(icons);
      writeFileSync(outPng, encodePng(strip.rgba, strip.width, strip.height));
      console.log(`${outPng}: ${icons.frames.length} コマ (${strip.width}x${strip.height})、アニメ速度 ${icons.animSpeed}`);
      break;
    }
    case 'icon-import': {
      const [name, inPng, speed] = args;
      if (!name || !inPng) throw new Error('icon-import <vmu.bin> <名前> <in.png> [アニメ速度]  (高さ 32、幅 32/64/96 = 1〜3 コマ)');
      const vmu = load();
      const e = need(vmu.find(name), name);
      const img = decodePng(readFileSync(inPng));
      const icons = rgbaToIcons(img.rgba, img.width, img.height);
      const changes = { palette: icons.palette, frames: icons.frames };
      if (speed !== undefined) changes.animSpeed = Number(speed);
      const { entry, resized } = applyEdit(vmu, e, editVms(vmu.readFile(e), e, changes), { fixCrc: false });
      saveImage(vmu.toBytes());
      console.log(`${name}: アイコンを ${icons.frames.length} コマに置き換えました${icons.exact ? '' : ' (16 色を超えたので近い色に減色)'}${resized ? ` (サイズ ${e.sizeBlocks} → ${entry.sizeBlocks} ブロック)` : ''}`);
      break;
    }
    case 'history': {
      const versions = listHistory(imagePath);
      if (!versions.length) console.log('履歴はありません (このイメージを CLI で書き換えると自動で残ります)');
      for (const v of versions) console.log(`${String(v.id).padStart(4)}  ${new Date(v.time).toLocaleString('ja-JP')}  ${v.note}`);
      if (versions.length) console.log(`過去の版は "${imagePath}@番号" で指定できます (例: diff ${imagePath}@${versions.at(-1).id} ${imagePath} <名前>)`);
      break;
    }
    case 'restore': {
      if (!args[0]) throw new Error('restore <vmu.bin> <番号>');
      const { restored, backup: b } = restore(imagePath, args[0]);
      console.log(`版 ${restored.id} (${new Date(restored.time).toLocaleString('ja-JP')}) に戻しました。戻す前の状態は版 ${b.id} に保存`);
      break;
    }
    case 'fixroot': {
      const vmu = load();
      if (!vmu.fixRoot()) {
        console.log('直す必要はありません');
        break;
      }
      saveImage(vmu.toBytes());
      console.log('ルートの位置 (0x44) を 255 にしました');
      break;
    }
    case 'convert': {
      const [out] = args;
      if (!imagePath || !out) throw new Error('convert <in.bin|in.dcm> <out.bin|out.dcm>');
      const bytes = readImageFile(imagePath);
      if (!splitPages(bytes) && bytes.length !== IMAGE_SIZE) throw new Error(`VMU イメージではありません (${bytes.length} バイト)`);
      writeFileSync(out, isDcmName(out) ? dcmSwap(bytes) : bytes);
      const pages = bytes.length / IMAGE_SIZE;
      console.log(`${out}: ${isDcmName(out) ? 'DCM' : '生イメージ'} (${pages} ページ)`);
      break;
    }
    case 'asm': {
      const [out] = args;
      if (!imagePath || !out) throw new Error('asm <src.s> <out.vms>');
      const { bytes, header, labels } = buildGame(readFileSync(imagePath, 'utf8'));
      writeFileSync(out, bytes);
      console.log(`${out}: ${bytes.length} バイト (${bytes.length / 512} ブロック)${header ? `、ヘッダ「${header.description}」CRC 0x${header.crc.toString(16).padStart(4, '0')}` : '、VMS ヘッダ無し'}`);
      if (labels.main !== undefined) console.log(`main = 0x${labels.main.toString(16)}`);
      break;
    }
    case 'run': {
      if (!imagePath) throw new Error('run <vmu.bin|game.vms> [--seconds 2] [--keys "1:right,1.5:"] [--png lcd.png] [--bios rom.bin]');
      let rom = null;
      if (biosPath) {
        rom = readFileSync(biosPath);
        if (!looksLikeBios(rom)) throw new Error('BIOS は 64KB の生のダンプを指定してください (先頭がジャンプ命令のもの)');
      }
      const original = readImageFile(imagePath);
      if (writeBack && original.length !== IMAGE_SIZE) throw new Error('--write は 128KB の VMU イメージのときだけ使えます (--save で別ファイルに保存してください)');
      const emu = new VmuEmulator({ flash: flashFrom(original), rom });
      const before = Uint8Array.from(emu.flash);
      const clock = clockArg === null || clockArg === 'now' ? new Date() : new Date(clockArg);
      if (Number.isNaN(clock.getTime())) throw new Error(`--clock の日時が読めません: ${clockArg}`);
      if (resumePath) {
        if (bootGame) throw new Error('--resume と --boot は同時に使えません');
        emu.loadState(JSON.parse(readFileSync(resumePath, 'utf8')));
        before.set(emu.flash); // 状態に含まれるフラッシュを基準にする
        console.log(`${resumePath} の状態から再開`);
      } else if (bootGame) {
        if (!rom) throw new Error('--boot には --bios が必要です');
        console.log(biosAutoStart(emu, { clock }) ? `BIOS: 時計を ${clock.toLocaleString('ja-JP')} に合わせてミニゲームを起動しました` : '警告: BIOS からミニゲームを起動できませんでした');
      }
      const rec = recordAudio(emu, { seconds: seconds === null ? 2 : Number(seconds), keys: parseKeys(keys) });
      const st = emu.state();
      const lcd = emu.lcd();
      console.log(lcdText(lcd));
      console.log(`LCD ${lcd.on ? 'オン' : 'オフ'}  PC=0x${st.pc.toString(16).padStart(4, '0')} (${st.bank})  ${st.cycles} サイクル${emu.beeper() ? `  ブザー ${Math.round(emu.beeper())}Hz` : ''}`);
      if (st.stopReason) console.log(`停止: ${st.stopMessage}`);
      if (pngOut) {
        const img = lcdRgba(lcd, 4);
        writeFileSync(pngOut, encodePng(img.rgba, img.width, img.height));
        console.log(`${pngOut} に画面を保存`);
      }
      const notes = audioNotes(rec).filter((n) => n.hz >= 20 && n.hz <= 20000);
      if (notes.length) {
        console.log(`音: ${notes.length} 個 (${notes.slice(0, 8).map((n) => `${Math.round(n.hz)}Hz ${Math.round(n.dur * 1000)}ms`).join(', ')}${notes.length > 8 ? ' ...' : ''})`);
      }
      if (wavOut) {
        writeFileSync(wavOut, pcmToWav(edgesToPcm(rec)));
        console.log(`${wavOut} に音を保存 (${(rec.end - rec.start).toFixed(1)} 秒)`);
      }
      const ch = flashChanges(before, emu.flash, Vmu);
      if (ch.blocks.length) {
        console.log(`フラッシュの書き換え: ${ch.blocks.length} ブロック${ch.files.length ? ` (${ch.files.join(', ')})` : ''}${ch.system ? ' + FAT/ディレクトリ' : ''}`);
      } else if (saveOut || writeBack) console.log('フラッシュは書き換えられていません');
      if (suspendPath) {
        writeFileSync(suspendPath, JSON.stringify(emu.saveState({ withFlash: true })));
        console.log(`${suspendPath} に状態を保存 (--resume で続きから)`);
      }
      if (saveOut) {
        writeFileSync(saveOut, isDcmName(saveOut) ? dcmSwap(emu.flash) : emu.flash);
        console.log(`${saveOut} に実行後のイメージを保存`);
      }
      if (writeBack && ch.blocks.length) {
        const problems = new Vmu(Uint8Array.from(emu.flash)).check();
        if (problems.length) throw new Error(`実行後のイメージに問題があるため書き戻しません: ${problems.join(' / ')}`);
        saveImage(Uint8Array.from(emu.flash));
        console.log(`${imagePath} に書き戻しました (元の状態は history / restore で戻せます)`);
      }
      if (st.stopReason && st.stopReason !== 'bios') process.exitCode = 1;
      break;
    }
    case 'defrag': {
      const vmu = load();
      const frag = vmu.fragmented().map((e) => e.name);
      if (!frag.length) {
        console.log('断片化したファイルはありません');
        break;
      }
      vmu.defragment();
      saveImage(vmu.toBytes());
      console.log(`詰め直しました: ${frag.join(', ')}`);
      break;
    }
    case 'reorder': {
      if (!args.length) throw new Error('reorder <vmu.bin> <名前> [<名前> ...]  (先頭に並べたい順)');
      const vmu = load();
      const list = vmu.reorder(args);
      saveImage(vmu.toBytes());
      console.log(list.map((e) => e.name).join(' / '));
      break;
    }
    case 'patch': {
      const [name, offsetText, hexText, flag] = args;
      if (!name || !offsetText || !hexText) throw new Error('patch <vmu.bin> <名前> <offset> <HEX> [--no-crc]');
      const offset = Number(offsetText);
      if (!Number.isInteger(offset)) throw new Error(`オフセットが不正です: ${offsetText}`);
      const vmu = load();
      const e = need(vmu.find(name), name);
      const before = vmu.readFile(e);
      const edited = patchBytes(before, [{ offset, bytes: parseHexBytes(hexText) }]);
      const { crc } = applyEdit(vmu, e, edited, { fixCrc: !noCrc && flag !== '--no-crc' });
      for (const d of diffBytes(before, vmu.readFile(e))) {
        console.log(`0x${d.offset.toString(16).padStart(4, '0')}: ${hex(d.before)} -> ${hex(d.after)}`);
      }
      if (crc !== null) console.log(`CRC更新: ${crc.toString(16).padStart(4, '0')}`);
      saveImage(vmu.toBytes());
      break;
    }
    case 'fixcrc': {
      const vmu = load();
      const e = need(vmu.find(args[0]), args[0]);
      const data = vmu.readFile(e);
      const s = crcStatus(data, e);
      if (s.status === 'none' || s.status === 'broken') throw new Error(`CRCを計算できません (${s.status === 'none' ? 'VMSヘッダ無し' : 'データ長が不正'})`);
      const { crc } = applyEdit(vmu, e, data);
      console.log(`${e.name}: ${s.stored.toString(16)} -> ${crc.toString(16)}${s.status === 'ok' ? ' (変更なし)' : ''}`);
      saveImage(vmu.toBytes());
      break;
    }
    case 'defs': {
      const { defs, errors } = loadDefs();
      for (const d of defs) {
        const match = Object.entries(d.match).map(([k, v]) => `${k}=${v}`).join(' ');
        console.log(`${d.id.padEnd(20)} ${d.title}  [${match}] ${d.fields.length}項目  (${d.source})`);
      }
      errors.forEach((e) => console.log(`NG: ${e}`));
      console.log(`${defs.length}件の定義${errors.length ? `, ${errors.length}件のエラー` : ''}`);
      process.exitCode = errors.length ? 1 : 0;
      break;
    }
    case 'fields': {
      const vmu = load();
      const e = need(vmu.find(args[0]), args[0]);
      const data = vmu.readFile(e);
      const def = pickDef(e, data);
      const view = openView(def, e, data);
      console.log(`${def.title} (${def.id})  基準: ${view.label}`);
      for (const { group, fields } of groupFields(resolveViewFields(def, view))) {
        if (group) console.log(`[${group}]`);
        for (const f of fields) {
          const off = `+0x${f.relOffset.toString(16).padStart(4, '0')} (0x${f.offset.toString(16).padStart(4, '0')})`;
          console.log(`  ${padW(f.name, 16)} ${off} ${f.type.padEnd(6)} ${formatField(f, readField(view.bytes, f))}`);
        }
      }
      for (const c of checksumStatus(def, view.bytes, view.base)) {
        console.log(c.inRange
          ? `${c.name}: 格納値 0x${c.stored.toString(16)} / 計算値 0x${c.actual.toString(16)} ${c.ok ? '(一致)' : '(不一致)'}`
          : `${c.name}: 範囲外`);
      }
      break;
    }
    case 'set': {
      const [name, ...pairs] = args;
      if (!name || !pairs.length) throw new Error('set <vmu.bin> <名前> <フィールド>=<値> ... [--no-crc] [--no-checksum]');
      const vmu = load();
      const e = need(vmu.find(name), name);
      const before = vmu.readFile(e);
      const def = pickDef(e, before);
      const assignments = Object.fromEntries(pairs.map((p) => {
        const i = p.indexOf('=');
        if (i < 1) throw new Error(`"フィールド=値" の形式で指定してください: ${p}`);
        return [p.slice(0, i), p.slice(i + 1)];
      }));
      const edited = setFields(before, def, e, assignments, { fixChecksums: !noChecksum });
      const { crc, resized } = applyEdit(vmu, e, edited, { fixCrc: !noCrc });
      const e2 = vmu.find(name);
      const viewBefore = openView(def, e, before);
      const viewAfter = openView(def, e2, vmu.readFile(e2));
      for (const f of resolveViewFields(def, viewAfter).filter((x) => x.name in assignments)) {
        console.log(`${f.name}: ${formatField(f, readField(viewBefore.bytes, f))} -> ${formatField(f, readField(viewAfter.bytes, f))}`);
      }
      for (const c of checksumStatus(def, viewAfter.bytes, viewAfter.base)) {
        if (c.inRange) console.log(`${c.name}: 0x${c.stored.toString(16)}${c.ok ? '' : ' (不一致のまま)'}`);
      }
      if (crc !== null) console.log(`CRC更新: ${crc.toString(16).padStart(4, '0')}`);
      if (resized) console.log(`ファイルサイズ変更: ${e.sizeBlocks} -> ${e2.sizeBlocks} ブロック`);
      saveImage(vmu.toBytes());
      break;
    }
    case 'diff': {
      const [otherPath, name] = args;
      const a = load();
      const b = new Vmu(readFileSync(resolveImageSpec(otherPath)));
      const ea = need(a.find(name), name);
      const eb = need(b.find(name), name);
      let da = a.readFile(ea);
      let db = b.readFile(eb);
      // 構造定義が一致すれば、コンテナを展開した中身同士を比べ、差分にフィールド名を付ける (--raw で無効)
      let def = null;
      if (!raw) {
        try {
          def = pickDef(ea, da);
        } catch {
          def = null;
        }
      }
      const va = def && openView(def, ea, da);
      const vb = def && openView(def, eb, db);
      let fields = [];
      let sums = [];
      if (va && vb) {
        console.log(`定義 ${def.id} で比較 (${va.label})`);
        da = va.bytes;
        db = vb.bytes;
        fields = resolveViewFields(def, va);
        sums = checksumStatus(def, da, va.base);
      }
      const label = (start, end) => [
        ...fields.filter((f) => f.offset < end && f.offset + f.size > start).map((f) => f.name),
        ...sums.filter((c) => c.inRange && c.at < end && c.at + c.size > start).map((c) => c.name),
      ];
      const ranges = diffBytes(da, db);
      for (const d of ranges) {
        const names = label(d.offset, d.offset + d.after.length);
        const more = d.after.length > 32 ? ` ... (${d.after.length} バイト)` : '';
        console.log(`0x${d.offset.toString(16).padStart(4, '0')}: ${hex(d.before.subarray(0, 32))} -> ${hex(d.after.subarray(0, 32))}${more}${names.length ? `  [${names.join(', ')}]` : ''}`);
      }
      console.log(ranges.length ? `${ranges.length}箇所の差分` : '差分なし');
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
} catch (err) {
  console.error(`エラー: ${err.message}`);
  process.exitCode = 1;
}
