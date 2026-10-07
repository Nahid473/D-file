/* MCQ Master service worker: installable + offline app shell.
   Questions are NOT handled here any more: they live in the Supabase database and supabase.js keeps the
   lessons you opened in IndexedDB, so they keep working offline.
   - App files (html/css/js): network first (so updates arrive), cached copy when offline.
   - Supabase / other sites are never touched. */
const SHELL='mcq-shell-v4';
const SHELL_FILES=['./','index.html','script.js','supabase.js','style.css','manifest.webmanifest','icon.svg','icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png'];
self.addEventListener('install',e=>{
 e.waitUntil((async()=>{
  const c=await caches.open(SHELL);
  await Promise.all(SHELL_FILES.map(f=>c.add(f).catch(()=>{})));   // a missing optional file must not break the install
  await self.skipWaiting();
 })());
});
self.addEventListener('activate',e=>{
 e.waitUntil((async()=>{
  for(const k of await caches.keys())if(k.startsWith('mcq-')&&k!==SHELL)await caches.delete(k);   // also removes the old question-file cache
  await self.clients.claim();
 })());
});
async function shellFetch(req){
 const c=await caches.open(SHELL),nav=req.mode==='navigate';
 try{
  const res=await Promise.race([fetch(req),new Promise((_,rej)=>setTimeout(()=>rej(new Error('slow')),4000))]);
  if(res&&res.ok)c.put(nav?'index.html':req,res.clone());
  return res;
 }catch(err){
  const hit=await c.match(nav?'index.html':req,{ignoreSearch:true});
  if(hit)return hit;
  throw err;
 }
}
self.addEventListener('fetch',e=>{
 const req=e.request;if(req.method!=='GET')return;
 const url=new URL(req.url);if(url.origin!==location.origin)return;
 e.respondWith(shellFetch(req));
});
