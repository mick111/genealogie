// Session utilisateur authentifiée (passkey / PIN).

export const authSession = {
  user: null,       // entrée registry
  mkKey: null,      // CryptoKey clé maître
  mkRaw: null,      // octets MK (session — pour ré-enveloppe PIN sans exportKey)
  treeKey: null,    // alias = mkKey pour tree.enc
  registry: null,
};

export function clearAuthSession() {
  authSession.user = null;
  authSession.mkKey = null;
  authSession.mkRaw = null;
  authSession.treeKey = null;
  authSession.registry = null;
  sessionStorage.removeItem('gen_auth_uid');
  sessionStorage.removeItem('gen_auth_cred');
}

export function setAuthSession(user, mkKey, registry, mkRaw = null) {
  authSession.user = user;
  authSession.mkKey = mkKey;
  authSession.mkRaw = mkRaw;
  authSession.treeKey = mkKey;
  authSession.registry = registry;
  sessionStorage.setItem('gen_auth_uid', user.id);
  sessionStorage.setItem('gen_auth_cred', user.credentialId);
}

export function canEditPerson(personId) {
  const u = authSession.user;
  if (!u) return false;
  if (u.role === 'admin' || u.role === 'editor') return true;
  if (u.role === 'self' && u.personId === personId) return true;
  return false;
}

export function canEditTree() {
  const r = authSession.user?.role;
  return r === 'admin' || r === 'editor';
}

export function canPublish() {
  return canEditTree();
}

export function isAdmin() {
  return authSession.user?.role === 'admin';
}

export function needsPersonLink() {
  const u = authSession.user;
  return u && u.status === 'approved' && !u.personId && (u.role === 'self' || u.role === 'editor');
}

export function needsSetupFinalize(user) {
  return !!(user?.status === 'approved' && user.setupRequired && user.setupWrap && !user.pinWrap);
}
