// Lecture des fichiers token en clair (gitignore).
// Priorité : token_publish / token_register, repli sur token (legacy).

import { readFileSync, existsSync } from 'node:fs';

export function readTokenLine(path) {
  if (!existsSync(path)) return null;
  const line = readFileSync(path, 'utf8').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line || null;
}

export function loadPublishToken() {
  return readTokenLine('token_publish') || readTokenLine('token');
}

export function loadRegisterToken() {
  return readTokenLine('token_register') || readTokenLine('token');
}
