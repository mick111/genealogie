// Chiffrement de l'arbre avec la clé maître MK (format v2).

import { encryptBytesWithKey, decryptBytesWithContainer } from '../crypto.js';

export async function encryptTreeContainer(mkKey, gedcomText) {
  const enc = await encryptBytesWithKey(mkKey, new TextEncoder().encode(gedcomText));
  return { v: 2, type: 'tree', cipher: enc.cipher, iv: enc.iv, ct: enc.ct };
}

export async function decryptTreeContainer(mkKey, container) {
  if (container?.v === 2 && container.type === 'tree') {
    const bytes = await decryptBytesWithContainer(mkKey, container);
    return new TextDecoder().decode(bytes);
  }
  throw new Error('LEGACY_TREE');
}

export function isMkTree(container) {
  return container?.v === 2 && container.type === 'tree';
}
