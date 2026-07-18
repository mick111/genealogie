// Mot de passe local pour les outils CLI (tests, build, chiffrement).
// Ordre : GEN_PASSWORD → fichier passwd à la racine → défaut fourni.
// Ne jamais committer passwd (voir .gitignore).

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASSWD_FILE = join(ROOT, 'passwd');

export function loadPassword(fallback = '') {
  if (process.env.GEN_PASSWORD) return process.env.GEN_PASSWORD;
  if (existsSync(PASSWD_FILE)) {
    const line = readFileSync(PASSWD_FILE, 'utf8').split(/\r?\n/).find((l) => l.trim());
    if (line) return line.trim();
  }
  return fallback;
}
