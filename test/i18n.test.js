// GUI の英語表示: 画面の決まった文がすべて訳され、値の入るメッセージも訳されるか
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tr, setLang, getLang } from '../i18n.js';

const JP = /[぀-ヿ一-鿿]/;

test('index.html の日本語はすべて英訳がある', () => {
  setLang('en');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const texts = [
    ...[...html.matchAll(/>([^<>]*)</g)].map((m) => m[1].trim()),
    ...[...html.matchAll(/(?:title|placeholder|aria-label)="([^"]*)"/g)].map((m) => m[1]),
  ].filter((t) => JP.test(t) && !t.includes('/'));
  assert.ok(texts.length > 20);
  for (const t of texts) assert.doesNotMatch(tr(t), JP, `訳が無い: ${t}`);
});

test('値の入るメッセージ・エラーを英訳し、日本語に戻せる', () => {
  setLang('en');
  const cases = {
    'SAVE01 は既に存在します。上書きしますか？': 'SAVE01 already exists. Overwrite?',
    'A: ファイルがありません: FOO': 'A: File not found: FOO',
    '4 ブロック (2048 バイト)': '4 blocks (2048 bytes)',
    'セーブ: 1 ブロック変更 (COUNTER)': 'Saves: 1 block(s) changed (COUNTER)',
    'SAVE に変更を適用しました (CRC → 1a2b)。保存でイメージに書き出されます': 'Applied changes to SAVE (CRC → 1a2b). Save to write the image',
    'カーソル 0x0010 (16)  データ  [16進入力 — Tabで切替]': 'Cursor 0x0010 (16)  Data  [hex input — Tab to switch]',
    '停止: BIOS が必要です (ゲームが BIOS の 0x0100 を呼びました)': 'Stopped: A BIOS is required (the game called BIOS address 0x0100)',
    ' 音': ' Sound',
  };
  for (const [ja, en] of Object.entries(cases)) assert.equal(tr(ja), en, ja);
  assert.equal(tr('訳の無い文はそのまま'), '訳の無い文はそのまま');
  assert.equal(tr('ASCII only'), 'ASCII only');
  setLang('ja');
  assert.equal(getLang(), 'ja');
  assert.equal(tr('開く'), '開く');
});
