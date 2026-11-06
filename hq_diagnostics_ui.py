"""Phase 15 — the plain admin diagnostics page (``GET /diagnostics``, admin-only). Static HTML; all data comes from the
``/api/diag/*`` endpoints through ``assets/hq-diagnostics.js`` (no inline script, no external call, no auto-refresh, no animation)."""

from __future__ import annotations

PAGE = """<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Diagnostics · Transfert HQ</title>
<style>
body{font:14px/1.45 system-ui,Segoe UI,sans-serif;margin:0 auto;max-width:960px;padding:12px 16px;color:#1c1c1c;background:#fff}
h1{font-size:1.25rem;margin:.2rem 0 .6rem}h2{font-size:1rem;margin:1.2rem 0 .4rem;border-bottom:1px solid #bbb;padding-bottom:2px}
table{border-collapse:collapse;width:100%}td,th{padding:3px 8px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}
th{font-weight:600;width:34%}code{font-family:Consolas,monospace;font-size:.92em}
.s-ok{color:#0a6b2d}.s-degraded{color:#8a5a00}.s-unavailable,.s-error,.s-not_ready{color:#b00020}.s-not_configured,.s-never{color:#555}
.badge{font-weight:700}button{font:inherit;padding:4px 10px;margin:2px 6px 2px 0}input{font:inherit;padding:3px 6px;width:22em;max-width:100%}
.muted{color:#555}.err{white-space:pre-wrap;word-break:break-word}
@media (prefers-color-scheme:dark){body{background:#161616;color:#e8e8e8}td,th,h2{border-color:#444}.muted,.s-not_configured{color:#aaa}.s-ok{color:#5fd38a}.s-degraded{color:#f0b24a}.s-unavailable,.s-error,.s-not_ready{color:#ff7a8a}}
</style></head><body>
<h1>Diagnostics</h1>
<p class="muted">Local et en lecture seule, sauf le test d'écriture explicite. Aucun rafraîchissement automatique.
<button id="refresh" type="button">Rafraîchir</button></p>
<section aria-labelledby="agent-guide-title">
<h2 id="agent-guide-title">Guide agents (debug HQ)</h2>
<p class="muted">Pipeline complet : <code>docs/agent-debugging.md</code> dans le dépôt (résumé aussi dans <code>AGENTS.md</code>).</p>
<ol>
<li>Activer la capture : <code>client_debug_hud</code> ou <code>HQ_CLIENT_DEBUG=1</code>, redémarrer le bridge, recharger HQ.</li>
<li>Brief agent (coller dans le chat) : <code>GET /api/diag/agent-brief?limit=50</code> — champ <code>brief_md</code>.</li>
<li>Bundle complet : <code>GET /api/diag/session-bundle?limit=50</code> — <code>agent_triage</code> + <code>timeline</code> + journal.</li>
<li>Symptômes : <code>docs/hq-symptom-index.md</code>.</li>
<li>Fichiers : <code>.hq-carnet/diagnostics/client-browser.jsonl</code> (2×200 lignes max).</li>
<li>Lag : <code>agent_triage.slowest_marks</code> ou <code>kind: perf-mark</code>.</li>
<li>Erreurs API : <code>request_id</code> client ↔ <code>server_errors</code> / <code>errors.jsonl</code>.</li>
</ol>
</section>
<div id="root" aria-live="polite">Chargement…</div>
<script src="/assets/hq-diagnostics.js"></script>
</body></html>
"""


def render_page() -> str:
    return PAGE
