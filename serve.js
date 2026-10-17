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

createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/defs/index.json') {
    // defs/*.json をまとめて返す (追加・編集はリロードで反映)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(loadDefs()));
    return;
  }
  const path = normalize(urlPath).replace(/^([\\/]\.\.)+/, '');
  const file = join(ROOT, path === '\\' || path === '/' ? 'index.html' : path);
  if (!file.startsWith(ROOT) || /[\\/]\.emu[\\/]/.test(file)) {
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
