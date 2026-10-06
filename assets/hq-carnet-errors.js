/* Transfert HQ — Carnet: ONE typed fallback message for a failed request (pure; no network, no storage, no clock, no DOM).
 *
 * Phase 13. The Carnet surfaces used to end an unexplained failure with the bare word « Erreur ». This keeps the server's own message when there is
 * one and otherwise says WHAT KIND of failure it was and what to do next. It never retries anything and never claims a mutation did or did not happen
 * when it cannot know (a lost answer is « résultat inconnu »). Kinds: offline · access · missing · conflict · corrupt · integrity · server · unknown.
 * Plain ES2020, UMD (browser global HqCarnetErrors / CommonJS).
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetErrors = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MSG = {
    offline: "Connexion indisponible : le résultat est inconnu. Vérifie l'état avant de réessayer.",
    access: "Accès refusé : cette action n'est pas autorisée avec cette session.",
    missing: "Élément introuvable : il n'existe plus à cet endroit.",
    conflict: "Cet élément a changé depuis son ouverture. Recharge-le avant de réessayer.",
    corrupt: "Cet élément est altéré : il reste en lecture seule et rien n'est modifié.",
    integrity: "Anomalie d'intégrité : rien n'est modifié. Les données sont conservées telles quelles.",
    server: "Le serveur n'a pas pu traiter la demande. Rien n'est confirmé ; réessaie plus tard.",
    unknown: "Échec inattendu : rien n'est confirmé. Vérifie l'état avant de réessayer.",
  };

  function isObj(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  /** The kind of a failure, from the HTTP status / an explicit code / the shape of a network error. */
  function kind(err) {
    const d = err && isObj(err.data) ? err.data : {};
    const code = typeof d.code === "string" ? d.code : "";
    if (/integrity/.test(code)) return "integrity";
    if (/corrupt/.test(code)) return "corrupt";
    if (/conflict|stale/.test(code)) return "conflict";
    const st = err && Number.isInteger(err.status) ? err.status : 0;
    if (st === 401 || st === 403) return "access";
    if (st === 404 || st === 410) return "missing";
    if (st === 409 || st === 412) return "conflict";
    if (st >= 500) return "server";
    if (!st && err && (err.offline === true || err.name === "TypeError" || /failed to fetch|network|load failed/i.test(String(err.message || "")))) return "offline";
    return "unknown";
  }

  /** The text to show: the server's own message first, else the typed fallback. Never the bare word « Erreur ». */
  function message(err, limit) {
    const d = err && isObj(err.data) ? err.data : {};
    const own = typeof d.error === "string" && d.error.trim() ? d.error : "";
    const k = kind(err);
    // an unclassified failure keeps its own message when it has one (it says more than any generic sentence); a classified one is explained by kind
    const raw = k === "unknown" && err && typeof err.message === "string" && err.message.trim() ? err.message : "";
    return String(own || raw || MSG[k]).slice(0, limit || 200);
  }

  return { MSG, kind, message };
});
