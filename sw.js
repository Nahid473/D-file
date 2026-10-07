/* MCQ Master service worker: makes the app installable (home-screen app) and nothing else.
   ONLINE ONLY: nothing is cached here. Every request goes straight to the network, so you always get the
   newest version of the app and the newest questions from Supabase. Without internet the app shows a
   "No internet" message instead of old data. */
self.addEventListener('install',()=>{self.skipWaiting()});
self.addEventListener('activate',e=>{
 e.waitUntil((async()=>{
  for(const k of await caches.keys())if(k.startsWith('mcq-'))await caches.delete(k);   // remove the old offline copies
  await self.clients.claim();
 })());
});
// pass-through handler (keeps the app installable); the browser does the normal network request
self.addEventListener('fetch',()=>{});
