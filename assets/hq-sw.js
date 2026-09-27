/* Transfert HQ service worker — opt-in Web Push only. No background sync, no caches of user files. */
self.addEventListener("push", (event) => {
  let data = { title: "Transfert HQ", body: "" };
  try {
    if (event.data) data = event.data.json();
  } catch (_) {}
  const title = String(data.title || "Transfert HQ").slice(0, 120);
  const body = String(data.body || "").slice(0, 500);
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
      return undefined;
    })
  );
});
