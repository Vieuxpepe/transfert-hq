/* Pure HQ UI helpers. No network, no DOM, no secrets. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    root.hqPaletteRecentEntry = api.paletteRecentEntry;
    root.hqSanitizeRecents = api.sanitizeRecents;
    root.hqGroupPaletteHits = api.groupPaletteHits;
    root.hqFilesSortMode = api.filesSortMode;
    root.hqSortFolderItems = api.sortFolderItems;
  }
})(typeof window !== "undefined" ? window : null, function () {
  const PALETTE_GROUPS = [
    ["folder", "Dossiers"],
    ["favorite", "Favoris"],
    ["device", "Appareils"],
    ["scene", "Scènes"],
    ["action", "Actions"],
    ["terminal", "Commandes"],
  ];
  const KIND_HINT = {
    folder: "Dossier",
    favorite: "Favori",
    device: "Appareil",
    scene: "Scène",
    action: "Action",
    terminal: "Commande",
  };
  const RECENTS_MAX = 6;
  const SORTS = ["name", "recent", "size"];

  function paletteRecentEntry(hit) {
    if (!hit || typeof hit !== "object") return null;
    const kind = String(hit.kind || "");
    if (!Object.prototype.hasOwnProperty.call(KIND_HINT, kind)) return null;
    const id = String(hit.id || "").slice(0, 120);
    const label = String(hit.label || "").slice(0, 120);
    if (!id || !label) return null;
    const hint = String(hit.hint || KIND_HINT[kind]).slice(0, 160);
    return { kind: kind, id: id, label: label, hint: hint };
  }

  function sanitizeRecents(raw, cap) {
    const limit = Math.min(8, Math.max(1, Number(cap) || RECENTS_MAX));
    const out = [];
    const seen = new Set();
    const list = Array.isArray(raw) ? raw : [];
    for (let i = 0; i < list.length; i += 1) {
      const entry = paletteRecentEntry(list[i]);
      if (!entry) continue;
      const key = entry.kind + "\0" + entry.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
      if (out.length >= limit) break;
    }
    return out;
  }

  function groupPaletteHits(hits) {
    const buckets = new Map();
    PALETTE_GROUPS.forEach(function (row) {
      buckets.set(row[0], { kind: row[0], label: row[1], items: [] });
    });
    const order = [];
    (hits || []).forEach(function (hit, index) {
      const bucket = buckets.get(hit && hit.kind);
      if (!bucket) return;
      if (!bucket.items.length) order.push(bucket);
      bucket.items.push({ hit: hit, index: index });
    });
    return order;
  }

  function filesSortMode(value) {
    return SORTS.indexOf(value) >= 0 ? value : "name";
  }

  function sortFolderItems(items, mode) {
    const chosen = filesSortMode(mode);
    const dirs = [];
    const files = [];
    (items || []).forEach(function (item) {
      if (!item) return;
      if (item.type === "dir") dirs.push(item);
      else files.push(item);
    });
    const byName = function (a, b) {
      return String(a.name || "").localeCompare(String(b.name || ""), "fr", { sensitivity: "base" });
    };
    const byRecent = function (a, b) {
      return (Number(b.mtime) || 0) - (Number(a.mtime) || 0) || byName(a, b);
    };
    const bySize = function (a, b) {
      return (Number(b.size) || 0) - (Number(a.size) || 0) || byName(a, b);
    };
    if (chosen === "recent") {
      dirs.sort(byRecent);
      files.sort(byRecent);
    } else if (chosen === "size") {
      dirs.sort(byName);
      files.sort(bySize);
    } else {
      dirs.sort(byName);
      files.sort(byName);
    }
    return dirs.concat(files);
  }

  return {
    RECENTS_MAX: RECENTS_MAX,
    PALETTE_GROUPS: PALETTE_GROUPS,
    KIND_HINT: KIND_HINT,
    paletteRecentEntry: paletteRecentEntry,
    sanitizeRecents: sanitizeRecents,
    groupPaletteHits: groupPaletteHits,
    filesSortMode: filesSortMode,
    sortFolderItems: sortFolderItems,
  };
});
