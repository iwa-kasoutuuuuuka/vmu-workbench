// エミュレーター検証用のテストVMUイメージを生成する
// 使い方: node scripts/make-test-image.js <出力.bin> [取り込む実VMUイメージ.bin]
import { readFileSync, writeFileSync } from 'node:fs';
import { Vmu, BLOCK_SIZE } from '../src/vmu.js';
import { parseHeader, updateCrc } from '../src/vms.js';
import { applyEdit, patchBytes } from '../src/edit.js';
import { setFields } from '../src/structdef.js';
import { readIcons, editVms } from '../src/vmsedit.js';
import { loadDefs } from '../src/defs-node.js';

const [out, realImage] = process.argv.slice(2);
if (!out) {
  console.error('usage: node scripts/make-test-image.js <out.bin> [real-vmu.bin]');
  process.exit(1);
}

const pattern = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) & 0xff);

/** アイコン付きの正しいVMSヘッダを持つセーブを作る */
function makeSave(desc, dataSize) {
  const file = new Uint8Array(0x80 + 512 + dataSize);
  const v = new DataView(file.buffer);
  const ascii = (s, off) => file.set(new TextEncoder().encode(s), off);
  ascii(desc.padEnd(16), 0x00);
  ascii('DC_VMU TEST SAVE'.padEnd(32), 0x10);
  ascii('DC_VMU', 0x30);
  v.setUint16(0x40, 1, true);
  v.setUint32(0x48, dataSize, true);
  [0xf000, 0xffff, 0xff00, 0xf0f0, 0xf00f].forEach((c, i) => v.setUint16(0x60 + i * 2, c, true));
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x += 2) {
      const c = (px) => ((px >> 3) + (y >> 3)) % 5;
      file[0x80 + y * 16 + x / 2] = (c(x) << 4) | c(x + 1);
    }
  }
  file.set(pattern(dataSize, 3), 0x80 + 512);
  updateCrc(file, parseHeader(file));
  return file;
}

// defs/dcvmu-test.json の構造に沿った値を入れる (構造定義の見本として)
const { defs } = loadDefs();
const testDef = defs.find((d) => d.id === 'dcvmu-test');
function setStruct(entry, values) {
  applyEdit(vmu, entry, setFields(vmu.readFile(entry), testDef, entry, values));
}

const vmu = Vmu.format({ date: new Date(2026, 0, 1, 12, 0, 0) });
const save01 = vmu.writeFile('DCVMU_SAVE01', makeSave('DC_VMU SAVE 1', 1000), { date: new Date(2026, 9, 16, 22, 0, 0) });
setStruct(save01, {
  所持金: 1500, レベル: 12, 難易度: 'Normal', クリア: 0b011, 名前: 'SONIC',
  'アイテム[0]': 3, 'アイテム[1]': 1, 'アイテム[2]': 0, 'アイテム[3]': 0, 'アイテム[4]': 9, 'プレイ時間(秒)': 7265,
});
vmu.writeFile('DCVMU_ONE', pattern(100, 1));
// 断片化: 間のファイルを消して大きいファイルを書く
vmu.writeFile('DCVMU_GAP', pattern(BLOCK_SIZE * 2, 2));
vmu.writeFile('DCVMU_MID', pattern(BLOCK_SIZE, 4));
vmu.deleteFile(vmu.find('DCVMU_GAP'));
vmu.writeFile('DCVMU_FRAG', pattern(BLOCK_SIZE * 5 + 17, 5), { copyProtected: true });

// 改造: データ部を書き換えて CRC を自動更新 (Dreamcast 側で PKG OK になるべき)
const patched = vmu.writeFile('DCVMU_PATCH', makeSave('DC_VMU PATCHED', 700));
applyEdit(vmu, patched, patchBytes(vmu.readFile(patched), [{ offset: 0x80 + 512 + 5, bytes: Uint8Array.of(0xde, 0xad, 0xbe, 0xef) }]));
// 構造定義による改造: 名前付きフィールドの書き換え + CRC 自動更新 (PKG OK になるべき)
const struct = vmu.writeFile('DCVMU_STRUCT', makeSave('DC_VMU STRUCT', 400));
setStruct(struct, { 所持金: 9999999, レベル: 99, 難易度: 'Hard', クリア: 0x87, 名前: 'MODDED', 'アイテム[4]': 255 });
// アイコン・説明の編集: 3 コマに増やしてファイルサイズが変わる (PKG OK になるべき)
const iconSave = vmu.writeFile('DCVMU_ICON3', makeSave('DC_VMU ICON', 200));
{
  const icons = readIcons(vmu.readFile(iconSave), iconSave);
  const frames = [icons.frames[0], icons.frames[0].map((c) => (c + 1) % 5), icons.frames[0].map((c) => (c + 2) % 5)];
  applyEdit(vmu, iconSave, editVms(vmu.readFile(iconSave), iconSave, { frames, animSpeed: 10, description: 'DC_VMU 3 ICONS' }), { fixCrc: false });
}
// 対照: 書き換えて CRC を更新しない (Dreamcast 側で PKG NG になるべき)
const bad = vmu.writeFile('DCVMU_BADCRC', makeSave('DC_VMU BAD CRC', 300));
applyEdit(vmu, bad, patchBytes(vmu.readFile(bad), [{ offset: 0x80 + 512 + 5, bytes: Uint8Array.of(0x55) }]), { fixCrc: false });

if (realImage) {
  // 実際のエミュレーターで作られたイメージからファイルをコピー
  const real = new Vmu(readFileSync(realImage));
  for (const e of real.list().slice(0, 3)) {
    if (vmu.freeBlocks().length - e.sizeBlocks < 10) break;
    vmu.writeFile(e.name, real.readFile(e), { type: e.type, copyProtected: e.copyProtected, date: e.timestamp ?? new Date() });
  }
}

const problems = vmu.check();
if (problems.length) throw new Error(problems.join('\n'));
writeFileSync(out, vmu.toBytes());
console.log(`wrote ${out}`);
for (const e of vmu.list()) console.log(`  ${e.name.padEnd(12)} ${e.sizeBlocks} blocks`);
