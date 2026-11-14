/* Transfert HQ — admin settings for the NVIDIA visit fallback. Key is write-only. */
(function () {
  "use strict";

  var form = document.getElementById("nvidia-settings-form");
  if (!form) return;
  var keyInput = document.getElementById("nvidia-api-key");
  var modelInput = document.getElementById("nvidia-visit-model");
  var keyState = document.getElementById("nvidia-key-state");
  var status = document.getElementById("nvidia-settings-status");
  var telemetry = document.getElementById("nvidia-visit-telemetry");
  var saveButton = document.getElementById("nvidia-save");
  var clearButton = document.getElementById("nvidia-clear-key");
  if (!keyInput || !modelInput || !keyState || !status || !telemetry || !saveButton || !clearButton) return;

  function setStatus(text, bad) {
    status.textContent = text || "";
    status.classList.toggle("is-bad", !!bad);
    status.style.color = bad ? "var(--danger)" : "";
  }

  function renderTelemetry(t) {
    if (!t) {
      telemetry.textContent = "";
      return;
    }
    var last = t.last_provider
      ? " Dernier appel : " + t.last_provider + (t.last_reason ? " (" + t.last_reason + ")" : "") + "."
      : "";
    var stored = t.persisted === false ? " (totaux non enregistrés)" : "";
    telemetry.textContent = "Aujourd'hui" + stored + " : Gemini " + (t.gemini_ok || 0) + " OK / "
      + (t.gemini_error || 0) + " échec(s) ; NVIDIA " + (t.nvidia_ok || 0) + " OK / "
      + (t.nvidia_error || 0) + " échec(s)." + last;
  }

  function render(data) {
    modelInput.value = data.model || "";
    keyState.textContent = data.configured
      ? "Clé de repli configurée sur ce PC."
      : "Aucune clé de repli : Gemini reste principal, puis les lignes pré-écrites.";
    keyState.classList.toggle("is-bad", !data.configured);
    keyState.style.color = data.configured ? "" : "var(--danger)";
    renderTelemetry(data.telemetry);
  }

  async function request(method, body) {
    const response = await fetch("/api/admin/nvidia", {
      method: method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(data.error || "Erreur serveur (" + response.status + ")");
    return data;
  }

  async function load() {
    try {
      render(await request("GET"));
    } catch (error) {
      if (document.body.dataset.role === "admin") setStatus(error.message || "Chargement impossible", true);
    }
  }

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    const payload = { model: modelInput.value.trim() };
    const key = keyInput.value.trim();
    if (key) payload.api_key = key;
    saveButton.disabled = true;
    setStatus("Enregistrement…", false);
    try {
      render(await request("POST", payload));
      keyInput.value = "";
      setStatus("Réglages enregistrés.", false);
    } catch (error) {
      setStatus(error.message || "Enregistrement impossible", true);
    } finally {
      saveButton.disabled = false;
    }
  });

  clearButton.addEventListener("click", async function () {
    if (!window.confirm("Effacer la clé NVIDIA de repli ? Les visites utiliseront Gemini, puis les lignes pré-écrites.")) return;
    clearButton.disabled = true;
    setStatus("Effacement…", false);
    try {
      render(await request("POST", { clear_key: true }));
      keyInput.value = "";
      setStatus("Clé effacée.", false);
    } catch (error) {
      setStatus(error.message || "Effacement impossible", true);
    } finally {
      clearButton.disabled = false;
    }
  });

  load();
})();