/* ============================================================================
   config.js — VERSION 4 — LE SEUL FICHIER À PERSONNALISER pour chaque nouvelle boutique
   (le nom, le logo, la description, le WhatsApp… se règlent ensuite depuis
    l'espace propriétaire « vendeur.html », sans toucher au code).
   ============================================================================ */
window.NB_CONFIG = {

  /* ── 1) SUPABASE (Supabase > Project Settings > API) ───────────────────────
     • supabaseUrl : « Project URL »            ex. https://abcdefgh.supabase.co
     • supabaseKey : clé PUBLIQUE (« anon » ou « publishable »).
       ⚠️ Ne mettez JAMAIS la clé « service_role » / « secret » ici.            */
  supabaseUrl: 'https://jmuysxygsajstnmafkji.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImptdXlzeHlnc2Fqc3RubWFma2ppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ3NDQxNzUsImV4cCI6MjExMDMyMDE3NX0._Sm8bpv8ZEuh59QWI3AAVyyc_jxETtxdApb08vl-U6A',

  /* ── 2) CACHE : durée pendant laquelle le navigateur du visiteur réutilise les
        données sans interroger Supabase. Les modifications du propriétaire
        apparaissent donc chez les visiteurs après ce délai (5 à 10 minutes).    */
  cacheMinutes: 5,

  /* ── 3) APPARENCE ───────────────────────────────────────────────────────────  */
  couleur: '#2563eb',        // couleur principale de la boutique (bleu par défaut)
  devise: 'FCFA',            // texte affiché après les prix
  lotAffichage: 12,          // nombre de produits ajoutés à chaque défilement (chargement progressif)
  vitesseBande: 45,          // vitesse de la bande défilante en haut (pixels par seconde)
  delaiCarrousel: 5000,      // V3 : temps (en millisecondes) entre deux diapositives du carrousel (5000 = 5 secondes)

  /* ── 3 bis) WHATSAPP DU DÉVELOPPEUR (boutons « Notifiez-nous » / « Contactez-nous » de l'espace propriétaire)
        Format international sans + ni espaces, ex. '22961000000'. Laissez '' pour masquer la barre.      */
  whatsappSupport: '22961196907',

  /* ── 4) RÉGLAGES AVANCÉS ────────────────────────────────────────────────────  */
  cleCache: 'nb_cache_v4',   // nom de la mémoire du navigateur (changez-le pour forcer une mise à jour chez tous)
  cleePanier: 'nb_panier_v1',
  cleCommandes: 'nb_cmd_attente_v3'   // V3 : commandes dont la notification n'a pas pu partir (réseau coupé) : renvoyées automatiquement
};
