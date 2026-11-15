/* ============================================================================
   vendeur.js — Espace propriétaire (vendeur.html)
   ----------------------------------------------------------------------------
   • Connexion Google ; accès UNIQUEMENT si le Gmail est dans la table « proprietaires » (fonction SQL est_proprietaire()).
     La vraie protection est côté Supabase (RLS) : même en trafiquant cette page, un autre compte ne peut rien écrire.
   • Produits : ajouter / modifier / masquer / supprimer, 1 à 4 photos, « Plus d'informations » ≤ 60 mots.
     Publication DIRECTE (aucune validation d'administrateur).
   • Photos : ≤ 120 Ko → envoyées telles quelles (aucune compression).
               > 120 Ko → converties en WebP et ramenées à ≤ 130 Ko en gardant la meilleure qualité possible.
   • Bande défilante : ajouter / modifier / réordonner / masquer / supprimer les messages (table « annonces »).
   • Ma boutique : nom, propriétaire, description, ville, localisation, WhatsApp, logo (table « boutique »).
   Toutes les données sont affichées via textContent : aucune injection HTML possible.
   ============================================================================ */
(function () {
  'use strict';

  var NB = window.NB, cfg = NB.cfg, el = NB.el, $ = NB.$;
  var BUCKET = 'boutique-images';
  var SEUIL_SANS_COMPRESSION = 120 * 1024;     // ≤ 120 Ko : on n'y touche pas
  var CIBLE_MAX = 130 * 1024;                  // > 120 Ko : on vise ≤ 130 Ko
  var QUALITE_MIN = 0.72;                      // en dessous, on préfère réduire un peu les dimensions

  var sb = null;
  var S = { session: null, boutique: {}, produits: [], annonces: [], photos: [], editId: null, editAnn: null, logoUrl: null, logoFichier: null, logoInitial: null };

  /* ───────────────────────────── Utilitaires ───────────────────────────── */
  var timerToast = null;
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(timerToast); timerToast = setTimeout(function () { t.hidden = true; }, 3200); }
  function occupe(msg) { var b = $('busy'); if (msg) { $('busy-msg').textContent = msg; b.hidden = false; } else b.hidden = true; }
  function montrerErreur(id, msg) { var e = $(id); if (!msg) { e.hidden = true; return; } e.textContent = msg; e.hidden = false; }
  function uuid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); }
  function octets(n) { return n >= 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' Mo' : Math.max(1, Math.round(n / 1024)) + ' Ko'; }
  function invaliderCache() { NB.effacer(cfg.cleCache); }

  /** Traduit les erreurs techniques de Supabase en phrases claires */
  function messageErreur(e) {
    var m = String((e && (e.message || e.error_description)) || e || 'Erreur inconnue');
    if (/row-level security|violates row|permission denied|PGRST116|42501/i.test(m)) return 'Accès refusé : reconnectez-vous avec le compte propriétaire.';
    if (/Limite de/i.test(m)) return m;
    if (/plus_infos/i.test(m)) return '« Plus d’informations » : 60 mots maximum.';
    if (/ancien_prix/i.test(m)) return 'L’ancien prix doit être supérieur au prix de vente.';
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

  /* ───────────────────────────── Écrans & connexion ───────────────────────────── */
  function montrer(ecran) { ['v-login', 'v-denied', 'v-app'].forEach(function (id) { $(id).hidden = id !== ecran; }); }

  function montrerLogin() {
    montrer('v-login');
    var g = $('login-logo'); g.textContent = 'N';
  }
  function verifier(session) {
    S.session = session;
    occupe('Vérification de votre accès…');
    return sb.rpc('est_proprietaire').then(function (r) {
      if (r.error) throw r.error;
      if (r.data === true) return chargerTout().then(function () { montrer('v-app'); });
      $('denied-email').textContent = (session.user && session.user.email) || '';
      montrer('v-denied');
    }).catch(function (e) { montrer('v-login'); montrerErreur('login-error', messageErreur(e)); })
      .then(function () { occupe(false); });
  }

  function connexion() {
    montrerErreur('login-error', '');
    sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: 'select_account' } } })
      .then(function (r) { if (r.error) montrerErreur('login-error', messageErreur(r.error)); });
  }
  function deconnexion() { invaliderCache(); return sb.auth.signOut().then(function () { S.session = null; montrerLogin(); }); }

  /* ───────────────────────────── Chargement des données ───────────────────────────── */
  function chargerTout() {
    return Promise.all([
      sb.from('boutique').select('*').eq('id', 1).maybeSingle(),
      sb.from('produits').select('*').order('ordre', { ascending: true }).order('cree_le', { ascending: false }),
      sb.from('annonces').select('*').order('ordre', { ascending: true }).order('cree_le', { ascending: true })
    ]).then(function (r) {
      for (var i = 0; i < r.length; i++) if (r[i].error) throw r[i].error;
      S.boutique = r[0].data || {}; S.produits = r[1].data || []; S.annonces = r[2].data || [];
      $('app-shop').textContent = S.boutique.nom || 'Ma boutique';
      $('app-email').textContent = (S.session && S.session.user && S.session.user.email) || '';
      dessinerProduits(); dessinerAnnonces(); remplirBoutique();
    });
  }

  /* ───────────────────────────── Produits : liste ───────────────────────────── */
  function vignette(src) { var u = NB.urlImage(src); return u ? el('img', { 'class': 'item-img', src: u, alt: '', loading: 'lazy', width: 62, height: 62 }) : el('span', { 'class': 'item-img' }); }

  function dessinerProduits() {
    var liste = $('prod-list'); liste.textContent = '';
    var q = $('search').value.trim().toLowerCase();
    var visibles = S.produits.filter(function (p) { return !q || p.nom.toLowerCase().indexOf(q) >= 0; });
    $('n-produits').textContent = String(S.produits.length);
    $('count-line').textContent = S.produits.length + ' / ' + (S.boutique.max_produits || 100) + ' produits' + (q ? ' · ' + visibles.length + ' trouvé(s)' : '');
    $('prod-empty').hidden = S.produits.length > 0;
    visibles.forEach(function (p) {
      var sub = el('div', { 'class': 'item-sub' }, [NB.prix(p.prix), p.ancien_prix ? el('s', { text: NB.prix(p.ancien_prix) }) : null, ' · ' + (p.images || []).length + ' photo(s)']);
      var nom = el('div', { 'class': 'item-name' }, [p.nom, p.visible ? null : el('span', { 'class': 'tag', text: 'Masqué' })]);
      var bEdit = el('button', { 'class': 'mini', type: 'button' }, [NB.icon('edit', 16), 'Modifier']);
      var bVis = el('button', { 'class': 'mini', type: 'button' }, [NB.icon(p.visible ? 'eyeoff' : 'eye', 16), p.visible ? 'Masquer' : 'Afficher']);
      var bDel = el('button', { 'class': 'mini danger', type: 'button' }, [NB.icon('trash', 16), 'Supprimer']);
      bEdit.onclick = function () { ouvrirProduit(p); };
      bVis.onclick = function () { basculerProduit(p); };
      bDel.onclick = function () { supprimerProduit(p); };
      liste.appendChild(el('li', { 'class': 'item' + (p.visible ? '' : ' off') }, [vignette(p.images && p.images[0]), el('div', {}, [nom, sub]), el('div', { 'class': 'item-actions' }, [bEdit, bVis, bDel])]));
    });
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
      .then(function () { toast('Produit supprimé.'); })
      .catch(function (e) { toast(messageErreur(e)); }).then(function () { occupe(false); });
  }

  /* ───────────────────────────── Produits : formulaire ───────────────────────────── */
  var dernierFocus = null;
  function ouvrirModal(id) { dernierFocus = document.activeElement; $(id).hidden = false; document.body.classList.add('no-scroll'); }
  function fermerModal(id) { $(id).hidden = true; if ($('modal-prod').hidden && $('modal-ann').hidden) document.body.classList.remove('no-scroll'); if (dernierFocus && dernierFocus.focus) dernierFocus.focus(); }

  function compteurMots() {
    var n = NB.nbMots($('p-plus').value), c = $('plus-count');
    c.textContent = n + ' / 60 mots'; c.classList.toggle('bad', n > 60);
  }

  function dessinerPhotos() {
    var zone = $('photos'); zone.textContent = '';
    S.photos.forEach(function (ph, i) {
      var box = el('div', { 'class': 'ph' }, [el('img', { src: ph.apercu, alt: 'Photo ' + (i + 1) })]);
      if (i === 0) box.appendChild(el('span', { 'class': 'ph-main', text: 'Principale' }));
      if (ph.taille) box.appendChild(el('span', { 'class': 'ph-size', text: octets(ph.taille) }));
      var btns = el('div', { 'class': 'ph-btns' });
      var sup = el('button', { type: 'button', 'aria-label': 'Retirer cette photo' }, [NB.icon('close', 14)]);
      sup.onclick = function () { S.photos.splice(i, 1); dessinerPhotos(); };
      btns.appendChild(sup);
      if (i > 0) { var g = el('button', { type: 'button', 'aria-label': 'Déplacer vers la gauche' }, [NB.icon('left', 14)]); g.onclick = function () { var t = S.photos[i - 1]; S.photos[i - 1] = S.photos[i]; S.photos[i] = t; dessinerPhotos(); }; btns.appendChild(g); }
      box.appendChild(btns);
      zone.appendChild(box);
    });
    if (S.photos.length < 4) {
      var add = el('button', { 'class': 'ph-add', type: 'button' }, [NB.icon('image', 22), 'Ajouter']);
      add.onclick = function () { $('p-files').click(); };
      zone.appendChild(add);
    }
  }

  function ouvrirProduit(p) {
    S.editId = p ? p.id : null;
    $('mp-title').textContent = p ? 'Modifier le produit' : 'Nouveau produit';
    $('p-nom').value = p ? p.nom : ''; $('p-prix').value = p ? p.prix : ''; $('p-ancien').value = (p && p.ancien_prix) ? p.ancien_prix : '';
    $('p-desc').value = p ? p.description : ''; $('p-carac').value = p ? (p.caracteristiques || []).join('\n') : '';
    $('p-plus').value = p ? p.plus_infos : ''; $('p-ordre').value = p ? p.ordre : 0; $('p-visible').checked = p ? p.visible : true;
    S.photos = p ? (p.images || []).map(function (u) { return { url: u, apercu: u, taille: 0 }; }) : [];
    $('photo-info').textContent = 'La 1re photo est l’image principale. Les photos sont automatiquement allégées (≈ 130 Ko, WebP) sans perte visible.';
    montrerErreur('p-error', ''); compteurMots(); dessinerPhotos(); ouvrirModal('modal-prod');
    $('p-nom').focus();
  }

  function ajouterFichiers(fichiers) {
    var places = 4 - S.photos.length, liste = Array.prototype.slice.call(fichiers, 0, Math.max(0, places)), infos = [], erreurs = [];
    if (!liste.length) { toast('4 photos maximum.'); return Promise.resolve(); }
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
      $('photo-info').textContent = infos.length ? 'Photo(s) prête(s) : ' + infos.join(' · ') : $('photo-info').textContent;
      if (erreurs.length) montrerErreur('p-error', erreurs.join(' '));
      if (liste.length < fichiers.length) toast('4 photos maximum : les suivantes ont été ignorées.');
    }).then(function () { occupe(false); }, function () { occupe(false); });
  }

  function lireFormulaireProduit() {
    var nom = $('p-nom').value.trim(), prix = parseInt($('p-prix').value, 10), brut = $('p-ancien').value.trim();
    var ancien = brut === '' ? null : parseInt(brut, 10), desc = $('p-desc').value.trim(), plus = $('p-plus').value.trim();
    var carac = $('p-carac').value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    var ordre = parseInt($('p-ordre').value, 10); if (!isFinite(ordre)) ordre = 0;
    var e = null;
    if (!S.photos.length) e = 'Ajoutez au moins une photo.';
    else if (nom.length < 2) e = 'Indiquez le nom du produit.';
    else if (!isFinite(prix) || prix < 1 || prix > 100000000) e = 'Indiquez un prix valide (en chiffres).';
    else if (ancien !== null && (!isFinite(ancien) || ancien <= prix)) e = 'L’ancien prix doit être supérieur au prix (ou laissez la case vide).';
    else if (ancien !== null && ancien > 100000000) e = 'Ancien prix trop élevé.';
    else if (desc.length > 600) e = 'Description trop longue (600 caractères maximum).';
    else if (carac.length > 15) e = '15 caractéristiques maximum.';
    else if (carac.some(function (c) { return c.length > 200; })) e = 'Une caractéristique dépasse 200 caractères.';
    else if (NB.nbMots(plus) > 60) e = '« Plus d’informations » : 60 mots maximum (vous en avez ' + NB.nbMots(plus) + ').';
    else if (plus.length > 700) e = '« Plus d’informations » est trop long.';
    return { erreur: e, ligne: { nom: nom, prix: prix, ancien_prix: ancien, description: desc, caracteristiques: carac, plus_infos: plus, visible: $('p-visible').checked, ordre: Math.max(-100000, Math.min(100000, ordre)) } };
  }

  function enregistrerProduit(ev) {
    ev.preventDefault(); montrerErreur('p-error', '');
    var f = lireFormulaireProduit(); if (f.erreur) return montrerErreur('p-error', f.erreur);
    var anciennes = []; var envoyes = [];
    if (S.editId) { var orig = S.produits.filter(function (p) { return p.id === S.editId; })[0]; anciennes = (orig && orig.images) || []; }
    $('p-save').disabled = true; occupe('Enregistrement…');

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
      .then(function () { fermerModal('modal-prod'); toast('Produit enregistré. Visible sur le site d’ici ' + cfg.cacheMinutes + ' min environ.'); })
      .catch(function (e) { return supprimerFichiers(envoyes).then(function () { montrerErreur('p-error', messageErreur(e)); }); })     // échec : on retire les fichiers déjà envoyés
      .then(function () { $('p-save').disabled = false; occupe(false); });
  }

  /* ───────────────────────────── Bande défilante ───────────────────────────── */
  function dessinerAnnonces() {
    var liste = $('ann-list'); liste.textContent = '';
    $('ann-empty').hidden = S.annonces.length > 0;
    $('btn-add-ann').disabled = S.annonces.length >= 10;
    S.annonces.forEach(function (a, i) {
      var bHaut = el('button', { 'class': 'mini', type: 'button', 'aria-label': 'Monter' }, [NB.icon('up', 16)]);
      var bBas = el('button', { 'class': 'mini', type: 'button', 'aria-label': 'Descendre' }, [NB.icon('down', 16)]);
      var bEdit = el('button', { 'class': 'mini', type: 'button' }, [NB.icon('edit', 16), 'Modifier']);
      var bVis = el('button', { 'class': 'mini', type: 'button' }, [NB.icon(a.visible ? 'eyeoff' : 'eye', 16), a.visible ? 'Masquer' : 'Afficher']);
      var bDel = el('button', { 'class': 'mini danger', type: 'button' }, [NB.icon('trash', 16), 'Supprimer']);
      bHaut.disabled = i === 0; bBas.disabled = i === S.annonces.length - 1;
      bHaut.onclick = function () { deplacerAnnonce(i, -1); };
      bBas.onclick = function () { deplacerAnnonce(i, 1); };
      bEdit.onclick = function () { ouvrirAnnonce(a); };
      bVis.onclick = function () { majAnnonce(a.id, { visible: !a.visible }, 'Message mis à jour.'); };
      bDel.onclick = function () { supprimerAnnonce(a); };
      var corps = el('div', {}, [el('div', { 'class': 'item-name' }, [a.message, a.visible ? null : el('span', { 'class': 'tag', text: 'Masqué' })]), a.lien ? el('div', { 'class': 'item-sub', text: '🔗 ' + a.lien }) : null]);
      liste.appendChild(el('li', { 'class': 'item ann' + (a.visible ? '' : ' off') }, [corps, el('div', { 'class': 'item-actions' }, [bHaut, bBas, bEdit, bVis, bDel])]));
    });
  }

  function executer(promesse, ok) {
    occupe('Enregistrement…');
    return promesse.then(function (r) { if (r && r.error) throw r.error; invaliderCache(); return chargerTout(); })
      .then(function () { if (ok) toast(ok); return true; })
      .catch(function (e) { toast(messageErreur(e)); return false; }).then(function (v) { occupe(false); return v; });
  }
  function majAnnonce(id, champs, ok) { return executer(sb.from('annonces').update(champs).eq('id', id).select().single(), ok); }
  function supprimerAnnonce(a) {
    if (!window.confirm('Supprimer ce message de la bande défilante ?')) return;
    executer(sb.from('annonces').delete().eq('id', a.id).select(), 'Message supprimé.');
  }
  function deplacerAnnonce(i, sens) {
    var j = i + sens; if (j < 0 || j >= S.annonces.length) return;
    var ids = S.annonces.map(function (a) { return a.id; }); var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    occupe('Enregistrement…');
    ids.reduce(function (c, id, k) { return c.then(function () { var a = S.annonces.filter(function (x) { return x.id === id; })[0]; if (a.ordre === k) return; return sb.from('annonces').update({ ordre: k }).eq('id', id).then(function (r) { if (r.error) throw r.error; }); }); }, Promise.resolve())
      .then(function () { invaliderCache(); return chargerTout(); }).catch(function (e) { toast(messageErreur(e)); }).then(function () { occupe(false); });
  }
  function ouvrirAnnonce(a) {
    S.editAnn = a ? a.id : null;
    $('ma-title').textContent = a ? 'Modifier le message' : 'Nouveau message';
    $('a-msg').value = a ? a.message : ''; $('a-lien').value = a && a.lien ? a.lien : ''; $('a-visible').checked = a ? a.visible : true;
    montrerErreur('a-error', ''); $('a-count').textContent = $('a-msg').value.length + ' / 160'; ouvrirModal('modal-ann'); $('a-msg').focus();
  }
  function enregistrerAnnonce(ev) {
    ev.preventDefault(); montrerErreur('a-error', '');
    var msg = $('a-msg').value.trim(), lien = $('a-lien').value.trim();
    if (msg.length < 2) return montrerErreur('a-error', 'Écrivez un message.');
    if (lien && !/^(https:\/\/|\/|\?|#)/i.test(lien)) return montrerErreur('a-error', 'Le lien doit commencer par https://');
    var champs = { message: msg, lien: lien || null, visible: $('a-visible').checked };
    var p;
    if (S.editAnn) p = sb.from('annonces').update(champs).eq('id', S.editAnn).select().single();
    else { champs.ordre = S.annonces.reduce(function (m, a) { return Math.max(m, a.ordre); }, -1) + 1; p = sb.from('annonces').insert(champs).select().single(); }
    $('a-save').disabled = true;
    executer(p, 'Bande défilante mise à jour.').then(function (ok) { $('a-save').disabled = false; if (ok) fermerModal('modal-ann'); else montrerErreur('a-error', 'Enregistrement impossible.'); });
  }

  /* ───────────────────────────── Ma boutique ───────────────────────────── */
  function dessinerLogo() {
    var z = $('b-logo-prev'); z.textContent = '';
    var src = S.logoFichier ? S.logoFichier.apercu : NB.urlImage(S.logoUrl);
    if (src) z.appendChild(el('img', { src: src, alt: 'Logo' })); else z.textContent = ($('b-nom').value || 'B').charAt(0).toUpperCase();
  }
  function remplirBoutique() {
    var b = S.boutique || {};
    $('b-nom').value = b.nom || ''; $('b-prop').value = b.proprietaire || ''; $('b-desc').value = b.description || '';
    $('b-ville').value = b.ville || ''; $('b-loc').value = b.localisation || ''; $('b-wa').value = b.whatsapp || '';
    S.logoUrl = b.logo_url || null; S.logoFichier = null; S.logoInitial = b.logo_url || null; dessinerLogo();
    $('dev-line').textContent = 'Réglages du développeur (non modifiables ici) : mélange aléatoire des produits ' + (b.melange_actif === false ? 'désactivé' : 'activé') + ' · limite de ' + (b.max_produits || 100) + ' produits.';
  }
  function enregistrerBoutique(ev) {
    ev.preventDefault(); montrerErreur('b-error', '');
    var nom = $('b-nom').value.trim(), wa = NB.chiffres($('b-wa').value);
    if (nom.length < 2) return montrerErreur('b-error', 'Indiquez le nom de la boutique.');
    if (wa.length < 8 || wa.length > 15) return montrerErreur('b-error', 'Numéro WhatsApp invalide : 8 à 15 chiffres avec l’indicatif (ex. 22961000000).');
    $('b-save').disabled = true; occupe('Enregistrement…');
    var avant = Promise.resolve(S.logoUrl), nouveau = null;
    if (S.logoFichier) avant = envoyerFichier('logos', S.logoFichier).then(function (r) { nouveau = r.url; return r.url; });
    avant.then(function (logo) {
      return sb.from('boutique').update({ nom: nom, proprietaire: $('b-prop').value.trim(), description: $('b-desc').value.trim(), ville: $('b-ville').value.trim(), localisation: $('b-loc').value.trim(), whatsapp: wa, logo_url: logo || null }).eq('id', 1).select().single();
    }).then(function (r) {
      if (r.error) throw r.error;
      return (S.logoInitial && S.logoInitial !== r.data.logo_url) ? supprimerFichiers([S.logoInitial]) : null;
    }).then(function () { invaliderCache(); return chargerTout(); })
      .then(function () { toast('Boutique enregistrée ✓'); })
      .catch(function (e) { return (nouveau ? supprimerFichiers([nouveau]) : Promise.resolve()).then(function () { montrerErreur('b-error', messageErreur(e)); }); })
      .then(function () { $('b-save').disabled = false; occupe(false); });
  }

  /* ───────────────────────────── Démarrage ───────────────────────────── */
  function changerOnglet(nom) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { var a = t.getAttribute('data-tab') === nom; t.classList.toggle('active', a); t.setAttribute('aria-selected', a ? 'true' : 'false'); });
    ['produits', 'bande', 'boutique'].forEach(function (n) { $('panel-' + n).hidden = n !== nom; });
  }

  function init() {
    NB.appliquerCouleur();
    Array.prototype.forEach.call(document.querySelectorAll('[data-icon]'), function (n) { n.appendChild(NB.icon(n.getAttribute('data-icon'), 18)); });
    Array.prototype.forEach.call(document.querySelectorAll('.icon-btn'), function (n) { n.appendChild(NB.icon('close', 18)); });
    Array.prototype.forEach.call(document.querySelectorAll('.devise'), function (n) { n.textContent = cfg.devise; });
    $('cache-min').textContent = String(cfg.cacheMinutes);

    if (!window.supabase || /VOTRE/i.test(cfg.supabaseUrl) || /VOTRE/i.test(cfg.supabaseKey)) {
      montrer('v-login'); montrerErreur('login-error', 'Configuration manquante : renseignez supabaseUrl et supabaseKey dans config.js.'); $('btn-login').disabled = true; return;
    }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });

    $('btn-login').onclick = connexion;
    $('btn-logout').onclick = deconnexion;
    $('btn-denied-out').onclick = deconnexion;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { t.onclick = function () { changerOnglet(t.getAttribute('data-tab')); }; });
    $('btn-add').onclick = function () { if (S.produits.length >= (S.boutique.max_produits || 100)) return toast('Limite de produits atteinte pour cette boutique.'); ouvrirProduit(null); };
    $('btn-add-ann').onclick = function () { ouvrirAnnonce(null); };
    $('search').addEventListener('input', dessinerProduits);
    $('p-plus').addEventListener('input', compteurMots);
    $('a-msg').addEventListener('input', function () { $('a-count').textContent = $('a-msg').value.length + ' / 160'; });
    $('p-files').addEventListener('change', function (e) { var fs = e.target.files; if (fs && fs.length) ajouterFichiers(fs).then(function () { e.target.value = ''; }); });
    $('form-prod').addEventListener('submit', enregistrerProduit);
    $('form-ann').addEventListener('submit', enregistrerAnnonce);
    $('form-boutique').addEventListener('submit', enregistrerBoutique);
    $('b-nom').addEventListener('input', function () { if (!S.logoFichier && !S.logoUrl) dessinerLogo(); });
    $('b-logo-file').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      occupe('Optimisation du logo…');
      compresserImage(f).then(function (r) { S.logoFichier = { blob: r.blob, type: r.type, ext: r.ext, apercu: URL.createObjectURL(r.blob) }; $('b-logo-info').textContent = 'Logo prêt : ' + octets(r.taille) + '. Cliquez sur « Enregistrer ma boutique ».'; dessinerLogo(); })
        .catch(function (er) { montrerErreur('b-error', er.message); }).then(function () { occupe(false); e.target.value = ''; });
    });
    $('b-logo-del').onclick = function () { S.logoUrl = null; S.logoFichier = null; $('b-logo-info').textContent = 'Logo retiré : enregistrez pour confirmer.'; dessinerLogo(); };
    Array.prototype.forEach.call(document.querySelectorAll('.modal'), function (m) {
      m.addEventListener('click', function (e) { if (e.target.hasAttribute('data-close')) fermerModal(m.id); });
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { if (!$('modal-prod').hidden) fermerModal('modal-prod'); else if (!$('modal-ann').hidden) fermerModal('modal-ann'); } });

    sb.auth.onAuthStateChange(function (evt) { if (evt === 'SIGNED_OUT') { S.session = null; montrerLogin(); } });
    sb.auth.getSession().then(function (r) {
      if (r.data && r.data.session) verifier(r.data.session); else montrerLogin();
    }).catch(function () { montrerLogin(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
