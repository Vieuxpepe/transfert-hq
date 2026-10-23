/* Forge Studio, phase J4: couch mode. A calmer, larger layout for the sofa: prompt, destination,
   generate, results and gallery only; the hidden settings still apply. A page-side display
   choice only: no request, no timer, nothing about the session, idle lock or vault changes.
   The choice itself (on/off) is kept on this device; no prompt is stored. */
(function () {
  const studio = document.getElementById("forge-studio");
  const toggle = document.getElementById("forge-couch");
  const note = document.getElementById("forge-couch-note");
  if (!studio || !toggle) return;
  const KEY = "hqForgeCouch";

  function set(on, remember) {
    studio.classList.toggle("is-couch", on);
    toggle.setAttribute("aria-pressed", on ? "true" : "false");
    toggle.textContent = on ? "Quitter le mode canap\u00e9" : "Mode canap\u00e9";
    if (note) note.hidden = !on;
    if (remember) {
      try { if (on) localStorage.setItem(KEY, "1"); else localStorage.removeItem(KEY); } catch (_e) { /* private browsing: just not remembered */ }
    }
  }

  let saved = false;
  try { saved = localStorage.getItem(KEY) === "1"; } catch (_e) { saved = false; }
  set(saved, false);
  toggle.addEventListener("click", () => set(!studio.classList.contains("is-couch"), true));
})();
