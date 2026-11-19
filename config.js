/* ============================================================================
   config.js — LE SEUL FICHIER À PERSONNALISER pour chaque nouvelle boutique
   (le nom, le logo, la description, le WhatsApp… se règlent ensuite depuis
    l'espace propriétaire « vendeur.html », sans toucher au code).
   ============================================================================ */
window.NB_CONFIG = {

  /* ── 1) SUPABASE (Supabase > Project Settings > API) ───────────────────────
     • supabaseUrl : « Project URL »            ex. https://abcdefgh.supabase.co
     • supabaseKey : clé PUBLIQUE (« anon » ou « publishable »).
       ⚠️ Ne mettez JAMAIS la clé « service_role » / « secret » ici.            */
  supabaseUrl: 'https://pffewftmptdpzwlavhxe.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmZmV3ZnRtcHRkcHp3bGF2aHhlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUwNjc0MjQsImV4cCI6MjExMDY0MzQyNH0.8BdtA6DIEnpjPLz9hc0JY7w5i_DyPLH0K5dD25OkW5U',

  /* ── 2) CACHE : durée pendant laquelle le navigateur du visiteur réutilise les
        données sans interroger Supabase. Les modifications du propriétaire
        apparaissent donc chez les visiteurs après ce délai (5 à 10 minutes).    */
  cacheMinutes: 5,

  /* ── 3) APPARENCE ───────────────────────────────────────────────────────────  */
  couleur: '#2563eb',        // couleur principale de la boutique (bleu par défaut)
  devise: 'FCFA',            // texte affiché après les prix
  lotAffichage: 12,          // nombre de produits ajoutés à chaque défilement (chargement progressif)
  vitesseBande: 45,          // vitesse de la bande défilante en haut (pixels par seconde)

  /* ── 3 bis) WHATSAPP DU DÉVELOPPEUR (boutons « Notifiez-nous » / « Contactez-nous » de l'espace propriétaire)
        Format international sans + ni espaces, ex. '22961000000'. Laissez '' pour masquer la barre.      */
  whatsappSupport: '22961196907',

  /* ── 4) RÉGLAGES AVANCÉS ────────────────────────────────────────────────────  */
  cleCache: 'nb_cache_v1',   // nom de la mémoire du navigateur (changez-le pour forcer une mise à jour chez tous)
  cleePanier: 'nb_panier_v1'
};
