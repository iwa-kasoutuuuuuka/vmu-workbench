import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Vmu, IMAGE_SIZE, FILE_GAME } from '../src/vmu.js';
import { parseVmi, buildVmi, vmiChecksum, splitPages, replacePage, VMI_SIZE, dcmSwap, isDcmName } from '../src/formats.js';

const sample = new Vmu(readFileSync(new URL('./fixtures/sample.bin', import.meta.url)));

test('VMI の作成と読み取り (資料のレイアウト)', () => {
  const e = sample.find('DCVMU_SAVE01');
  const data = sample.readFile(e);
  const vmi = buildVmi(e, data, { resourceName: 'SAVE01', copyright: 'DC_VMU' });
  assert.equal(vmi.length, VMI_SIZE);
  // チェックサム = "SAVE" & "SEGA"
  assert.deepEqual([...vmi.subarray(0, 4)], [0x53 & 0x53, 0x41 & 0x45, 0x56 & 0x47, 0x45 & 0x41]);
  const v = parseVmi(vmi);
  assert.equal(v.checksumOk, true);
  assert.equal(v.resourceName, 'SAVE01');
  assert.equal(v.fileName, 'DCVMU_SAVE01');
  assert.equal(v.description, 'DC_VMU TEST SAVE'); // VMS ヘッダの説明 (DC 用)
  assert.equal(v.copyright, 'DC_VMU');
  assert.equal(v.size, data.length);
  assert.equal(v.type, e.type);
  assert.equal(v.copyProtected, false);
  assert.equal(v.date.getTime(), e.timestamp.getTime());
  assert.equal(new DataView(vmi.buffer).getUint16(0x4e, true), 1); // file number
});

test('VMI のモードビット (ゲーム / コピー禁止)', () => {
  const vmu = Vmu.format();
  const g = vmu.writeFile('GAME', new Uint8Array(1024), { type: FILE_GAME });
  const p = vmu.writeFile('PROT', new Uint8Array(10), { copyProtected: true });
  assert.equal(new DataView(buildVmi(g, vmu.readFile(g)).buffer).getUint16(0x64, true), 2);
  assert.equal(new DataView(buildVmi(p, vmu.readFile(p)).buffer).getUint16(0x64, true), 1);
  const bad = buildVmi(p, vmu.readFile(p));
  bad[0] ^= 0xff;
  assert.equal(parseVmi(bad).checksumOk, false);
  assert.throws(() => parseVmi(new Uint8Array(10)), /108/);
  assert.deepEqual([...vmiChecksum(new Uint8Array(0))], [0, 0, 0, 0]);
});

test('複数ページのイメージ', () => {
  const a = Vmu.format();
  a.writeFile('PAGE0', new Uint8Array(10));
  const b = Vmu.format();
  b.writeFile('PAGE1', new Uint8Array(10));
  const joined = new Uint8Array(IMAGE_SIZE * 2);
  joined.set(a.toBytes(), 0);
  joined.set(b.toBytes(), IMAGE_SIZE);
  const pages = splitPages(joined);
  assert.equal(pages.length, 2);
  assert.equal(new Vmu(pages[1]).list()[0].name, 'PAGE1');
  b.writeFile('NEW', new Uint8Array(10));
  const updated = replacePage(joined, 1, b.toBytes());
  assert.deepEqual(new Vmu(splitPages(updated)[1]).list().map((x) => x.name), ['PAGE1', 'NEW']);
  assert.deepEqual(splitPages(updated)[0], a.toBytes());
  assert.equal(splitPages(new Uint8Array(1000)), null);
});

test('DCM (Nexus のダンプ): 4 バイトごとのバイト順反転', () => {
  const vmu = Vmu.format();
  vmu.writeFile('DCM_TEST', new Uint8Array(512).fill(7));
  const img = vmu.toBytes();
  const dcm = dcmSwap(img);
  // 資料: ファイルの先頭バイトはフラッシュの 4 バイト目
  assert.equal(dcm[0], img[3]);
  assert.equal(dcm[3], img[0]);
  assert.deepEqual(dcmSwap(dcm), img);
  assert.equal(new Vmu(dcmSwap(dcm)).find('DCM_TEST').sizeBlocks, 1);
  assert.throws(() => dcmSwap(new Uint8Array(5)), /4 の倍数/);
  assert.equal(isDcmName('a/B.DCM'), true);
  assert.equal(isDcmName('b.bin'), false);
});
