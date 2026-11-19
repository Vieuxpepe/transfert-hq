/* Transfert HQ — Inventoria panel: English for the panel's own French strings.
   The panel's words follow the same setting as her replies (companions reply in English when that is pinned). The code keeps
   French as the source text; when the language is "en" this file rewrites text nodes and a few attributes in place, and puts the
   French back if the language flips. Chat messages are never touched. Server change labels ("Ajuster Lait de -1") are patterns. */
(function (root) {
  "use strict";

  const PAIRS = [
    // tabs, header, controls
    ["Discuter", "Chat"], ["À acheter", "To buy"], ["Suivi", "Tracking"], ["Réglages", "Settings"], ["Voix", "Voice"],
    ["Envoyer", "Send"], ["Annuler", "Cancel"], ["Appliquer", "Apply"], ["Ignorer", "Dismiss"], ["Fermer", "Close"],
    ["Agrandir", "Enlarge"], ["Réduire", "Shrink"], ["Taille normale", "Normal size"], ["Masquer", "Hide"],
    ["Humeur suivante", "Next mood"], ["Humeur · accueil", "Mood · home"], ["Humeur · forge", "Mood · forge"],
    ["Humeur · occupée", "Mood · busy"], ["Humeur · parole", "Mood · speaking"], ["Humeur · proactive", "Mood · proactive"],
    ["Humeur · écoute", "Mood · listening"],
    ["Dicter un message", "Dictate a message"], ["Appareil photo : photo ou code-barres", "Camera: photo or barcode"],
    ["Sections d'Inventoria", "Inventoria sections"], ["Message pour Inventoria", "Message for Inventoria"],
    ["Demande à Inventoria…", "Ask Inventoria…"], ["Inventoria — ouvrir ou déplacer", "Inventoria — open or move"],
    ["Inventoria — glisser · pincement ou Ctrl+molette = taille · appui long = menu", "Inventoria — drag · pinch or Ctrl+wheel = size · long press = menu"],
    ["Replier ou afficher Inventoria", "Collapse or show Inventoria"], ["Inventoria écrit", "Inventoria is typing"],
    ["Conversation", "Conversation"], ["Oublier cette note", "Forget this note"], ["Arrêter de surveiller", "Stop watching"],
    ["Forge, stocks et courses — prête quand tu ouvres le panneau.", "Forge, stock and groceries — ready when you open the panel."],
    // Suivi tab (titles are built before the language is known on a first visit)
    ["Historique", "History"], ["Pouvoir faire", "Can I make it?"], ["Dépenses", "Spending"], ["Filament 3D", "3D filament"],
    ["Codes-barres", "Barcodes"], ["Chargement…", "Loading…"], ["Rien d'appliqué pour l'instant.", "Nothing applied yet."],
    // shop tab
    ["Liste à copier", "List to copy"], ["Liste de courses à copier", "Shopping list to copy"],
    // settings
    ["Saisie rapide", "Quick entry"], ["Appliquer tout de suite les changements de quantité simples", "Apply simple quantity changes right away"],
    ["« −1 lait », une ligne de ticket connue, une case cochée : appliqué aussitôt, avec 10 s pour annuler. Créer, déplacer ou modifier un article, ou tout cas douteux, reste à confirmer.",
     "“−1 milk”, a known receipt line, a ticked box: applied at once, with 10 s to undo. Creating, moving or editing an item, or anything doubtful, still needs your OK."],
    ["Vibration quand un changement est appliqué", "Vibrate when a change is applied"],
    ["Surnoms", "Nicknames"], ["Dis-lui « PQ, c'est le papier toilette » et elle s'en souviendra.", "Tell her “PQ is toilet paper” and she will remember it."],
    ["Raccourci iPhone et étiquettes QR", "iPhone Shortcut and QR labels"], ["Raccourci iPhone (Siri, bouton Action)", "iPhone Shortcut (Siri, Action button)"],
    ["Lien du raccourci", "Shortcut link"], ["Copier le lien", "Copy the link"],
    ["Dans Raccourcis : « Dicter le texte », puis « URL » avec ce lien suivi du texte dicté, puis « Ouvrir les URL ». Donne-lui un nom (« Inventoria ») pour Siri, ou mets-le sur le bouton Action. Safari doit être connecté à HQ.",
     "In Shortcuts: “Dictate Text”, then “URL” with this link followed by the dictated text, then “Open URLs”. Name it (“Inventoria”) for Siri, or put it on the Action button. Safari must be signed in to HQ."],
    ["Imprimer les étiquettes QR des emplacements", "Print QR labels for the places"],
    ["Colle une étiquette sur chaque tablette ou bac : l'appareil photo de l'iPhone l'ouvre directement dans Inventoria.",
     "Stick a label on each shelf or bin: the iPhone camera opens it straight in Inventoria."],
    ["Générateur QR indisponible sur cette page.", "QR generator unavailable on this page."], ["Aucun emplacement pour l'instant.", "No places yet."],
    ["Autorise les fenêtres pour imprimer les étiquettes.", "Allow pop-ups to print the labels."], ["Impossible de lire les emplacements.", "Could not read the places."],
    ["Alertes hors ligne (désactivées)", "Offline alerts (off)"], ["Alertes hors ligne (activées)", "Offline alerts (on)"],
    ["Prévenir même quand HQ est fermé", "Notify even when HQ is closed"], ["Ping dès qu'un article devient bas", "Ping as soon as an item runs low"],
    ["Résumé du matin à", "Morning summary at"], ["Heure du résumé du matin", "Morning summary time"], ["Tester", "Test"],
    ["Envoyé par le webhook Discord et les notifications push déjà configurés dans HQ.", "Sent through the Discord webhook and push notifications already set up in HQ."],
    ["Test envoyé.", "Test sent."], ["Aucun canal configuré (webhook Discord ou push).", "No channel configured (Discord webhook or push)."],
    ["Réglages enregistrés.", "Settings saved."], ["Réglage non enregistré.", "Setting not saved."], ["Échec.", "Failed."],
    ["Copié.", "Copied."], ["Sélectionne le texte puis copie-le.", "Select the text, then copy it."],
    ["Autoriser l'envoi de photos à Inventoria", "Allow sending photos to Inventoria"],
    ["Une photo est envoyée à Google (Gemini, avec ta clé d'API) pour être analysée. HQ ne la conserve pas : seule une empreinte non réversible sert à repérer un doublon pendant 30 jours. Les métadonnées (position GPS...) sont retirées avant l'envoi. Évite cartes bancaires, adresses et pièces d'identité ; un ticket peut montrer des chiffres de carte : recadre-le au besoin.",
     "A photo is sent to Google (Gemini, with your API key) to be analysed. HQ does not keep it: only a non-reversible fingerprint is used to spot a duplicate for 30 days. Metadata (GPS position…) is removed before sending. Avoid bank cards, addresses and ID documents; a receipt can show card digits: crop it if needed."],
    ["Revoir l'avis au prochain envoi", "Show the notice again on the next send"], ["Avis réactivé", "Notice re-enabled"],
    ["Impossible d'oublier ce surnom.", "Could not forget this nickname."],
    // drafts and notices
    ["Brouillon annulé.", "Draft cancelled."], ["Brouillon impossible à appliquer", "The draft could not be applied"],
    ["Ce brouillon ne passe pas la validation — rien à appliquer", "This draft fails validation — nothing to apply"],
    ["Annulé.", "Undone."], ["Appliqué.", "Applied."], ["Annulation impossible.", "Undo failed."], ["Impossible de préparer le brouillon.", "Could not prepare the draft."],
    ["Impossible d'ignorer ce changement (photo).", "Could not dismiss this change (photo)."], ["Impossible d'ignorer ce changement (courses).", "Could not dismiss this change (groceries)."],
    ["Ajout impossible.", "Could not add it."], ["Envoi impossible.", "Could not send it."], ["Photo impossible", "Photo failed"],
    ["Inventoria indisponible", "Inventoria unavailable"], ["Session indisponible", "Session unavailable"], ["décodeur indisponible", "decoder unavailable"],
    ["Quantité achetée de", "Quantity bought of"],
    ["Envoyer une photo (ticket de caisse, étagère)", "Send a photo (receipt, shelf)"],
    ["Dis-moi ce que tu as acheté, demande l'état du stock ou envoie une photo de ticket ou de liste.",
     "Tell me what you bought, ask about your stock, or send a photo of a receipt or a list."],
    ["Ce qu'elle retient", "What she remembers"],
    // feel pass
    ["Discrétion", "Quiet & limits"], ["Alertes max par jour", "Max alerts per day"], ["Silence de (h)", "Quiet from (hour)"],
    ["jusqu'à (h)", "until (hour)"], ["Pause 1 jour", "Snooze 1 day"], ["Pause 1 semaine", "Snooze 1 week"], ["Reprendre", "Resume"],
    ["Mode courses", "Shop mode"], ["Quitter le mode courses", "Leave shop mode"],
    ["Au-delà, ou la nuit, les alertes attendent. Le résumé du matin reste un seul message.",
     "Beyond that, or at night, alerts wait. The morning digest stays a single message."],
  ];

  // Patterns: server labels and strings with numbers. Each returns the English text for a French match.
  const num = (n) => n;
  const PATTERNS = [
    [/^Ajuster (.+) de ([+-]\d+)(.*)$/, (m, tr) => "Adjust " + m[1] + " by " + m[2] + tr(m[3])],
    [/^Acheté : (.+) de ([+-]\d+)(.*)$/, (m, tr) => "Bought: " + m[1] + " " + m[2] + tr(m[3])],
    [/^Ajouter (.+) : (\+\d+)$/, (m) => "Add " + m[1] + ": " + m[2]],
    [/^Créer (.+) \(×(\d+)([^)]*)\) dans (.+)$/, (m) => "Create " + m[1] + " (×" + m[2] + m[3] + ") in " + m[4]],
    [/^Créer (.+) \(×(\d+)([^)]*)\) \(sans emplacement\)(.*)$/, (m) => "Create " + m[1] + " (×" + m[2] + m[3] + ") (no place)" + m[4]],
    [/^Créer (.+) \(×(\d+)([^)]*)\)$/, (m) => "Create " + m[1] + " (×" + m[2] + m[3] + ")"],
    [/^Modifier (.+)$/, (m) => "Edit " + m[1]],
    [/^Déplacer (\d+) article\(s\) vers (.+)$/, (m) => "Move " + m[1] + " item(s) to " + (m[2] === "sans emplacement" ? "no place" : m[2])],
    [/^Annuler : (.+)$/, (m, tr) => "Undo: " + tr(m[1])],
    [/^Compter (.+) : (\d+) → (\d+)$/, (m) => "Count " + m[1] + ": " + m[2] + " → " + m[3]],
    [/^Cuisiné \((.+)\) : (.+) de ([+-]\d+)$/, (m) => "Cooked (" + m[1] + "): " + m[2] + " by " + m[3]],
    [/^Brouillon à vérifier — rien n'est appliqué \((\d+) changements?\)$/, (m) => "Draft to review — nothing is applied (" + m[1] + (m[1] === "1" ? " change)" : " changes)")],
    [/^Annulation du lot — rien n'est appliqué \((\d+) changements?\)$/, (m) => "Undoing the batch — nothing is applied yet (" + m[1] + (m[1] === "1" ? " change)" : " changes)")],
    [/^Appliqué en partie \((\d+)\/(\d+)\) : (.+)$/, (m, tr) => "Partly applied (" + m[1] + "/" + m[2] + "): " + tr(m[3])],
    [/^Surveillances \((\d+)\)$/, (m) => "Watches (" + m[1] + ")"],
    [/^Ce qu'elle retient \((\d+)\)$/, (m) => "What she remembers (" + m[1] + ")"],
    [/^Quantité achetée de (.+)$/, (m) => "Quantity bought of " + m[1]],
    [/^Oublier le surnom (.+)$/, (m) => "Forget the nickname " + m[1]],
    [/^(\d+) étiquette\(s\) prête\(s\) à imprimer\.$/, (m) => m[1] + " label(s) ready to print."],
    [/^(.+) — alerte à (\d+)( \(actuel (\d+)\))?\s*$/, (m) => m[1] + " — alert at " + m[2] + (m[4] ? " (now " + m[4] + ")" : "")],
    [/^(.+) est en rupture\.$/, (m) => m[1] + " is out of stock."],
    [/^(.+) est sous son minimum \((\d+) sur (\d+)\)\.$/, (m) => m[1] + " is below its minimum (" + m[2] + " of " + m[3] + ")."],
  ];

  const EXACT = new Map(PAIRS);
  const SKIP_ATTR = ".hq-inventoria-thread-log,.hq-inventoria-msg,.hq-inventoria-where-more";     // her words and yours: never rewritten
  const SKIP = "script,style,textarea," + SKIP_ATTR;                                              // text nodes also skip a textarea's content (the list you copy)
  const ATTRS = ["placeholder", "aria-label", "title", "alt"];
  const tracked = [];                                  // [node, attr|null, original] so French can be restored
  const TRACK_MAX = 6000;

  function translate(str) {
    if (typeof str !== "string" || !str) return str;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(str);
    const lead = m[1], core = m[2], trail = m[3];
    if (!core) return str;
    const hit = EXACT.get(core);
    if (hit !== undefined) return lead + hit + trail;
    for (let i = 0; i < PATTERNS.length; i++) {
      const mm = PATTERNS[i][0].exec(core);
      if (mm) return lead + PATTERNS[i][1](mm, translate) + trail;
    }
    return str;
  }

  function skipped(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return !el || (el.closest && !!el.closest(SKIP));
  }

  function track(node, attr, original) {
    if (tracked.length >= TRACK_MAX) {
      for (let i = tracked.length - 1; i >= 0; i--) if (!tracked[i][0].isConnected) tracked.splice(i, 1);
      if (tracked.length >= TRACK_MAX) tracked.splice(0, 1000);
    }
    tracked.push([node, attr, original]);
  }

  function doText(node) {
    if (skipped(node)) return;
    const v = node.nodeValue, t = translate(v);
    if (t !== v) { track(node, null, v); node.nodeValue = t; }
  }

  function doAttrs(el) {
    if (!el.getAttribute || (el.closest && el.closest(SKIP_ATTR))) return;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v) continue;
      const t = translate(v);
      if (t !== v) { track(el, a, v); el.setAttribute(a, t); }
    }
  }

  function walk(node) {
    if (node.nodeType === 3) { doText(node); return; }
    if (node.nodeType !== 1) return;
    doAttrs(node);
    const doc = node.ownerDocument;
    const it = doc.createTreeWalker(node, 1 | 4);       // elements and text
    let n;
    while ((n = it.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
  }

  function revert() {
    for (const [node, attr, original] of tracked.splice(0)) {
      try { if (attr) node.setAttribute(attr, original); else node.nodeValue = original; } catch (_) {}
    }
  }

  function apply(rootEl, lang) {
    if (!rootEl) return;
    if (lang === "en") walk(rootEl); else revert();
  }

  function onMutations(muts, lang) {
    if (lang !== "en") return;
    for (const m of muts) {
      if (m.type === "childList") m.addedNodes.forEach((n) => walk(n));
      else if (m.type === "characterData") doText(m.target);
      else if (m.type === "attributes") doAttrs(m.target);
    }
  }

  root.HqInventoriaI18n = { translate, apply, onMutations, revert, size: () => EXACT.size + PATTERNS.length };
})(typeof window !== "undefined" ? window : globalThis);
