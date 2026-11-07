'use strict';

// Bei jeder Änderung an den App-Dateien erhöhen, damit die Handys die neue Version laden.
const CACHE = 'rezepte-v8';
// Rezeptbilder bleiben über App-Updates hinweg erhalten, damit sie auch offline da sind.
const BILDER_CACHE = 'rezepte-bilder';
// Eigene Fotos verwaltet app.js; dieser Speicher darf bei Updates nie gelöscht werden.
const FOTO_CACHE = 'rezepte-fotos';
const DATEIEN = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

// Fremde Bilder belegen viel Speicherkontingent; die ältesten fliegen ab 300 Stück raus.
const MAX_BILDER = 300;
function kuerzeBilderCache(cache) {
  return cache.keys().then((schluessel) => Promise.all(
    schluessel.slice(0, Math.max(0, schluessel.length - MAX_BILDER)).map((s) => cache.delete(s))
  ));
}

self.addEventListener('install', (e) => {
  // cache: 'reload' umgeht den Browser-Cache (GitHub Pages erlaubt 10 Minuten), sonst landet die alte Version im neuen Cache.
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(DATEIEN.map((datei) => new Request(datei, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((namen) => Promise.all(namen.filter((n) => n !== CACHE && n !== BILDER_CACHE && n !== FOTO_CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Rezeptbilder: erst Cache, sonst laden und merken (auch undurchsichtige Antworten von <img>).
  if (e.request.destination === 'image' && url.origin !== location.origin && url.protocol === 'https:') {
    e.respondWith(
      caches.open(BILDER_CACHE).then((c) => c.match(e.request).then((treffer) => treffer || fetch(e.request).then((antwort) => {
        if (antwort.ok || antwort.type === 'opaque') {
          c.put(e.request, antwort.clone()).then(() => kuerzeBilderCache(c)).catch(() => {});
        }
        return antwort;
      })))
    );
    return;
  }

  // Rezeptseiten und Umwege laufen ganz normal übers Netz.
  if (url.origin !== location.origin) return;

  // Erst Netz, damit Änderungen sofort ankommen; ohne Verbindung aus dem Cache.
  // no-cache: beim Server nachfragen statt bis zu 10 Minuten die alte Datei aus dem Browser-Cache zu nehmen.
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((antwort) => {
        if (antwort.ok) {
          const kopie = antwort.clone();
          caches.open(CACHE).then((c) => c.put(e.request, kopie));
        }
        return antwort;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then((treffer) => treffer || caches.match('./')))
  );
});
