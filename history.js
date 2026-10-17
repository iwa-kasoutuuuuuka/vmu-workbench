// GUI の履歴: VMU イメージのスナップショットをブラウザ (IndexedDB) に保存する。
// 読み込み時・保存時・手動で残し、過去の版を開いたり、反対側のペインに開いて比べたりできる。
// IndexedDB が使えない環境 (プライベートウィンドウ等) では何もしない (例外は出さない)。
const DB = 'dcvmu';
const STORE = 'snapshots';
const KEEP = 30; // 1 ファイル名あたりの保持数

let dbPromise = null;
function open() {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('name', 'name');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const result = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(result?.result ?? result);
      t.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** name のスナップショット一覧 (新しい順、bytes は含めない) */
export async function listSnapshots(name) {
  const db = await open();
  if (!db) return [];
  const all = await tx(db, 'readonly', (s) => s.index('name').getAll(name));
  return (all ?? []).map(({ bytes, ...meta }) => ({ ...meta, size: bytes.length })).sort((a, b) => b.id - a.id);
}

export async function getSnapshot(id) {
  const db = await open();
  if (!db) return null;
  return tx(db, 'readonly', (s) => s.get(id));
}

export async function deleteSnapshot(id) {
  const db = await open();
  if (db) await tx(db, 'readwrite', (s) => s.delete(id));
}

/** スナップショットを追加 (直前と同じ内容なら追加しない)。古いものは KEEP 件を超えたら消す */
export async function addSnapshot(name, bytes, note) {
  const db = await open();
  if (!db) return false;
  const list = await listSnapshots(name);
  if (list.length) {
    const latest = await getSnapshot(list[0].id);
    if (latest && latest.bytes.length === bytes.length && latest.bytes.every((b, i) => b === bytes[i])) return false;
  }
  await tx(db, 'readwrite', (s) => s.add({ name, time: new Date().toISOString(), note, bytes: Uint8Array.from(bytes) }));
  for (const old of list.slice(KEEP - 1)) await deleteSnapshot(old.id);
  return true;
}
