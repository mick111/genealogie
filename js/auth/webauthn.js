// WebAuthn : enregistrement et authentification passkey (+ PRF si disponible).

import { exportRawAesKey, importRawAesKey, encryptBytesWithKey, decryptBytesWithContainer } from '../crypto.js';
import { getRpId } from './site.js';

function uid() {
  return crypto.randomUUID();
}

function toBytes(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  return new Uint8Array(buf);
}

function b64(buf) {
  const bytes = toBytes(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBuf(b64s) {
  const bin = atob(b64s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function prfSalt() {
  return new TextEncoder().encode('prf|genealogie|v1');
}

export function credentialIdB64(credential) {
  return b64(credential.rawId);
}

export async function registerPasskey(displayName, userId = uid()) {
  if (!window.PublicKeyCredential) throw new Error('WEBAUTHN_UNAVAILABLE');
  const userBytes = new TextEncoder().encode(userId);
  const opts = {
    rp: { name: 'Généalogie', id: getRpId() },
    user: { id: userBytes, name: displayName, displayName },
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    extensions: { prf: { eval: { first: prfSalt() } } },
  };
  const cred = /** @type {PublicKeyCredential} */ (await navigator.credentials.create({ publicKey: opts }));
  const ext = cred.getClientExtensionResults?.();
  const prfOut = ext?.prf?.results?.first;
  return {
    userId,
    displayName,
    credentialId: credentialIdB64(cred),
    publicKey: cred.response.getPublicKey ? b64(cred.response.getPublicKey()) : null,
    prfEnabled: !!(ext?.prf?.enabled && prfOut),
    prfBytes: prfOut ? new Uint8Array(prfOut) : null,
  };
}

export async function authenticatePasskey(credentialIdB64str = null) {
  if (!window.PublicKeyCredential) throw new Error('WEBAUTHN_UNAVAILABLE');
  const opts = {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rpId: getRpId(),
    userVerification: 'preferred',
    extensions: { prf: { eval: { first: prfSalt() } } },
  };
  if (credentialIdB64str) {
    opts.allowCredentials = [{ type: 'public-key', id: b64ToBuf(credentialIdB64str) }];
  }
  const cred = /** @type {PublicKeyCredential} */ (await navigator.credentials.get({ publicKey: opts }));
  const ext = cred.getClientExtensionResults?.();
  const prfOut = ext?.prf?.results?.first;
  return {
    credentialId: credentialIdB64(cred),
    prfKey: prfOut ? await importRawAesKey(new Uint8Array(prfOut)) : null,
    prfBytes: prfOut ? new Uint8Array(prfOut) : null,
  };
}

export async function wrapMkRawWithPrf(mkRaw, prfBytes) {
  const prfKey = await importRawAesKey(new Uint8Array(prfBytes));
  return encryptBytesWithKey(prfKey, mkRaw);
}

export async function unwrapMkWithPrfRaw(prfWrap, prfKey) {
  const mkRaw = await decryptBytesWithContainer(prfKey, prfWrap);
  return { mkKey: await importRawAesKey(mkRaw), mkRaw };
}

export async function wrapMkWithPrf(mkKey, userId, prfBytes) {
  const prfKey = await importRawAesKey(new Uint8Array(prfBytes));
  const raw = await exportRawAesKey(mkKey);
  return encryptBytesWithKey(prfKey, raw);
}

export async function unwrapMkWithPrf(prfWrap, prfBytes) {
  const prfKey = await importRawAesKey(new Uint8Array(prfBytes));
  const raw = await decryptBytesWithContainer(prfKey, prfWrap);
  return importRawAesKey(raw);
}

export async function wrapMkWithPrfKey(mkKey, prfKey) {
  const raw = await exportRawAesKey(mkKey);
  return encryptBytesWithKey(prfKey, raw);
}

export async function unwrapMkWithPrfKey(prfWrap, prfKey) {
  const raw = await decryptBytesWithContainer(prfKey, prfWrap);
  return importRawAesKey(raw);
}
