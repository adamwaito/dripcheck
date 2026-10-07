const CACHE_NAME = 'dripcheck-shell-v7';
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './drip-icon.svg',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './images/underlay_ink_mask.png',
  './images/underlay_white_mask.png',
  './images/underlay_mask.png',
  './images/NO_overlay.png',
  './images/YES_overlay.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith('dripcheck-') && key !== CACHE_NAME).map(key => caches.delete(key)),
    )),
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put('./index.html', copy)));
      return response;
    }).catch(() => caches.match('./index.html')));
    return;
  }

  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});

self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data?.text() || '' };
  }

  event.waitUntil(self.registration.showNotification(payload.title || 'DripCheck', {
    body: payload.body || 'A cold period is in the forecast.',
    icon: './drip-icon.svg',
    badge: './drip-icon.svg',
    tag: payload.tag || 'dripcheck-forecast',
    renotify: false,
    data: { url: payload.url || './' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url || './', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const existing = clients.find(client => client.url.startsWith(self.location.origin));
    if (existing) return existing.focus();
    return self.clients.openWindow(destination);
  }));
});