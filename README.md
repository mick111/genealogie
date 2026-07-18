# 🌳 Arbre généalogique

Site web statique et **privé** pour consulter ton arbre généalogique, hébergeable
gratuitement sur **GitHub Pages**. Les données sont **chiffrées** (AES-256) : le
fichier publié est illisible sans le mot de passe, même en regardant le code source.

- Aucune dépendance, aucune étape de build côté site (HTML/CSS/JS vanilla).
- Fonctionnalités : arbre ascendant interactif, fiches individuelles, recherche, photos.
- Accès par **mot de passe** ou par **lien avec token**.

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
# Le mot de passe est demandé au clavier (ou via la variable GEN_PASSWORD)
node tools/build.mjs mon-arbre.ged
```

Cela produit :

- `data/tree.enc` — le GEDCOM chiffré ;
- `data/media/<photo>.jpg.enc` — chaque image de `data/media/` chiffrée.

Ce sont ces fichiers `.enc` **qui sont publiés**. Refais cette commande à chaque
mise à jour de ton arbre ou de tes photos. Pour changer de mot de passe, relance
simplement le build avec le nouveau (tout est re-chiffré).

> Test rapide : `node tools/verify.mjs` déchiffre et affiche un échantillon
> (mot de passe via `GEN_PASSWORD`, défaut `famille2024` pour l'exemple).

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

- **Mot de passe** : saisi dans l'écran de connexion. Le déchiffrement se fait
  dans le navigateur ; le mot de passe ne quitte jamais l'appareil.
- **Token (lien partageable)** : ajoute `#token=LEMOTDEPASSE` à l'URL, par ex.
  `https://<user>.github.io/<repo>/#token=famille2024`. Le fragment `#…` n'est
  jamais envoyé au serveur ni journalisé. Le lien déverrouille automatiquement,
  puis le token est retiré de la barre d'adresse.

---

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
- La solidité dépend **entièrement de ton mot de passe** : choisis-en un long.
- C'est du statique : pas de gestion de comptes, pas de révocation individuelle.
  Changer le mot de passe = re-chiffrer et republier.
- Le site est en `noindex` pour éviter le référencement par les moteurs.

## Structure

```text
index.html          page + écran de connexion
css/style.css        styles (thème clair/sombre)
js/crypto.js         déchiffrement WebCrypto
js/gedcom.js         parseur GEDCOM
js/tree.js           arbre ascendant SVG
js/app.js            application (login, routing, fiches, recherche)
data/tree.enc        GEDCOM chiffré (généré, publié)
data/media/*.enc     photos chiffrées (générées, publiées)
tools/build.mjs      chiffre le .ged + les photos  ->  *.enc
tools/verify.mjs     test local déchiffrement + parsing
sample/famille.ged   exemple factice (mot de passe : famille2024)
```
