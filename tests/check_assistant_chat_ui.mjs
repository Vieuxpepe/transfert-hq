// Offline proof of the chat-UI wiring: the four stop controls, Securia's
// confirmation card and Musica's composer stop. Runs the real browser files in
// a small DOM (tests/hq_dom_stub.mjs) — no browser, no server, no network.
//
//   node tests/check_assistant_chat_ui.mjs            normal run
//   HQ_UI_PROVE=1 node tests/check_assistant_chat_ui.mjs   sabotage run: each
//     test is replayed against a copy of its module with the route removed and
//     must fail, proving the click-to-route assertions are load-bearing.
import assert from "node:assert/strict";
import { loadChip, byId, byText, tick, deferred } from "./hq_dom_stub.mjs";

const PROVE = process.env.HQ_UI_PROVE === "1";
const proven = [];

function sabotage(from, to) {
  return (source) => {
    assert.ok(source.includes(from), "mutation target present: " + from);
    return source.replace(from, to);
  };
}

async function forgia(mutate) {
  const h = loadChip("hq-forgia-chip.js", { view: "forge", mutate });
  const { doc, net } = h;
  const stop = byId(doc, "hq-forgia-stop");
  assert.ok(stop, "forgia: stop control exists");
  assert.equal(stop.hidden, true, "forgia: stop hidden while idle");
  net.on("/api/forgia/status", () => ({ body: { ok: true, headline: "enclume chaude", thread: [] } }));
  byId(doc, "hq-forgia-chip").click();
  await tick();
  assert.equal(byId(doc, "hq-forgia-drawer").hidden, false, "forgia: drawer opens");

  const chat = deferred();
  net.on("/api/forgia/chat", () => chat.promise);
  net.on("/api/forgia/cancel", () => ({ body: { ok: true, cancelled: true } }));
  byId(doc, "hq-forgia-input").value = "un prompt cyberpunk";
  byId(doc, "hq-forgia-form").dispatchEvent({ type: "submit", bubbles: true });
  await tick();
  assert.equal(stop.hidden, false, "forgia: stop appears while the turn is busy");

  stop.click();
  await tick();
  const sent = net.callsTo("/api/forgia/cancel");
  assert.equal(sent.length, 1, "forgia: one click -> exactly one cancel request");
  assert.equal(sent[0].method, "POST", "forgia: cancel is a POST");
  assert.match(String(sent[0].body && sent[0].body.job), /^fg-[a-z0-9]{20}$/, "forgia: cancel carries the turn job");
  assert.equal(stop.disabled, true, "forgia: stop disabled while the cancel is in flight");

  chat.resolve({ status: 200, body: { ok: true, cancelled: true, messages: [] } });
  await tick(6);
  assert.equal(stop.hidden, true, "forgia: stop disappears after the cancelled turn");
  const thread = byId(doc, "hq-forgia-messages").textContent;
  assert.ok(!thread.includes("Inspection de l'atelier"), "forgia: no ghost assistant draft after cancel");
  assert.equal(net.callsTo("/api/forgia/chat").length, 1, "forgia: the turn was sent once");
}

async function culinia(mutate) {
  const h = loadChip("hq-culinia-chip.js", { view: "cuisine", mutate });
  const { doc, net } = h;
  const stop = byId(doc, "hq-culinia-stop");
  assert.ok(stop, "culinia: stop control exists");
  assert.equal(stop.hidden, true, "culinia: stop hidden while idle");
  net.on("/api/culinia/status", () => ({ body: { ok: true, headline: "fourneaux prêts", thread: [] } }));
  byId(doc, "hq-culinia-chip").click();
  await tick();
  assert.equal(byId(doc, "hq-culinia-drawer").hidden, false, "culinia: drawer opens");

  const chat = deferred();
  net.on("/api/culinia/chat", () => chat.promise);
  net.on("/api/culinia/cancel", () => ({ body: { ok: true, cancelled: true } }));
  byId(doc, "hq-culinia-input").value = "un menu du mardi";
  byId(doc, "hq-culinia-form").dispatchEvent({ type: "submit", bubbles: true });
  await tick();
  assert.equal(stop.hidden, false, "culinia: stop appears while the turn is busy");

  stop.click();
  await tick();
  const sent = net.callsTo("/api/culinia/cancel");
  assert.equal(sent.length, 1, "culinia: one click -> exactly one cancel request");
  assert.equal(sent[0].method, "POST", "culinia: cancel is a POST");
  assert.match(String(sent[0].body && sent[0].body.job), /^cl-[a-z0-9]{20}$/, "culinia: cancel carries the turn job");
  assert.equal(stop.disabled, true, "culinia: stop disabled while the cancel is in flight");

  chat.resolve({ status: 200, body: { ok: true, cancelled: true, messages: [] } });
  await tick(6);
  assert.equal(stop.hidden, true, "culinia: stop disappears after the cancelled turn");
  const thread = byId(doc, "hq-culinia-messages").textContent;
  assert.ok(!thread.includes("Vérification des fourneaux"), "culinia: no ghost assistant draft after cancel");
  assert.equal(net.callsTo("/api/culinia/chat").length, 1, "culinia: the turn was sent once");
}

const PENDING_PROPOSAL = () => [
  { role: "user", text: "bloque 203.0.113.9" },
  {
    role: "assistant",
    text: "Je peux bloquer cette adresse.",
    tools_used: ["block_ip"],
    proposals: [{
      id: "scp-11112222",
      name: "block_ip",
      args: { ip: "203.0.113.9" },
      summary: "Bloquer 203.0.113.9 (permanent)",
      status: "pending",
    }],
  },
];
const RESOLVED_PROPOSAL = (status) => {
  const messages = PENDING_PROPOSAL();
  messages[1].proposals[0].status = status;
  messages[1].proposals[0].result = status === "done" ? "adresse bloquée" : "";
  return messages;
};

async function openSecuria(mutate) {
  const h = loadChip("hq-securia-chip.js", { view: "securite", mutate });
  const { doc, net } = h;
  const stop = byId(doc, "hq-securia-stop");
  assert.ok(stop, "securia: stop control exists");
  assert.equal(stop.hidden, true, "securia: stop hidden while idle");
  net.on("/api/securia/status", () => ({ body: { ok: true, headline: "calme", thread: [] } }));
  byId(doc, "hq-securia-chip").click();
  await tick();
  assert.equal(byId(doc, "hq-securia-drawer").hidden, false, "securia: drawer opens");

  const chat = deferred();
  net.on("/api/securia/chat", () => chat.promise);
  net.on("/api/securia/cancel", () => ({ body: { ok: true, cancelled: true } }));
  byId(doc, "hq-securia-input").value = "bloque 203.0.113.9";
  byId(doc, "hq-securia-form").dispatchEvent({ type: "submit", bubbles: true });
  await tick();
  assert.equal(stop.hidden, false, "securia: stop appears while the turn is busy");

  stop.click();
  await tick();
  const sent = net.callsTo("/api/securia/cancel");
  assert.equal(sent.length, 1, "securia: one click -> exactly one cancel request");
  assert.equal(sent[0].method, "POST", "securia: cancel is a POST");
  assert.match(String(sent[0].body && sent[0].body.job), /^sc-[a-z0-9]{20}$/, "securia: cancel carries the turn job");
  assert.equal(stop.disabled, true, "securia: stop disabled while the cancel is in flight");

  chat.resolve({ status: 200, body: { ok: true, cancelled: true, messages: [] } });
  await tick(6);
  assert.equal(stop.hidden, true, "securia: stop disappears after the cancelled turn");
  const thread = byId(doc, "hq-securia-messages").textContent;
  assert.ok(!thread.includes("Analyse de la télémétrie"), "securia: no ghost assistant draft after cancel");
  assert.equal(net.callsTo("/api/securia/chat").length, 1, "securia: the turn was sent once");
  return h;
}

async function securiaCard(mutate, kind) {
  const h = await openSecuria(mutate);
  const { doc, net } = h;
  const chat = deferred();
  net.on("/api/securia/chat", () => chat.promise);
  byId(doc, "hq-securia-input").value = "bloque 203.0.113.9";
  byId(doc, "hq-securia-form").dispatchEvent({ type: "submit", bubbles: true });
  chat.resolve({ status: 200, body: { ok: true, messages: PENDING_PROPOSAL() } });
  await tick(6);

  const card = doc.querySelector(".hq-securia-proposal");
  assert.ok(card, "securia: pending proposal card rendered");
  assert.ok(card.textContent.includes("Bloquer 203.0.113.9"), "securia: card names the action");
  assert.equal(doc.querySelectorAll(".hq-securia-proposal-btn").length, 2, "securia: confirm and dismiss offered");

  const action = kind === "dismiss" ? "annuler" : "confirmer";
  const button = byText(card, kind === "dismiss" ? "Annuler" : "Confirmer", "button");
  assert.ok(button, "securia: " + action + " button exists");

  if (kind === "fail") {
    net.on("/api/securia/confirm", () => ({ status: 500, body: { error: "refus du pare-feu" } }));
  } else {
    net.on("/api/securia/" + kind, () => ({ body: { ok: true, messages: RESOLVED_PROPOSAL(kind === "confirm" ? "done" : "dismissed") } }));
  }
  button.click();
  await tick();
  const route = "/api/securia/" + (kind === "fail" ? "confirm" : kind);
  const sent = net.callsTo(route);
  assert.equal(sent.length, 1, "securia: one click -> exactly one " + route + " request (calls: " + net.calls.map((c) => c.url).join(", ") + ")");
  assert.equal(sent[0].method, "POST", "securia: " + route + " is a POST");
  assert.deepEqual(sent[0].body, { id: "scp-11112222" }, "securia: " + route + " carries the proposal id");
  assert.equal(button.disabled, true, "securia: the button is disabled while the action runs");

  await tick(6);
  if (kind === "confirm") {
    const done = doc.querySelector(".hq-securia-proposal.is-done");
    assert.ok(done, "securia: card turns done");
    assert.ok(done.textContent.includes("Appliquée"), "securia: card shows the applied state");
    assert.ok(done.textContent.includes("adresse bloquée"), "securia: card shows the tool result");
    assert.equal(doc.querySelectorAll(".hq-securia-proposal-actions").length, 0, "securia: actions gone once applied");
  } else if (kind === "dismiss") {
    const off = doc.querySelector(".hq-securia-proposal.is-dismissed");
    assert.ok(off, "securia: card turns dismissed");
    assert.ok(off.textContent.includes("Annulée"), "securia: card shows the dismissed state");
  } else {
    assert.ok(h.win.toasts.some((t) => t.kind === "err" && t.message.includes("refus du pare-feu")),
      "securia: a failed confirm surfaces an error instead of silently doing nothing");
    assert.ok(doc.querySelector(".hq-securia-proposal"), "securia: the pending card stays visible after a failure");
  }
}

async function inventoria(mutate) {
  const h = loadChip("hq-inventoria-chip.js", { view: "inventaire", mutate });
  const { doc, net } = h;
  assert.ok(byId(doc, "hq-inventoria"), "inventoria: chip mounts");
  const thread = doc.querySelector(".hq-inventoria-thread-log");
  assert.ok(thread, "inventoria: thread exists");
  assert.equal(thread.querySelector(".hq-inventoria-typing-cancel"), null, "inventoria: no cancel control while idle");

  const chat = deferred();
  net.on("*", (call) => {
    if (call.url === "/api/inventoria/sessions") return { body: { ok: true, session: { id: "ivo-0000000000000001" } } };
    if (call.url === "/api/inventoria/sessions/ivo-0000000000000001/message") return chat.promise;
    if (call.url === "/api/inventoria/cancel") return { body: { ok: true, cancelled: true } };
    return { body: { ok: true } };
  });

  const input = doc.querySelector(".hq-inventoria-chat-input");
  assert.ok(input, "inventoria: chat input exists");
  input.value = "ajoute du lait";
  doc.querySelector(".hq-inventoria-chat").dispatchEvent({ type: "submit", bubbles: true });
  await tick(6);

  const cancel = thread.querySelector(".hq-inventoria-typing-cancel");
  assert.ok(cancel, "inventoria: cancel appears while the turn is busy");
  cancel.click();
  await tick(4);

  const sent = net.callsTo("/api/inventoria/cancel");
  assert.equal(sent.length, 1, "inventoria: one click -> exactly one cancel request");
  assert.equal(sent[0].method, "POST", "inventoria: cancel is a POST");
  assert.match(String(sent[0].body && sent[0].body.job), /^iot-[a-z0-9]+$/, "inventoria: cancel carries the turn job");
  assert.equal(thread.querySelector(".hq-inventoria-msg.is-typing"), null, "inventoria: typing draft removed on cancel");
  assert.ok(byId(doc, "hq-inventoria").textContent.includes("Annulé."), "inventoria: cancelled state is visible");
  assert.ok(byId(doc, "hq-inventoria").textContent.includes("Aucun changement de stock n'a été appliqué"),
    "inventoria: cancel promises only what is true (no stock change; saved notes/watches are kept)");
  assert.ok(thread.textContent.includes("ajoute du lait"), "inventoria: the question stays readable");
  assert.equal(net.calls.filter((c) => /\/cancel$/.test(c.url)).length, 1, "inventoria: only one cancel route was called");
}

async function mountMusica(mutate, options = {}) {
  const h = loadChip("hq-music.js", {
    view: "musique",
    mutate,
    win: { sessionStorage: { hq_music_tab: "musica" } },
  });
  const { doc, win } = h;
  const host = doc.createElement("div");
  host.id = "hq-music-host";
  doc.body.appendChild(host);

  const calls = [];
  const chats = [deferred(), deferred()];
  let chatCalls = 0;
  const request = async ({ path, method, body }) => {
    calls.push({ path, method: method || "GET", body });
    if (path === "/api/spotify/status") {
      return { status: 200, body: { connected: true, configured: true, product: "premium", devices: [] } };
    }
    if (path === "/api/music/taste") {
      return { status: 200, body: { taste: { banned_artists: [], auto_excluded: [], history_sharing: false } } };
    }
    if (path === "/api/musica/thread") return { status: 200, body: { messages: [] } };
    if (path === "/api/musica/chat") return chats[Math.min(chatCalls++, chats.length - 1)].promise;
    if (path === "/api/musica/cancel") {
      return options.cancelFails
        ? { status: 500, body: { error: "annulation refusée" } }
        : { status: 200, body: { ok: true, cancelled: true } };
    }
    if (path === "/api/musica/confirm") {
      return { status: 200, body: { thread: [{ role: "assistant", text: "Artiste banni.", actions: [] }] } };
    }
    if (path === "/api/spotify/player") return { status: 200, body: { playing: false, item: null } };
    if (path === "/api/spotify/devices") return { status: 200, body: { devices: [] } };
    if (path === "/api/spotify/playlists") return { status: 200, body: { playlists: [] } };
    return { status: 200, body: { ok: true } };
  };

  await win.HqMusic.mount(host, { request });
  await tick(10);
  return { h, host, calls, chats };
}

async function sendMusicaMessage(host, text) {
  const composer = host.querySelector(".hqm-chat-composer");
  assert.ok(composer, "musica: composer rendered");
  composer.querySelector("textarea").value = text;
  const send = byText(composer, "Envoyer", "button");
  assert.ok(send, "musica: send button exists");
  send.click();
  await tick(4);
  return composer;
}

async function musica(mutate) {
  const { host, calls, chats } = await mountMusica(mutate);
  const composer = host.querySelector(".hqm-chat-composer");
  assert.ok(!byText(composer, "Arrêter", "button"), "musica: no stop control while idle");
  await sendMusicaMessage(host, "joue du jazz");

  const stop = byText(host, "Arrêter", "button");
  assert.ok(stop, "musica: stop appears while the turn is busy");
  stop.click();
  await tick(4);

  const cancel = calls.filter((c) => c.path === "/api/musica/cancel");
  assert.equal(cancel.length, 1, "musica: one click -> exactly one cancel request");
  assert.equal(cancel[0].method, "POST", "musica: cancel is a POST");
  assert.match(String(cancel[0].body && cancel[0].body.job), /^mus-[a-z0-9]+$/, "musica: cancel carries the turn job");
  assert.equal(stop.disabled, true, "musica: stop disabled while the cancel is in flight");

  chats[0].resolve({ status: 200, body: { cancelled: true } });
  await tick(8);
  assert.equal(byText(host, "Arrêter", "button"), null, "musica: no stop control after the cancelled turn");
  assert.equal(host.querySelector(".hqm-chat-composer textarea").value, "", "musica: the draft is cleared, not left as a ghost");
  assert.ok(host.textContent.includes("Arrêtée. Rien n'a été enregistré."), "musica: cancelled state is announced");
  assert.equal(calls.filter((c) => c.path === "/api/musica/chat").length, 1, "musica: the turn was sent once");
}

async function musicaConfirm(mutate) {
  const { host, calls, chats } = await mountMusica(mutate);
  await sendMusicaMessage(host, "bannis Sabaton");
  chats[0].resolve({
    status: 200,
    body: {
      thread: [{
        role: "assistant",
        text: "Je peux bannir Sabaton.",
        actions: [{ name: "ban_artist", target: "Sabaton", needs_confirmation: true, token: "tok-sabaton" }],
      }],
    },
  });
  await tick(8);

  const confirm = host.querySelectorAll("button").find((b) => b.textContent.startsWith("Confirmer · Bannir"));
  assert.ok(confirm, "musica: a destructive action renders a Confirmer button");
  assert.equal(calls.filter((c) => c.path === "/api/musica/confirm").length, 0,
    "musica: nothing is confirmed before the click");

  confirm.click();
  await tick(6);
  const sent = calls.filter((c) => c.path === "/api/musica/confirm");
  assert.equal(sent.length, 1, "musica: one click -> exactly one confirm request");
  assert.equal(sent[0].method, "POST", "musica: confirm is a POST");
  assert.equal(sent[0].body && sent[0].body.token, "tok-sabaton", "musica: confirm carries the action token");
  assert.ok(host.textContent.includes("Artiste banni."), "musica: the confirmed thread replaces the proposal");
  assert.ok(!host.querySelectorAll("button").some((b) => b.textContent.startsWith("Confirmer · Bannir")),
    "musica: the confirm button is gone once applied");
}

// Mirrors the real proposal payload the chip can match a change card on:
// `payload.id` + `refs.item_id` for an existing item, `payload.name` for a created one.
function inventoriaOp(id, label, item) {
  const target = item || {};
  const payload = target.id ? { id: target.id, delta: 1 } : { name: target.name || label, qty: 2 };
  const refs = target.id ? { item_id: target.id } : {};
  return { id, proposals: [{ op: target.id ? "item.adjust" : "item.create", label_fr: label, payload, refs }] };
}

// noticeBox / detBox / groceryBox all carry the `hq-inventoria-draft` class too: take the bare one.
function inventoriaDraftBox(doc) {
  // The box itself, not its -title / -list children; it may also carry "is-queued" while another card is in front.
  return doc.querySelectorAll(".hq-inventoria-draft").find((n) => String(n.className).split(/\s+/).filter((t) => t && t !== "is-queued").join(" ") === "hq-inventoria-draft");
}

async function mountInventoria(mutate, labels, opts) {
  // The chip restores its thread during load, so the routes must exist before the script runs.
  let chat = null;
  const route = (call) => {
    const url = call.url;
    if (url === "/api/inventoria/sessions") {
      return { body: { ok: true, session: { id: "ivo-0000000000000001" } } };
    }
    if (url === "/api/inventoria/sessions/ivo-0000000000000001/message") return chat ? chat.promise : { status: 503, body: { error: "no turn" } };
    if (opts && opts.restore && /^\/api\/inventoria\/sessions\/[^/]+$/.test(url)) return { body: opts.restore };
    if (url === "/api/inventoria/ops/ivo-op-1/undo") {
      return { body: { ok: true, operation: inventoriaOp("ivo-op-2", "Annuler : Lait de -2", { id: "itm-lait", name: "Lait" }) } };
    }
    if (/\/validate$/.test(url)) return { body: { ok: true, validation: { ok: true } } };
    if (/\/preview$/.test(url)) {
      const opId = (url.match(/ops\/([^/]+)\/preview$/) || [])[1] || "";
      const label = (labels && labels[opId]) || (/ivo-op-2/.test(url) ? "Créer Papier (×2)" : "Ajuster Lait de +2");
      return { body: { ok: true, preview: { changes: [{ label_fr: label, before: { qty: 1 }, after: { qty: 3 } }] } } };
    }
    return { body: { ok: true } };
  };
  const h = loadChip("hq-inventoria-chip.js", {
    view: "inventaire", mutate, win: (opts && opts.win) || {},
    setup: (n) => n.on("*", route),
  });
  const { doc, win, net } = h;
  chat = deferred();

  const send = (text) => {
    const input = doc.querySelector(".hq-inventoria-chat-input");
    input.value = text;
    doc.querySelector(".hq-inventoria-chat").dispatchEvent({ type: "submit", bubbles: true });
  };
  return { doc, win, net, chat, send };
}

async function openInventoriaDraft(mutate) {
  const { doc, net, chat, send } = await mountInventoria(mutate);
  send("ajoute 2 lait");
  chat.resolve({
    status: 200,
    body: {
      ok: true,
      messages: [{ role: "user", text: "ajoute 2 lait" }, { role: "assistant", text: "J'ai préparé un brouillon." }],
      operations: [inventoriaOp("ivo-op-1", "Ajuster Lait de +2", { id: "itm-lait", name: "Lait" })],
    },
  });
  await tick(8);
  return { doc, net, draftBox: () => inventoriaDraftBox(doc) };
}

async function inventoriaDraft(mutate) {
  const { doc, net, draftBox } = await openInventoriaDraft(mutate);
  const draft = draftBox();
  assert.ok(draft && !draft.hidden, "inventoria: the draft is visible");
  assert.ok(draft.textContent.includes("Brouillon à vérifier — rien n'est appliqué"),
    "inventoria: the draft says nothing is applied yet");
  const apply = doc.querySelector(".hq-inventoria-draft-apply");
  assert.ok(apply, "inventoria: Appliquer offered");
  assert.equal(net.callsTo("/api/inventoria/ops/ivo-op-1/commit").length, 0,
    "inventoria: nothing is committed before the click");

  apply.click();
  await tick(8);
  const previews = net.callsTo("/api/inventoria/ops/ivo-op-1/preview");
  assert.equal(previews.length, 2, "inventoria: preview runs once to describe, once confirmed");
  assert.equal(previews[0].body.confirm, false, "inventoria: the describing preview is unconfirmed");
  assert.equal(previews[1].body.confirm, true, "inventoria: applying confirms the preview");
  const commits = net.callsTo("/api/inventoria/ops/ivo-op-1/commit");
  assert.equal(commits.length, 1, "inventoria: one click -> exactly one commit");
  assert.equal(commits[0].method, "POST", "inventoria: commit is a POST");
  assert.match(String(commits[0].body.idempotency_key), /^ivo-[0-9a-f-]+-0$/, "inventoria: commit is idempotent");
  assert.ok(draft.textContent.includes("Appliqué."), "inventoria: applied state shown");
  const undo = doc.querySelector(".hq-inventoria-draft-undo");
  assert.ok(undo, "inventoria: undo offered after applying");

  undo.click();
  await tick(8);
  const undone = net.callsTo("/api/inventoria/ops/ivo-op-1/undo");
  assert.equal(undone.length, 1, "inventoria: one click -> exactly one undo");
  assert.equal(undone[0].method, "POST", "inventoria: undo is a POST");
  assert.deepEqual(undone[0].body, {}, "inventoria: undo asks for the reverse operation");
  assert.ok(draftBox().textContent.includes("Annulation du lot"),
    "inventoria: undo opens its own draft instead of applying silently");
  const applyUndo = doc.querySelector(".hq-inventoria-draft-apply");
  assert.ok(applyUndo, "inventoria: the undo draft is appliable");

  applyUndo.click();
  await tick(8);
  assert.equal(net.callsTo("/api/inventoria/ops/ivo-op-2/commit").length, 1,
    "inventoria: applying the undo commits the reverse operation");
  assert.ok(draftBox().textContent.includes("Annulé."), "inventoria: the undo result is shown");
  assert.equal(doc.querySelector(".hq-inventoria-draft-undo"), null, "inventoria: no second undo after an undo");
}

async function inventoriaDismiss(mutate) {
  const { doc, net, draftBox } = await openInventoriaDraft(mutate);
  const draft = draftBox();
  const apply = doc.querySelector(".hq-inventoria-draft-apply");
  const dismiss = doc.querySelector(".hq-inventoria-draft-cancel");
  assert.ok(apply, "inventoria: Appliquer offered on the draft");
  assert.ok(dismiss, "inventoria: Annuler offered next to Appliquer");
  assert.equal(dismiss.textContent.trim(), "Annuler", "inventoria: the dismiss affordance says Annuler");
  assert.ok(draft.textContent.includes("Brouillon à vérifier"), "inventoria: the draft is on screen");

  // Displaying a draft only runs the unconfirmed describe pass (preview {confirm:false}).
  // Nothing destructive happens until a button is clicked.
  assert.equal(net.callsTo("/api/inventoria/ops/ivo-op-1/cancel").length, 0,
    "inventoria: nothing is cancelled before the click");
  assert.equal(net.callsTo("/api/inventoria/ops/ivo-op-1/commit").length, 0,
    "inventoria: nothing is committed before the click");
  const shownPreviews = net.callsTo("/api/inventoria/ops/ivo-op-1/preview");
  assert.equal(shownPreviews.length, 1, "inventoria: displaying the draft runs only the read-only preview");
  assert.equal(shownPreviews[0].body.confirm, false, "inventoria: that preview is unconfirmed");

  dismiss.click();
  await tick(8);
  const cancelled = net.callsTo("/api/inventoria/ops/ivo-op-1/cancel");
  assert.equal(cancelled.length, 1, "inventoria: one Annuler -> exactly one cancel request");
  assert.equal(cancelled[0].method, "POST", "inventoria: dismiss is a POST");
  assert.equal(Object.keys(cancelled[0].body || {}).length, 0, "inventoria: dismiss sends an empty payload");
  assert.equal(net.callsTo("/api/inventoria/ops/ivo-op-1/commit").length, 0,
    "inventoria: dismissing never commits");
  assert.equal(net.callsTo("/api/inventoria/ops/ivo-op-1/preview").filter((c) => c.body.confirm === true).length, 0,
    "inventoria: dismissing never confirms a preview");
  assert.equal(doc.querySelector(".hq-inventoria-draft-undo"), null,
    "inventoria: no undo offered for a lot that was never applied");
  assert.equal(doc.querySelector(".hq-inventoria-draft-list"), null, "inventoria: the draft list is gone after dismissal");
  assert.equal(doc.querySelector(".hq-inventoria-draft-apply"), null, "inventoria: Appliquer is gone after dismissal");
  assert.equal(doc.querySelector(".hq-inventoria-draft-cancel"), null, "inventoria: Annuler is gone after dismissal");
  assert.ok(draftBox().textContent.includes("Brouillon annulé."), "inventoria: the dismissal is stated");
  assert.equal(doc.querySelector(".hq-inventoria-msg.is-typing"), null, "inventoria: no spinner left behind");
  assert.ok(doc.querySelector(".hq-inventoria-thread-log").textContent.includes("J'ai préparé un brouillon."),
    "inventoria: the thread settles into a readable state");
}

async function musicaCancelFailure(mutate) {
  const { host, calls, chats } = await mountMusica(mutate, { cancelFails: true });
  await sendMusicaMessage(host, "bannis Sabaton");
  chats[0].resolve({
    status: 200,
    body: {
      thread: [{
        role: "assistant",
        text: "Je peux bannir Sabaton.",
        actions: [{ name: "ban_artist", target: "Sabaton", needs_confirmation: true, token: "tok-sabaton" }],
      }],
    },
  });
  await tick(8);
  assert.ok(host.querySelectorAll("button").some((b) => b.textContent.startsWith("Confirmer · Bannir")),
    "musica: a pending action is seeded in the thread");

  await sendMusicaMessage(host, "autre chose");
  const stop = byText(host, "Arrêter", "button");
  assert.ok(stop, "musica: stop offered for the running turn");
  stop.click();
  await tick(6);

  assert.equal(calls.filter((c) => c.path === "/api/musica/cancel").length, 1,
    "musica: one stop -> one cancel attempt");
  const status = host.querySelector(".hqm-status");
  assert.ok(status.textContent.includes("annulation refusée"),
    "musica: the failed cancel is surfaced, not silently swallowed");
  assert.ok(status.classList.contains("is-error"), "musica: the failure is an error state, not a silent success");
  const log = host.querySelector(".hqm-chat-log");
  const alert = log.querySelector("[role=alert]");
  assert.ok(alert, "musica: the failure renders inside the conversation log");
  assert.ok(log.contains(alert), "musica: the alert is contained by the thread subtree");
  assert.ok(alert.textContent.includes("annulation refusée"), "musica: the thread alert names the failure");
  assert.equal(stop.disabled, false, "musica: the stop is retryable after a failed cancel");
  assert.equal(calls.filter((c) => c.path === "/api/musica/confirm").length, 0,
    "musica: a failed cancel never confirms anything");
  assert.equal(calls.filter((c) => /commit|preview/.test(c.path)).length, 0,
    "musica: a failed cancel never commits or previews");
  assert.ok(host.querySelectorAll("button").some((b) => b.textContent.startsWith("Confirmer · Bannir")),
    "musica: the pending action is not dropped");
  assert.ok(host.querySelector(".hqm-typing"), "musica: the turn is still live, not dropped silently");

  chats[1].resolve({ status: 200, body: { thread: [{ role: "assistant", text: "Terminé.", actions: [] }] } });
  await tick(8);
  assert.equal(byText(host, "Arrêter", "button"), null, "musica: the stop clears once the turn ends");
  assert.equal(host.querySelector(".hqm-typing"), null, "musica: no stuck spinner after the failed cancel");
  assert.ok(host.textContent.includes("Terminé."), "musica: the turn still lands in the thread");
}

async function inventoriaGroceryIgnore(mutate) {
  const { doc, win, net, chat, send } = await mountInventoria(mutate);
  send("il me faut du lait");
  chat.resolve({
    status: 200,
    body: {
      ok: true,
      messages: [{ role: "user", text: "il me faut du lait" }, { role: "assistant", text: "Voici ta liste.", at: 1712000000 }],
      grocery: { lines: [{ name: "Papier", qty: 2, unit: "" }] },
      cards: { grocery: "ivo-op-2" },
      operations: [
        inventoriaOp("ivo-op-1", "Ajuster Lait de +2", { id: "itm-lait", name: "Lait" }),
        inventoriaOp("ivo-op-2", "Créer Papier (×2)", { name: "Papier" }),
      ],
    },
  });
  await tick(8);

  const grocery = doc.querySelector(".hq-inventoria-grocery");
  assert.ok(grocery && !grocery.hidden, "inventoria: the grocery change box is shown");
  assert.ok(grocery.textContent.includes("Papier"), "inventoria: the change is listed");
  const dismiss = byText(grocery, "Ignorer", "button");
  assert.ok(dismiss, "inventoria: Ignorer is offered on the change box");
  // The reply also carries an operation draft, so its read-only describe pass
  // (validate + preview {confirm:false}) does run; /to-grocery is never posted.
  assert.equal(net.callsTo("/api/inventoria/to-grocery").length, 0,
    "inventoria: displaying the change box never posts to /to-grocery");
  assert.equal(net.calls.filter((c) => /\/preview$/.test(c.url) && c.body && c.body.confirm === true).length, 0,
    "inventoria: displaying the change box never confirms a preview");

  dismiss.click();
  await tick(8);
  const cancelled = net.callsTo("/api/inventoria/ops/ivo-op-2/cancel");
  assert.equal(cancelled.length, 1, "inventoria: one Ignorer -> exactly one cancel for the card's own op");
  assert.equal(cancelled[0].method, "POST", "inventoria: the op cancel is a POST");
  assert.equal(Object.keys(cancelled[0].body || {}).length, 0, "inventoria: the op cancel sends an empty payload");
  assert.equal(net.callsTo("/api/inventoria/ops/ivo-op-1/cancel").length, 0,
    "inventoria: the neighbouring op is never cancelled");
  assert.equal(net.callsTo("/api/inventoria/to-grocery").length, 0, "inventoria: Ignorer never adds to the grocery list");
  assert.equal(grocery.hidden, true, "inventoria: the change box is dismissed");
  assert.equal(grocery.children.length, 0, "inventoria: the change is removed, not just hidden");
  assert.equal(net.calls.filter((c) => /\/commit$/.test(c.url)).length, 0, "inventoria: Ignorer never commits");
  assert.equal(net.calls.filter((c) => /\/preview$/.test(c.url) && c.body && c.body.confirm === true).length, 0,
    "inventoria: Ignorer never confirms a preview");
  const draft = inventoriaDraftBox(doc);
  assert.ok(draft && !draft.hidden, "inventoria: the operation draft stays visible");
  assert.ok(draft.textContent.includes("Ajuster Lait de +2"), "inventoria: the other change stays in the draft");
  assert.ok(!draft.textContent.includes("Créer Papier"), "inventoria: the ignored change left the draft");
  const apply = doc.querySelector(".hq-inventoria-draft-apply");
  assert.ok(apply && !apply.disabled, "inventoria: the rest of the draft is still appliable");
  assert.equal(doc.querySelector(".hq-inventoria-msg.is-typing"), null, "inventoria: no spinner");
  assert.ok(doc.querySelector(".hq-inventoria-thread-log").textContent.includes("Voici ta liste."),
    "inventoria: the thread stays readable");
}

async function inventoriaDetectIgnore(mutate) {
  const { doc, win, net, chat, send } = await mountInventoria(mutate);
  send("compte mes boîtes");
  chat.resolve({
    status: 200,
    body: {
      ok: true,
      messages: [{ role: "user", text: "compte mes boîtes" }, { role: "assistant", text: "Voici ce que je vois.", at: 1712000001 }],
      detections: { mode: "add", places: [], rows: [{ name: "Papier", qty: 2, confidence: "ok" }] },
      cards: { detections: "ivo-op-2" },
      operations: [
        inventoriaOp("ivo-op-1", "Ajuster Lait de +2", { id: "itm-lait", name: "Lait" }),
        inventoriaOp("ivo-op-2", "Créer Papier (×2)", { name: "Papier" }),
      ],
    },
  });
  await tick(8);

  const det = doc.querySelector(".hq-inventoria-detect");
  assert.ok(det && !det.hidden, "inventoria: the detection change box is shown");
  const dismiss = byText(det, "Ignorer", "button");
  assert.ok(dismiss, "inventoria: Ignorer is offered on the detection box");
  assert.equal(net.callsTo("/api/inventoria/detections").length, 0,
    "inventoria: displaying the detection box never posts to /detections");

  dismiss.click();
  await tick(8);
  const cancelled = net.callsTo("/api/inventoria/ops/ivo-op-2/cancel");
  assert.equal(cancelled.length, 1, "inventoria: one Ignorer -> exactly one cancel for the card's own op");
  assert.equal(cancelled[0].method, "POST", "inventoria: the op cancel is a POST");
  assert.equal(Object.keys(cancelled[0].body || {}).length, 0, "inventoria: the op cancel sends an empty payload");
  assert.equal(net.callsTo("/api/inventoria/ops/ivo-op-1/cancel").length, 0,
    "inventoria: the neighbouring op is never cancelled");
  assert.equal(det.hidden, true, "inventoria: the detection box is dismissed");
  assert.equal(det.children.length, 0, "inventoria: the detection change is removed, not just hidden");
  assert.equal(net.callsTo("/api/inventoria/detections").length, 0, "inventoria: Ignorer never prepares a detection draft");
  assert.equal(net.calls.filter((c) => /\/commit$/.test(c.url)).length, 0, "inventoria: Ignorer never commits");
  assert.equal(net.calls.filter((c) => /\/preview$/.test(c.url) && c.body && c.body.confirm === true).length, 0,
    "inventoria: Ignorer never confirms a preview");
  const draft = inventoriaDraftBox(doc);
  assert.ok(draft && !draft.hidden, "inventoria: the operation draft stays visible");
  assert.ok(draft.textContent.includes("Ajuster Lait de +2"), "inventoria: the other change stays in the draft");
  assert.ok(!draft.textContent.includes("Créer Papier"), "inventoria: the ignored change left the draft");
  assert.ok(doc.querySelector(".hq-inventoria-draft-apply"), "inventoria: the rest of the draft is still appliable");
  assert.equal(doc.querySelector(".hq-inventoria-msg.is-typing"), null, "inventoria: no spinner");
  assert.ok(doc.querySelector(".hq-inventoria-thread-log").textContent.includes("Voici ce que je vois."),
    "inventoria: the thread stays readable");
}

// A grocery line has no item id: the server binds it (by item name) to the adjust op and the chip honours that id.
async function inventoriaGroceryIgnoreAdjust(mutate) {
  const { doc, net, chat, send } = await mountInventoria(mutate, { "ivo-op-2": "Ajuster Riz de +1" });
  send("il me faut du riz");
  chat.resolve({
    status: 200,
    body: {
      ok: true,
      messages: [{ role: "user", text: "il me faut du riz" }, { role: "assistant", text: "Voici ta liste." }],
      grocery: { lines: [{ name: "Riz", qty: 1, unit: "" }] },
      cards: { grocery: "ivo-op-2" },
      operations: [
        inventoriaOp("ivo-op-1", "Ajuster Lait de +2", { id: "itm-lait" }),
        inventoriaOp("ivo-op-2", "Ajuster Riz de +1", { id: "itm-riz" }),
      ],
    },
  });
  await tick(8);

  const grocery = doc.querySelector(".hq-inventoria-grocery");
  assert.ok(grocery && !grocery.hidden, "inventoria: the grocery change box is shown");
  const dismiss = byText(grocery, "Ignorer", "button");
  assert.ok(dismiss, "inventoria: Ignorer is offered on the change box");
  dismiss.click();
  await tick(8);

  const cancelled = net.callsTo("/api/inventoria/ops/ivo-op-2/cancel");
  assert.equal(cancelled.length, 1, "inventoria: a name-only grocery line cancels the adjust op it names");
  assert.equal(cancelled[0].method, "POST", "inventoria: that adjust cancel is a POST");
  assert.equal(Object.keys(cancelled[0].body || {}).length, 0, "inventoria: that adjust cancel sends an empty payload");
  assert.equal(net.callsTo("/api/inventoria/ops/ivo-op-1/cancel").length, 0,
    "inventoria: the other adjust op is never cancelled");
  assert.equal(grocery.hidden, true, "inventoria: the change box is dismissed");
  const draft = inventoriaDraftBox(doc);
  assert.ok(draft && !draft.hidden, "inventoria: the operation draft stays visible");
  assert.ok(draft.textContent.includes("Ajuster Lait de +2"), "inventoria: the other adjust op stays in the draft");
  assert.ok(!draft.textContent.includes("Ajuster Riz de +1"), "inventoria: the ignored adjust op left the draft");
  assert.equal(net.calls.filter((c) => /\/commit$/.test(c.url)).length, 0, "inventoria: Ignorer never commits");
  assert.equal(net.calls.filter((c) => /\/preview$/.test(c.url) && c.body && c.body.confirm === true).length, 0,
    "inventoria: Ignorer never confirms a preview");
  assert.equal(doc.querySelector(".hq-inventoria-msg.is-typing"), null, "inventoria: no spinner");
}

// Two ops name the same item: the server sends no card op, so the card dismisses locally and cancels nothing.
async function inventoriaGroceryIgnoreAmbiguous(mutate) {
  const labels = { "ivo-op-1": "Ajuster Riz de +2", "ivo-op-2": "Ajuster Riz de +1" };
  const { doc, net, chat, send } = await mountInventoria(mutate, labels);
  send("il me faut du riz");
  chat.resolve({
    status: 200,
    body: {
      ok: true,
      messages: [{ role: "user", text: "il me faut du riz" }, { role: "assistant", text: "Voici ta liste." }],
      grocery: { lines: [{ name: "Riz", qty: 1, unit: "" }] },
      operations: [
        inventoriaOp("ivo-op-1", "Ajuster Riz de +2", { id: "itm-riz-a" }),
        inventoriaOp("ivo-op-2", "Ajuster Riz de +1", { id: "itm-riz-b" }),
      ],
    },
  });
  await tick(8);

  const grocery = doc.querySelector(".hq-inventoria-grocery");
  const dismiss = byText(grocery, "Ignorer", "button");
  dismiss.click();
  await tick(8);

  assert.equal(net.calls.filter((c) => /\/ops\/[^/]+\/cancel$/.test(c.url)).length, 0,
    "inventoria: an ambiguous card cancels no operation at all");
  assert.equal(grocery.hidden, true, "inventoria: the ambiguous card is dismissed locally");
  const draft = inventoriaDraftBox(doc);
  assert.ok(draft && !draft.hidden, "inventoria: the operation draft stays visible");
  assert.ok(draft.textContent.includes("Ajuster Riz de +2") && draft.textContent.includes("Ajuster Riz de +1"),
    "inventoria: both candidate ops stay in the draft");
  const apply = doc.querySelector(".hq-inventoria-draft-apply");
  assert.ok(apply && !apply.disabled, "inventoria: the draft is still appliable");
  assert.equal(net.calls.filter((c) => /\/commit$/.test(c.url)).length, 0, "inventoria: an ambiguous Ignorer never commits");
  assert.equal(doc.querySelector(".hq-inventoria-msg.is-typing"), null, "inventoria: no spinner");
}

// The card's lines name two different operations: the server sends no card op, so Ignorer cancels nothing.
async function inventoriaGroceryIgnoreMultiRow(mutate) {
  const labels = { "ivo-op-1": "Ajuster Lait de +2", "ivo-op-2": "Ajuster Riz de +1" };
  const { doc, net, chat, send } = await mountInventoria(mutate, labels);
  send("il me faut du lait et du riz");
  chat.resolve({
    status: 200,
    body: {
      ok: true,
      messages: [{ role: "user", text: "il me faut du lait et du riz" }, { role: "assistant", text: "Voici ta liste." }],
      grocery: { lines: [{ name: "Lait", qty: 2, unit: "" }, { name: "Riz", qty: 1, unit: "" }] },
      operations: [
        inventoriaOp("ivo-op-1", "Ajuster Lait de +2", { id: "itm-lait" }),
        inventoriaOp("ivo-op-2", "Ajuster Riz de +1", { id: "itm-riz" }),
      ],
    },
  });
  await tick(8);

  const grocery = doc.querySelector(".hq-inventoria-grocery");
  assert.ok(grocery && !grocery.hidden, "inventoria: the grocery change box is shown");
  assert.ok(grocery.textContent.includes("Lait") && grocery.textContent.includes("Riz"),
    "inventoria: both lines are listed before Ignorer");
  const dismiss = byText(grocery, "Ignorer", "button");
  dismiss.click();
  await tick(8);

  assert.equal(net.calls.filter((c) => /\/ops\/[^/]+\/cancel$/.test(c.url)).length, 0,
    "inventoria: a card spanning two ops cancels no operation at all");
  assert.equal(grocery.hidden, true, "inventoria: the spanning card is dismissed locally");
  assert.equal(grocery.children.length, 0, "inventoria: the spanning card's lines are removed");
  const draft = inventoriaDraftBox(doc);
  assert.ok(draft && !draft.hidden, "inventoria: the operation draft stays visible");
  assert.ok(draft.textContent.includes("Ajuster Lait de +2") && draft.textContent.includes("Ajuster Riz de +1"),
    "inventoria: every op stays in the draft");
  const apply = doc.querySelector(".hq-inventoria-draft-apply");
  assert.ok(apply && !apply.disabled, "inventoria: the whole draft is still appliable");
  assert.equal(net.calls.filter((c) => /\/commit$/.test(c.url)).length, 0,
    "inventoria: a spanning Ignorer never commits");
  assert.equal(net.calls.filter((c) => /\/preview$/.test(c.url) && c.body && c.body.confirm === true).length, 0,
    "inventoria: a spanning Ignorer never confirms a preview");
  assert.equal(doc.querySelector(".hq-inventoria-msg.is-typing"), null, "inventoria: no phantom spinner");
}

// The detection rows name two different operations: the server sends no card op, so Ignorer cancels nothing.
async function inventoriaDetectIgnoreMultiRow(mutate) {
  const labels = { "ivo-op-1": "Ajuster Lait de +2", "ivo-op-2": "Ajuster Riz de +1" };
  const { doc, net, chat, send } = await mountInventoria(mutate, labels);
  send("compte mes boîtes");
  chat.resolve({
    status: 200,
    body: {
      ok: true,
      messages: [{ role: "user", text: "compte mes boîtes" }, { role: "assistant", text: "Voici ce que je vois." }],
      detections: {
        mode: "add", places: [],
        rows: [{ name: "Lait", qty: 1, confidence: "ok" }, { name: "Riz", qty: 2, confidence: "ok" }],
      },
      operations: [
        inventoriaOp("ivo-op-1", "Ajuster Lait de +2", { id: "itm-lait" }),
        inventoriaOp("ivo-op-2", "Ajuster Riz de +1", { id: "itm-riz" }),
      ],
    },
  });
  await tick(8);

  const det = doc.querySelector(".hq-inventoria-detect");
  assert.ok(det && !det.hidden, "inventoria: the detection change box is shown");
  assert.ok(det.textContent.includes("Lait") && det.textContent.includes("Riz"),
    "inventoria: both detected rows are listed before Ignorer");
  const dismiss = byText(det, "Ignorer", "button");
  dismiss.click();
  await tick(8);

  assert.equal(net.calls.filter((c) => /\/ops\/[^/]+\/cancel$/.test(c.url)).length, 0,
    "inventoria: a detection card spanning two ops cancels no operation at all");
  assert.equal(det.hidden, true, "inventoria: the spanning detection card is dismissed locally");
  assert.equal(det.children.length, 0, "inventoria: the spanning detection card's rows are removed");
  const draft = inventoriaDraftBox(doc);
  assert.ok(draft && !draft.hidden, "inventoria: the operation draft stays visible");
  assert.ok(draft.textContent.includes("Ajuster Lait de +2") && draft.textContent.includes("Ajuster Riz de +1"),
    "inventoria: every op stays in the draft");
  const apply = doc.querySelector(".hq-inventoria-draft-apply");
  assert.ok(apply && !apply.disabled, "inventoria: the whole draft is still appliable");
  assert.equal(net.calls.filter((c) => /\/commit$/.test(c.url)).length, 0,
    "inventoria: a spanning detection Ignorer never commits");
  assert.equal(net.calls.filter((c) => /\/preview$/.test(c.url) && c.body && c.body.confirm === true).length, 0,
    "inventoria: a spanning detection Ignorer never confirms a preview");
  assert.equal(net.callsTo("/api/inventoria/detections").length, 0,
    "inventoria: a spanning detection Ignorer never prepares a detection draft");
  assert.equal(doc.querySelector(".hq-inventoria-msg.is-typing"), null, "inventoria: no phantom spinner");
}

// A reloaded card rebinds the op id the server stored in the message meta, while that op is still pending.
async function mountRestored(mutate, opts) {
  const seed = Object.assign({ hq_inventoria_session: "ivo-0000000000000001" }, opts.seed || {});
  const h = await mountInventoria(mutate, opts.labels, {
    win: { localStorage: seed },
    restore: opts.restore,
  });
  await tick(8);
  return h;
}

const RESTORE_AT = 1712345678;
const restoreSession = (meta, pending) => ({
  ok: true,
  session: { id: "ivo-0000000000000001", messages: [{ role: "assistant", text: "Voici ce que je vois.", at: RESTORE_AT, meta }] },
  pending_operations: pending,
});

async function inventoriaRestoreGrocery(mutate) {
  const pending = [
    inventoriaOp("ivo-op-1", "Ajuster Lait de +2", { id: "itm-lait", name: "Lait" }),
    inventoriaOp("ivo-op-2", "Créer Papier (×2)", { name: "Papier" }),
  ];
  const { doc, net } = await mountRestored(mutate, {
    labels: { "ivo-op-1": "Ajuster Lait de +2", "ivo-op-2": "Créer Papier (×2)" },
    restore: restoreSession({ grocery: [{ name: "Papier", qty: 2, unit: "" }], grocery_op: "ivo-op-2" }, pending),
  });

  const grocery = doc.querySelector(".hq-inventoria-grocery");
  assert.ok(grocery && !grocery.hidden, "inventoria: the saved grocery card comes back after a reload");
  byText(grocery, "Ignorer", "button").click();
  await tick(8);

  assert.equal(net.callsTo("/api/inventoria/ops/ivo-op-2/cancel").length, 1,
    "inventoria: a restored grocery card cancels the op it saved");
  assert.equal(net.callsTo("/api/inventoria/ops/ivo-op-1/cancel").length, 0,
    "inventoria: a restored grocery card leaves the other pending op alone");
  assert.equal(grocery.hidden, true, "inventoria: the restored grocery card is dismissed");
  const draft = inventoriaDraftBox(doc);
  assert.ok(draft && draft.textContent.includes("Ajuster Lait de +2"), "inventoria: the untouched pending op stays in the draft");
  assert.ok(!draft.textContent.includes("Créer Papier"), "inventoria: the cancelled op left the draft");
  assert.equal(net.calls.filter((c) => /\/commit$/.test(c.url)).length, 0, "inventoria: a restored Ignorer never commits");
  assert.equal(net.calls.filter((c) => /\/preview$/.test(c.url) && c.body && c.body.confirm === true).length, 0,
    "inventoria: a restored Ignorer never confirms a preview");
  assert.equal(doc.querySelector(".hq-inventoria-msg.is-typing"), null, "inventoria: no spinner");
}

async function inventoriaRestoreDetect(mutate) {
  const pending = [
    inventoriaOp("ivo-op-1", "Ajuster Lait de +2", { id: "itm-lait", name: "Lait" }),
    inventoriaOp("ivo-op-2", "Créer Papier (×2)", { name: "Papier" }),
  ];
  const { doc, net } = await mountRestored(mutate, {
    labels: { "ivo-op-1": "Ajuster Lait de +2", "ivo-op-2": "Créer Papier (×2)" },
    restore: restoreSession({ detections: { mode: "add", places: [], rows: [{ name: "Papier", qty: 2, confidence: "ok" }] }, detections_op: "ivo-op-2" }, pending),
  });

  const det = doc.querySelector(".hq-inventoria-detect");
  assert.ok(det && !det.hidden, "inventoria: the saved detection card comes back after a reload");
  byText(det, "Ignorer", "button").click();
  await tick(8);

  assert.equal(net.callsTo("/api/inventoria/ops/ivo-op-2/cancel").length, 1,
    "inventoria: a restored detection card cancels the op it saved");
  assert.equal(net.callsTo("/api/inventoria/ops/ivo-op-1/cancel").length, 0,
    "inventoria: a restored detection card leaves the other pending op alone");
  assert.equal(det.hidden, true, "inventoria: the restored detection card is dismissed");
  const draft = inventoriaDraftBox(doc);
  assert.ok(draft && draft.textContent.includes("Ajuster Lait de +2"), "inventoria: the untouched pending op stays in the draft");
  assert.ok(!draft.textContent.includes("Créer Papier"), "inventoria: the cancelled op left the draft");
  assert.equal(net.calls.filter((c) => /\/commit$/.test(c.url)).length, 0, "inventoria: a restored detection Ignorer never commits");
  assert.equal(net.calls.filter((c) => /\/preview$/.test(c.url) && c.body && c.body.confirm === true).length, 0,
    "inventoria: a restored detection Ignorer never confirms a preview");
  assert.equal(doc.querySelector(".hq-inventoria-msg.is-typing"), null, "inventoria: no spinner");
}

async function inventoriaRestoreAmbiguous(mutate) {
  const pending = [
    inventoriaOp("ivo-op-1", "Ajuster Riz de +2", { id: "itm-riz-a" }),
    inventoriaOp("ivo-op-2", "Ajuster Riz de +1", { id: "itm-riz-b" }),
  ];
  const { doc, net } = await mountRestored(mutate, {
    labels: { "ivo-op-1": "Ajuster Riz de +2", "ivo-op-2": "Ajuster Riz de +1" },
    restore: restoreSession({ grocery: [{ name: "Riz", qty: 1, unit: "" }] }, pending),
  });

  const grocery = doc.querySelector(".hq-inventoria-grocery");
  assert.ok(grocery && !grocery.hidden, "inventoria: the saved grocery card comes back after a reload");
  byText(grocery, "Ignorer", "button").click();
  await tick(8);

  assert.equal(net.calls.filter((c) => /\/ops\/[^/]+\/cancel$/.test(c.url)).length, 0,
    "inventoria: a restored card with no unique saved op cancels nothing");
  assert.equal(grocery.hidden, true, "inventoria: the ambiguous restored card is dismissed locally");
  const draft = inventoriaDraftBox(doc);
  assert.ok(draft.textContent.includes("Ajuster Riz de +2") && draft.textContent.includes("Ajuster Riz de +1"),
    "inventoria: both same-named pending ops stay in the draft");
  const apply = doc.querySelector(".hq-inventoria-draft-apply");
  assert.ok(apply && !apply.disabled, "inventoria: the draft is still appliable");
  assert.equal(net.calls.filter((c) => /\/commit$/.test(c.url)).length, 0, "inventoria: an ambiguous restored Ignorer never commits");
  assert.equal(doc.querySelector(".hq-inventoria-msg.is-typing"), null, "inventoria: no spinner");
}

async function inventoriaRestoreOpGone(mutate) {
  const pending = [inventoriaOp("ivo-op-1", "Ajuster Lait de +2", { id: "itm-lait", name: "Lait" })];
  const { doc, net } = await mountRestored(mutate, {
    labels: { "ivo-op-1": "Ajuster Lait de +2" },
    restore: restoreSession({ grocery: [{ name: "Papier", qty: 2, unit: "" }], grocery_op: "ivo-op-9" }, pending),
  });

  const grocery = doc.querySelector(".hq-inventoria-grocery");
  assert.ok(grocery && !grocery.hidden, "inventoria: the saved grocery card comes back after a reload");
  byText(grocery, "Ignorer", "button").click();
  await tick(8);

  assert.equal(net.calls.filter((c) => /\/ops\/[^/]+\/cancel$/.test(c.url)).length, 0,
    "inventoria: a card whose saved op is gone cancels nothing");
  assert.equal(grocery.hidden, true, "inventoria: the gone-op card is dismissed locally");
  const draft = inventoriaDraftBox(doc);
  assert.ok(draft.textContent.includes("Ajuster Lait de +2"), "inventoria: the unrelated pending op stays in the draft");
  assert.equal(net.calls.filter((c) => /\/commit$/.test(c.url)).length, 0, "inventoria: a gone-op Ignorer never commits");
  assert.equal(doc.querySelector(".hq-inventoria-msg.is-typing"), null, "inventoria: no spinner");
}

async function inventoriaGroceryIgnoreFailure(mutate) {
  const { doc, net, chat, send } = await mountInventoria(mutate);
  net.on("/api/inventoria/ops/ivo-op-2/cancel", () => ({ status: 500, body: { error: "op introuvable" } }));
  send("il me faut du lait");
  chat.resolve({
    status: 200,
    body: {
      ok: true,
      messages: [{ role: "assistant", text: "Voici ta liste." }],
      grocery: { lines: [{ name: "Papier", qty: 2, unit: "" }] },
      cards: { grocery: "ivo-op-2" },
      operations: [
        inventoriaOp("ivo-op-1", "Ajuster Lait de +2", { id: "itm-lait", name: "Lait" }),
        inventoriaOp("ivo-op-2", "Créer Papier (×2)", { name: "Papier" }),
      ],
    },
  });
  await tick(8);

  const grocery = doc.querySelector(".hq-inventoria-grocery");
  const dismiss = byText(grocery, "Ignorer", "button");
  dismiss.click();
  await tick(8);

  assert.equal(net.callsTo("/api/inventoria/ops/ivo-op-2/cancel").length, 1,
    "inventoria: a failed cancel is attempted once for the card's own op");
  assert.equal(net.callsTo("/api/inventoria/ops/ivo-op-1/cancel").length, 0,
    "inventoria: a failed dismiss never touches the neighbouring op");
  const alert = grocery.querySelector("[role=alert]");
  assert.ok(alert && grocery.contains(alert), "inventoria: the failure is surfaced inside the change card");
  assert.ok(alert.textContent.includes("op introuvable"), "inventoria: the card shows the server error");
  assert.equal(grocery.hidden, false, "inventoria: a failed Ignorer leaves the change visible");
  assert.equal(dismiss.disabled, false, "inventoria: a failed Ignorer leaves the change retryable");
  assert.ok(inventoriaDraftBox(doc).textContent.includes("Ajuster Lait de +2"),
    "inventoria: a failed Ignorer does not drop the op from the draft");
  assert.equal(net.calls.filter((c) => /\/commit$/.test(c.url)).length, 0, "inventoria: a failed Ignorer never commits");
  assert.equal(net.calls.filter((c) => /\/preview$/.test(c.url) && c.body && c.body.confirm === true).length, 0,
    "inventoria: a failed Ignorer never confirms a preview");
  assert.equal(doc.querySelector(".hq-inventoria-msg.is-typing"), null, "inventoria: no spinner");

  net.on("/api/inventoria/ops/ivo-op-2/cancel", () => ({ body: { ok: true } }));
  dismiss.click();
  await tick(8);
  assert.equal(net.callsTo("/api/inventoria/ops/ivo-op-2/cancel").length, 2,
    "inventoria: the retry reaches the card's own cancel route again");
  assert.equal(grocery.hidden, true, "inventoria: the retry clears the change card");
  assert.ok(!inventoriaDraftBox(doc).textContent.includes("Créer Papier"),
    "inventoria: the retry removes the ignored op from the draft");
}

async function inventoriaDetectIgnoreFailure(mutate) {
  const { doc, net, chat, send } = await mountInventoria(mutate);
  net.on("/api/inventoria/ops/ivo-op-2/cancel", () => ({ status: 500, body: { error: "op introuvable" } }));
  send("compte mes boîtes");
  chat.resolve({
    status: 200,
    body: {
      ok: true,
      messages: [{ role: "assistant", text: "Voici ce que je vois." }],
      detections: { mode: "add", places: [], rows: [{ name: "Papier", qty: 2, confidence: "ok" }] },
      cards: { detections: "ivo-op-2" },
      operations: [
        inventoriaOp("ivo-op-1", "Ajuster Lait de +2", { id: "itm-lait", name: "Lait" }),
        inventoriaOp("ivo-op-2", "Créer Papier (×2)", { name: "Papier" }),
      ],
    },
  });
  await tick(8);

  const det = doc.querySelector(".hq-inventoria-detect");
  const dismiss = byText(det, "Ignorer", "button");
  dismiss.click();
  await tick(8);

  const alert = det.querySelector("[role=alert]");
  assert.ok(alert && det.contains(alert), "inventoria: the detection failure is surfaced inside the card");
  assert.ok(alert.textContent.includes("op introuvable"), "inventoria: the detection card shows the server error");
  assert.equal(det.hidden, false, "inventoria: a failed detection Ignorer leaves the change visible");
  assert.equal(dismiss.disabled, false, "inventoria: a failed detection Ignorer leaves the change retryable");
  assert.ok(inventoriaDraftBox(doc).textContent.includes("Ajuster Lait de +2"),
    "inventoria: a failed detection Ignorer does not drop the op from the draft");

  net.on("/api/inventoria/ops/ivo-op-2/cancel", () => ({ body: { ok: true } }));
  dismiss.click();
  await tick(8);
  assert.equal(det.hidden, true, "inventoria: the detection retry clears the card");
  assert.ok(!inventoriaDraftBox(doc).textContent.includes("Créer Papier"),
    "inventoria: the detection retry removes the ignored op from the draft");
}

// A trusted change came back already applied: a toast says what changed and its Undo applies the inverse in one tap.
async function inventoriaUndoToast(mutate) {
  const { doc, net, chat, send } = await mountInventoria(mutate);
  net.on("/api/inventoria/ops/ivo-op-7/undo", () => ({ body: { ok: true, applied: [{ operation_id: "ivo-op-8", changes: [] }] } }));
  send("j'ai fini un lait");
  chat.resolve({
    status: 200,
    body: {
      ok: true,
      messages: [{ role: "user", text: "j'ai fini un lait" }, { role: "assistant", text: "Noté : Lait -1.", at: 1712000100 }],
      applied: [{ operation_id: "ivo-op-7", changes: [{ op: "item.adjust", label_fr: "Ajuster Lait de -1", before: { qty: 3 }, after: { qty: 2 } }] }],
    },
  });
  await tick(8);

  const toast = doc.querySelector(".hq-inventoria-toast");
  assert.ok(toast && !toast.hidden, "inventoria: the applied change shows a toast");
  assert.ok(toast.textContent.includes("Lait") && toast.textContent.includes("3 → 2"), "inventoria: the toast says what changed");
  assert.equal(net.calls.filter((c) => /\/commit$|\/preview$|\/validate$/.test(c.url)).length, 0,
    "inventoria: nothing is re-validated or committed by the client for an applied change");
  const draft = inventoriaDraftBox(doc);
  assert.ok(!draft || draft.hidden, "inventoria: no draft card for an applied change");
  const undo = byText(toast, "Annuler", "button");
  assert.ok(undo, "inventoria: the toast offers Undo");
  undo.click();
  await tick(8);
  const calls = net.callsTo("/api/inventoria/ops/ivo-op-7/undo");
  assert.equal(calls.length, 1, "inventoria: one Undo -> exactly one undo request");
  assert.equal(calls[0].body && calls[0].body.apply, true, "inventoria: the undo asks the server to apply the inverse at once");
  assert.ok(toast.textContent.includes("Annulé."), "inventoria: the toast confirms the undo");
}

// The iPhone Shortcut opens HQ at #inventoria-say=<text>: the chip sends that text once and clears it from the address bar.
async function inventoriaDeepLinkSay(mutate) {
  const { win, net, chat } = await mountInventoria(mutate);
  win.location.hash = "#inventoria-say=" + encodeURIComponent("j'ai fini le riz");
  win.dispatchEvent({ type: "hashchange" });
  await tick(6);
  const sent = net.callsTo("/api/inventoria/sessions/ivo-0000000000000001/message");
  assert.equal(sent.length, 1, "inventoria: the deep link sends exactly one message");
  assert.equal(sent[0].body && sent[0].body.text, "j'ai fini le riz", "inventoria: the dictated text is sent as typed");
  chat.resolve({ status: 200, body: { ok: true, messages: [{ role: "assistant", text: "Noté." }] } });
  await tick(4);
}

// "Where is X?" is answered from the stock at once: shelf path + photo, and no model turn at all.
async function inventoriaWhereIs(mutate) {
  const { doc, net, send } = await mountInventoria(mutate);
  net.on("/api/inventoria/where", () => ({ body: { ok: true, matches: [
    { name: "Vis M3", where: "Atelier > Bac 2", qty: 40, unit: "pcs", photo: "asset-aaaaaaaaaaaaaaaaaaaaaaaa", photo_of: "item" }] } }));
  send("où sont les vis M3 ?");
  await tick(6);
  const asked = net.callsTo("/api/inventoria/where");
  assert.equal(asked.length, 1, "inventoria: one where lookup");
  assert.equal(asked[0].body && asked[0].body.q, "vis M3", "inventoria: the item words are looked up");
  assert.equal(net.callsTo("/api/inventoria/sessions/ivo-0000000000000001/message").length, 0, "inventoria: no model turn for a where question");
  const card = doc.querySelector(".hq-inventoria-where");
  assert.ok(card && card.textContent.includes("Atelier > Bac 2"), "inventoria: the shelf path is shown");
  const img = card.querySelector("img");
  assert.ok(img && img.src === "/api/carnet/asset/asset-aaaaaaaaaaaaaaaaaaaaaaaa", "inventoria: the item photo is shown");
  assert.ok(doc.querySelector(".hq-inventoria-thread-log").textContent.includes("Atelier > Bac 2"), "inventoria: the answer stays in the thread");
}

const classesOf = (n) => String(n.className).split(/\s+/);

// Several cards can be pending (a draft AND a grocery card): only one shows, and a bar names the other and brings it forward.
async function inventoriaOneCard(mutate) {
  const { doc, chat, send } = await mountInventoria(mutate);
  send("il me faut du lait");
  chat.resolve({
    status: 200,
    body: {
      ok: true,
      messages: [{ role: "user", text: "il me faut du lait" }, { role: "assistant", text: "Voici ta liste.", at: 1712000200 }],
      grocery: { lines: [{ name: "Papier", qty: 2, unit: "" }] },
      cards: { grocery: "ivo-op-2" },
      operations: [inventoriaOp("ivo-op-1", "Ajuster Lait de +2", { id: "itm-lait", name: "Lait" }),
                   inventoriaOp("ivo-op-2", "Créer Papier (×2)", { name: "Papier" })],
    },
  });
  await tick(8);
  const draft = inventoriaDraftBox(doc);
  const grocery = doc.querySelector(".hq-inventoria-grocery");
  assert.ok(grocery && !grocery.hidden && !classesOf(grocery).includes("is-queued"), "inventoria: the newest card (grocery) is in front");
  assert.ok(draft && !draft.hidden && classesOf(draft).includes("is-queued"), "inventoria: the draft waits behind it, not dropped");
  const bar = doc.querySelector(".hq-inventoria-cardbar");
  assert.ok(bar && !bar.hidden && bar.textContent.includes("Brouillon"), "inventoria: a bar names what else is waiting");
  bar.click();
  await tick(2);
  assert.ok(!classesOf(draft).includes("is-queued") && classesOf(grocery).includes("is-queued"), "inventoria: the bar brings the waiting card forward");
  assert.ok(draft.textContent.includes("Brouillon à vérifier"), "inventoria: the waiting draft kept its content");
}

// One camera button in the chat bar: a menu of photo / scan (the old separate photo and scan buttons are gone).
async function inventoriaCameraMenu(mutate) {
  const { doc } = await mountInventoria(mutate);
  const form = doc.querySelector(".hq-inventoria-chat");
  const cams = form.querySelectorAll(".hq-inventoria-chat-cam");
  assert.equal(cams.length, 1, "inventoria: exactly one camera button in the chat bar");
  assert.equal(form.querySelectorAll(".hq-inventoria-chat-photo").length, 1, "inventoria: no second photo button in the bar");
  assert.equal(form.querySelectorAll(".hq-inventoria-chat-scan").length, 0, "inventoria: no separate scan button in the bar");
  const menu = doc.querySelector(".hq-inventoria-cammenu");
  assert.ok(menu && menu.hidden, "inventoria: the menu starts closed");
  cams[0].click();
  await tick(2);
  assert.equal(menu.hidden, false, "inventoria: the camera button opens the menu");
  assert.equal(menu.querySelectorAll(".hq-inventoria-cammenu-item").length, 2, "inventoria: the menu offers photo and scan");
  assert.ok(menu.textContent.includes("Scanner un code-barres"), "inventoria: scan is one of the choices");
  assert.equal(cams[0].getAttribute("aria-expanded"), "true", "inventoria: the button says the menu is open");
}

// The Undo toast waits while it is touched or focused, then restarts a short countdown.
async function inventoriaToastHold(mutate) {
  const { doc, win, chat, send } = await mountInventoria(mutate);
  send("j'ai fini un lait");
  chat.resolve({ status: 200, body: { ok: true, messages: [{ role: "assistant", text: "Noté.", at: 1712000300 }],
    applied: [{ operation_id: "ivo-op-7", changes: [{ op: "item.adjust", label_fr: "Ajuster Lait de -1", before: { qty: 3 }, after: { qty: 2 } }] }] } });
  await tick(8);
  const toast = doc.querySelector(".hq-inventoria-toast");
  const live = () => [...win.timers.values()].filter((t) => t.ms === 10000 || t.ms === 4000).length;
  assert.equal(live(), 1, "inventoria: the toast has one countdown running");
  toast.dispatchEvent({ type: "pointerenter", bubbles: false });
  assert.equal(live(), 0, "inventoria: touching the toast stops the countdown");
  assert.equal(toast.hidden, false, "inventoria: the toast stays while held");
  toast.dispatchEvent({ type: "pointerleave", bubbles: false });
  assert.equal([...win.timers.values()].filter((t) => t.ms === 4000).length, 1, "inventoria: letting go restarts a short countdown");
}

// Settings is an accordion (one section open) and the shop tab keeps the list first with a collapsed strip below it.
async function inventoriaSettingsAndShop(mutate) {
  const { doc } = await mountInventoria(mutate);
  const sections = byId(doc, "hq-inv-pane-settings").children.filter((c) => c.tagName === "DETAILS");
  assert.ok(sections.length >= 4, "inventoria: the settings sections exist");
  assert.equal(sections.filter((d) => d.open).length, 1, "inventoria: only one settings section starts open");
  assert.ok(classesOf(sections.find((d) => d.open)).includes("hq-inventoria-fast"), "inventoria: the open one is Saisie rapide");
  assert.ok(sections.some((d) => classesOf(d).includes("hq-inventoria-linkbox") && !d.open), "inventoria: the Shortcut / QR labels live in their own collapsed section");
  const shop = byId(doc, "hq-inv-pane-shop");
  const kids = shop.children;
  const strip = kids.find((c) => classesOf(c).includes("hq-inventoria-insights"));
  assert.ok(strip, "inventoria: the insights strip exists");
  assert.equal(kids[kids.length - 1], strip, "inventoria: the strip comes after the shopping list");
  assert.ok(!strip.open, "inventoria: the strip is collapsed by default");
}

// "Où est…" is one tap away.
async function inventoriaWhereChip(mutate) {
  const { doc } = await mountInventoria(mutate);
  const chip = doc.querySelectorAll(".hq-inventoria-quick-btn").find((b) => b.textContent.startsWith("Où est"));
  assert.ok(chip, "inventoria: a quick chip offers Où est…");
  assert.ok(!doc.querySelectorAll(".hq-inventoria-quick-btn").some((x) => x.textContent === "Photo"), "inventoria: no Photo chip: the camera button covers it");
  chip.click();
  await tick(2);
  assert.equal(doc.querySelector(".hq-inventoria-chat-input").value, "Où est ", "inventoria: it prefills the question");
}

// A where answer with nothing extra to show (no photo, one match) is just the thread reply: no duplicate card.
async function inventoriaWhereNoCard(mutate) {
  const { doc, net, send } = await mountInventoria(mutate);
  net.on("/api/inventoria/where", () => ({ body: { ok: true, matches: [{ name: "Lait", where: "Atelier", qty: 2, unit: "L", photo: null }] } }));
  send("où est le lait ?");
  await tick(6);
  const log = doc.querySelector(".hq-inventoria-thread-log").textContent;
  assert.equal(log.split("Atelier").length - 1, 1, "inventoria: the answer appears once in the thread");
  assert.ok(!doc.querySelector(".hq-inventoria-where"), "inventoria: no card when it would only repeat the reply");   // boolean: a failing node comparison would try to print the whole DOM
  const notice = doc.querySelector(".hq-inventoria-notice");
  assert.ok(!notice || notice.hidden, "inventoria: no notice box left open");
  const rows = doc.querySelectorAll(".hq-inventoria-row");
  assert.ok(rows.length >= 2 && rows.every((r) => String(r.className).includes("is-new")), "inventoria: live messages are flagged to rise in");
}

async function inventoriaValidateFailure(mutate) {
  const { doc, net, chat, send } = await mountInventoria(mutate);
  net.on("/api/inventoria/ops/ivo-op-1/validate", () => ({ body: { ok: true, validation: { ok: false, reason: "stock inconnu" } } }));
  send("ajoute 2 lait");
  chat.resolve({
    status: 200,
    body: {
      ok: true,
      messages: [{ role: "assistant", text: "J'ai préparé un brouillon." }],
      operations: [inventoriaOp("ivo-op-1", "Ajuster Lait de +2", { id: "itm-lait", name: "Lait" })],
    },
  });
  await tick(8);

  const draft = inventoriaDraftBox(doc);
  const apply = doc.querySelector(".hq-inventoria-draft-apply");
  assert.ok(apply, "inventoria: the invalid draft still renders its actions");
  assert.equal(apply.disabled, true, "inventoria: an invalid draft cannot be applied");
  assert.ok(draft.textContent.includes("Ce brouillon ne passe pas la validation"),
    "inventoria: the validation failure is stated");
  assert.ok(!draft.textContent.includes("Appliqué."), "inventoria: no false-success state");
  assert.equal(net.callsTo("/api/inventoria/ops/ivo-op-1/preview").length, 0,
    "inventoria: an invalid draft never previews");
  assert.equal(net.callsTo("/api/inventoria/ops/ivo-op-1/commit").length, 0,
    "inventoria: an invalid draft never commits");
  assert.equal(doc.querySelector(".hq-inventoria-msg.is-typing"), null, "inventoria: no spinner");
  assert.ok(doc.querySelector(".hq-inventoria-thread-log").textContent.includes("J'ai préparé un brouillon."),
    "inventoria: the thread stays readable");
}

const ONLY = process.env.HQ_UI_CASE || "";
const CASES = [
  { name: "forgia", mutation: ["/api/forgia/cancel", "/api/forgia/cancel-removed"], run: forgia },
  { name: "culinia", mutation: ["/api/culinia/cancel", "/api/culinia/cancel-removed"], run: culinia },
  { name: "securia", mutation: ["/api/securia/cancel", "/api/securia/cancel-removed"], run: openSecuria },
  { name: "securia-confirm", mutation: ['resolveProposal(prop.id, "confirm")', 'resolveProposal(prop.id, "confirm-removed")'], run: (m) => securiaCard(m, "confirm") },
  { name: "securia-dismiss", mutation: ['resolveProposal(prop.id, "dismiss")', 'resolveProposal(prop.id, "dismiss-removed")'], run: (m) => securiaCard(m, "dismiss") },
  { name: "securia-confirm-failure", mutation: ['resolveProposal(prop.id, "confirm")', 'resolveProposal(prop.id, "confirm-removed")'], run: (m) => securiaCard(m, "fail") },
  { name: "inventoria", mutation: ["/api/inventoria/cancel", "/api/inventoria/cancel-removed"], run: inventoria },
  { name: "inventoria-draft", mutation: ['opUrl(ops[i].id, "commit")', 'opUrl(ops[i].id, "commit-removed")'], run: inventoriaDraft },
  { name: "inventoria-undo", mutation: ['opUrl(ids[i], "undo")', 'opUrl(ids[i], "undo-removed")'], run: inventoriaDraft },
  { name: "inventoria-dismiss", mutation: ['opUrl(o.id, "cancel")', 'opUrl(o.id, "cancel-removed")'], run: inventoriaDismiss },
  { name: "musica", mutation: ["/api/musica/cancel", "/api/musica/cancel-removed"], run: musica },
  { name: "musica-confirm", mutation: ["/api/musica/confirm", "/api/musica/confirm-removed"], run: musicaConfirm },
  { name: "musica-cancel-failure", mutation: ['threadAlert("Arrêt impossible : " + err.message);', 'void 0;'], run: musicaCancelFailure },
  { name: "inventoria-ignorer", mutation: ["const groceryOp = opId ? { id: opId } : null;", "const groceryOp = null;"], run: inventoriaGroceryIgnore },
  { name: "inventoria-ignorer-failure", mutation: ["groceryBox.insertBefore(n, row);", "clearGrocery();"], run: inventoriaGroceryIgnoreFailure },
  { name: "inventoria-ignorer-detect", mutation: ["det.op = opId ? { id: opId } : null;", "det.op = null;"], run: inventoriaDetectIgnore },
  { name: "inventoria-ignorer-detect-failure", mutation: ["detBox.insertBefore(n, actions);", "clearDetect();"], run: inventoriaDetectIgnoreFailure },
  { name: "inventoria-ignorer-adjust", mutation: ['showGrocery(grocery, cards.grocery || "")', 'showGrocery(grocery, "")'], run: inventoriaGroceryIgnoreAdjust },
  { name: "inventoria-ignorer-ambiguous", mutation: ["const groceryOp = opId ? { id: opId } : null;", "const groceryOp = opId ? { id: opId } : (draftOps[0] || null);"], run: inventoriaGroceryIgnoreAmbiguous },
  { name: "inventoria-ignorer-multi-row", mutation: ["const groceryOp = opId ? { id: opId } : null;", "const groceryOp = opId ? { id: opId } : (draftOps[0] || null);"], run: inventoriaGroceryIgnoreMultiRow },
  { name: "inventoria-ignorer-detect-multi-row", mutation: ["det.op = opId ? { id: opId } : null;", "det.op = opId ? { id: opId } : (draftOps[0] || null);"], run: inventoriaDetectIgnoreMultiRow },
  { name: "inventoria-restore-grocery", mutation: ['return typeof id === "string" && pendingIds.has(id) ? id : "";', 'return pending[0] ? pending[0].id : "";'], run: inventoriaRestoreGrocery },
  { name: "inventoria-restore-detect", mutation: ['return typeof id === "string" && pendingIds.has(id) ? id : "";', 'return pending[0] ? pending[0].id : "";'], run: inventoriaRestoreDetect },
  { name: "inventoria-restore-ambiguous", mutation: ['return typeof id === "string" && pendingIds.has(id) ? id : "";', 'return pending[0] ? pending[0].id : "";'], run: inventoriaRestoreAmbiguous },
  { name: "inventoria-restore-op-gone", mutation: ['return typeof id === "string" && pendingIds.has(id) ? id : "";', 'return pending[0] ? pending[0].id : "";'], run: inventoriaRestoreOpGone },
  { name: "inventoria-undo-toast", mutation: ['jsonPost(opUrl(ids[i], "undo"), { apply: true })', 'jsonPost(opUrl(ids[i], "undo-removed"), { apply: true })'], run: inventoriaUndoToast },
  { name: "inventoria-deep-link-say", mutation: ['if (m[1] === "say" && val) runChat(val);', "if (false) runChat(val);"], run: inventoriaDeepLinkSay },
  { name: "inventoria-where-is", mutation: ['if (askWhere(said)) { chatInput.value = ""; return; }', "if (false) { return; }"], run: inventoriaWhereIs },
  { name: "inventoria-one-card", mutation: ['b.classList.toggle("is-queued", b !== cardFront)', 'b.classList.toggle("is-queued", false)'], run: inventoriaOneCard },
  { name: "inventoria-camera-menu", mutation: ["chatForm.insertBefore(camBtn, chatSend);", "chatForm.insertBefore(photoBtn, chatSend);"], run: inventoriaCameraMenu },
  { name: "inventoria-toast-hold", mutation: ['["pointerenter", "pointerdown", "focusin"].forEach((t) => toastBox.addEventListener(t, holdToast));', ""], run: inventoriaToastHold },
  { name: "inventoria-settings-shop", mutation: ["SECTIONS.forEach((d) => { d.open = d === fastBox; });", ""], run: inventoriaSettingsAndShop },
  { name: "inventoria-where-chip", mutation: ['[en ? "Where is…" : "Où est…", "search",', '[en ? "Where is…" : "Où est…", "search", null && '], run: inventoriaWhereChip },
  { name: "inventoria-where-no-card", mutation: ["if (!top.photo && hits.length < 2) {", "if (false) {"], run: inventoriaWhereNoCard },
  { name: "inventoria-validate-failure", mutation: ["v.ok && v.data.validation && v.data.validation.ok ?", "v.ok ?"], run: inventoriaValidateFailure },
];

const selected = ONLY ? CASES.filter((c) => c.name === ONLY) : CASES;

if (!PROVE) {
  assert.ok(selected.length, "unknown case: " + ONLY);
  for (const c of selected) {
    await c.run();
    console.log("  ok  " + c.name);
  }
  console.log("check_assistant_chat_ui: ok (" + selected.length + " cases, offline DOM)");
} else {
  for (const c of selected) {
    let failed = false;
    try {
      await c.run(sabotage(c.mutation[0], c.mutation[1]));
    } catch (err) {
      failed = true;
    }
    assert.ok(failed, c.name + ": assertions must fail once the wiring is removed");
    proven.push(c.name);
    console.log("  ok  " + c.name + " fails without " + c.mutation[0]);
  }
  console.log("check_assistant_chat_ui: load-bearing (mutations detected: " + proven.length + "/" + selected.length + ")");
}
