/* Forge coffre: the vault panel's rendering only. hq-forge.js keeps the state, the API calls and the
   privacy scrub; this file is fetched the first time the coffre becomes the destination, so a normal
   visit to the generator never parses it. The card, the order controls and the icon cache all read
   their state through the ctx object core hands over, so nothing here can hold a stale copy. */
(function () {
  "use strict";

  function create(ctx) {
    const $ = ctx.$;
    const api = ctx.api;
    const quoted = ctx.quoted;
    const GLYPHS = ctx.glyphs;
    const COLOURS = ctx.colours;

    // V5 photo icon: one blob URL for the open vault, dropped as soon as it is locked or switched.
    let iconCache = { vid: null, url: null, loading: null };

    function dropIcon() {
      if (iconCache.url) URL.revokeObjectURL(iconCache.url);
      iconCache = { vid: null, url: null, loading: null };
    }

    function loadIcon(vid) {
      if (iconCache.loading === vid) return;
      dropIcon();
      iconCache.loading = vid;
      fetch("/api/forge/vaults/" + encodeURIComponent(vid) + "/icon", { credentials: "same-origin", cache: "no-store" })
        .then((response) => (response.ok ? response.blob() : null))
        .then((blob) => {
          if (!blob || iconCache.loading !== vid || ctx.openVid !== vid) return;
          iconCache = { vid, url: URL.createObjectURL(blob), loading: null };
          renderVaults();
        })
        .catch(() => { if (iconCache.loading === vid) iconCache.loading = null; });
    }

    function vaultCard(v, move) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      const open = v.id === ctx.openVid;
      button.type = "button";
      button.className = "forge-vault-card";
      button.dataset.vid = v.id;
      button.dataset.open = open ? "true" : "false";
      const tile = document.createElement("span");
      tile.className = "forge-vault-tile";
      tile.dataset.colour = COLOURS[v.colour] ? v.colour : "ardoise";
      tile.setAttribute("aria-hidden", "true");
      tile.textContent = (GLYPHS[v.glyph] || GLYPHS.coffre)[0];
      if (open && v.icon) {
        // V5: the photo icon, only while this vault is open here; locked, the glyph and colour stay.
        if (iconCache.vid === v.id && iconCache.url) {
          const img = document.createElement("img");
          img.alt = "";
          img.src = iconCache.url;
          tile.replaceChildren(img);
          tile.classList.add("forge-vault-tile-photo");
        } else {
          loadIcon(v.id);
        }
      }
      const name = document.createElement("span");
      name.className = "forge-vault-card-name";
      name.textContent = ctx.vaultName(v);
      const state = document.createElement("span");
      state.className = "forge-vault-card-state";
      state.textContent = open ? "Ouvert" : "Verrouillé";
      button.append(tile, name, state);
      button.setAttribute("aria-label", ctx.vaultName(v) + ", " + state.textContent.toLowerCase());
      button.addEventListener("click", () => {
        if (v.id === ctx.openVid) {
          ctx.vaultsNote(quoted(ctx.vaultName(v)) + " est déjà ouvert.");
          return;
        }
        ctx.openSheet(v.id);
      });
      item.appendChild(button);
      if (move) {
        // V5: manual order with buttons (no drag and drop), 44 px each.
        const row = document.createElement("div");
        row.className = "forge-vault-move";
        [["up", "Monter", -1], ["down", "Descendre", 1]].forEach(([dir, text, delta]) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "secondary";
          b.dataset.move = dir;
          b.textContent = text;
          b.setAttribute("aria-label", text + " " + ctx.vaultSafeName(v));
          b.disabled = (delta < 0 && move.first) || (delta > 0 && move.last);
          b.addEventListener("click", () => { moveVault(v.id, delta).catch((error) => ctx.vaultsNote(error.message || "L'ordre n'a pas pu \u00eatre enregistr\u00e9.")); });
          row.appendChild(b);
        });
        item.appendChild(row);
      }
      return item;
    }

    function sortedVaults(rows) {
      const list = rows.slice();
      if (ctx.vaultSort === "nom") list.sort((a, b) => ctx.vaultSafeName(a).localeCompare(ctx.vaultSafeName(b), "fr", { sensitivity: "base" }));
      else if (ctx.vaultSort === "recent") list.sort((a, b) => String(b.last_used_day || "").localeCompare(String(a.last_used_day || "")) || a.number - b.number);
      return list;
    }

    async function moveVault(vid, delta) {
      const ids = (ctx.listing.vaults || []).map((v) => v.id);
      const at = ids.indexOf(vid);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= ids.length) return;
      [ids[at], ids[to]] = [ids[to], ids[at]];
      await api("/api/forge/vaults/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
      await ctx.refreshVault();
      const v = ctx.vaultById(vid);
      ctx.vaultsNote(v ? quoted(ctx.vaultSafeName(v)) + (delta < 0 ? " est mont\u00e9." : " est descendu.") : "");
      const again = document.querySelector('.forge-vault-card[data-vid="' + vid + '"]');
      const btn = again && again.parentElement.querySelector('[data-move="' + (delta < 0 ? "up" : "down") + '"]');
      if (btn && !btn.disabled) btn.focus(); else if (again) again.focus();
    }

    function renderVaults() {
      const list = $("forge-vaults-list");
      list.replaceChildren();
      const rows = ctx.listing.vaults || [];
      if (iconCache.vid && iconCache.vid !== ctx.openVid) dropIcon();
      const manual = ctx.vaultSort === "manuel" && rows.length > 1;
      const ordered = sortedVaults(rows);
      // Panel redesign: one card on top (the open vault, else the destination, else the first); the rest behind a fold.
      const current = ctx.vaultById(ctx.openVid) || ctx.vaultById(ctx.privateTarget) || ordered[0] || null;
      if (rows.length < 2) ctx.vaultsAll = false;
      ordered.forEach((v, index, all) => {
        const item = vaultCard(v, manual ? { first: index === 0, last: index === all.length - 1 } : null);
        if (current && v.id === current.id) item.classList.add("is-current");
        list.appendChild(item);
      });
      list.classList.toggle("is-all", ctx.vaultsAll);
      const allBtn = $("forge-vaults-all");
      allBtn.hidden = rows.length < 2;
      allBtn.textContent = ctx.vaultsAll ? "Masquer les autres coffres" : "Tous mes coffres (" + rows.length + ")";
      allBtn.setAttribute("aria-expanded", ctx.vaultsAll ? "true" : "false");
      $("forge-vaults-more").hidden = !ctx.vaultsAll;
      ctx.currentVid = current ? current.id : null;
      $("forge-vault-current-actions").hidden = !current;
      $("forge-vault-lock").hidden = !current || current.id !== ctx.openVid;
      $("forge-vault-current-open").hidden = !current || current.id === ctx.openVid;
      if (current) $("forge-vault-current-open").setAttribute("aria-label", "Ouvrir " + quoted(ctx.vaultName(current)));
      $("forge-vaults-sort-note").hidden = ctx.vaultSort !== "recent";
      ctx.syncVaultEdit();
      $("forge-vaults-new").hidden = rows.length >= (ctx.listing.max || 12) || ctx.listing.layout === "legacy";
      $("forge-vaults-restore").hidden = $("forge-vaults-new").hidden;
      $("forge-vaults-empty").hidden = rows.length > 0;
      const opened = ctx.vaultById(ctx.openVid);
      $("forge-vault-gallery-title").textContent = opened ? ctx.vaultName(opened) : "Coffre";
      ctx.renderTarget();
      if (window.hqForgeOnVaults) window.hqForgeOnVaults();
    }

    return { renderVaults, dropIcon, loadIcon, vaultCard, sortedVaults, moveVault };
  }

  window.hqForgeVault = { create };
})();
