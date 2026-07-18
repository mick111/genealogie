// Vérif locale : déchiffrement (WebCrypto) + parsing GEDCOM. Non déployé.
import { readFileSync } from 'node:fs';
import { decryptTextContainer } from '../js/crypto.js';
import { parseGedcom, formatDate } from '../js/gedcom.js';
import { loadPassword } from './passwd.mjs';

const PW = loadPassword('famille2024');
const container = JSON.parse(readFileSync(new URL('../data/tree.enc', import.meta.url), 'utf8'));

try { await decryptTextContainer(container, 'mauvais'); console.log('FAIL: bad pw accepted'); }
catch (e) { console.log('OK  mauvais mot de passe rejeté:', e.message); }

const { text } = await decryptTextContainer(container, PW);
const { individuals, families } = parseGedcom(text);
console.log(`OK  déchiffré + parsé: ${individuals.size} individus, ${families.size} familles`);

// Échantillon générique (indépendant des identifiants réels).
const someone = [...individuals.values()].find((p) => p.birth) || individuals.values().next().value;
console.log('    ex individu:', someone.name,
  '| né', someone.birth ? formatDate(someone.birth.date) : '?',
  someone.birth?.place ? 'à ' + someone.birth.place : '');
const withMarr = [...families.values()].find((f) => f.marr);
if (withMarr) console.log('    ex mariage:', formatDate(withMarr.marr.date), '| enfants:', withMarr.chil.length);
