// Drive Tracker — service worker for installability + offline app-shell
// resilience. Deliberately narrow: only ever handles same-origin GET
// requests for this app's own static files. Supabase API calls, the
// Leaflet CDN script, and Google Fonts are never intercepted here, so
// auth/trip/location data is always live, never served stale from cache.

const CACHE_NAME = 'drive-tracker-v1';
const APP_SHELL = [
  './',
  './index.html',
  './script.js',
  './style.css',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;

  // Stale-while-revalidate: serve the cached shell instantly if we have
  // it, refresh the cache in the background, and fall back to cache if
  // the network fails (so a reload still works offline).
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
