# 🛍️ Nya-Boutique V2 — Guide de configuration (en-tête 20vh avec image de couverture)

Mini-site pour **un seul vendeur** (TikTok / Facebook / WhatsApp), inspiré de Nya-Market.
Pas d'administrateur : le propriétaire publie **directement** ses produits depuis `vendeur.html`.

> **Version 2 = Version 1 + en-tête fixe de 20 % de la hauteur de l'écran avec image de couverture** choisie par le vendeur. Toutes les fonctionnalités de la V1 sont conservées à l'identique (produits, promotions, bande défilante, panier, commande WhatsApp, GPS, partage, infos boutique…).

---

## 0. Ce que contient le dossier

| Fichier | Rôle |
|---|---|
| `index.html` · `style.css` · `app.js` | **Site visiteur** : en-tête fixe 20vh avec **image de couverture** (**nouveau V2**), bande défilante, grille 2×2, détail produit, panier, commande WhatsApp, infos boutique |
| `vendeur.html` · `vendeur.css` · `vendeur.js` | **Espace vendeur** (connexion Google) : produits, prix promo, bande défilante, informations, lien à partager + **section « Image de couverture »** (**nouveau V2**) |
| `shared.js` | Petits outils communs (icônes, prix, sécurité des liens…) |
| `config.js` | **Le seul fichier à personnaliser** (clés Supabase, couleur, cache…) |
| `SQL/1-schema-boutique.sql` | Script SQL de base (tables, sécurité RLS, stockage des photos) — **inchangé** |
| `SQL/2-gerer-proprietaire.sql` | Ajouter / retirer jusqu'à 3 propriétaires — **inchangé** |
| `SQL/3-ameliorations.sql` | Seulement si vous aviez déjà l'ancienne V1 — **inchangé** |
| `SQL/4-v2-couverture.sql` | **Nouveau V2** : colonne `cover_url` de la table `boutique` + droit du propriétaire de la modifier |

Aucune installation, aucun `npm` : ce sont des fichiers statiques.

### ✨ Le header V2 en détail
- **Hauteur exacte : `height: 20vh`** (1,2 sur 6 de l'écran), **fixé en haut** pendant tout le défilement (`position: fixed`). La page démarre juste dessous (marge calculée automatiquement).
- L'**image de couverture** du vendeur est en arrière-plan (`object-fit: cover`, centrée, remplit tout l'en-tête).
- **Filtre sombre en dégradé** par-dessus l'image (plus foncé en haut et en bas, là où sont la bande et le nom) : le **nom de la boutique, le logo, les annonces et l'icône du panier restent lisibles quelle que soit l'image**, même très claire. Le nom a en plus une ombre portée et le panier un fond translucide.
- Superposition au premier plan : **bande défilante** (annonces) en haut, puis **logo + nom** à gauche et **panier** 🛒 à droite.
- Sans image de couverture : dégradé de la couleur de la boutique (`config.js › couleur`). Si l'image ne charge pas : même repli.
- Petits écrans en paysage (hauteur < 520 px) : les éléments rapetissent pour que 20vh suffise.
- Le panier garde son icône de panier (le « 🗑️ » de votre cahier des charges a été lu comme « panier »).

---

## 1. Créer le projet Supabase (≈ 3 min)

1. Allez sur **supabase.com** → **New project** (un projet par client est recommandé : données et accès bien séparés).
2. Notez le mot de passe de la base, choisissez la région la plus proche de vos clients.
3. Une fois le projet prêt : **Project Settings → API** et gardez sous la main :
   - **Project URL** (ex. `https://abcdefgh.supabase.co`)
   - la clé **publique** (`anon` ou `publishable`). ⚠️ Jamais la clé `service_role` / `secret`.

---

## 2. Exécuter le script SQL (≈ 2 min)

1. Ouvrez `SQL/1-schema-boutique.sql` dans le Bloc-notes.
2. Repérez la ligne `v_email text := 'PROPRIETAIRE@gmail.com';` et **remplacez par le Gmail du vendeur** (c'est la seule modification). Ce Gmail est le **seul** autorisé à entrer dans l'espace propriétaire.
3. Supabase → **SQL Editor → New query** → collez **tout** le fichier → **Run**. Message attendu : *« ✅ Propriétaire enregistré »*.
3 bis. **Nouveau V2 — dans une nouvelle requête, collez et lancez `SQL/4-v2-couverture.sql`** (ajoute la colonne de l'image de couverture). Ordre à respecter : **1 puis 4** (installation neuve) ; sur une base V1 déjà en service : seulement **4**.
4. Vérification (facultatif) — collez et Run :
   ```sql
   select tablename, rowsecurity from pg_tables
   where schemaname='public' and tablename in ('proprietaires','boutique','produits','annonces');
   ```
   → 4 lignes, `rowsecurity = true` partout.

Le script est **rejouable** sans risque (il ne supprime aucune donnée).

> Gmail oublié, ou besoin de 2 autres propriétaires (3 au maximum) : `SQL/2-gerer-proprietaire.sql` (voir étape 9 bis).
> Installation déjà faite avec l'ancienne version ? Lancez `SQL/3-ameliorations.sql` (une fois), **puis** `SQL/4-v2-couverture.sql`.
> ⚠️ Si vous rejouez un jour `3-ameliorations.sql`, relancez ensuite `4-v2-couverture.sql` (le 3 réinitialise les droits de modification de la table `boutique`).

### Ce que la sécurité (RLS) garantit
- **Visiteurs** : lecture seule des produits *visibles*, de la boutique et des annonces *visibles*.
- **Propriétaire** : seul le Gmail enregistré **ET** connecté par Google peut écrire (produits, annonces, boutique, photos).
- **Tout autre compte Google** : aucun droit d'écriture (même en bidouillant la page).
- La liste des propriétaires est **invisible** depuis le navigateur.
- Réglages réservés au développeur (le propriétaire ne peut **pas** les modifier) : `logo_url`, `melange_actif`, `max_produits` (16 par défaut).
- **3 propriétaires maximum** (imposé par la base).
- **V2** : la couverture (`cover_url`) n'est modifiable que par le propriétaire, et doit être une adresse `https://` (500 caractères max).
- Contrôles de données côté base : prix 1 → 100 000 000, ancien prix > prix, 1 à 4 photos en `https://`, « Plus d'informations » ≤ 60 mots, ≤ 10 messages de bande, ≤ 15 caractéristiques.

---

## 3. Activer la connexion Google (≈ 10 min, une seule fois par projet)

**A. Google Cloud Console** (console.cloud.google.com)
1. Créez un projet (ou utilisez-en un) → **APIs & Services → OAuth consent screen** : type *External*, nom de l'app, votre e-mail ; enregistrez.
2. **Credentials → Create credentials → OAuth client ID** → type **Web application**.
3. **Authorized redirect URIs** : ajoutez exactement
   `https://VOTRE-REF.supabase.co/auth/v1/callback`
   (remplacez par votre *Project URL* + `/auth/v1/callback`).
4. Créez, puis copiez **Client ID** et **Client secret**.

**B. Supabase**
1. **Authentication → Providers → Google** : activez, collez Client ID et Client secret, enregistrez.
2. **Authentication → URL Configuration** :
   - **Site URL** : l'adresse de votre site (ex. `https://ma-boutique.vercel.app`)
   - **Redirect URLs** : ajoutez `https://ma-boutique.vercel.app/vendeur.html` (et, pour vos essais, `http://localhost:3000/vendeur.html` si besoin).

---

## 4. Renseigner `config.js`

```js
supabaseUrl: 'https://VOTRE-REF.supabase.co',
supabaseKey: 'VOTRE_CLE_PUBLIQUE',
cacheMinutes: 5,           // 5 à 10 : délai avant que les visiteurs voient les modifications
couleur: '#2563eb',        // couleur de la boutique
devise: 'FCFA',
```
Le nom, la description, la ville, le WhatsApp… se règlent ensuite **depuis l'espace vendeur**, sans toucher au code. **Le logo, lui, est réglé par vous** dans Supabase (étape 9). `whatsappSupport` = votre WhatsApp, utilisé par les boutons « Notifiez-nous / Contactez-nous » du bas de l'espace vendeur (laissez `''` pour les masquer).

---

## 5. Mettre en ligne

**Option simple (Vercel)**
1. Mettez le contenu du dossier dans un dépôt GitHub (à la racine : `index.html`, `vendeur.html`…).
2. vercel.com → **Add New → Project** → importez le dépôt. *Framework Preset* : **Other**. Laissez *Build command* et *Output directory* vides → **Deploy**.
3. Ajoutez l'adresse obtenue dans Supabase (étape 3-B) si ce n'est pas déjà fait.

**Autres hébergements** : Netlify, Cloudflare Pages, GitHub Pages fonctionnent pareil (site statique). Le site doit être servi en **HTTPS**.

---

## 6. Premier test (10 min)

1. Ouvrez `https://VOTRE-SITE/vendeur.html` → **Se connecter avec Google** avec le Gmail enregistré.
   - Autre Gmail ⇒ « Accès refusé » (comportement voulu).
2. Section **Informations de la boutique** → *Modifier* : nom, propriétaire, description, **WhatsApp avec indicatif** (ex. `22961000000`). Le lien **Modifier** près de la ville règle la ville et la localisation.
3. **Ajouter un produit** : 1 à 4 photos, nom, prix, description, caractéristiques (1 par ligne), « Plus d'informations » (≤ 60 mots). Pour une **promotion** : cochez « Mettre ce produit en promotion » et saisissez le prix promotionnel : le prix normal s'affiche barré avec le pourcentage de réduction. La barre de progression montre combien de produits sont utilisés sur 16.
4. Section **Bande défilante** : ajoutez/modifiez/réordonnez des messages (lien facultatif en `https://`).
4 bis. **Nouveau V2 — section « Image de couverture »** : touchez *Choisir une image* (de préférence large/paysage). L'aperçu reproduit l'en-tête avec le filtre sombre. L'image est allégée automatiquement (règle de la section 8) et envoyée dans le stockage `boutique-images/couverture/`. *Changer l'image* supprime l'ancienne du stockage ; *Retirer* revient au dégradé de couleur.
5. Ouvrez `https://VOTRE-SITE/` : les visiteurs voient les changements **après `cacheMinutes` minutes** (mémoire du navigateur). Pour voir tout de suite pendant vos essais : console du navigateur → `localStorage.clear()` puis recharger.
6. Passez une commande de test : *Commander → remplir → Confirmer sur WhatsApp*.

---

## 7. Comportement du site (rappel)

- **En-tête fixe de 20vh** avec image de couverture + filtre sombre : bande infinie (masquée s'il n'y a aucun message actif ; pause au survol), logo + nom + panier au premier plan.
- **Grille 2×2**, produits **mélangés à chaque chargement**, affichés par lots de 12 (chargement progressif au défilement + `loading="lazy"`).
- **Clic sur un produit** → vue détail : galerie jusqu'à 4 photos (flèches, miniatures, balayage), description, caractéristiques, **Commander** (ouvre la commande), **Ajouter au panier**, **Partager** (lien `?p=…`).
  Pas de défilement d'un produit à l'autre : le bouton flottant **« Voir tous les produits »** ramène à la grille. Le bloc **« Plus d'informations »** s'affiche sous le produit.
- **Bas de page** : nom de la boutique, propriétaire, description, localisation, boutons WhatsApp et carte.
- Le bouton *Retour* du navigateur fonctionne (détail ↔ grille).

---

## 8. Photos : règle de compression

| Photo envoyée | Ce qui se passe |
|---|---|
| **≤ 120 Ko** (JPEG/PNG/WebP) | Envoyée **telle quelle**, aucune compression |
| **> 120 Ko** | Convertie en **WebP**, ramenée à **≤ 130 Ko**. Qualité maximale recherchée (jusqu'à 92 %) ; si besoin, les dimensions baissent d'abord par paliers (1600 → 1400 → 1200 → 1080 → 960 px…) avant de toucher à la qualité |

Le propriétaire voit la taille avant/après sous le formulaire. Les fichiers retirés ou supprimés sont aussi effacés du stockage.

---

## 9. Réglages « développeur » (SQL Editor, réservés à vous)

```sql
-- Arrêter le mélange aléatoire (ordre fixe = champ « Position » de chaque produit)
update public.boutique set melange_actif = false;
-- Le remettre
update public.boutique set melange_actif = true;

-- Limite de produits (16 par défaut ; la barre de progression de l'espace vendeur suit cette valeur)
update public.boutique set max_produits = 30;

-- Logo de la boutique (le vendeur ne peut pas le changer lui-même)
--   1) Supabase > Storage > boutique-images : envoyez le logo (carré, ≤ 512 Ko), clic dessus > « Get URL »
--   2) puis :
update public.boutique set logo_url = 'https://VOTRE-REF.supabase.co/storage/v1/object/public/boutique-images/logo.webp';
-- Retirer le logo :
update public.boutique set logo_url = null;
```
`cacheMinutes`, `couleur`, `devise`, `lotAffichage`, `vitesseBande` se règlent dans `config.js`.

### Nouveautés du site visiteur
- **Prix** : le prix actuel est en **bleu**, le vrai prix (ancien) est **barré en rouge**.
- **Lien de partage court** : `https://votre-site/#a1b2c3d4` (8 caractères) au lieu du long `?p=…`. Les anciens liens longs déjà partagés fonctionnent toujours. Le lien court est aussi celui écrit dans le message WhatsApp de commande.
- **Position GPS du client** : dans la commande, le bouton « Utiliser ma position (GPS) » demande l'accord du client puis ajoute au message WhatsApp un lien Google Maps de sa position (avec la précision). La position n'est ni enregistrée ni envoyée ailleurs. Le client peut la retirer ; l'adresse écrite reste possible (l'un des deux suffit). Nécessite https (Vercel : oui).

### 9 bis. Gérer les propriétaires (3 maximum)

Ouvrez `SQL/2-gerer-proprietaire.sql`, modifiez **uniquement l'ÉTAPE 1**, puis *Run* :

```sql
v_ajouter  text[] := array['proprio1@gmail.com', 'proprio2@gmail.com', 'proprio3@gmail.com'];  -- 3 d'un coup
v_retirer  text[] := array['ancien@gmail.com', '', ''];                                         -- ou '' = personne
v_confirmer text := '';           -- vide = APERÇU seulement ; 'APPLIQUER' = appliquer
```
Le script affiche d'abord ce qui sera retiré/ajouté et la liste finale. Il refuse (sans rien modifier) un 4ᵉ propriétaire, une adresse invalide, ou de supprimer tous les propriétaires. Retirer un propriétaire ne supprime pas les produits : il perd seulement l'accès.

---

## 10. Vendre le site à un nouveau vendeur — check-list

1. Le vendeur vous donne **son Gmail** (celui avec lequel il se connectera).
2. Nouveau projet Supabase (ou nouveau déploiement) → étapes **1 à 5** avec **son** Gmail dans le SQL.
3. Vous lui remettez : l'adresse du site, l'adresse `…/vendeur.html`, et le rappel « connectez-vous avec Google ».
4. Changement de propriétaire plus tard : `SQL/2-gerer-proprietaire.sql` (retirer l'ancien + ajouter le nouveau dans le même passage).
5. Le logo : envoyez-le vous-même et renseignez `logo_url` (étape 9).

---

## 11. Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| « Configuration manquante » sur `vendeur.html` | `config.js` non rempli | Étape 4 |
| `redirect_uri_mismatch` (Google) | URI de redirection incorrecte | Étape 3-A.3 : `https://REF.supabase.co/auth/v1/callback` exact |
| Après connexion Google, retour sur une page d'erreur / pas connecté | Adresse du site absente des *Redirect URLs* | Étape 3-B.2 |
| « Accès refusé » avec le bon Gmail | Gmail non enregistré ou faute de frappe | `select email from public.proprietaires;` puis `SQL/2-gerer-proprietaire.sql` |
| Produit enregistré mais invisible sur le site | Cache (≤ `cacheMinutes`) ou produit « Masqué » | Attendre / `localStorage.clear()` ; vérifier l'étiquette « Masqué » |
| « Boutique impossible à charger » côté visiteur | URL/clé erronée, ou script SQL non exécuté | Étapes 2 et 4 |
| Image de couverture absente après l'avoir choisie | `SQL/4-v2-couverture.sql` non lancé (message « Base de données non à jour ») ou cache | Lancer le script 4 ; attendre `cacheMinutes` ou `localStorage.clear()` |
| Photo refusée « trop lourde » | Fichier > 512 Ko côté stockage | Ne devrait pas arriver (compression) ; réessayer avec une autre photo |
| « Limite de N produits atteinte » | `max_produits` | Section 9 |
| Numéro WhatsApp refusé | 8 à 15 chiffres, avec indicatif | Ex. `22961000000` |

---

## 12. Ce qui a été vérifié — et ce qui ne l'a pas été

**V1 — vérifié lors de la livraison précédente** (copie locale de Supabase + navigateur automatisé avec simulation de Supabase) :
32 contrôles de sécurité SQL (+1 vérifié à part) (visiteur, autre compte Google, propriétaire, limites, valeurs interdites, rejouabilité du script), la limite par défaut de 16, le logo protégé, la limite de 3 propriétaires, le script d'ajout/retrait (ajout de 3 d'un coup, refus d'un 4ᵉ, refus de 0 propriétaire, adresse invalide, aperçu sans modification) et la migration `3-ameliorations.sql` (sur une installation simulée de l'ancienne version, limite personnalisée conservée) ; site visiteur (grille 2×2, mélange, ordre fixe, cache, galerie, partage, panier, message WhatsApp, pied de page, absence de débordement 320–1200 px) ; nouvel espace vendeur (57 contrôles : accès, absence de documents/selfie/logo, produits, promotion, photos, compteur 16 + barre de progression, limite atteinte, bande, informations, erreurs).

**V2 — vérifié** dans un vrai navigateur (Chromium, écran 390×844) avec un Supabase simulé : en-tête = 20vh exact (168,8 px sur 844 px), fixe pendant le défilement, image de couverture + filtre appliqués, repli si la colonne `cover_url` n'existe pas encore, envoi/remplacement/retrait de la couverture depuis l'espace vendeur, aucune erreur JavaScript.

**Non vérifié par moi** : la connexion Google réelle, vos clés Supabase, l'exécution réelle du SQL V2 sur votre projet, et un téléphone réel. Faites le **test de l'étape 6** après mise en place.

**Limites connues**
- L'aperçu d'un lien partagé sur WhatsApp/Facebook montre le nom et la description de la **boutique** (pas la photo du produit) : le site est statique.
- Pas de notification Telegram des commandes dans la V2 (la commande arrive directement sur le WhatsApp du vendeur) : c'est l'objet de la **V3**.
