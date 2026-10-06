#!/usr/bin/env node
/* Builds q-*.js files + q-manifest.js for banks of any size (100,000+ questions).
   Usage:  node build-shards.js source/ out/
   source/ holds .json files, each:
     {"cat":"Math","sub":"Algebra","lesson":"optional name","questions":[{"q":"..","o":["..",".."],"a":0,"e":"explanation"},
                                                                          {"t":"text","q":"..","ans":["answer"]}]}
   Questions without "id" get unique ids automatically (starting at 100001, or after the highest id found).
   500 questions go in each file; every file gets a content hash "h" so phones re-download only changed files. */
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const [src,out]=[process.argv[2]||'source',process.argv[3]||'out'],PER=500;
fs.mkdirSync(out,{recursive:true});
const groups=new Map();let maxId=100000;
for(const f of fs.readdirSync(src).filter(f=>f.endsWith('.json')).sort()){
 const j=JSON.parse(fs.readFileSync(path.join(src,f),'utf8')),key=j.cat+'\u0000'+j.sub;
 if(!groups.has(key))groups.set(key,{cat:j.cat,sub:j.sub,qs:[]});
 (j.questions||[]).forEach(q=>{if(Number.isFinite(q.id))maxId=Math.max(maxId,q.id);groups.get(key).qs.push(q)});
}
const cats=new Map();let n=0,files=0,seen=new Set();
for(const g of groups.values()){
 const ks=[];
 for(let i=0;i<g.qs.length;i+=PER){
  const part=g.qs.slice(i,i+PER).filter(q=>q&&typeof q.q==='string'&&q.q.trim());
  part.forEach(q=>{if(!Number.isFinite(q.id)||seen.has(q.id))q.id=++maxId;seen.add(q.id)});
  if(!part.length)continue;
  const k='b'+(++files).toString(36),body=JSON.stringify(part).replace(/\u2028|\u2029/g,' ');
  const h=crypto.createHash('md5').update(body).digest('hex').slice(0,8);
  fs.writeFileSync(path.join(out,'q-'+k+'.js'),`window.__shard(${JSON.stringify(k)},${JSON.stringify(g.cat)},${JSON.stringify(g.sub)},${body});\n`);
  const ids=part.map(q=>q.id);
  ks.push({k,c:part.length,t:part.filter(q=>q.t==='text').length,lo:Math.min(...ids),hi:Math.max(...ids),h});n+=part.length;
 }
 if(!cats.has(g.cat))cats.set(g.cat,[]);cats.get(g.cat).push({n:g.sub,k:ks});
}
const man={v:Date.now(),p:'q-',cats:[...cats].map(([c,s])=>({c,s}))};
fs.writeFileSync(path.join(out,'q-manifest.js'),'window.MANIFEST='+JSON.stringify(man)+';\n');
console.log(`${n.toLocaleString()} questions -> ${files} files + q-manifest.js in ${out}/`);
