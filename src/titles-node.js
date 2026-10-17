// Node 用: titles/titles.json を読む (無い・壊れている場合は空の DB)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TITLES_PATH = fileURLToPath(new URL('../titles/titles.json', import.meta.url));

export function loadTitles(path = TITLES_PATH) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { vmu: [], ps1: [] };
  }
}
