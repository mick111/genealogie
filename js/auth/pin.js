// PIN secours 8 chiffres — enveloppe la clé maître MK.

import { deriveKey, encryptBytesWithKey, decryptBytesWithContainer, exportRawAesKey, importRawAesKey } from '../crypto.js';

const PIN_RE = /^\d{8}$/;

export function validatePin(pin) {
  return PIN_RE.test(String(pin || '').trim());
}

function saltB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function pinWrapKey(userId, pin) {
  return deriveKey(pin, saltB64('pin|' + userId), 150000, 'SHA-256');
}

export async function wrapMkRawWithPin(mkRaw, userId, pin) {
  if (!validatePin(pin)) throw new Error('PIN_INVALID');
  const pinKey = await pinWrapKey(userId, pin.trim());
  return encryptBytesWithKey(pinKey, mkRaw);
}

export async function wrapMkWithPin(mkKey, userId, pin) {
  const raw = await exportRawAesKey(mkKey);
  return wrapMkRawWithPin(raw, userId, pin);
}

export async function unwrapMkWithPin(pinWrap, userId, pin) {
  if (!validatePin(pin)) throw new Error('PIN_INVALID');
  const pinKey = await pinWrapKey(userId, pin.trim());
  const mkRaw = await decryptBytesWithContainer(pinKey, pinWrap);
  const mkKey = await importRawAesKey(mkRaw);
  return { mkKey, mkRaw };
}
