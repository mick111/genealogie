// Transfert temporaire de la clé maître vers l'appareil d'inscription (ECDH P-256).
// L'admin ne voit jamais le PIN ; la personne le choisit à la finalisation.

import { encryptBytesWithKey, decryptBytesWithContainer } from '../crypto.js';

const SETUP_PK_PREFIX = 'gen_setup_pk_';

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export async function createSetupKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey'],
  );
  const publicSpki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
  const privatePkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  return {
    publicKeyB64: bytesToB64(new Uint8Array(publicSpki)),
    privateKeyB64: bytesToB64(new Uint8Array(privatePkcs8)),
  };
}

async function importSetupPrivateKey(privateKeyB64) {
  return crypto.subtle.importKey(
    'pkcs8',
    b64ToBytes(privateKeyB64),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey'],
  );
}

async function importSetupPublicKey(publicKeyB64) {
  return crypto.subtle.importKey(
    'spki',
    b64ToBytes(publicKeyB64),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
}

async function deriveSetupAesKey(privateKey, publicKey) {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function wrapMkForSetup(mkRaw, userSetupPublicKeyB64) {
  const userPublic = await importSetupPublicKey(userSetupPublicKeyB64);
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey'],
  );
  const aesKey = await deriveSetupAesKey(ephemeral.privateKey, userPublic);
  const enc = await encryptBytesWithKey(aesKey, mkRaw);
  const ephPublicSpki = await crypto.subtle.exportKey('spki', ephemeral.publicKey);
  return {
    v: 1,
    ephPublicKey: bytesToB64(new Uint8Array(ephPublicSpki)),
    cipher: enc.cipher,
    iv: enc.iv,
    ct: enc.ct,
  };
}

export async function unwrapMkFromSetup(setupWrap, userSetupPrivateKeyB64) {
  const userPrivate = await importSetupPrivateKey(userSetupPrivateKeyB64);
  const ephPublic = await importSetupPublicKey(setupWrap.ephPublicKey);
  const aesKey = await deriveSetupAesKey(userPrivate, ephPublic);
  return decryptBytesWithContainer(aesKey, setupWrap);
}

export function storeSetupPrivateKey(userId, privateKeyB64) {
  localStorage.setItem(SETUP_PK_PREFIX + userId, privateKeyB64);
}

export function loadSetupPrivateKey(userId) {
  return localStorage.getItem(SETUP_PK_PREFIX + userId);
}

export function clearSetupPrivateKey(userId) {
  localStorage.removeItem(SETUP_PK_PREFIX + userId);
}

export function hasLocalSetupForUser(userId) {
  return !!loadSetupPrivateKey(userId);
}
