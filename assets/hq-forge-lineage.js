/* Forge Studio, phase J2: lineage tree of a gallery image (finitions and retouches), shown in
   the viewer. Normal gallery only; the private vault is never asked. Tapping a node opens it. */
(function () {
  const $ = (id) => document.getElementById(id);
  const H = window.hqForgeHooks;
  const box = $("forge-lineage");
  if (!H || !box) return;
  const tree = $("forge-lineage-tree");
  const note = $("forge-lineage-note");
  const LABEL = { finish: "Finition", inpaint: "Retouche" };
  const TRIAGE = { keep: "gard\u00e9e", favorite: "favorite", reject: "\u00e0 la corbeille" };
  let current = "";
  let shownFor = "";

  function day(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("fr-CA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  function reset() {
    tree.replaceChildren();
    note.textContent = "";
    shownFor = "";
  }

  async function load() {
    const id = current;
    if (!id || shownFor === id) return;
    reset();
    note.textContent = "Chargement\u2026";
    try {
      const out = await H.api("/api/forge/gallery/" + encodeURIComponent(id) + "/lineage", { cache: "no-store" });
      if (id !== current) return;
      shownFor = id;
      for (const node of out.nodes) {
        const li = document.createElement("li");
        li.style.setProperty("--depth", String(node.depth));
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "forge-lineage-node";
        btn.dataset.id = node.id;
        const img = document.createElement("img");
        img.alt = "";
        img.loading = "lazy";
        img.src = node.thumb;
        const text = document.createElement("span");
        const kind = node.relation ? LABEL[node.relation] || "D\u00e9riv\u00e9e" : "Image de d\u00e9part";
        const extra = [day(node.created), TRIAGE[node.triage] || ""].filter(Boolean).join(" \u00b7 ");
        text.textContent = kind + (node.id === id ? " (cette image)" : "");
        const small = document.createElement("span");
        small.className = "forge-note";
        small.textContent = extra;
        const col = document.createElement("span");
        col.append(text, document.createElement("br"), small);
        btn.append(img, col);
        btn.setAttribute("aria-label", kind + (extra ? ", " + extra : "") + (node.id === id ? ", image affich\u00e9e" : ", ouvrir"));
        if (node.id === id) btn.setAttribute("aria-current", "true");
        btn.addEventListener("click", () => { if (node.id !== current) { box.open = false; H.closeViewer(); H.openImage(node.id); } });
        li.append(btn);
        tree.append(li);
      }
      const alone = out.nodes.length <= 1;
      note.textContent = alone ? "Cette image n'a ni image d'origine ni finition ou retouche dans la galerie." :
        (out.root_parent_missing ? "L'image de d\u00e9part a \u00e9t\u00e9 supprim\u00e9e ; l'arbre commence plus bas. " : "") + (out.truncated ? "Arbre tronqu\u00e9." : "");
    } catch (error) {
      if (id === current) note.textContent = error.message || "G\u00e9n\u00e9alogie indisponible.";
    }
  }

  const prev = window.hqForgeOnViewer;
  window.hqForgeOnViewer = (kind, id, triage) => {
    if (prev) prev(kind, id, triage);
    if (kind !== "normal") return;
    if (id !== current) { current = id; box.open = false; reset(); }
  };
  box.addEventListener("toggle", () => { if (box.open) load(); });
})();
