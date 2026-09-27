/*
 * Helpdock's service worker, for web push only (M3-07, ADR 0002).
 *
 * It caches nothing and intercepts no request: the admin is an online app,
 * and a worker that served stale bundles would be a second place for a
 * deploy to go wrong. It shows what the api pushes and, on a click, focuses a
 * Helpdock tab or opens one on the ticket.
 *
 * Plain JavaScript in `public/`, so Vite serves it at `/sw.js` unhashed: a
 * service worker's URL is its identity, and a hashed name would register a new
 * worker on every build.
 */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = typeof data.title === 'string' ? data.title : 'Helpdock';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    icon: '/favicon.svg',
    data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          return client.navigate(url).then((navigated) => (navigated ?? client).focus());
        }
      }

      return self.clients.openWindow(url);
    }),
  );
});
