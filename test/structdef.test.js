import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vmu, BLOCK_SIZE } from '../src/vmu.js';
import { parseHeader, updateCrc } from '../src/vms.js';
import {
  validateDef, matches, findDefs, resolveFields, readField, formatField, encodeField, setFields, newDefFor, baseOffset, groupFields,
} from '../src/structdef.js';
import { loadDefs } from '../src/defs-node.js';
import { applyEdit, crcStatus } from '../src/edit.js';

function makeSave(appId = 'DC_VMU', dataSize = 64) {
  const file = new Uint8Array(0x80 + 512 + dataSize);
  const v = new DataView(file.buffer);
  file.set(new TextEncoder().encode('STRUCT TEST'), 0);
  file.set(new TextEncoder().encode(appId), 0x30);
  v.setUint16(0x40, 1, true);
  v.setUint32(0x48, dataSize, true);
  const d = 0x80 + 512;
  v.setUint32(d, 1234, true);   // 所持金
  file[d + 4] = 7;              // レベル
  file[d + 5] = 1;              // 難易度 Normal
  file[d + 6] = 0b10000101;     // クリア: 1,3,隠し
  file.set(new TextEncoder().encode('SONIC'), d + 0x10);
  file.set([1, 2, 3, 4, 5], d + 0x20);
  v.setUint32(d + 0x28, 3600, false);
  updateCrc(file, parseHeader(file));
  return file;
}

const { defs, errors } = loadDefs();
const def = defs.find((d) => d.id === 'dcvmu-test');

test('defs/ の定義はすべて有効', () => {
  assert.deepEqual(errors, []);
  assert.ok(def);
});

test('定義の検証でエラーを検出', () => {
  const bad = {
    id: 'x', title: 'x', match: {}, base: 'nope',
    fields: [
      { name: 'a', offset: 0, type: 'u9' },
      { name: 'a', offset: -1, type: 'u8' },
      { name: 'b', offset: 0, type: 'string' },
      { name: 'c', offset: 0, type: 'bool', enum: { 0: 'x' } },
      { name: 'd', offset: 0, type: 'u8', flags: { 8: 'x' } },
    ],
  };
  const errs = validateDef(bad).join('\n');
  for (const s of ['base', 'match', 'type が不正', '重複', 'offset', 'length', 'enum / flags', 'ビット番号']) {
    assert.match(errs, new RegExp(s), s);
  }
});

test('appId で一致判定', () => {
  const vmu = Vmu.format();
  const e = vmu.writeFile('S1', makeSave());
  const other = vmu.writeFile('S2', makeSave('OTHER'));
  assert.equal(matches(def, e, vmu.readFile(e)), true);
  assert.equal(matches(def, other, vmu.readFile(other)), false);
  assert.deepEqual(findDefs(defs, e, vmu.readFile(e)).map((d) => d.id), ['dcvmu-test']);
});

test('フィールドの読み取り (data基準・配列展開・enum/flags表示)', () => {
  const vmu = Vmu.format();
  const e = vmu.writeFile('S1', makeSave());
  const data = vmu.readFile(e);
  const fields = resolveFields(def, e, data);
  const get = (name) => fields.find((f) => f.name === name);
  const val = (name) => readField(data, get(name));

  assert.equal(baseOffset(def, e, data), 0x80 + 512);
  assert.equal(get('所持金').offset, 0x80 + 512);
  assert.equal(val('所持金'), 1234);
  assert.equal(val('レベル'), 7);
  assert.equal(formatField(get('難易度'), val('難易度')), 'Normal (1)');
  assert.equal(formatField(get('クリア'), val('クリア')), 'ステージ1, ステージ3, 隠し (0x85)');
  assert.equal(val('名前'), 'SONIC');
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => val(`アイテム[${i}]`)), [1, 2, 3, 4, 5]);
  assert.equal(val('プレイ時間(秒)'), 3600);
});

test('値の書き込み + CRC自動更新', () => {
  const vmu = Vmu.format();
  const e = vmu.writeFile('S1', makeSave());
  const edited = setFields(vmu.readFile(e), def, e, {
    所持金: '0xFFFF', 難易度: 'Hard', 名前: 'TAILS', 'アイテム[4]': 99, 'プレイ時間(秒)': 1,
  });
  applyEdit(vmu, e, edited);
  const data = vmu.readFile(e);
  const fields = resolveFields(def, e, data);
  const val = (name) => readField(data, fields.find((f) => f.name === name));
  assert.equal(val('所持金'), 0xffff);
  assert.equal(val('難易度'), 2);
  assert.equal(val('名前'), 'TAILS');
  assert.equal(val('アイテム[4]'), 99);
  assert.equal(val('プレイ時間(秒)'), 1);
  assert.equal(val('レベル'), 7); // 他は変わらない
  assert.equal(crcStatus(data, e).status, 'ok');
});

test('範囲外・不正な値は拒否', () => {
  const vmu = Vmu.format();
  const e = vmu.writeFile('S1', makeSave());
  const data = vmu.readFile(e);
  const f = (name) => resolveFields(def, e, data).find((x) => x.name === name);
  assert.throws(() => encodeField(f('レベル'), 0), /1〜99/);
  assert.throws(() => encodeField(f('レベル'), 'abc'), /整数/);
  assert.throws(() => encodeField(f('名前'), 'TOOLONGNAME'), /8 文字/);
  assert.throws(() => encodeField(f('名前'), 'ソニック'), /半角/);
  assert.throws(() => setFields(data, def, e, { 無い: 1 }), /フィールドがありません/);
});

test('bool / bytes / ファイル基準 / 範囲外フィールド', () => {
  const d2 = {
    id: 't', title: 't', match: { fileName: '^RAW$' }, base: 'file',
    fields: [
      { name: 'on', offset: 0, type: 'bool' },
      { name: 'raw', offset: 1, type: 'bytes', length: 3 },
      { name: 'far', offset: 9999, type: 'u8' },
    ],
  };
  assert.deepEqual(validateDef(d2), []);
  const vmu = Vmu.format();
  const e = vmu.writeFile('RAW', new Uint8Array(BLOCK_SIZE));
  const data = setFields(vmu.readFile(e), d2, e, { on: 'true', raw: 'aa bb cc' });
  const fields = resolveFields(d2, e, data);
  assert.equal(readField(data, fields[0]), true);
  assert.equal(formatField(fields[1], readField(data, fields[1])), 'aa bb cc');
  assert.equal(fields[2].inRange, false);
  assert.equal(formatField(fields[2], readField(data, fields[2])), '(範囲外)');
  assert.throws(() => setFields(data, d2, e, { far: 1 }), /範囲外/);
});

test('グループごとにまとめる (初出順)', () => {
  const g = groupFields([{ name: 'a', group: 'X' }, { name: 'b', group: 'Y' }, { name: 'c', group: 'X' }, { name: 'd' }]);
  assert.deepEqual(g.map((x) => [x.group, x.fields.map((f) => f.name)]), [['X', ['a', 'c']], ['Y', ['b']], ['', ['d']]]);
});

test('新規定義の雛形', () => {
  const vmu = Vmu.format();
  const e = vmu.writeFile('S1', makeSave('MY.GAME'));
  const d = newDefFor(e, vmu.readFile(e));
  assert.equal(d.match.appId, '^MY\\.GAME$');
  assert.equal(d.base, 'data');
  d.fields.push({ name: 'x', offset: 0, type: 'u8' });
  assert.deepEqual(validateDef(d), []);
  assert.equal(matches(d, e, vmu.readFile(e)), true);

  const raw = vmu.writeFile('RAWFILE', new Uint8Array(10));
  const d3 = newDefFor(raw, vmu.readFile(raw));
  assert.equal(d3.match.fileName, '^RAWFILE$');
  assert.equal(d3.base, 'file');
});
