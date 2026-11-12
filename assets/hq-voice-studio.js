/* Voice studio: audition and save a voice per companion (XTTS for Else, Phonon for the others).
 * Mounted by the companion editor ("Studio vocal"). Previews never persist anything; only "Enregistrer" does.
 * One audio element, one in-flight request: a new preview or Stop cancels the previous one. */
(function (root) {
  "use strict";
  const NAMES = { else: "Else", transferania: "Transferina", inventoria: "Inventoria", musica: "Musica" };
  const SAMPLE = {
    transferania: "Coucou, mon Maître ! J'ai enfin ma propre voix, et franchement, je suis beaucoup trop contente !",
    inventoria: "Bonjour ! Nous avons vingt-quatre articles répertoriés, dont sept nécessitent une vérification.",
    musica: "Salut ! Imagine une mélodie douce, quelques notes de piano et une ambiance parfaite pour relaxer.",
    else: "Je suis là. Dis-moi ce dont tu as besoin, nous allons le régler calmement."
  };

  function mount(doc, container, opts) {
    opts = opts || {};
    const fetchFn = opts.fetch || ((...a) => doc.defaultView.fetch(...a));
    const deviceId = opts.deviceId || "";
    const el = (tag, props, ...kids) => {
      const n = doc.createElement(tag);
      Object.assign(n, props || {});
      n.append(...kids);
      return n;
    };
    const post = (body) => fetchFn("/api/ai", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ action: "transferania", device_id: deviceId }, body)),
      signal: state.abort ? state.abort.signal : undefined
    }).then((r) => r.json());

    const state = { abort: null, audio: null, seq: 0, data: null, destroyed: false };
    const status = el("p", { role: "status" });
    const charSel = el("select", { ariaLabel: "Personnage" });
    const engSel = el("select", { ariaLabel: "Moteur vocal" });
    const voiceSel = el("select", { ariaLabel: "Voix" });
    const rate = el("input", { type: "range", min: "-0.4", max: "0.4", step: "0.05", value: "0", ariaLabel: "Débit" });
    const rateOut = el("output", { textContent: "0" });
    const pitch = el("input", { type: "range", min: "-6", max: "6", step: "0.5", value: "0", ariaLabel: "Hauteur (demi-tons)" });
    const pitchOut = el("output", { textContent: "0" });
    const text = el("textarea", { maxLength: 400, ariaLabel: "Texte à écouter" });
    const hint = el("p", { className: "hq-voice-studio-hint" });
    const playBtn = el("button", { type: "button", textContent: "Écouter" });
    const stopBtn = el("button", { type: "button", textContent: "Arrêter" });
    const saveBtn = el("button", { type: "button", textContent: "Enregistrer" });
    const resetBtn = el("button", { type: "button", textContent: "Valeur par défaut" });

    function stop() {
      state.seq++;
      if (state.abort) { try { state.abort.abort(); } catch (e) {} state.abort = null; }
      if (state.audio) {
        const a = state.audio; state.audio = null;
        a.onended = a.onerror = null; try { a.pause(); } catch (e) {} a.removeAttribute("src"); try { a.load(); } catch (e) {}
      }
      playBtn.disabled = false;
    }
    function fill(sel, items, current) {
      sel.replaceChildren(...items.map(([v, t]) => el("option", { value: v, textContent: t })));
      if (current != null) sel.value = current;
    }
    function refreshVoices() {
      const c = charSel.value, d = state.data, prof = d.profiles[c];
      const engines = ["phonon", "browser"].concat(c === "else" ? ["xtts"] : []).filter((e) => d.engines[e].indexOf(c) >= 0);
      const labels = { xtts: "Coqui XTTS-v2", phonon: "Phonon", browser: "Navigateur" };
      fill(engSel, engines.map((e) => [e, labels[e]]), engines.indexOf(prof.engine) >= 0 ? prof.engine : engines[0]);
      const cand = d.candidates[c] || [];
      const all = d.voices.fr.map((v) => v.name).concat((d.voices.en || []).map((v) => v.name));
      const ordered = cand.filter((n) => all.indexOf(n) >= 0).concat(all.filter((n) => cand.indexOf(n) < 0));
      const desc = {}; d.voices.fr.forEach((v) => { desc[v.name] = v.description; });
      const isEn = {}; (d.voices.en || []).forEach((v) => { isEn[v.name] = true; });
      fill(voiceSel, ordered.map((n) => [n, (cand.indexOf(n) >= 0 ? "★ " : "") + (isEn[n] ? "EN · " : "") + n]), prof.voice || prof.preview_voice || ordered[0]);
      voiceSel.disabled = engSel.value !== "phonon";
      rate.value = String(prof.rate || 0); rateOut.value = rate.value;
      pitch.value = String(prof.pitch || 0); pitchOut.value = pitch.value;
      text.value = SAMPLE[c] || "";
      const st = d.status;
      const frOk = st.models && st.models.fr;
      hint.textContent = (engSel.value === "phonon" && !frOk)
        ? "Le modèle français Phonon n'est pas chargé (accès Hugging Face requis); les aperçus français sont indisponibles."
        : (prof.selected ? "Voix enregistrée : " + (prof.voice || labels[prof.engine]) : "Aucune voix enregistrée — ★ = pistes d'écoute, à confirmer à l'oreille.");
      stopBtn.disabled = false;
    }
    charSel.addEventListener("change", () => { stop(); refreshVoices(); });
    engSel.addEventListener("change", () => { stop(); voiceSel.disabled = engSel.value !== "phonon"; });
    rate.addEventListener("input", () => { rateOut.value = rate.value; });
    pitch.addEventListener("input", () => { pitchOut.value = pitch.value; });

    playBtn.addEventListener("click", () => {
      if (!text.value.trim()) return;
      if (engSel.value === "browser") {
        const w = doc.defaultView;
        try { w.speechSynthesis.cancel(); w.speechSynthesis.speak(new w.SpeechSynthesisUtterance(text.value)); } catch (e) {}
        status.textContent = "Lecture avec la voix du navigateur.";
        return;
      }
      stop();
      const my = state.seq;
      state.abort = new doc.defaultView.AbortController();
      playBtn.disabled = true;
      status.textContent = "Préparation locale…";
      post({ op: "voice_preview", character: charSel.value, engine: engSel.value, voice: voiceSel.value,
             rate: Number(rate.value), pitch: Number(pitch.value), text: text.value, language: "fr" })
        .then((res) => {
          if (my !== state.seq || state.destroyed) return;
          playBtn.disabled = false;
          if (!res || !res.ok || !res.audio_url) { status.textContent = (res && res.error) || "Aperçu indisponible."; return; }
          const a = new doc.defaultView.Audio(res.audio_url);
          state.audio = a;
          a.onended = () => { if (state.audio === a) { state.audio = null; status.textContent = "Terminé."; } };
          a.onerror = () => { status.textContent = "Lecture impossible."; };
          status.textContent = "Lecture · " + (res.engine || "") + (res.voice ? " · " + res.voice : "") + (res.cached ? " (cache)" : "");
          const p = a.play(); if (p && p.catch) p.catch(() => { status.textContent = "Lecture bloquée par le navigateur."; });
        })
        .catch((e) => { if (e && e.name === "AbortError") return; playBtn.disabled = false; status.textContent = "Aperçu indisponible."; });
    });
    stopBtn.addEventListener("click", () => { stop(); try { doc.defaultView.speechSynthesis.cancel(); } catch (e) {} status.textContent = "Arrêté."; });
    saveBtn.addEventListener("click", () => {
      post({ op: "voice_save", character: charSel.value, engine: engSel.value, voice: voiceSel.value, rate: Number(rate.value), pitch: Number(pitch.value) })
        .then((res) => { status.textContent = res.ok ? "Voix enregistrée." : (res.error || "Échec"); if (res.ok) { state.data.profiles[charSel.value] = res.profile; refreshVoices(); } });
    });
    resetBtn.addEventListener("click", () => {
      post({ op: "voice_reset", character: charSel.value })
        .then((res) => { if (res.ok) { state.data.profiles[charSel.value] = res.profile; refreshVoices(); status.textContent = "Réglage par défaut rétabli."; } });
    });

    container.replaceChildren(
      el("label", {}, "Personnage", charSel), el("label", {}, "Moteur", engSel), el("label", {}, "Voix", voiceSel),
      el("label", {}, "Débit ", rate, rateOut), el("label", {}, "Hauteur ", pitch, pitchOut), el("label", {}, "Texte", text), hint,
      el("div", {}, playBtn, stopBtn, saveBtn, resetBtn), status);
    status.textContent = "Chargement…";
    post({ op: "voice_profiles" }).then((d) => {
      if (!d || !d.ok) { status.textContent = "Studio vocal indisponible."; return; }
      state.data = d;
      fill(charSel, Object.keys(NAMES).map((k) => [k, NAMES[k]]), opts.character || "transferania");
      refreshVoices();
      status.textContent = "";
    }).catch(() => { status.textContent = "Studio vocal indisponible."; });
    return { destroy() { state.destroyed = true; stop(); } };
  }
  root.HqVoiceStudio = { mount };
})(typeof window !== "undefined" ? window : globalThis);
