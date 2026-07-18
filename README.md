# 🌳 Arbre généalogique

Site web statique et **privé** pour consulter ton arbre généalogique, hébergeable
gratuitement sur **GitHub Pages**. Les données sont **chiffrées** (AES-256) : le
fichier publié est illisible sans le mot de passe, même en regardant le code source.

- Aucune dépendance, aucune étape de build côté site (HTML/CSS/JS vanilla).
- Fonctionnalités : **3 vues d'arbre** (Famille/sablier, Pedigree, Éventail) avec
  choix du nombre de générations, fiches individuelles, recherche, photos.
- **Édition** : ajouter parents / conjoint·e / enfants, modifier une fiche.
- **Plusieurs arbres** : choix au démarrage (`trees/`), chacun avec son mot de passe.
- Accès par **mot de passe** ou par **lien avec token** ; option **comptes passkey**
  pour la famille (voir §5).

---

## 1. Récupérer tes données (GEDCOM)

Le site lit le format **GEDCOM** (`.ged`), le standard de la généalogie. Tes deux
sites l'exportent :

- **MyHeritage** : `Famille → Gérer les arbres → (⋯) → Exporter vers GEDCOM`.
  Un e-mail te fournit un `.ged` à télécharger. (Export parfois soumis à l'abonnement.)
- **Filae / Geneanet** : `Mon arbre → Paramètres / Exporter → GEDCOM`.

> ⚠️ Ne fais **pas** de scraping des sites : c'est fragile et contraire à leurs CGU.
> L'export GEDCOM est la méthode officielle et propre.

Si tu as deux arbres, exporte les deux ; tu peux soit garder deux fichiers, soit
les fusionner dans un logiciel comme [Gramps](https://gramps-project.org) (gratuit).

Place ton fichier, par ex. `mon-arbre.ged`, à la racine du projet (il est
`.gitignore` : il ne sera **pas** publié en clair).

## 2. Chiffrer les données (et les photos)

Il te faut [Node.js](https://nodejs.org) (v18+). Un seul outil chiffre le GEDCOM
**et** les photos avec le même mot de passe :

```bash
# Le mot de passe est demandé au clavier (ou via passwd / GEN_PASSWORD)
node tools/build.mjs mon-arbre.ged --tree principal
```

Cela produit :

- `trees/<id>/tree.enc` — le GEDCOM chiffré ;
- `trees/<id>/media/<photo>.jpg.enc` — chaque image chiffrée.

Le catalogue des arbres est dans `trees/index.json`. L'exemple factice est dans
`trees/exemple/` (mot de passe : `famille2024`).

Ce sont ces fichiers `.enc` **qui sont publiés**. Refais cette commande à chaque
mise à jour de ton arbre ou de tes photos. Pour changer de mot de passe, relance
simplement le build avec le nouveau (tout est re-chiffré).

> Test rapide : `node tools/verify.mjs --tree principal` ou `--tree exemple`

## 3. Tester en local

```bash
python3 -m http.server 8000
# puis ouvre http://localhost:8000  (mot de passe de l'exemple : famille2024)
```

Il faut un serveur HTTP (les modules ES ne se chargent pas via `file://`).

## 4. Publier sur GitHub Pages

1. Crée un dépôt GitHub et pousse ces fichiers (y compris `data/tree.enc`, chiffré).
2. `Settings → Pages → Build and deployment → Source : Deploy from a branch`,
   branche `main`, dossier `/ (root)`.
3. Le site est en ligne sur `https://<user>.github.io/<repo>/`.

## 5. Accès : mot de passe & token

Deux modes coexistent selon la configuration du dépôt :

| Mode | Déclencheur | Connexion |
|------|-------------|-----------|
| **Classique** | pas de `data/auth/site.json` | Mot de passe arbre (+ lien `#token=…`) |
| **Comptes passkey** | `data/auth/site.json` présent | Passkey (+ PIN secours 8 chiffres) |

### Mode classique (mot de passe)

- **Mot de passe** : saisi dans l'écran de connexion. Le déchiffrement se fait
  dans le navigateur ; le mot de passe ne quitte jamais l'appareil.
- **Token (lien partageable)** : ajoute `#token=LEMOTDEPASSE` à l'URL, par ex.
  `https://<user>.github.io/<repo>/#token=famille2024`. Le fragment `#…` n'est
  jamais envoyé au serveur ni journalisé. Le lien déverrouille automatiquement,
  puis le token est retiré de la barre d'adresse.

### Mode comptes passkey (famille)

Quand `data/auth/site.json` est publié, le site bascule en **authentification
par comptes** : chaque membre de la famille a sa passkey (Touch ID, Face ID,
Windows Hello, clé de sécurité…). L'arbre reste chiffré avec une **clé maître
(MK)** unique ; chaque compte ne reçoit qu'une **enveloppe** chiffrée de cette
clé (jamais la clé en clair sur GitHub).

**Connexion :**

1. **Passkey** (recommandé) — après une première activation via PIN (voir ci-dessous).
2. **PIN secours** (8 chiffres) — toujours disponible si la passkey est perdue.

> La première connexion (ou après réinstallation du navigateur) se fait avec le
> **PIN secours** : le site active alors la connexion passkey pour les fois
> suivantes (extension WebAuthn PRF, si le navigateur la supporte).

**Inscription d'un membre :**

1. La personne clique **Créer un compte**, crée sa passkey (sans PIN pour l'instant).
2. La demande part **automatiquement** sur GitHub (`data/auth/pending.json`).
3. L'administrateur ouvre `#/admin`, choisit un **rôle** et approuve — **sans connaître le PIN**.
4. La personne revient sur **le même appareil / navigateur**, clique **Finaliser mon compte**, vérifie sa passkey et choisit son **PIN secours** (8 chiffres).
5. Le compte apparaît dans `data/auth/registry.json` ; connexion passkey ou PIN ensuite.

**Rôles :**

| Rôle | Droits |
|------|--------|
| `viewer` | Lecture seule |
| `self` | Lecture + modification de **sa** fiche (après lien `#/link`) |
| `editor` | Édition large + publication |
| `admin` | Tout + validation des inscriptions |

**Migration depuis le mot de passe unique** (one-shot, en local) :

```bash
# PIN admin 8 chiffres + mot de passe arbre (passwd / GEN_PASSWORD)
node tools/migrate-auth.mjs --tree principal

# Réinitialiser l'auth admin (registry + passkeys) sans toucher au GEDCOM source :
ADMIN_PIN=12345678 node tools/migrate-auth.mjs --reset --tree principal --from-ged merged.ged

# Tokens GitHub chiffrés (fichiers token_publish / token_register à la racine)
ADMIN_PIN=12345678 node tools/encrypt-auth-tokens.mjs
```

Puis dans le navigateur : connexion **PIN admin** → création **passkey admin** →
utilisation normale. Les tokens GitHub (`data/github_token.enc` pour publier
l'arbre, `data/github_reg_token.enc` pour les inscriptions auto) sont alors
chiffrés avec la clé maître, plus avec le mot de passe arbre.

**Fichiers auth publiés :**

```text
data/auth/site.json       configuration (sel, chemins)
data/auth/registry.json   comptes approuvés + enveloppes MK
data/auth/pending.json    demandes d'inscription en attente
```

Les tokens GitHub bruts (`token`, `token_publish`, `token_register`) restent
**hors dépôt** (`.gitignore`).

---

## Éditer l'arbre

Sur une fiche : **Modifier**, **Supprimer**, **+ Ajouter un parent**,
**+ Conjoint·e**, **+ Enfant**. Pour un enfant, un menu **« Mère / Père »**
permet de choisir le co-parent (union existante, nouveau, ou « Pas de mère/père »).
Supprimer une personne retire proprement ses liens familiaux.

Comme le site est statique, les modifications sont enregistrées **chiffrées dans
ton navigateur** (localStorage) : elles persistent sur cet appareil et sont
prioritaires sur le fichier publié.

Pour **publier / partager** tes modifications :

1. Clique **Publier** (en haut) — configure une fois le dépôt et un token GitHub
   (le token est **chiffré** localement avec la clé de ton mot de passe).
2. Ou télécharge un secours via **⬇︎** puis remplace `data/tree.enc` à la main.

> Astuce : pour repartir de la version publiée (annuler les modifs locales),
> vide le stockage du site dans ton navigateur (ou exécute
> `localStorage.removeItem('gen_data_v1_<id>')` dans la console, ex. `gen_data_v1_principal`).

## Les 3 vues d'arbre

- **Famille** (sablier) : ancêtres au-dessus, descendants en-dessous, conjoint·e
  et frères/sœurs sur la ligne du centre.
- **Pedigree** : ascendants dépliés horizontalement.
- **Éventail** : ascendants en éventail radial.

Chaque vue a un réglage du **nombre de générations**, et un **clic sur une
personne recentre l'arbre** sur elle.

## Photos

Si ton GEDCOM référence des images (`OBJE`/`FILE`), dépose les fichiers image
dans `data/media/` (le nom de fichier doit correspondre à celui référencé, ex.
`500002_….jpg`). `tools/build.mjs` les chiffre en `.enc` ; le navigateur les
déchiffre à la volée et les affiche sur les fiches.

> ✅ Les photos sont **chiffrées** au même titre que le texte : seuls les `.enc`
> sont publiés, illisibles sans le mot de passe. Les images en clair
> (`data/media/*.jpg`…) restent en local et sont ignorées par `.gitignore`.
>
> Note : les URLs photo d'un export MyHeritage sont temporaires (elles expirent).
> Télécharge les images en local **avant** de lancer le build.

## Notes de sécurité (à lire)

- La protection est **réelle** pour tout le contenu (noms, dates, lieux, liens
  **et photos**) : chiffré AES-256-GCM, clé dérivée par PBKDF2 (200 000 itérations).
- En mode **mot de passe**, la solidité dépend **entièrement du mot de passe** :
  choisis-en un long.
- En mode **passkey**, la clé maître est répartie via enveloppes par utilisateur
  (PRF passkey + PIN secours). Révoquer quelqu'un = retirer son entrée du
  `registry.json` et republier (sans rechiffrer tout l'arbre).
- C'est du statique : pas de serveur d'auth. Les métadonnées comptes (`registry.json`)
  sont publics dans le dépôt, mais illisibles sans passkey ou PIN de la personne.
- Le site est en `noindex` pour éviter le référencement par les moteurs.

## Structure

```text
index.html          page + écran de connexion
css/style.css        styles (thème clair/sombre)
js/crypto.js         déchiffrement WebCrypto
js/gedcom.js         parseur GEDCOM
js/tree.js           arbre ascendant SVG
js/app.js            application (login, routing, fiches, recherche)
js/auth/             authentification passkey + PIN (si site.json)
js/trees.js           catalogue et chemins multi-arbres
js/github.js         publication GitHub (token chiffré)
data/github_token.enc  token GitHub admin chiffré (publié)
data/github_reg_token.enc  token inscriptions auto chiffré (publié)
data/github_meta.json  config dépôt GitHub
data/auth/           registry + pending (mode passkey)
trees/index.json       catalogue des arbres
trees/<id>/tree.enc    GEDCOM chiffré (généré, publié)
trees/<id>/media/*.enc photos chiffrées (générées, publiées)
tools/build.mjs      chiffre le .ged + les photos  ->  trees/<id>/
tools/migrate-auth.mjs  migration mot de passe → clé maître + auth
tools/encrypt-auth-tokens.mjs  chiffre token_publish / token_register
tools/verify.mjs     test local déchiffrement + parsing
sample/famille.ged   exemple factice (mot de passe : famille2024)
```
