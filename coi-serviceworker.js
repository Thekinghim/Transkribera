// Gör sidan "cross-origin isolated" på GitHub Pages (som inte låter oss sätta egna HTTP-rubriker).
// Det krävs för SharedArrayBuffer, så att taligenkänningen kan använda alla processorkärnor
// i stället för en enda. Service workern lägger bara till rubrikerna COOP/COEP på sidans egna svar.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  const url = new URL(req.url);
  // Bara våra egna filer. Allt annat (modeller, CDN, Claude-API) går direkt som vanligt.
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const res = await fetch(req);
    if (res.status === 0 || res.type === 'opaque') return res;
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  })());
});
