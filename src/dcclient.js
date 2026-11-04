// Dreamcast 本体のセーブマネージャ (dc/savemgr) に BBA 経由でつなぐ部品。Node 18 以上とブラウザで動く (fetch を使う)。
// API は docs/dc-savemgr-spec.md の 6 章。この版は読むだけ (info / list / image / file / check)。

export const DC_DEFAULT_HOST = '192.168.10.2';
export const DC_SLOTS = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'd1', 'd2'];

export class DcError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

const sjis = (() => {
  try { return new TextDecoder('shift_jis'); } catch { return null; }
})();

/** descHex (Shift-JIS の 16 進) を文字列に */
export function decodeSjisHex(hex) {
  const bytes = Uint8Array.from((hex || '').match(/../g) || [], (x) => parseInt(x, 16));
  return (sjis ? sjis.decode(bytes) : String.fromCharCode(...bytes)).trimEnd();
}

export function normalizeSlot(slot) {
  const s = String(slot ?? '').toLowerCase();
  if (!DC_SLOTS.includes(s)) throw new DcError(`スロットは a1〜d2 で指定してください: ${slot}`);
  return s;
}

export class DcClient {
  constructor(host = DC_DEFAULT_HOST, { timeoutMs = 15000 } = {}) {
    this.base = /^https?:\/\//.test(host) ? host.replace(/\/+$/, '') : `http://${host}`;
    this.timeoutMs = timeoutMs;
  }

  async request(path) {
    let res;
    try {
      res = await fetch(this.base + path, { cache: 'no-store', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const why = err?.name === 'TimeoutError' ? '時間切れ' : (err?.cause?.code || err.message);
      throw new DcError(`${this.base} につながりません (${why})。Dreamcast でセーブマネージャが動いているか、BBA のケーブルと IP を確かめてください`);
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* JSON でない */ }
      throw new DcError(`${path}: ${msg}`, res.status);
    }
    return res;
  }

  async json(path) {
    return (await this.request(path)).json();
  }

  async bytes(path) {
    const res = await this.request(path);
    const etag = (res.headers.get('etag') || '').replace(/"/g, '');
    return { bytes: new Uint8Array(await res.arrayBuffer()), etag };
  }

  info() {
    return this.json('/api/info');
  }

  /** ファイル一覧。説明 (Shift-JIS) は desc / longDesc に読める文字で入れ直す */
  async list(slot) {
    const j = await this.json(`/api/vmu/${normalizeSlot(slot)}`);
    for (const f of j.files || []) {
      if (f.header) {
        f.desc = decodeSjisHex(f.descHex);
        f.longDesc = decodeSjisHex(f.longDescHex);
      }
    }
    return j;
  }

  /** VMU を丸ごと (128KB) */
  image(slot) {
    return this.bytes(`/api/vmu/${normalizeSlot(slot)}/image`);
  }

  /** 1 ファイル。fmt = 'raw' (.vms の中身) か 'dci' */
  file(slot, name, fmt = 'raw') {
    return this.bytes(`/api/vmu/${normalizeSlot(slot)}/file/${encodeURIComponent(name)}?fmt=${fmt}`);
  }

  check(slot) {
    return this.json(`/api/vmu/${normalizeSlot(slot)}/check`);
  }
}
