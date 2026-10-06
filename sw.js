/* MCQ Master service worker: installable + offline, built for banks of 100,000+ questions.
   - App files (html/css/js): network first (so updates arrive), cached copy when offline.
   - Question files (q-*.js): cached the first time they are used. Small banks (<= PRECACHE_MAX questions)
     are also downloaded in full on install. Big banks are NOT: the person taps "download offline" in MCQ AI
     (or the page posts {type:'precache',cats:[...]}) and only the missing files are fetched.
   - Updating questions: change "v" in q-manifest.js, or give a shard its own "h" (hash) so only that file is re-downloaded. */
self.window=self;
importScripts('q-manifest.js');
const MAN=self.MANIFEST||{v:0,cats:[],p:'q-'};
const SHELL='mcq-shell-v3',DATA='mcq-data';
const PRECACHE_MAX=20000;
const SHELL_FILES=['./','index.html','script.js','style.css','q-manifest.js','manifest.webmanifest','icon.svg','icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png'];
const P=MAN.p===undefined?'data/':MAN.p;
function shards(cats){
 const m=new Map();
 (MAN.cats||[]).forEach(c=>{if(cats&&!cats.includes(c.c))return;c.s.forEach(s=>s.k.forEach(k=>{if(!m.has(k.k))m.set(k.k,{u:P+k.k+'.js?v='+(k.h||MAN.v),n:k.c||0})}))});
 return [...m.values()];
}
const total=l=>l.reduce((a,x)=>a+x.n,0);
async function fill(list,notify){
 const d=await caches.open(DATA);let done=0,i=0;
 const worker=async()=>{while(i<list.length){const x=list[i++];
  if(!(await d.match(x.u)))await d.add(x.u).catch(()=>{});
  done++;if(notify&&done%25===0)notify({type:'prog',done,total:list.length});}};
 await Promise.all([worker(),worker(),worker(),worker()]);
 if(notify)notify({type:'done',total:list.length});
}
self.addEventListener('install',e=>{
 e.waitUntil((async()=>{
  await (await caches.open(SHELL)).addAll(SHELL_FILES);
  const all=shards();
  if(total(all)<=PRECACHE_MAX)await fill(all);
  await self.skipWaiting();
 })());
});
self.addEventListener('activate',e=>{
 e.waitUntil((async()=>{
  for(const k of await caches.keys())if(k.startsWith('mcq-')&&k!==SHELL&&k!==DATA)await caches.delete(k);
  // drop cached question files that are no longer part of the current manifest (keeps only changed files to re-download)
  const keep=new Set(shards().map(x=>{const u=new URL(x.u,self.location.href);return u.pathname+u.search})),d=await caches.open(DATA);
  for(const r of await d.keys()){const u=new URL(r.url);if(!keep.has(u.pathname+u.search))await d.delete(r)}
  await self.clients.claim();
 })());
});
self.addEventListener('message',e=>{
 const m=e.data||{};if(m.type!=='precache')return;
 const src=e.source,notify=x=>{try{src&&src.postMessage(x)}catch(_){}};
 e.waitUntil(fill(shards(m.cats&&m.cats.length?m.cats:null),notify));
});
const isData=u=>{const f=u.pathname.split('/').pop();return f.endsWith('.js')&&f!=='q-manifest.js'&&(MAN.p===undefined?u.pathname.includes('/data/'):f.startsWith(MAN.p))};
async function dataFetch(req,url){
 const c=await caches.open(DATA),hit=await c.match(req);
 if(hit)return hit;
 try{
  const res=await fetch(req);
  if(res.ok&&!url.searchParams.has('r'))c.put(req,res.clone());
  return res;
 }catch(err){
  const any=await c.match(req,{ignoreSearch:true});
  if(any)return any;
  throw err;
 }
}
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
 e.respondWith(isData(url)?dataFetch(req,url):shellFetch(req));
});
