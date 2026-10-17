// Node 用: defs/*.json の構造定義を読み込む
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDef } from './structdef.js';

export const DEFS_DIR = fileURLToPath(new URL('../defs/', import.meta.url));

/** @returns {{defs: object[], errors: string[]}} 不正な定義は errors に入れて除外 */
export function loadDefs(dir = DEFS_DIR) {
  const defs = [];
  const errors = [];
  if (!existsSync(dir)) return { defs, errors };
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const def = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const problems = validateDef(def);
      if (problems.length) errors.push(...problems.map((p) => `${name}: ${p}`));
      else defs.push({ ...def, source: name });
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  return { defs, errors };
}
