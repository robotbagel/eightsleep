// @ts-nocheck
// Service worker: shows the morning sleep report push and opens the app on tap.
self.addEventListener("push", (event) => {
  let payload = { title: "Sleep report", body: "", url: "/" };
  try {
    payload = { ...payload, ...event.data.json() };
  } catch (e) {
    // keep defaults
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: payload.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return clients.openWindow(url);
    }),
  );
});
