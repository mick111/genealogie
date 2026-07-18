// crypto.js — déchiffrement côté navigateur (WebCrypto).
// Format de conteneur partagé avec tools/build.mjs :
//   { v:1, kdf:{name,hash,iterations,salt(b64)}, cipher:"AES-GCM", iv(b64), ct(b64) }
// ct = ciphertext || authTag(16o), compatible SubtleCrypto AES-GCM.
//
// Le GEDCOM et les photos sont chiffrés avec la MÊME clé (même sel) : on ne
// dérive donc la clé (PBKDF2, coûteux) qu'une seule fois, au login, puis on la
// réutilise pour déchiffrer chaque image.

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

// Dérive la clé AES-GCM à partir de la phrase secrète et du sel du conteneur.
export async function deriveKey(passphrase, saltB64, iterations, hash) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations, hash },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Chiffre un texte en conteneur, en réutilisant le même sel (kdf) que l'original
// pour que la clé dérivée au login reste valable.
export async function encryptText(key, kdf, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return {
    v: 1,
    kdf,
    cipher: 'AES-GCM',
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(buf)),
  };
}

async function decryptRaw(key, ivB64, ctB64) {
  try {
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(ivB64) },
      key,
      b64ToBytes(ctB64)
    );
  } catch (e) {
    throw new Error('BAD_PASSWORD');
  }
}

// Déchiffre le conteneur texte (GEDCOM). Renvoie la clé dérivée + le texte,
// pour que l'appelant réutilise la clé sur les images.
export async function decryptTextContainer(container, passphrase) {
  const key = await deriveKey(
    passphrase,
    container.kdf.salt,
    container.kdf.iterations,
    container.kdf.hash
  );
  const buf = await decryptRaw(key, container.iv, container.ct);
  return { key, text: new TextDecoder().decode(buf) };
}

// Déchiffre un conteneur binaire (image) avec une clé déjà dérivée.
export async function decryptBytesWithKey(key, container) {
  const buf = await decryptRaw(key, container.iv, container.ct);
  return new Uint8Array(buf);
}

// Déchiffre un conteneur texte avec une clé déjà dérivée (ex. token GitHub chiffré).
export async function decryptTextWithKey(key, container) {
  const buf = await decryptRaw(key, container.iv, container.ct);
  return new TextDecoder().decode(buf);
}
