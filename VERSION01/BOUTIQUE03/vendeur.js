/* ============================================================================
   vendeur.js — VERSION 3 — Espace vendeur (vendeur.html) — même interface que l'ancien espace vendeur Nya-Market,
   SANS documents ni selfie.
   ----------------------------------------------------------------------------
   • Connexion Google ; accès UNIQUEMENT si le Gmail est dans la table « proprietaires » (fonction SQL est_proprietaire()).
     La vraie protection est côté Supabase (RLS) : même en trafiquant cette page, un autre compte ne peut rien écrire.
   • Produits : ajouter / modifier / masquer / supprimer, 1 à 4 photos, « Plus d'informations » ≤ 60 mots,
     PRIX PROMOTIONNEL (prix normal barré + pourcentage). Publication DIRECTE (aucune validation).
   • Limite de produits : boutique.max_produits (16 par défaut, augmentée par le développeur dans Supabase),
     avec barre de progression. Le logo ne se change PAS ici : il est réglé par le développeur (boutique.logo_url).
   • Photos : ≤ 120 Ko → envoyées telles quelles ; > 120 Ko → WebP ≤ 130 Ko, meilleure qualité possible.
   • Bande défilante : ajouter / modifier / réordonner / masquer / supprimer (table « annonces », 10 maximum).
   • Informations : nom, propriétaire, description, WhatsApp, ville, localisation (table « boutique »).
   • V2 : IMAGE DE COUVERTURE de l'en-tête du site (boutique.cover_url) : choisir / changer / retirer, avec compression automatique.
   • V3 : CARROUSEL promotionnel (3 diapositives : image, titre, texte, lien, ordre, visibilité), COMMANDES reçues (liste, traitée / non traitée),
          NOTIFICATIONS de commande (bot Telegram + webhook : réglages privés enregistrés par des fonctions SQL, jeton jamais relu).
   Toutes les données du vendeur sont échappées (esc) avant affichage : aucune injection HTML possible.
   ============================================================================ */
(function () {
  'use strict';

  var NB = window.NB, cfg = NB.cfg, $ = NB.$;
  var BUCKET = 'boutique-images';
  var DEFAUT_MAX = 16;                         // doit rester identique à la valeur par défaut du SQL
  var MAX_PHOTOS = 4;
  var MAX_ANNONCES = 10;
  var MAX_SLIDES = 3;                          // V3 : diapositives du carrousel (doit rester identique au SQL)
  var MODALES_SIMPLES = ['modal-loc', 'modal-shop', 'modal-ann', 'modal-slide', 'modal-notif'];   // fermées par clic sur le fond ou la touche Échap
  var SEUIL_SANS_COMPRESSION = 120 * 1024;     // ≤ 120 Ko : on n'y touche pas
  var CIBLE_MAX = 130 * 1024;                  // > 120 Ko : on vise ≤ 130 Ko
  var QUALITE_MIN = 0.72;                      // en dessous, on préfère réduire un peu les dimensions

  var sb = null;
  var S = { session: null, boutique: {}, produits: [], annonces: [], photos: [], editId: null, editAnn: null, chargeUne: false, dernierRefresh: 0,
            slides: [], commandes: [], notif: null, manque: {}, editSlide: null, slideImg: null };

  /* ───────────────────────────── Utilitaires ───────────────────────────── */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var timerToast = null;
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(timerToast); timerToast = setTimeout(function () { t.classList.remove('show'); }, 3000); }
  function occupe(msg) { var b = $('busy'); if (msg) { $('busy-msg').textContent = msg; b.classList.remove('hidden'); } else b.classList.add('hidden'); }
  function erreur(id, msg) { var e = $(id); e.textContent = msg || ''; e.classList.toggle('hidden', !msg); }
  function afficher(id, oui, classeAffichage) { var e = $(id); e.classList.toggle('hidden', !oui); if (classeAffichage) e.classList.toggle(classeAffichage, !!oui); }
  function ouvrirModal(id) { $(id).classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
  function fermerModal(id) { $(id).classList.add('hidden'); if (!document.querySelector('.modal-overlay:not(.hidden)')) document.body.style.overflow = ''; }
  function cacherLoader() { var l = $('app-loader'); if (l && l.parentNode) l.parentNode.removeChild(l); }
  function uuid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); }
  function octets(n) { return n >= 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' Mo' : Math.max(1, Math.round(n / 1024)) + ' Ko'; }
  function invaliderCache() { NB.effacer(cfg.cleCache); }
  function limite() { var m = parseInt(S.boutique && S.boutique.max_produits, 10); return m > 0 ? m : DEFAUT_MAX; }
  function fcfa(n) { return Number(n || 0).toLocaleString('fr-FR') + ' ' + cfg.devise; }
  function pourcent(normal, promo) { return Math.round((1 - promo / normal) * 100); }

  function occupeBtn(btn, oui, msg) {
    if (!btn) return;
    if (oui) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>' + (msg || 'Patientez…'); }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }

  /** Traduit les erreurs techniques de Supabase en phrases claires */
  function messageErreur(e) {
    var m = String((e && (e.message || e.error_description)) || e || 'Erreur inconnue');
    if (/row-level security|violates row|permission denied|PGRST116|42501/i.test(m)) return 'Accès refusé : reconnectez-vous avec le compte propriétaire.';
    if (/Limite de/i.test(m)) return m;
    if (/cover_url/i.test(m) && /column|schema cache|find/i.test(m)) return 'Base de données non à jour : lancez SQL/4-v2-couverture.sql dans Supabase.';
    if (/cover_url/i.test(m)) return 'Adresse de l’image de couverture invalide.';
    if (/telegram_token/i.test(m)) return 'Jeton du bot invalide (format attendu : 123456789:AAxxxxxxxx…).';
    if (/telegram_chat_id/i.test(m)) return 'Chat ID invalide (un nombre comme 123456789, négatif pour un groupe, ou @nom_du_canal).';
    if (/webhook_url/i.test(m)) return 'Adresse du webhook invalide (https:// obligatoire).';
    if (/carrousel_non_vide/i.test(m)) return 'Ajoutez au moins une image, un titre ou un texte.';
    if (/does not exist|Could not find the (table|function)|schema cache/i.test(m)) return 'Base de données non à jour : lancez le script SQL de cette version (voir le fichier configuration).';
    if (/plus_infos/i.test(m)) return '« Plus d’informations » : 60 mots maximum.';
    if (/ancien_prix/i.test(m)) return 'Le prix promotionnel doit être inférieur au prix normal.';
    if (/images/i.test(m) && /check|violat/i.test(m)) return 'Il faut entre 1 et 4 photos valides.';
    if (/whatsapp/i.test(m)) return 'Numéro WhatsApp invalide (8 à 15 chiffres, sans + ni espaces).';
    if (/Failed to fetch|NetworkError|network/i.test(m)) return 'Connexion impossible. Vérifiez votre réseau et réessayez.';
    if (/Payload too large|exceeded the maximum|too large/i.test(m)) return 'Photo trop lourde.';
    return m;
  }

  /* ───────────────────────────── Compression d'image ───────────────────────────── */
  function chargerImage(file) {
    return new Promise(function (ok, ko) {
      var u = URL.createObjectURL(file), i = new Image();
      i.onload = function () { URL.revokeObjectURL(u); ok(i); };
      i.onerror = function () { URL.revokeObjectURL(u); ko(new Error('Image illisible.')); };
      i.src = u;
    });
  }
  function decoder(file) {
    if (window.createImageBitmap) return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return chargerImage(file); });
    return chargerImage(file);
  }
  function versBlob(canvas, type, q) { return new Promise(function (ok) { canvas.toBlob(ok, type, q); }); }
  var EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

  /**
   * Règle demandée :
   *  – fichier ≤ 120 Ko (et déjà WebP/JPEG/PNG) → AUCUNE compression, envoyé tel quel ;
   *  – sinon → conversion WebP, taille ≤ 130 Ko. On cherche la meilleure qualité (jusqu'à 0,92) à dimension élevée ;
   *    si la qualité devait descendre sous 0,72, on réduit d'abord un peu les dimensions (1600 → 1400 → 1200 → … px).
   * Retourne { blob, type, ext, taille, origine, compresse }.
   */
  function compresserImage(file) {
    if (!/^image\//.test(file.type)) return Promise.reject(new Error('« ' + file.name + ' » n’est pas une image.'));
    if (file.size <= SEUIL_SANS_COMPRESSION && EXT[file.type]) {
      return Promise.resolve({ blob: file, type: file.type, ext: EXT[file.type], taille: file.size, origine: file.size, compresse: false });
    }
    return decoder(file).then(function (bmp) {
      var w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
      if (!w0 || !h0) throw new Error('Image illisible.');
      var plusGrand = Math.max(w0, h0);
      var cv = document.createElement('canvas'), ctx = cv.getContext('2d');
      var mime = 'image/webp';

      function essai(cote, q) {
        var k = Math.min(1, cote / plusGrand), w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
        cv.width = w; cv.height = h;
        if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
        ctx.drawImage(bmp, 0, 0, w, h);
        return versBlob(cv, mime, q).then(function (b) {
          if (b && b.type !== mime && mime === 'image/webp') { mime = 'image/jpeg'; return essai(cote, q); }   // navigateur sans encodeur WebP
          return b;
        });
      }
      function sortie(b) { return { blob: b, type: b.type, ext: EXT[b.type] || 'webp', taille: b.size, origine: file.size, compresse: true }; }

      var cotes = [Math.min(1600, plusGrand)];
      [1400, 1200, 1080, 960, 800, 640].forEach(function (c) { if (c < cotes[0]) cotes.push(c); });

      function parCote(i) {
        if (i >= cotes.length) return dernierRecours();
        var cote = cotes[i];
        return essai(cote, 0.92).then(function (hi) {
          if (hi.size <= CIBLE_MAX) return sortie(hi);                   // déjà léger en très haute qualité
          return essai(cote, QUALITE_MIN).then(function (lo) {
            if (lo.size > CIBLE_MAX) return parCote(i + 1);              // trop lourd même à 0,72 → dimension inférieure
            var a = QUALITE_MIN, b = 0.92, meilleur = lo, n = 0;
            function dicho() {
              if (n++ >= 6) return sortie(meilleur);
              var m = (a + b) / 2;
              return essai(cote, m).then(function (t) { if (t.size <= CIBLE_MAX) { meilleur = t; a = m; } else b = m; return dicho(); });
            }
            return dicho();
          });
        });
      }
      function dernierRecours() {
        var qs = [0.6, 0.5, 0.4, 0.3], d = null;
        function suite(i) {
          if (i >= qs.length) return sortie(d);
          return essai(640, qs[i]).then(function (t) { d = t; return t.size <= CIBLE_MAX ? sortie(t) : suite(i + 1); });
        }
        return suite(0);
      }
      return parCote(0).then(function (r) { if (bmp.close) bmp.close(); return r; });
    });
  }
  NB.compresserImage = compresserImage;       // (exposée pour les tests)

  /* ───────────────────────────── Stockage ───────────────────────────── */
  function envoyerFichier(dossier, photo) {
    var chemin = dossier + '/' + uuid() + '.' + photo.ext;
    return sb.storage.from(BUCKET).upload(chemin, photo.blob, { contentType: photo.type, cacheControl: '31536000', upsert: false }).then(function (r) {
      if (r.error) throw r.error;
      return { chemin: chemin, url: sb.storage.from(BUCKET).getPublicUrl(chemin).data.publicUrl };
    });
  }
  function cheminDepuisUrl(u) { var i = String(u || '').indexOf('/object/public/' + BUCKET + '/'); return i < 0 ? null : decodeURIComponent(u.slice(i + ('/object/public/' + BUCKET + '/').length).split('?')[0]); }
  function supprimerFichiers(urls) {
    var chemins = (urls || []).map(cheminDepuisUrl).filter(Boolean);
    if (!chemins.length) return Promise.resolve();
    return sb.storage.from(BUCKET).remove(chemins).then(function () { /* nettoyage : l'échec n'est pas bloquant */ }, function () { });
  }

  /* ───────────────────────────── Écrans ───────────────────────────── */
  function vue(nom) {
    afficher('view-landing', nom === 'landing');
    afficher('view-denied', nom === 'denied');
    afficher('view-dashboard', nom === 'dashboard');
    var lo = $('btn-logout');
    lo.classList.toggle('hidden', nom === 'landing');
    lo.classList.toggle('inline-flex', nom !== 'landing');
    afficher('bottom-bar', nom === 'dashboard' && !!NB.chiffres(cfg.whatsappSupport));
  }

  /* ───────────────────────────── Boutons fixes (WhatsApp pré-remplis) ───────────────────────────── */
  function lienWa(texte) { return 'https://wa.me/' + NB.chiffres(cfg.whatsappSupport) + '?text=' + encodeURIComponent(texte); }
  function majContacts() {
    var b = S.boutique || {};
    var nom = b.nom || 'ma boutique';
    $('btn-notify').href = lienWa('🔔 *NOTIFICATION VENDEUR*\n\n🏪 Boutique : ' + nom + '\n👤 Propriétaire : ' + (b.proprietaire || '—') + '\n📧 Gmail : ' + ((S.session && S.session.user && S.session.user.email) || '—') +
      '\n📦 Produits : ' + S.produits.length + '/' + limite() + '\n\nJe souhaite vous informer d\'une mise à jour sur ma boutique.');
    $('btn-contact').href = lienWa('Bonjour, je suis le propriétaire de la boutique « ' + nom + ' ». J\'aimerais avoir une information.');
  }

  /* ───────────────────────────── Connexion ───────────────────────────── */
  function verifier(session) {
    S.session = session;
    occupe('Vérification de votre accès…');
    return sb.rpc('est_proprietaire').then(function (r) {
      if (r.error) throw r.error;
      if (r.data === true) return chargerTout().then(function () { vue('dashboard'); majContacts(); });
      $('denied-email').textContent = (session.user && session.user.email) || '';
      vue('denied');
    }).catch(function (e) { vue('landing'); erreur('login-error', messageErreur(e)); })
      .then(function () { occupe(false); cacherLoader(); });
  }
  function connexion() {
    var btn = $('btn-google');
    erreur('login-error', '');
    occupeBtn(btn, true, 'Redirection vers Google…');
    sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: 'select_account' } } })
      .then(function (r) { if (r.error) { occupeBtn(btn, false); erreur('login-error', messageErreur(r.error)); } });
  }
  function deconnexion() { invaliderCache(); return sb.auth.signOut().then(function () { S.session = null; S.chargeUne = false; vue('landing'); }); }

  /* ───────────────────────────── Chargement des données ───────────────────────────── */
  /** V3 : les nouvelles sections (carrousel, commandes, notifications) sont « douces » : si le script SQL/5 n'a pas été lancé,
      le reste de l'espace vendeur fonctionne quand même et la section affiche un message explicite. */
  function doux(cle, requete) {
    return Promise.resolve(requete).then(function (r) {
      if (r && r.error) { S.manque[cle] = true; return { data: null }; }
      S.manque[cle] = false; return r;
    }, function () { S.manque[cle] = true; return { data: null }; });
  }

  function chargerTout() {
    return Promise.all([
      sb.from('boutique').select('*').eq('id', 1).maybeSingle(),
      sb.from('produits').select('*').order('ordre', { ascending: true }).order('cree_le', { ascending: false }),
      sb.from('annonces').select('*').order('ordre', { ascending: true }).order('cree_le', { ascending: true }),
      doux('carrousel', sb.from('carrousel').select('*').order('ordre', { ascending: true }).order('cree_le', { ascending: true })),
      doux('commandes', sb.from('commandes').select('*').order('cree_le', { ascending: false }).limit(30)),
      doux('notif', sb.rpc('notif_statut'))
    ]).then(function (r) {
      for (var i = 0; i < 3; i++) if (r[i].error) throw r[i].error;
      S.boutique = r[0].data || {}; S.produits = r[1].data || []; S.annonces = r[2].data || [];
      S.slides = r[3].data || []; S.commandes = r[4].data || []; S.notif = r[5].data || null;
      S.chargeUne = true;
      dessinerTout();
    });
  }

  function dessinerTout() { dessinerBoutique(); dessinerProduits(); dessinerCommandes(); dessinerCarrousel(); dessinerAnnonces(); dessinerCouverture(); dessinerNotif(); majContacts(); }

  /* ───────────────────────────── Carte boutique ───────────────────────────── */
  function urlBoutique() { return location.origin + location.pathname.replace(/[^\/]*$/, ''); }

  function dessinerBoutique() {
    var b = S.boutique || {};
    $('shop-name').textContent = b.nom || 'Ma boutique';
    $('brand-name').textContent = b.nom || 'Ma boutique';
    $('shop-account-status').innerHTML = '<span class="badge badge-publie"><i class="fas fa-check-circle"></i> Boutique en ligne</span>';
    var logo = NB.urlImage(b.logo_url), im = $('shop-logo');
    if (logo) im.src = logo; else im.removeAttribute('src');
    im.classList.toggle('hidden', !logo);

    var lieu = [b.ville, b.localisation].filter(Boolean);
    $('shop-location').textContent = lieu.length ? lieu.join(' — ') : 'Ville non renseignée';
    $('btn-edit-loc').textContent = lieu.length ? 'Modifier' : 'Ajouter ma ville';

    var url = urlBoutique();
    $('btn-view-shop').href = url;
    $('shop-link-input').value = url;

    $('i-prop').textContent = b.proprietaire || '—';
    $('i-wa').textContent = b.whatsapp ? '+' + b.whatsapp : '—';
    $('i-desc').textContent = b.description || '—';
    $('cache-min').textContent = String(cfg.cacheMinutes);

    // Compteur + barre de progression (16 par défaut, réglable par le développeur dans Supabase)
    var n = S.produits.length, max = limite(), plein = n >= max;
    $('count-current').textContent = n;
    $('count-max').textContent = max;
    $('count-bar').style.width = Math.min(100, (n / max) * 100) + '%';
    $('count-bar').classList.toggle('full', plein);
    var t = $('count-track'); t.setAttribute('aria-valuemax', String(max)); t.setAttribute('aria-valuenow', String(n));
    $('count-hint').textContent = plein
      ? 'Limite atteinte : supprimez un produit, ou demandez au développeur d’augmenter votre limite.'
      : (max - n) + ' produit' + (max - n > 1 ? 's' : '') + ' encore possible' + (max - n > 1 ? 's' : '') + '.';
    $('btn-add-product').disabled = plein;
    $('btn-add-label').textContent = plein ? 'Limite de ' + max + ' produits atteinte' : 'Ajouter un produit';
  }

  var timerCopie = null;
  function copierTexte(texte) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(texte);
    return new Promise(function (ok, ko) {
      var ta = document.createElement('textarea');
      ta.value = texte; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, texte.length);
      var r = false; try { r = document.execCommand('copy'); } catch (e) { }
      document.body.removeChild(ta);
      r ? ok() : ko(new Error('copie impossible'));
    });
  }
  function copierLien() {
    copierTexte(urlBoutique()).then(function () {
      var l = $('btn-copy-label'); l.textContent = 'Lien copié ✓';
      clearTimeout(timerCopie); timerCopie = setTimeout(function () { l.textContent = 'Copier le lien'; }, 2200);
      toast('Lien copié ✓');
    }).catch(function () { var i = $('shop-link-input'); i.focus(); i.select(); toast('Copie automatique impossible : le lien est sélectionné, copiez-le à la main.'); });
  }
  function partagerLien() {
    var b = S.boutique || {}, url = urlBoutique(), texte = 'Découvrez ma boutique « ' + (b.nom || '') + ' » 🛍️';
    if (navigator.share) { navigator.share({ title: b.nom || 'Ma boutique', text: texte, url: url }).catch(function () { /* annulé */ }); return; }
    var w = window.open('https://wa.me/?text=' + encodeURIComponent(texte + '\n' + url), '_blank'); if (w) w.opener = null;
  }

  /* ───────────────────────────── Ville / localisation ───────────────────────────── */
  function ouvrirLoc() {
    var b = S.boutique || {};
    $('l-ville').value = b.ville || ''; $('l-loc').value = b.localisation || '';
    erreur('loc-error', ''); ouvrirModal('modal-loc');
  }
  function enregistrerLoc(ev) {
    ev.preventDefault(); erreur('loc-error', '');
    var ville = $('l-ville').value.trim(), loc = $('l-loc').value.trim();
    if (ville && (ville.length < 2 || ville.length > 60)) return erreur('loc-error', 'La ville doit faire entre 2 et 60 caractères (ou laissez vide).');
    if (loc && (loc.length < 2 || loc.length > 200)) return erreur('loc-error', 'La localisation doit faire entre 2 et 200 caractères (ou laissez vide).');
    var btn = $('btn-loc-submit'); occupeBtn(btn, true, 'Enregistrement…');
    sb.from('boutique').update({ ville: ville, localisation: loc }).eq('id', 1).select().single()
      .then(function (r) { if (r.error) throw r.error; invaliderCache(); return chargerTout(); })
      .then(function () { fermerModal('modal-loc'); toast('Localisation enregistrée ✓'); })
      .catch(function (e) { erreur('loc-error', 'Échec : ' + messageErreur(e)); })
      .then(function () { occupeBtn(btn, false); });
  }

  /* ───────────────────────────── Informations de la boutique ───────────────────────────── */
  function ouvrirInfos() {
    var b = S.boutique || {};
    $('b-nom').value = b.nom || ''; $('b-prop').value = b.proprietaire || ''; $('b-wa').value = b.whatsapp || ''; $('b-desc').value = b.description || '';
    erreur('shop-error', ''); ouvrirModal('modal-shop');
  }
  function enregistrerInfos(ev) {
    ev.preventDefault(); erreur('shop-error', '');
    var nom = $('b-nom').value.trim(), wa = NB.chiffres($('b-wa').value);
    if (nom.length < 2) return erreur('shop-error', 'Indiquez le nom de la boutique.');
    if (wa.length < 8 || wa.length > 15) return erreur('shop-error', 'Numéro WhatsApp invalide : 8 à 15 chiffres avec l’indicatif (ex. 22961000000).');
    var btn = $('btn-shop-submit'); occupeBtn(btn, true, 'Enregistrement…');
    sb.from('boutique').update({ nom: nom, proprietaire: $('b-prop').value.trim(), description: $('b-desc').value.trim(), whatsapp: wa }).eq('id', 1).select().single()
      .then(function (r) { if (r.error) throw r.error; invaliderCache(); return chargerTout(); })
      .then(function () { fermerModal('modal-shop'); toast('Informations enregistrées ✓'); })
      .catch(function (e) { erreur('shop-error', 'Échec : ' + messageErreur(e)); })
      .then(function () { occupeBtn(btn, false); });
  }

  /* ───────────────────────────── Produits : liste ───────────────────────────── */
  function dessinerProduits() {
    var liste = $('products-list'), n = S.produits.length;
    if (!n) {
      liste.innerHTML =
        '<div class="rounded-2xl border-2 border-dashed border-slate-300 bg-white p-8 text-center text-slate-500">' +
        '<i class="fas fa-box-open text-3xl text-slate-300 mb-2"></i>' +
        '<p class="font-bold text-slate-700">Aucun produit pour le moment</p>' +
        '<p class="text-sm mt-1">Ajoutez votre premier produit pour lancer votre boutique.</p></div>';
      return;
    }
    liste.innerHTML = S.produits.map(function (pr) {
      var img = NB.urlImage(pr.images && pr.images[0]);
      var promo = pr.ancien_prix && pr.ancien_prix > pr.prix;
      var badge = pr.visible
        ? '<span class="badge badge-publie"><i class="fas fa-check"></i> En ligne</span>'
        : '<span class="badge badge-off"><i class="fas fa-eye-slash"></i> Masqué</span>';
      return '' +
        '<article class="prod-card' + (pr.visible ? '' : ' off') + '" data-id="' + esc(pr.id) + '">' +
          (img ? '<img class="prod-thumb" src="' + esc(img) + '" alt="" loading="lazy">' : '<div class="prod-thumb"></div>') +
          '<div class="min-w-0 flex-1">' +
            '<div class="flex items-start justify-between gap-2">' +
              '<h4 class="font-extrabold text-slate-900 leading-tight truncate">' + esc(pr.nom) + '</h4>' + badge +
            '</div>' +
            '<p class="font-extrabold text-deal mt-1">' + esc(fcfa(pr.prix)) +
              (promo ? ' <s class="text-xs font-semibold text-slate-400">' + esc(fcfa(pr.ancien_prix)) + '</s> <span class="badge badge-promo">-' + pourcent(pr.ancien_prix, pr.prix) + '%</span>' : '') + '</p>' +
            '<div class="flex flex-wrap gap-2 mt-2">' +
              '<button type="button" class="prod-act prod-edit" data-action="edit"><i class="fas fa-pen"></i> Modifier</button>' +
              '<button type="button" class="prod-act prod-hide" data-action="toggle"><i class="fas ' + (pr.visible ? 'fa-eye-slash' : 'fa-eye') + '"></i> ' + (pr.visible ? 'Masquer' : 'Afficher') + '</button>' +
              '<button type="button" class="prod-act prod-del" data-action="delete"><i class="fas fa-trash"></i> Supprimer</button>' +
            '</div>' +
          '</div>' +
        '</article>';
    }).join('');
  }

  function clicProduit(e) {
    var btn = e.target.closest('[data-action]'); if (!btn) return;
    var card = btn.closest('.prod-card');
    var p = S.produits.filter(function (x) { return x.id === card.dataset.id; })[0]; if (!p) return;
    if (btn.dataset.action === 'edit') ouvrirProduit(p);
    if (btn.dataset.action === 'toggle') basculerProduit(p);
    if (btn.dataset.action === 'delete') supprimerProduit(p);
  }

  function basculerProduit(p) {
    occupe('Mise à jour…');
    sb.from('produits').update({ visible: !p.visible }).eq('id', p.id).select().single()
      .then(function (r) { if (r.error) throw r.error; invaliderCache(); return chargerTout(); })
      .then(function () { toast(p.visible ? 'Produit masqué du site.' : 'Produit visible sur le site.'); })
      .catch(function (e) { toast(messageErreur(e)); }).then(function () { occupe(false); });
  }

  function supprimerProduit(p) {
    if (!window.confirm('Supprimer définitivement « ' + p.nom + ' » et ses photos ?')) return;
    occupe('Suppression…');
    sb.from('produits').delete().eq('id', p.id).select()
      .then(function (r) { if (r.error) throw r.error; if (!r.data || !r.data.length) throw new Error('Accès refusé'); return supprimerFichiers(p.images); })
      .then(function () { invaliderCache(); return chargerTout(); })
      .then(function () { toast('Produit supprimé'); })
      .catch(function (e) { toast(messageErreur(e)); }).then(function () { occupe(false); });
  }

  /* ───────────────────────────── Produits : formulaire ───────────────────────────── */
  function compteurMots() {
    var n = NB.nbMots($('f-plus').value), c = $('plus-count');
    c.textContent = n + ' / 60 mots'; c.classList.toggle('text-red-600', n > 60);
  }

  function apercuPromo() {
    var normal = parseInt($('f-prix').value, 10), promo = parseInt($('f-promo').value, 10), p = $('promo-preview');
    if (isFinite(normal) && isFinite(promo) && promo >= 1 && promo < normal) {
      p.innerHTML = 'Vos clients verront : <span class="text-deal">' + esc(fcfa(promo)) + '</span> <s class="text-slate-400 font-semibold">' + esc(fcfa(normal)) + '</s> <span class="badge badge-promo">-' + pourcent(normal, promo) + '%</span>';
    } else if (isFinite(normal) && isFinite(promo) && promo >= normal) {
      p.innerHTML = '<span class="text-red-600">Le prix promotionnel doit être inférieur au prix normal.</span>';
    } else p.textContent = '';
  }
  function basculerPromo() { $('promo-box').classList.toggle('hidden', !$('f-promo-on').checked); apercuPromo(); }

  function dessinerPhotos() {
    $('photo-count').textContent = '(' + S.photos.length + '/' + MAX_PHOTOS + ')';
    var html = '';
    for (var i = 0; i < MAX_PHOTOS; i++) {
      var ph = S.photos[i];
      if (ph) {
        html += '<div class="photo-slot filled"><img src="' + esc(ph.apercu) + '" alt="Photo ' + (i + 1) + '">' +
          '<button type="button" class="photo-remove" data-remove="' + i + '" aria-label="Retirer la photo"><i class="fas fa-times"></i></button>' +
          (i > 0 ? '<button type="button" class="photo-main" data-main="' + i + '" aria-label="Mettre en photo principale"><i class="fas fa-arrow-left"></i></button>' : '<span class="photo-tag">Principale</span>') +
          '</div>';
      } else {
        html += '<label for="f-photos" class="photo-slot" aria-label="Ajouter une photo"><i class="fas fa-plus"></i></label>';
      }
    }
    $('photo-grid').innerHTML = html;
  }

  function ouvrirProduit(p) {
    if (!p && S.produits.length >= limite()) { toast('Limite de ' + limite() + ' produits atteinte.'); return; }
    S.editId = p ? p.id : null;
    $('product-title').textContent = p ? 'Modifier le produit' : 'Ajouter un produit';
    $('btn-product-label').textContent = p ? 'Enregistrer les modifications' : 'Publier le produit';
    var promo = !!(p && p.ancien_prix && p.ancien_prix > p.prix);
    $('f-nom').value = p ? p.nom : '';
    $('f-prix').value = p ? (promo ? p.ancien_prix : p.prix) : '';        // prix normal
    $('f-promo-on').checked = promo;
    $('f-promo').value = promo ? p.prix : '';
    $('f-desc').value = p ? (p.description || '') : '';
    $('f-carac').value = p ? (p.caracteristiques || []).join('\n') : '';
    $('f-plus').value = p ? (p.plus_infos || '') : '';
    $('f-ordre').value = p ? p.ordre : 0;
    $('f-visible').checked = p ? p.visible : true;
    S.photos = p ? (p.images || []).map(function (u) { return { url: u, apercu: u, taille: 0 }; }) : [];
    $('f-photos').value = '';
    erreur('product-error', ''); compteurMots(); basculerPromo(); dessinerPhotos();
    ouvrirModal('modal-product');
  }
  function fermerProduit() { S.photos.forEach(function (ph) { if (ph.blob && ph.apercu) URL.revokeObjectURL(ph.apercu); }); S.photos = []; fermerModal('modal-product'); }

  function ajouterFichiers(fichiers) {
    var places = MAX_PHOTOS - S.photos.length, liste = Array.prototype.slice.call(fichiers, 0, Math.max(0, places)), infos = [], erreurs = [];
    if (!liste.length) { toast(MAX_PHOTOS + ' photos maximum.'); return Promise.resolve(); }
    occupe('Optimisation des photos…');
    return liste.reduce(function (chaine, f) {
      return chaine.then(function () {
        return compresserImage(f).then(function (r) {
          S.photos.push({ blob: r.blob, type: r.type, ext: r.ext, apercu: URL.createObjectURL(r.blob), taille: r.taille, origine: r.origine });
          infos.push(r.compresse ? octets(r.origine) + ' → ' + octets(r.taille) : octets(r.taille) + ' (déjà légère, inchangée)');
        }).catch(function (e) { erreurs.push(e.message || String(e)); });
      });
    }, Promise.resolve()).then(function () {
      dessinerPhotos();
      if (infos.length) $('photo-info').textContent = 'Photo(s) prête(s) : ' + infos.join(' · ');
      if (erreurs.length) erreur('product-error', erreurs.join(' '));
      if (liste.length < fichiers.length) toast(MAX_PHOTOS + ' photos maximum : les suivantes ont été ignorées.');
    }).then(function () { occupe(false); }, function () { occupe(false); });
  }

  function lireFormulaireProduit() {
    var nom = $('f-nom').value.trim(), normal = parseInt($('f-prix').value, 10), desc = $('f-desc').value.trim(), plus = $('f-plus').value.trim();
    var carac = $('f-carac').value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    var ordre = parseInt($('f-ordre').value, 10); if (!isFinite(ordre)) ordre = 0;
    var promoOn = $('f-promo-on').checked, promo = parseInt($('f-promo').value, 10);
    var e = null;
    if (!S.photos.length) e = 'Ajoutez au moins une photo.';
    else if (nom.length < 2) e = 'Indiquez le nom du produit.';
    else if (!isFinite(normal) || normal < 1 || normal > 100000000) e = 'Indiquez un prix valide en ' + cfg.devise + ' (en chiffres).';
    else if (promoOn && (!isFinite(promo) || promo < 1)) e = 'Indiquez le prix promotionnel (ou décochez « Mettre ce produit en promotion »).';
    else if (promoOn && promo >= normal) e = 'Le prix promotionnel doit être inférieur au prix normal.';
    else if (desc.length > 600) e = 'Description trop longue (600 caractères maximum).';
    else if (carac.length > 15) e = '15 caractéristiques maximum.';
    else if (carac.some(function (c) { return c.length > 200; })) e = 'Une caractéristique dépasse 200 caractères.';
    else if (NB.nbMots(plus) > 60) e = '« Plus d’informations » : 60 mots maximum (vous en avez ' + NB.nbMots(plus) + ').';
    else if (plus.length > 700) e = '« Plus d’informations » est trop long.';
    else if (!S.editId && S.produits.length >= limite()) e = 'Limite de ' + limite() + ' produits atteinte.';
    // promotion : prix = prix promotionnel, ancien_prix = prix normal (barré). Sans promotion : ancien_prix vide.
    return { erreur: e, ligne: { nom: nom, prix: promoOn ? promo : normal, ancien_prix: promoOn ? normal : null, description: desc, caracteristiques: carac, plus_infos: plus, visible: $('f-visible').checked, ordre: Math.max(-100000, Math.min(100000, ordre)) } };
  }

  function enregistrerProduit(ev) {
    ev.preventDefault(); erreur('product-error', '');
    var f = lireFormulaireProduit(); if (f.erreur) return erreur('product-error', f.erreur);
    var anciennes = [], envoyes = [];
    if (S.editId) { var orig = S.produits.filter(function (p) { return p.id === S.editId; })[0]; anciennes = (orig && orig.images) || []; }
    var btn = $('btn-product-submit'); occupeBtn(btn, true, 'Envoi des photos…');

    // 1) envoi des NOUVELLES photos (dans l'ordre), les photos déjà en ligne sont conservées
    var urls = [];
    S.photos.reduce(function (chaine, ph) {
      return chaine.then(function () {
        if (ph.url) { urls.push(ph.url); return; }
        return envoyerFichier('produits', ph).then(function (r) { urls.push(r.url); envoyes.push(r.url); });
      });
    }, Promise.resolve()).then(function () {
      f.ligne.images = urls;
      return S.editId ? sb.from('produits').update(f.ligne).eq('id', S.editId).select().single() : sb.from('produits').insert(f.ligne).select().single();
    }).then(function (r) {
      if (r.error) throw r.error;
      // 2) nettoyage : photos retirées par le propriétaire
      return supprimerFichiers(anciennes.filter(function (u) { return urls.indexOf(u) < 0; }));
    }).then(function () { invaliderCache(); return chargerTout(); })
      .then(function () { fermerProduit(); toast('Produit enregistré ✓ Visible sur le site d’ici ' + cfg.cacheMinutes + ' min environ.'); })
      .catch(function (e) { return supprimerFichiers(envoyes).then(function () { erreur('product-error', 'Échec : ' + messageErreur(e)); }); })     // échec : on retire les fichiers déjà envoyés
      .then(function () { occupeBtn(btn, false); });
  }

  /* ───────────────────────────── Bande défilante ───────────────────────────── */
  function dessinerAnnonces() {
    var liste = $('ann-list'), n = S.annonces.length;
    $('ann-count').textContent = '(' + n + '/' + MAX_ANNONCES + ')';
    $('btn-add-ann').disabled = n >= MAX_ANNONCES;
    if (!n) { liste.innerHTML = '<p class="rounded-2xl border-2 border-dashed border-slate-300 bg-white p-5 text-center text-sm text-slate-500">Aucun message : la bande est masquée sur votre site.</p>'; return; }
    liste.innerHTML = S.annonces.map(function (a, i) {
      return '<article class="ann-card' + (a.visible ? '' : ' off') + '" data-id="' + esc(a.id) + '">' +
        '<div class="min-w-0 flex-1"><p class="font-bold text-sm break-words">' + esc(a.message) + (a.visible ? '' : ' <span class="badge badge-off">Masqué</span>') + '</p>' +
        (a.lien ? '<p class="text-xs text-slate-500 break-all mt-0.5">🔗 ' + esc(a.lien) + '</p>' : '') +
        '<div class="flex flex-wrap gap-2 mt-2">' +
          '<button type="button" class="prod-act prod-hide" data-aa="up" aria-label="Monter"' + (i === 0 ? ' disabled' : '') + '><i class="fas fa-arrow-up"></i></button>' +
          '<button type="button" class="prod-act prod-hide" data-aa="down" aria-label="Descendre"' + (i === n - 1 ? ' disabled' : '') + '><i class="fas fa-arrow-down"></i></button>' +
          '<button type="button" class="prod-act prod-edit" data-aa="edit"><i class="fas fa-pen"></i> Modifier</button>' +
          '<button type="button" class="prod-act prod-hide" data-aa="toggle"><i class="fas ' + (a.visible ? 'fa-eye-slash' : 'fa-eye') + '"></i> ' + (a.visible ? 'Masquer' : 'Afficher') + '</button>' +
          '<button type="button" class="prod-act prod-del" data-aa="delete"><i class="fas fa-trash"></i></button>' +
        '</div></div></article>';
    }).join('');
  }

  function executer(promesse, ok) {
    occupe('Enregistrement…');
    return promesse.then(function (r) { if (r && r.error) throw r.error; invaliderCache(); return chargerTout(); })
      .then(function () { if (ok) toast(ok); return true; })
      .catch(function (e) { toast(messageErreur(e)); return false; }).then(function (v) { occupe(false); return v; });
  }
  function deplacerAnnonce(i, sens) {
    var j = i + sens; if (j < 0 || j >= S.annonces.length) return;
    var ids = S.annonces.map(function (a) { return a.id; }); var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    occupe('Enregistrement…');
    ids.reduce(function (c, id, k) { return c.then(function () { var a = S.annonces.filter(function (x) { return x.id === id; })[0]; if (a.ordre === k) return; return sb.from('annonces').update({ ordre: k }).eq('id', id).then(function (r) { if (r.error) throw r.error; }); }); }, Promise.resolve())
      .then(function () { invaliderCache(); return chargerTout(); }).catch(function (e) { toast(messageErreur(e)); }).then(function () { occupe(false); });
  }
  function clicAnnonce(e) {
    var b = e.target.closest('[data-aa]'); if (!b) return;
    var card = b.closest('.ann-card'), idx = -1;
    S.annonces.forEach(function (a, i) { if (a.id === card.dataset.id) idx = i; });
    if (idx < 0) return;
    var a = S.annonces[idx], act = b.dataset.aa;
    if (act === 'up') deplacerAnnonce(idx, -1);
    if (act === 'down') deplacerAnnonce(idx, 1);
    if (act === 'edit') ouvrirAnnonce(a);
    if (act === 'toggle') executer(sb.from('annonces').update({ visible: !a.visible }).eq('id', a.id).select().single(), 'Message mis à jour.');
    if (act === 'delete' && window.confirm('Supprimer ce message de la bande défilante ?')) executer(sb.from('annonces').delete().eq('id', a.id).select(), 'Message supprimé.');
  }
  function ouvrirAnnonce(a) {
    S.editAnn = a ? a.id : null;
    $('ann-title').textContent = a ? 'Modifier le message' : 'Nouveau message';
    $('a-msg').value = a ? a.message : ''; $('a-lien').value = a && a.lien ? a.lien : ''; $('a-visible').checked = a ? a.visible : true;
    erreur('ann-error', ''); $('a-count').textContent = $('a-msg').value.length + ' / 160'; ouvrirModal('modal-ann');
  }
  function enregistrerAnnonce(ev) {
    ev.preventDefault(); erreur('ann-error', '');
    var msg = $('a-msg').value.trim(), lien = $('a-lien').value.trim();
    if (msg.length < 2) return erreur('ann-error', 'Écrivez un message.');
    if (lien && !/^(https:\/\/|\/|\?|#)/i.test(lien)) return erreur('ann-error', 'Le lien doit commencer par https://');
    var champs = { message: msg, lien: lien || null, visible: $('a-visible').checked }, p;
    if (S.editAnn) p = sb.from('annonces').update(champs).eq('id', S.editAnn).select().single();
    else { champs.ordre = S.annonces.reduce(function (m, a) { return Math.max(m, a.ordre); }, -1) + 1; p = sb.from('annonces').insert(champs).select().single(); }
    var btn = $('btn-ann-submit'); occupeBtn(btn, true, 'Enregistrement…');
    executer(p, 'Bande défilante mise à jour ✓').then(function (ok) { occupeBtn(btn, false); if (ok) fermerModal('modal-ann'); else erreur('ann-error', 'Enregistrement impossible.'); });
  }

  /* ───────────────────────────── V2 : image de couverture de l'en-tête ───────────────────────────── */
  function dessinerCouverture() {
    var b = S.boutique || {}, u = NB.urlImage(b.cover_url), im = $('cover-img');
    if (u) im.src = u; else im.removeAttribute('src');
    im.classList.toggle('hidden', !u);
    $('cover-empty').classList.toggle('hidden', !!u);
    $('cover-preview-name').textContent = b.nom || 'Ma boutique';
    $('btn-cover-remove').disabled = !u;
    $('btn-cover-label').textContent = u ? 'Changer l’image' : 'Choisir une image';
  }

  /** Compresse (≤ 130 Ko) → envoie dans le stockage → enregistre l'adresse → supprime l'ancienne image. */
  function changerCouverture(fichier) {
    erreur('cover-error', '');
    var ancienne = NB.urlImage((S.boutique || {}).cover_url), neuve = null, publie = false;
    occupe('Optimisation de l’image…');
    return compresserImage(fichier).then(function (r) {
      occupe('Envoi de l’image…');
      return envoyerFichier('couverture', r);
    }).then(function (r) {
      neuve = r.url;
      return sb.from('boutique').update({ cover_url: neuve }).eq('id', 1).select().single();
    }).then(function (r) {
      if (r.error) throw r.error;
      publie = true;                                                         // à partir d'ici la nouvelle image est en ligne
      return supprimerFichiers(ancienne ? [ancienne] : []);
    }).then(function () { invaliderCache(); return chargerTout(); })
      .then(function () { toast('Image de couverture enregistrée ✓ Visible d’ici ' + cfg.cacheMinutes + ' min environ.'); })
      .catch(function (e) {
        var nettoyage = (neuve && !publie) ? supprimerFichiers([neuve]) : Promise.resolve();   // échec avant publication : on retire le fichier envoyé
        return nettoyage.then(function () { erreur('cover-error', 'Échec : ' + messageErreur(e)); });
      })
      .then(function () { occupe(false); });
  }

  function retirerCouverture() {
    var ancienne = NB.urlImage((S.boutique || {}).cover_url); if (!ancienne) return;
    if (!window.confirm('Retirer l’image de couverture ? Le site affichera le dégradé de la couleur de votre boutique.')) return;
    erreur('cover-error', ''); occupe('Suppression…');
    sb.from('boutique').update({ cover_url: null }).eq('id', 1).select().single()
      .then(function (r) { if (r.error) throw r.error; return supprimerFichiers([ancienne]); })
      .then(function () { invaliderCache(); return chargerTout(); })
      .then(function () { toast('Image de couverture retirée.'); })
      .catch(function (e) { erreur('cover-error', 'Échec : ' + messageErreur(e)); })
      .then(function () { occupe(false); });
  }

  /* ───────────────────────────── V3 : commandes reçues ───────────────────────────── */
  function dessinerCommandes() {
    var liste = $('cmd-list'), cnt = $('cmd-count');
    if (S.manque.commandes) {
      cnt.textContent = '';
      liste.innerHTML = '<p class="rounded-2xl border-2 border-dashed border-slate-300 bg-white p-5 text-center text-sm text-slate-500">Section indisponible : lancez <strong>SQL/5-v3-carrousel-commandes.sql</strong> dans Supabase.</p>';
      return;
    }
    var nouvelles = S.commandes.filter(function (c) { return c.statut === 'nouvelle'; }).length;
    cnt.textContent = nouvelles ? '(' + nouvelles + ' nouvelle' + (nouvelles > 1 ? 's' : '') + ')' : '';
    if (!S.commandes.length) {
      liste.innerHTML = '<p class="rounded-2xl border-2 border-dashed border-slate-300 bg-white p-5 text-center text-sm text-slate-500">Aucune commande pour le moment.</p>';
      return;
    }
    liste.innerHTML = S.commandes.map(function (c) {
      var lignes = Array.isArray(c.lignes) ? c.lignes : [];
      var d = new Date(c.cree_le), date = isNaN(d) ? '' : d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      var tel = NB.chiffres(c.tel), fait = c.statut === 'traitee';
      var gps = /^-?[0-9]{1,3}(\.[0-9]+)?,-?[0-9]{1,3}(\.[0-9]+)?$/.test(c.gps || '') ? 'https://www.google.com/maps?q=' + c.gps : '';
      var devise = c.devise || cfg.devise;
      return '<article class="cmd-card' + (fait ? ' done' : '') + '" data-num="' + esc(c.numero) + '">' +
        '<div class="flex items-start justify-between gap-2">' +
          '<p class="font-extrabold text-slate-900 break-words min-w-0">#' + esc(c.numero) + ' · ' + esc(c.nom) + '</p>' +
          (fait ? '<span class="badge badge-publie"><i class="fas fa-check"></i> Traitée</span>' : '<span class="badge badge-review"><i class="fas fa-bell"></i> Nouvelle</span>') +
        '</div>' +
        '<p class="text-xs text-slate-500">' + esc(date) + '</p>' +
        '<p class="font-extrabold text-deal mt-1">' + esc(Number(c.total || 0).toLocaleString('fr-FR') + ' ' + devise) + '</p>' +
        '<details class="mt-1"><summary class="text-sm font-bold text-brand cursor-pointer">Voir le détail</summary>' +
          '<ul class="cmd-lines">' + lignes.map(function (l) { return '<li>' + esc(l.nom) + ' × ' + esc(l.qte) + ' — ' + esc(Number((l.prix || 0) * (l.qte || 1)).toLocaleString('fr-FR') + ' ' + devise) + '</li>'; }).join('') + '</ul>' +
          '<div class="mt-2 text-sm space-y-1">' +
            (tel ? '<p><i class="fas fa-phone text-brand"></i> <a class="underline font-semibold" href="tel:+' + esc(tel) + '">' + esc(c.tel) + '</a></p>' : '') +
            (c.adresse ? '<p><i class="fas fa-map-marker-alt text-brand"></i> ' + esc(c.adresse) + '</p>' : '') +
            (gps ? '<p><i class="fas fa-location-crosshairs text-brand"></i> <a class="underline font-semibold" href="' + esc(gps) + '" target="_blank" rel="noopener">Position GPS du client</a></p>' : '') +
            (c.note ? '<p><i class="fas fa-pen text-brand"></i> ' + esc(c.note) + '</p>' : '') +
          '</div>' +
        '</details>' +
        '<div class="flex flex-wrap gap-2 mt-2">' +
          '<button type="button" class="prod-act prod-hide" data-cm="toggle"><i class="fas ' + (fait ? 'fa-rotate-left' : 'fa-check') + '"></i> ' + (fait ? 'Remettre en nouvelle' : 'Marquer traitée') + '</button>' +
          '<button type="button" class="prod-act prod-del" data-cm="delete"><i class="fas fa-trash"></i></button>' +
        '</div>' +
      '</article>';
    }).join('');
  }

  function clicCommande(e) {
    var b = e.target.closest('[data-cm]'); if (!b) return;
    var card = b.closest('.cmd-card'), num = card && card.dataset.num;
    var c = S.commandes.filter(function (x) { return String(x.numero) === num; })[0]; if (!c) return;
    if (b.dataset.cm === 'toggle') executer(sb.from('commandes').update({ statut: c.statut === 'traitee' ? 'nouvelle' : 'traitee' }).eq('numero', c.numero).select().single(), 'Commande mise à jour ✓');
    if (b.dataset.cm === 'delete' && window.confirm('Supprimer définitivement la commande #' + c.numero + ' ?')) executer(sb.from('commandes').delete().eq('numero', c.numero).select(), 'Commande supprimée.');
  }

  /* ───────────────────────────── V3 : carrousel promotionnel ───────────────────────────── */
  function dessinerCarrousel() {
    var liste = $('slide-list'), n = S.slides.length;
    $('slide-count').textContent = S.manque.carrousel ? '' : '(' + n + '/' + MAX_SLIDES + ')';
    $('btn-add-slide').disabled = !!S.manque.carrousel || n >= MAX_SLIDES;
    if (S.manque.carrousel) {
      liste.innerHTML = '<p class="rounded-2xl border-2 border-dashed border-slate-300 bg-white p-5 text-center text-sm text-slate-500">Section indisponible : lancez <strong>SQL/5-v3-carrousel-commandes.sql</strong> dans Supabase.</p>';
      return;
    }
    if (!n) { liste.innerHTML = '<p class="rounded-2xl border-2 border-dashed border-slate-300 bg-white p-5 text-center text-sm text-slate-500">Aucune diapositive : le carrousel est masqué sur votre site.</p>'; return; }
    liste.innerHTML = S.slides.map(function (sl, i) {
      var img = NB.urlImage(sl.image_url);
      return '<article class="ann-card' + (sl.visible ? '' : ' off') + '" data-id="' + esc(sl.id) + '">' +
        (img ? '<img class="slide-thumb" src="' + esc(img) + '" alt="" loading="lazy">' : '<div class="slide-thumb slide-thumb-none"><i class="fas fa-image"></i></div>') +
        '<div class="min-w-0 flex-1"><p class="font-bold text-sm break-words">' + esc(sl.titre || '(sans titre)') + (sl.visible ? '' : ' <span class="badge badge-off">Masquée</span>') + '</p>' +
        (sl.texte ? '<p class="text-xs text-slate-600 break-words mt-0.5">' + esc(sl.texte) + '</p>' : '') +
        (sl.lien ? '<p class="text-xs text-slate-500 break-all mt-0.5">🔗 ' + esc(sl.lien) + '</p>' : '') +
        '<div class="flex flex-wrap gap-2 mt-2">' +
          '<button type="button" class="prod-act prod-hide" data-sl="up" aria-label="Monter"' + (i === 0 ? ' disabled' : '') + '><i class="fas fa-arrow-up"></i></button>' +
          '<button type="button" class="prod-act prod-hide" data-sl="down" aria-label="Descendre"' + (i === n - 1 ? ' disabled' : '') + '><i class="fas fa-arrow-down"></i></button>' +
          '<button type="button" class="prod-act prod-edit" data-sl="edit"><i class="fas fa-pen"></i> Modifier</button>' +
          '<button type="button" class="prod-act prod-hide" data-sl="toggle"><i class="fas ' + (sl.visible ? 'fa-eye-slash' : 'fa-eye') + '"></i> ' + (sl.visible ? 'Masquer' : 'Afficher') + '</button>' +
          '<button type="button" class="prod-act prod-del" data-sl="delete"><i class="fas fa-trash"></i></button>' +
        '</div></div></article>';
    }).join('');
  }

  function deplacerSlide(i, sens) {
    var j = i + sens; if (j < 0 || j >= S.slides.length) return;
    var ids = S.slides.map(function (a) { return a.id; }); var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    occupe('Enregistrement…');
    ids.reduce(function (c, id, k) {
      return c.then(function () {
        var a = S.slides.filter(function (x) { return x.id === id; })[0]; if (a.ordre === k) return;
        return sb.from('carrousel').update({ ordre: k }).eq('id', id).then(function (r) { if (r.error) throw r.error; });
      });
    }, Promise.resolve())
      .then(function () { invaliderCache(); return chargerTout(); }).catch(function (e) { toast(messageErreur(e)); }).then(function () { occupe(false); });
  }

  function clicSlide(e) {
    var b = e.target.closest('[data-sl]'); if (!b) return;
    var card = b.closest('.ann-card'), idx = -1;
    S.slides.forEach(function (a, i) { if (a.id === card.dataset.id) idx = i; });
    if (idx < 0) return;
    var sl = S.slides[idx], act = b.dataset.sl;
    if (act === 'up') deplacerSlide(idx, -1);
    if (act === 'down') deplacerSlide(idx, 1);
    if (act === 'edit') ouvrirSlide(sl);
    if (act === 'toggle') executer(sb.from('carrousel').update({ visible: !sl.visible }).eq('id', sl.id).select().single(), 'Diapositive mise à jour.');
    if (act === 'delete' && window.confirm('Supprimer cette diapositive ?')) {
      occupe('Suppression…');
      sb.from('carrousel').delete().eq('id', sl.id).select()
        .then(function (r) { if (r.error) throw r.error; if (!r.data || !r.data.length) throw new Error('Accès refusé'); return supprimerFichiers(sl.image_url ? [sl.image_url] : []); })
        .then(function () { invaliderCache(); return chargerTout(); })
        .then(function () { toast('Diapositive supprimée.'); })
        .catch(function (e) { toast(messageErreur(e)); }).then(function () { occupe(false); });
    }
  }

  function libererApercuSlide() { if (S.slideImg && S.slideImg.blob && S.slideImg.apercu) URL.revokeObjectURL(S.slideImg.apercu); }

  function dessinerApercuSlide() {
    var im = $('slide-img'), u = S.slideImg ? S.slideImg.apercu : '';
    if (u) im.src = u; else im.removeAttribute('src');
    im.classList.toggle('hidden', !u);
    $('sp-titre').textContent = $('s-titre').value.trim() || 'Votre titre';
    $('sp-texte').textContent = $('s-texte').value.trim() || 'Votre texte promotionnel';
    $('s-titre-count').textContent = $('s-titre').value.length + ' / 60';
    $('s-texte-count').textContent = $('s-texte').value.length + ' / 140';
    $('btn-slide-img-remove').disabled = !u;
    $('btn-slide-img-label').textContent = u ? 'Changer l’image' : 'Choisir une image';
  }

  function ouvrirSlide(sl) {
    if (!sl && S.slides.length >= MAX_SLIDES) { toast('Limite de ' + MAX_SLIDES + ' diapositives atteinte.'); return; }
    libererApercuSlide();
    S.editSlide = sl ? sl.id : null;
    S.slideImg = sl && NB.urlImage(sl.image_url) ? { url: sl.image_url, apercu: sl.image_url } : null;
    $('slide-title').textContent = sl ? 'Modifier la diapositive' : 'Nouvelle diapositive';
    $('s-titre').value = sl ? sl.titre : ''; $('s-texte').value = sl ? sl.texte : ''; $('s-lien').value = sl && sl.lien ? sl.lien : '';
    $('s-visible').checked = sl ? sl.visible : true; $('s-photo').value = '';
    erreur('slide-error', ''); dessinerApercuSlide(); ouvrirModal('modal-slide');
  }
  function fermerSlide() { libererApercuSlide(); S.slideImg = null; fermerModal('modal-slide'); }

  function choisirImageSlide(fichier) {
    occupe('Optimisation de l’image…'); erreur('slide-error', '');
    return compresserImage(fichier).then(function (r) {
      libererApercuSlide();
      S.slideImg = { blob: r.blob, type: r.type, ext: r.ext, apercu: URL.createObjectURL(r.blob), taille: r.taille };
      dessinerApercuSlide();
    }).catch(function (e) { erreur('slide-error', e.message || String(e)); }).then(function () { occupe(false); });
  }

  function enregistrerSlide(ev) {
    ev.preventDefault(); erreur('slide-error', '');
    var titre = $('s-titre').value.trim(), texte = $('s-texte').value.trim(), lien = $('s-lien').value.trim();
    if (!titre && !texte && !S.slideImg) return erreur('slide-error', 'Ajoutez au moins une image, un titre ou un texte.');
    if (titre.length > 60) return erreur('slide-error', 'Titre trop long (60 caractères maximum).');
    if (texte.length > 140) return erreur('slide-error', 'Texte trop long (140 caractères maximum).');
    if (lien && !/^(https:\/\/|\/|\?|#)/i.test(lien)) return erreur('slide-error', 'Le lien doit commencer par https://');
    if (!S.editSlide && S.slides.length >= MAX_SLIDES) return erreur('slide-error', 'Limite de ' + MAX_SLIDES + ' diapositives atteinte.');

    var orig = S.editSlide ? S.slides.filter(function (x) { return x.id === S.editSlide; })[0] : null;
    var ancienne = orig && orig.image_url ? orig.image_url : null, envoye = null, publie = false, finale = null;
    var btn = $('btn-slide-submit'); occupeBtn(btn, true, 'Enregistrement…');

    var etape = Promise.resolve(null);
    if (S.slideImg && S.slideImg.blob) etape = envoyerFichier('carrousel', S.slideImg).then(function (r) { envoye = r.url; return r.url; });
    else if (S.slideImg) etape = Promise.resolve(S.slideImg.url);

    etape.then(function (url) {
      finale = url || null;
      var champs = { titre: titre, texte: texte, image_url: finale, lien: lien || null, visible: $('s-visible').checked };
      if (S.editSlide) return sb.from('carrousel').update(champs).eq('id', S.editSlide).select().single();
      champs.ordre = S.slides.reduce(function (m, a) { return Math.max(m, a.ordre); }, -1) + 1;
      return sb.from('carrousel').insert(champs).select().single();
    }).then(function (r) {
      if (r.error) throw r.error;
      publie = true;
      return supprimerFichiers(ancienne && ancienne !== finale ? [ancienne] : []);          // ancienne image remplacée ou retirée
    }).then(function () { invaliderCache(); return chargerTout(); })
      .then(function () { fermerSlide(); toast('Diapositive enregistrée ✓ Visible d’ici ' + cfg.cacheMinutes + ' min environ.'); })
      .catch(function (e) {
        var nettoyage = (envoye && !publie) ? supprimerFichiers([envoye]) : Promise.resolve();
        return nettoyage.then(function () { erreur('slide-error', 'Échec : ' + messageErreur(e)); });
      })
      .then(function () { occupeBtn(btn, false); });
  }

  /* ───────────────────────────── V3 : notifications de commandes ───────────────────────────── */
  function dessinerNotif() {
    var n = S.notif, ok = !S.manque.notif && !!n;
    $('btn-notif-edit').disabled = !ok; $('btn-notif-test').disabled = !ok;
    var avert = $('notif-warn');
    if (!ok) {
      $('ns-tg').textContent = '—'; $('ns-wh').textContent = '—'; $('ns-actif').textContent = '—';
      avert.textContent = 'Section indisponible : lancez SQL/5-v3-carrousel-commandes.sql dans Supabase.'; avert.classList.remove('hidden');
      return;
    }
    $('ns-tg').textContent = n.telegram ? '✅ Connecté (Chat ID ' + n.chat_id + ', jeton …' + n.token_fin + ')' : '⚠️ Non configuré';
    var hote = ''; if (n.webhook) { try { hote = new URL(n.webhook).host; } catch (e) { hote = 'adresse enregistrée'; } }
    $('ns-wh').textContent = n.webhook ? '✅ ' + hote : '— (facultatif)';
    $('ns-actif').textContent = n.actif ? 'Activé' : '⏸ Désactivé : aucun message n’est envoyé';
    var rien = !n.telegram && !n.webhook;
    avert.textContent = rien ? 'Aucune notification configurée : touchez « Configurer » pour recevoir vos commandes sur Telegram. En attendant, elles restent visibles dans « Commandes reçues » et arrivent toujours sur votre WhatsApp.' : '';
    avert.classList.toggle('hidden', !rien);
  }

  function ouvrirNotif() {
    var n = S.notif || {};
    $('n-token').value = ''; $('n-chat').value = n.chat_id || ''; $('n-webhook').value = n.webhook || ''; $('n-actif').checked = n.actif !== false;
    $('n-token-hint').textContent = n.telegram
      ? 'Un jeton est déjà enregistré (…' + n.token_fin + '). Laissez ce champ vide pour le conserver, ou collez-en un nouveau pour le remplacer.'
      : 'Le jeton est enregistré de façon privée dans la base : il n’est jamais affiché ni relu par cette page.';
    $('btn-notif-clear').classList.toggle('hidden', !n.telegram);
    erreur('notif-error', ''); ouvrirModal('modal-notif');
  }

  function enregistrerNotif(ev, vider) {
    if (ev && ev.preventDefault) ev.preventDefault(); erreur('notif-error', '');
    var token = $('n-token').value.trim(), chat = $('n-chat').value.trim(), hook = $('n-webhook').value.trim();
    if (!vider) {
      if (token && !/^[0-9]{6,12}:[A-Za-z0-9_-]{30,50}$/.test(token)) return erreur('notif-error', 'Jeton invalide : copiez-le tel quel depuis @BotFather (ex. 123456789:AAxxxxxxxx…).');
      if (chat && !/^(-?[0-9]{5,20}|@[A-Za-z0-9_]{5,32})$/.test(chat)) return erreur('notif-error', 'Chat ID invalide : un nombre (ex. 123456789, négatif pour un groupe) ou @nom_du_canal.');
      if (hook && !/^https:\/\//i.test(hook)) return erreur('notif-error', 'Le webhook doit commencer par https://');
      if ((token || (S.notif && S.notif.telegram)) && !chat) return erreur('notif-error', 'Indiquez votre Chat ID Telegram.');
      if (chat && !token && !(S.notif && S.notif.telegram)) return erreur('notif-error', 'Indiquez le jeton de votre bot Telegram.');
    }
    var btn = $('btn-notif-submit'); occupeBtn(btn, true, 'Enregistrement…');
    sb.rpc('notif_enregistrer', { p_token: token, p_chat_id: vider ? '' : chat, p_webhook: hook, p_actif: $('n-actif').checked, p_vider_token: !!vider })
      .then(function (r) { if (r.error) throw r.error; return chargerTout(); })
      .then(function () { fermerModal('modal-notif'); toast(vider ? 'Bot Telegram retiré.' : 'Notifications enregistrées ✓ Envoyez un test pour vérifier.'); })
      .catch(function (e) { erreur('notif-error', 'Échec : ' + messageErreur(e)); })
      .then(function () { occupeBtn(btn, false); });
  }

  function testerNotif() {
    var sortie = $('notif-test-result'); sortie.classList.add('hidden');
    function montrer(txt) { sortie.textContent = txt; sortie.classList.remove('hidden'); }
    occupe('Envoi du message de test…');
    sb.rpc('notif_tester').then(function (r) {
      if (r.error) throw r.error;
      var envois = r.data || [];
      if (!envois.length) throw new Error('Aucun canal actif : renseignez le bot Telegram (jeton + Chat ID) ou un webhook, et cochez « Envoyer les notifications ».');
      occupe('Vérification de la réception…');
      return new Promise(function (ok) { setTimeout(ok, 3000); }).then(function () {
        return sb.rpc('notif_resultats', { p_ids: envois.map(function (x) { return x.id; }) });
      }).then(function (r2) { if (r2.error) throw r2.error; return { envois: envois, res: r2.data || [] }; });
    }).then(function (o) {
      montrer(o.envois.map(function (x) {
        var rr = o.res.filter(function (y) { return y.id === x.id; })[0], nom = x.canal === 'telegram' ? 'Telegram' : 'Webhook';
        if (!rr) return '⏳ ' + nom + ' : pas encore de réponse, réessayez le test dans quelques secondes.';
        if (rr.status >= 200 && rr.status < 300) return '✅ ' + nom + ' : message envoyé, vérifiez votre téléphone.';
        return '❌ ' + nom + ' : échec (code ' + (rr.status || 'aucune réponse') + '). ' + (rr.extrait || '');
      }).join('\n'));
    }).catch(function (e) { montrer('❌ ' + messageErreur(e)); }).then(function () { occupe(false); });
  }

  /* ───────────────────────────── Démarrage ───────────────────────────── */
  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('.devise'), function (n) { n.textContent = cfg.devise; });
    $('cache-min').textContent = String(cfg.cacheMinutes);
    document.documentElement.style.setProperty('--nb-couleur', cfg.couleur);

    if (!window.supabase || /VOTRE/i.test(cfg.supabaseUrl) || /VOTRE/i.test(cfg.supabaseKey)) {
      vue('landing'); cacherLoader(); erreur('login-error', 'Configuration manquante : renseignez supabaseUrl et supabaseKey dans config.js.'); $('btn-google').disabled = true; return;
    }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });

    $('btn-google').onclick = connexion;
    $('btn-logout').onclick = deconnexion;
    $('btn-denied-out').onclick = deconnexion;
    $('btn-add-product').onclick = function () { ouvrirProduit(null); };
    $('products-list').addEventListener('click', clicProduit);
    $('btn-edit-loc').onclick = ouvrirLoc;
    $('btn-loc-close').onclick = function () { fermerModal('modal-loc'); };
    $('form-loc').addEventListener('submit', enregistrerLoc);
    $('btn-edit-shop').onclick = ouvrirInfos;
    $('btn-shop-close').onclick = function () { fermerModal('modal-shop'); };
    $('form-shop').addEventListener('submit', enregistrerInfos);
    $('btn-copy-link').onclick = copierLien;
    $('btn-share-link').onclick = partagerLien;

    $('btn-product-close').onclick = fermerProduit;
    $('modal-product').addEventListener('click', function (e) { if (e.target === this) fermerProduit(); });
    $('f-plus').addEventListener('input', compteurMots);
    $('f-promo-on').addEventListener('change', basculerPromo);
    $('f-promo').addEventListener('input', apercuPromo);
    $('f-prix').addEventListener('input', apercuPromo);
    $('f-photos').addEventListener('change', function (e) { var fs = e.target.files; if (fs && fs.length) ajouterFichiers(fs).then(function () { e.target.value = ''; }); });
    $('photo-grid').addEventListener('click', function (e) {
      var rm = e.target.closest('[data-remove]'), mn = e.target.closest('[data-main]');
      if (rm) { var r = S.photos.splice(parseInt(rm.dataset.remove, 10), 1)[0]; if (r && r.blob && r.apercu) URL.revokeObjectURL(r.apercu); dessinerPhotos(); }
      else if (mn) { var k = parseInt(mn.dataset.main, 10), t = S.photos[k - 1]; S.photos[k - 1] = S.photos[k]; S.photos[k] = t; dessinerPhotos(); }
    });
    $('form-product').addEventListener('submit', enregistrerProduit);

    $('btn-add-ann').onclick = function () { ouvrirAnnonce(null); };
    $('ann-list').addEventListener('click', clicAnnonce);
    $('btn-ann-close').onclick = function () { fermerModal('modal-ann'); };
    $('a-msg').addEventListener('input', function () { $('a-count').textContent = $('a-msg').value.length + ' / 160'; });
    $('form-ann').addEventListener('submit', enregistrerAnnonce);

    // V3 : commandes, carrousel, notifications
    $('cmd-list').addEventListener('click', clicCommande);
    $('btn-add-slide').onclick = function () { ouvrirSlide(null); };
    $('slide-list').addEventListener('click', clicSlide);
    $('btn-slide-close').onclick = fermerSlide;
    $('form-slide').addEventListener('submit', enregistrerSlide);
    $('s-photo').addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; if (f) choisirImageSlide(f).then(function () { e.target.value = ''; }); });
    $('btn-slide-img-remove').onclick = function () { libererApercuSlide(); S.slideImg = null; dessinerApercuSlide(); };
    ['s-titre', 's-texte'].forEach(function (id) { $(id).addEventListener('input', dessinerApercuSlide); });
    $('btn-notif-edit').onclick = ouvrirNotif;
    $('btn-notif-test').onclick = testerNotif;
    $('btn-notif-close').onclick = function () { fermerModal('modal-notif'); };
    $('form-notif').addEventListener('submit', function (e) { enregistrerNotif(e, false); });
    $('btn-notif-clear').onclick = function () { if (window.confirm('Retirer le bot Telegram ? Vous ne recevrez plus les commandes sur Telegram.')) enregistrerNotif(null, true); };

    // V2 : image de couverture
    $('f-cover').addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; if (f) changerCouverture(f).then(function () { e.target.value = ''; }); });
    $('btn-cover-remove').onclick = retirerCouverture;

    MODALES_SIMPLES.forEach(function (id) { $(id).addEventListener('click', function (e) { if (e.target === this) fermerModal(id); }); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('modal-product').classList.contains('hidden')) fermerProduit();
      MODALES_SIMPLES.forEach(function (id) { if (!$(id).classList.contains('hidden')) fermerModal(id); });
    });

    // Au retour sur l'onglet : actualisation discrète (max. 1 fois / 30 s)
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible' || !S.chargeUne || Date.now() - S.dernierRefresh < 30000) return;
      if (document.querySelector('.modal-overlay:not(.hidden)')) return;      // jamais pendant une saisie
      S.dernierRefresh = Date.now(); chargerTout().catch(function () { /* silencieux */ });
    });

    sb.auth.onAuthStateChange(function (evt) { if (evt === 'SIGNED_OUT') { S.session = null; S.chargeUne = false; setTimeout(function () { vue('landing'); }, 0); } });
    sb.auth.getSession().then(function (r) {
      if (r.data && r.data.session) verifier(r.data.session); else { vue('landing'); cacherLoader(); }
    }).catch(function () { vue('landing'); cacherLoader(); });
    setTimeout(cacherLoader, 8000);     // filet de sécurité : le loader ne reste jamais plus de 8 s
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
