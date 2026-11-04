// GUI 用の簡易ローカルサーバー (ESモジュールは file:// で読めないため)
// 使い方: npm run serve → http://localhost:8765/
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDefs } from './src/defs-node.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT ?? 8765);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

createServer(async (req, res) => {
  // 別のサイトから名前を付け替えて (DNS リバインディング) 読まれないように、宛先は localhost だけ
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    res.writeHead(403).end();
    return;
  }
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('bad url'); // 壊れた %xx でサーバーが落ちないように
    return;
  }
  if (urlPath === '/defs/index.json') {
    // defs/*.json をまとめて返す (追加・編集はリロードで反映)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(loadDefs()));
    return;
  }
  const path = normalize(urlPath).replace(/^([\\/]\.\.)+/, '');
  const file = join(ROOT, path === '\\' || path === '/' ? 'index.html' : path);
  // .emu/ (BIOS)・.git/ など「.」で始まるフォルダ・ファイルは出さない
  // (Windows は大文字小文字を区別しないので、名前ではなく先頭の「.」で判断する)
  if (!file.startsWith(ROOT) || file.slice(ROOT.length).split(/[\\/]/).some((p) => p.startsWith('.'))) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`VMU Workbench: http://localhost:${PORT}/`));
