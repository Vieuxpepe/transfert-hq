/* Transfert HQ service worker — opt-in Web Push only. No background sync, no caches of user files. */
// Notification buttons may run ONE same-origin POST on tap (the server sends it; this list allowlists it again).
const ACTION_POSTS = ["/api/inventoria/to-grocery"];

const sameOriginPath = (u) => {
  try {
    const url = new URL(String(u || "/"), self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search + url.hash : "/";
  } catch (_) {
    return "/";
  }
};

self.addEventListener("push", (event) => {
  let data = { title: "Transfert HQ", body: "" };
  try {
    if (event.data) data = event.data.json();
  } catch (_) {}
  const title = String(data.title || "Transfert HQ").slice(0, 120);
  const body = String(data.body || "").slice(0, 500);
  const actions = Array.isArray(data.actions) ? data.actions.slice(0, 2).filter((a) => a && a.action && a.title) : [];
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: sameOriginPath(data.url), actions },
      actions: actions.map((a) => ({ action: String(a.action).slice(0, 24), title: String(a.title).slice(0, 40) })),
    })
  );
});

const openOrFocus = (path) => self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
  for (const client of clients) {
    if ("focus" in client) {
      if (path && path !== "/" && "navigate" in client) return client.navigate(path).then((c) => (c || client).focus()).catch(() => client.focus());
      return client.focus();
    }
  }
  if (self.clients.openWindow) return self.clients.openWindow(path || "/");
  return undefined;
});

self.addEventListener("notificationclick", (event) => {
  const data = (event.notification && event.notification.data) || {};
  event.notification.close();
  const path = sameOriginPath(data.url);
  const action = event.action ? (data.actions || []).find((a) => a && a.action === event.action) : null;
  if (action && action.post && ACTION_POSTS.includes(action.post.url)) {
    // Answered from the notification itself: same-origin, with the HQ session cookie (CSRF checks the Origin header).
    event.waitUntil(
      fetch(action.post.url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action.post.body || {}),
      }).then((r) => {
        if (!r.ok) return openOrFocus(path);
        return self.registration.showNotification("Inventoria", { body: "Ajouté à ta liste de courses.", icon: "/icon-192.png", badge: "/icon-192.png" });
      }).catch(() => openOrFocus(path))
    );
    return;
  }
  if (action) return;                                  // e.g. "Ignore": nothing to open
  event.waitUntil(openOrFocus(path));
});
