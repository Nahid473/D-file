const KEY={wrong:'mcq_more_practice_v2',hist:'mcq_history_v2'};
const IMP_KEY='mcq_important_v1',N10_KEY='mcq_need10_v1',N10=10; // N10 = how many correct answers finish a "10x practice" question
const PAGE=50,SEEN_KEY='mcq_seen_v1',SEENK_KEY='mcq_seenk_v1'; // PAGE = questions shown on one screen; SEEN_KEY = ids of questions already given in earlier exams

function get(k,f){try{const v=JSON.parse(MCQ_STORE.get(k));return v==null?f:v}catch(e){return f}}
function put(k,v){try{MCQ_STORE.set(k,JSON.stringify(v))}catch(e){}}
// Questions live in the Supabase database (supabase.js); only questions saved on this device are kept in `custom`.
const CUSTOM_KEY='mcq_custom_v1',TIMER_KEY='mcq_timer_pref_v1';
const PIN_MIN=4,PIN_MAX=12;
let custom=get(CUSTOM_KEY,[]);if(!Array.isArray(custom))custom=[];
custom=custom.filter(q=>q&&q.source!=='supabase');   // database questions are never stored on the device any more
function pinNormalize(v){return String(v??'').trim()}
function validPin(v){return /^\d{4,12}$/.test(pinNormalize(v))}
async function hashPin(pin){
 const raw=pinNormalize(pin);if(!validPin(raw))throw new Error('PIN must contain 4-12 digits.');
 if(window.crypto?.subtle){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
 return 'plain:'+raw;
}
async function verifyPinHash(hash,pin){return !!hash&&hash===(await hashPin(pin))}
async function askPin(action){
 const label=action||'continue';
 const pin=prompt(`Enter the ${label} PIN (4-12 digits):`);
 if(pin===null)return false;
 if(!validPin(pin)){toast('PIN must be 4-12 digits.');return false}
 return pin;
}
async function requireQuestionPin(x,action){
 if(!x?.locked)return true;
 if(!x.pinHash)return toast('🔒 This locked question has no PIN. Set a PIN by editing/unlocking it first.'),false;
 const pin=await askPin(action||'question');if(pin===false)return false;
 if(!await verifyPinHash(x.pinHash,pin)){toast('❌ Incorrect PIN.');return false}
 return true;
}

/* ---------- Question data: everything comes from the Supabase database (see supabase.js) ----------
   The app only knows the CATALOG (category > sub-category > lesson + counts). The questions of a lesson are read
   from the database when that lesson is needed, so the bank can hold any number of questions. */
const SHARDS={};let loadFail=new Set();
const DB=()=>window.MCQ_DB;
// a "shard" is one database lesson: {k,cat,sub,lesson,c,t}
async function loadLesson(sh,retry){return DB().loadLesson(sh,!!retry)}
// one broken lesson no longer stops the whole exam: try twice, then skip it and report it
async function loadLessonSafe(x){
 try{return await loadLesson(x)}catch(e){
  try{return await loadLesson(x,true)}catch(e2){loadFail.add(x.k);return[]}
 }
}
function loadShard(k,retry){const sh=typeof k==='string'?SHARDS[k]:k;return sh?loadLesson(sh,retry):Promise.reject(new Error('Unknown lesson '+k))}
// CAT = [{c:'Category',subs:[{n,total,base,shards:[{k,c,t,...}],lessons:[],custom:[]}]}]  (counts only, no question text)
let CAT=[];
function rebuildCatalog(){
 const m=new Map(),sub=(c,n)=>{let cc=m.get(c);if(!cc){cc=new Map();m.set(c,cc)}let x=cc.get(n);if(!x){x={n,shards:[],custom:[],base:0,lessons:[]};cc.set(n,x)}return x};
 for(const r of (DB()&&DB().catalog)||[]){
  const x=sub(r.cat,r.sub),k=r.cat+' › '+r.sub+' › '+r.lesson,sh=SHARDS[k]={k,cat:r.cat,sub:r.sub,lesson:r.lesson,c:r.c,t:r.t||0};
  x.shards.push(sh);x.base+=r.c;x.lessons.push({name:r.lesson,shard:sh,custom:[],total:r.c});
 }
 // questions saved only on this device (used when the database is not connected)
 custom.forEach(q=>{const x=sub(q.cat,q.sub),ln=q.lesson||'General';let l=x.lessons.find(y=>!y.shard&&y.name===ln);if(!l){l={name:ln,shard:null,custom:[],total:0};x.lessons.push(l)}l.custom.push(q);l.total++;x.custom.push(q)});
 CAT=[...m].map(([c,mm])=>({c,subs:[...mm.values()].map(x=>({...x,total:x.base+x.custom.length}))}));
}
rebuildCatalog();
function cats(){return CAT.map(x=>x.c)}
function subsOf(c){const x=CAT.find(y=>y.c===c);return x?x.subs:[]}
function catTotal(c){return subsOf(c).reduce((a,s)=>a+s.total,0)}
function totalQ(){return CAT.reduce((a,x)=>a+catTotal(x.c),0)}
let wrong=get(KEY.wrong,{}), history=get(KEY.hist,[]);
let seen=get(SEEN_KEY,{});if(!seen||typeof seen!=='object'||Array.isArray(seen))seen={};
let seenK=get(SEENK_KEY,{});if(!seenK||typeof seenK!=='object'||Array.isArray(seenK))seenK={};
// same question text + same correct answer = the same question, even when it sits in two files
function qkey(q){return hashStr(q.q.trim()+'|'+(isText(q)?q.ans[0]:q.o[q.a])).toString(36)}
function isSeen(q){return !!(seen[q.id]||seenK[qkey(q)])}
const SRCH_KEY='mcq_searched_v1'; // questions added from the Search page (More Practice > Searched)
let searched=get(SRCH_KEY,{});if(!searched||typeof searched!=='object'||Array.isArray(searched))searched={};
let important=get(IMP_KEY,{}),need10=get(N10_KEY,{});
if(!important||typeof important!=='object'||Array.isArray(important))important={};
if(!need10||typeof need10!=='object'||Array.isArray(need10))need10={};
let session=null,lastBatch=null;
// ---- skipped questions: added when you leave a question unanswered (exam, timer run-out or Daily 50)
const SKIP_KEY='mcq_skipped_v1';let skipQs=get(SKIP_KEY,{});if(!skipQs||typeof skipQs!=='object'||Array.isArray(skipQs))skipQs={};
let skT;function saveSkip(){updateBadges();clearTimeout(skT);skT=setTimeout(()=>put(SKIP_KEY,skipQs),50)}
function addSkip(q){const s=skipQs[q.id]=skipQs[q.id]||{id:q.id,count:0,addedAt:Date.now()};s.q=q;s.count++;saveSkip()}
function dropSkip(id){if(skipQs[id]){delete skipQs[id];saveSkip()}}

function qs(id){return document.getElementById(id)}
function toggleMenu(force){
 const m=qs('navMenu'),b=qs('burger'),open=force!==undefined?force:!m.classList.contains('open');
 m.classList.toggle('open',open);b.classList.toggle('open',open);b.setAttribute('aria-expanded',String(open));
}
function closeMenu(){toggleMenu(false)}
document.addEventListener('click',e=>{if(!e.target.closest('#topbar'))closeMenu();if(!e.target.closest('#lessonBox'))toggleLessonPanel(false)});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeMenu();toggleLessonPanel(false)}});
window.addEventListener('resize',()=>{if(window.innerWidth>1260)closeMenu()});
function show(id,fromPop){
 const hadMore=moreEntry&&!fromPop;
 if(daily&&!daily.submitted&&tmr&&qs('daily').classList.contains('active')){daily.left=Math.max(1000,tmr.endTs-Date.now());put(DAILY_KEY,daily)}
 stopTimer();slStop();
 const nv=(id==='exam'||id==='result'||id==='subs'||id==='setup')?'home':id;
 document.querySelectorAll('.navbtn').forEach(b=>b.classList.toggle('active',b.dataset.view===nv));
 closeMenu();toggleMore(false,true);closePicker();document.body.classList.toggle('focus',id==='exam'||id==='daily'||id==='ai'||id==='slider');
 {const bv=['bank','read','manage','history','ai','slider','stats','board','profile','account'].includes(nv)?'more':nv;document.querySelectorAll('.bnbtn').forEach(b=>b.classList.toggle('active',b.dataset.view===bv))}
 document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));qs(id).classList.add('active');
 if(id==='home')refreshHome(); if(id==='daily')renderDaily(); if(id==='bank')renderBank(); if(id==='read')readInit(); if(id==='search')searchInit(); if(id==='practice')renderPractice(); if(id==='history')renderHistory(); if(id==='manage')renderManage(); if(id==='ai')aiInit(); if(id==='slider')slInit();
 if(!fromPop){
  const cur=window.history.state;
  if(hadMore){
   // the More sheet had its own history entry: reuse it for the new screen instead of stacking another one
   if(cur&&cur.v===id){ignorePop++;navIdx--;try{window.history.back()}catch(e){ignorePop--}}
   else{try{window.history.replaceState({v:id,i:navIdx},'')}catch(e){}}
  }else if(!(cur&&cur.v===id)){navIdx++;try{window.history.pushState({v:id,i:navIdx},'')}catch(e){}}
 }
 window.scrollTo(0,0);
}
/* ---------- Back navigation (in-app Back button + phone/browser back) ---------- */
let navIdx=0,moreEntry=false,ignorePop=0;
try{window.history.replaceState({v:'home',i:0},'')}catch(e){}
// ---- leaving a running exam (Back button or phone Back) asks first ----
let leaveOk=false;                                           // set once the person confirmed, so the next Back goes through
const examIsOpen=()=>qs('exam').classList.contains('active');
function askLeaveExam(){
 let html='';
 try{const b=batchOf(),done=b.filter(q=>!isSkip(q,getAns(q))).length;html=`<div class="acstats" style="grid-template-columns:1fr 1fr"><div class="s-ok"><b>${done}</b><span>Answered</span></div><div class="s-bad"><b>${b.length-done}</b><span>Not answered</span></div></div>`}catch(e){}
 return alertCard({kind:'danger',icon:'🚪',title:'Leave this exam?',msg:'If you cancel the exam, the answers on this page that are not submitted will be lost.',html,ok:'Cancel exam',cancel:'Continue exam'});
}
function leaveExam(){leaveOk=true;if(navIdx>0)window.history.back();else{leaveOk=false;show('home')}}
function goBack(){
 if(examIsOpen()&&!leaveOk){askLeaveExam().then(leave=>{if(leave&&examIsOpen())leaveExam()});return}
 if(navIdx>0)window.history.back();else show('home');
}
window.addEventListener('popstate',e=>{
 if(ignorePop>0){ignorePop--;return}
 const st=e.state||{v:'home',i:0};
 // phone Back while the More sheet is open: only close the sheet, stay on the same screen
 if(moreEntry){moreEntry=false;toggleMore(false,true);navIdx=st.i||0;return}
 // leaving a running exam: ask first (a popstate cannot be cancelled, so the entry is put back if the person stays)
 if(examIsOpen()&&st.v!=='exam'){
  if(leaveOk)leaveOk=false;
  else{navIdx++;try{window.history.pushState({v:'exam',i:navIdx},'')}catch(x){}askLeaveExam().then(leave=>{if(leave&&examIsOpen())leaveExam()});return}   // a popstate cannot be cancelled, so the entry is put back and the card decides
 }
 navIdx=st.i||0;
 // exam / result screens cannot be rebuilt from history, so they fall back to the dashboard
 let v=st.v||'home';if(((v==='exam'||v==='result')&&!(qs(v).classList.contains('active')))||((v==='subs'||v==='setup')&&!homeCat))v='home';
 show(v,true);
 if(st.more){moreEntry=true;toggleMore(true,true)}
});
function loadCats(){
 qs('cat').innerHTML=CAT.map(x=>`<option value="${esc(x.c)}">${esc(x.c)} (${catTotal(x.c).toLocaleString()})</option>`).join('');loadSubs();renderCatGrid();
}
function loadSubs(){
 const c=qs('cat').value;
 qs('sub').innerHTML=`<option value="ALL">All sub-categories (${catTotal(c).toLocaleString()})</option>`+subsOf(c).map(x=>`<option value="${esc(x.n)}">${esc(x.n)} (${x.total.toLocaleString()})</option>`).join('');
 loadLessons();
}
// flat list of the lessons of the chosen sub-category (or of every sub-category), each tagged with its sub-category name
function allLessons(c,s){return subsOf(c).filter(x=>s==='ALL'||x.n===s).flatMap(x=>x.lessons.map(l=>({l,sub:x.n})))}
function loadLessons(){
 const c=qs('cat').value,s=qs('sub').value,box=qs('lessonBox'),list=allLessons(c,s);
 if(!list.length){box.style.display='none';qs('lessonList').innerHTML='';return}
 box.style.display='block';toggleLessonPanel(false);
 qs('lessonList').innerHTML=list.map((x,i)=>`<label class="opt"><input type="checkbox" class="lchk" value="${i}" checked onchange="lessonChange()"><span>${s==='ALL'?`<span class="muted">${esc(x.sub)} ›</span> `:''}${esc(x.l.name)} <span class="badge">${x.l.total.toLocaleString()}</span></span></label>`).join('');
 lessonChange();
}
function lessonChange(){
 const list=allLessons(qs('cat').value,qs('sub').value),ch=[...document.querySelectorAll('.lchk')],on=ch.filter(e=>e.checked);
 qs('lessonAll').checked=on.length===ch.length;
 qs('lessonBtnTxt').textContent=on.length===ch.length?`All lessons (${ch.length})`:on.length===0?'No lesson selected':`${on.length} of ${ch.length} lessons selected`;
 qs('lessonInfo').textContent=`${on.reduce((a,e)=>a+(list[+e.value]?list[+e.value].l.total:0),0).toLocaleString()} questions in ${on.length} of ${ch.length} lessons`;
 if(typeof setupSummary==='function')setupSummary();
}
function toggleLessonPanel(force){const p=qs('lessonPanel'),open=force!==undefined?force:p.style.display==='none';p.style.display=open?'block':'none';qs('lessonBtn').setAttribute('aria-expanded',String(open))}
function toggleLessons(on){document.querySelectorAll('.lchk').forEach(e=>e.checked=on);lessonChange()}
// null = every lesson; otherwise the array of chosen lesson numbers (positions in allLessons)
function lessonSel(){
 if(qs('lessonBox').style.display==='none')return null;
 const ch=[...document.querySelectorAll('.lchk')],on=ch.filter(e=>e.checked).map(e=>+e.value);
 return on.length===ch.length?null:on;
}
// lessons that make up a selection
function lessonsOf(c,s,idx){
 const flat=allLessons(c,s).map(x=>x.l);
 return idx?flat.filter((_,i)=>idx.includes(i)):flat;
}
function shuffle(a){a=[...a];for(let i=a.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function isText(q){return q.t==='text'}
function isSkip(q,a){return a==null||a===''}
const BN='০১২৩৪৫৬৭৮৯';
function norm(s){return String(s).toLowerCase().normalize('NFKC').replace(/[\u200c\u200d]/g,'').replace(/[০-৯]/g,d=>BN.indexOf(d)).replace(/[^\p{L}\p{N}\p{M}\s]/gu,' ').replace(/\s+/g,' ').trim()}
// a/an/the are ignored, but an answer that is only "A" (e.g. the unit ampere) must stay
function normA(s){const n=norm(s),t=n.replace(/\b(the|a|an)\b/g,' ').replace(/\s+/g,' ').trim();return t||n}
function lev(a,b){const m=a.length,n=b.length;if(!m)return n;if(!n)return m;let p=Array.from({length:n+1},(_,j)=>j);for(let i=1;i<=m;i++){const c=[i];for(let j=1;j<=n;j++)c[j]=Math.min(p[j]+1,c[j-1]+1,p[j-1]+(a[i-1]===b[j-1]?0:1));p=c}return p[n]}
// Typed answers: capitals, punctuation, a/an/the, Bangla/English digits and sub-/superscripts are ignored.
// One typo is forgiven only in longer answers WITHOUT numbers, so a wrong date or year is never accepted.
function matchText(q,a){
 const u=normA(a);if(!u)return false;
 return (q.ans||[]).some(x=>{const k=normA(x);return u===k||(k.length>=6&&!/\d/.test(k)&&lev(u,k)<=1)});
}
function isRight(q,a){if(isSkip(q,a))return false;return isText(q)?matchText(q,a):a===q.a}
function rightText(q){return isText(q)?esc(q.ans[0])+(q.ans.length>1?` <span class="muted">(also accepted: ${q.ans.slice(1).map(esc).join(', ')})</span>`:''):esc(q.o[q.a])}
function yourText(q,a){return isSkip(q,a)?'Skipped':isText(q)?esc(a):esc(q.o[a])}
function answerUI(q,pre,o){
 o=o||{};const dis=o.dis?'disabled':'';
 if(isText(q))return `<input type="text" class="ansinput" id="${pre}t_${q.id}" placeholder="Type your answer…" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(o.sel==null?'':o.sel)}" ${dis} oninput="${o.tx||''}" onkeydown="ansKey(event,'${pre}',${q.id})">`;
 return `<div class="opts">${q.o.map((x,j)=>`<label class="opt${o.cls?o.cls(j):''}"><input type="radio" name="${pre}_${q.id}" value="${j}" ${dis} ${o.sel===j?'checked':''} ${o.mc?`onchange="${o.mc(j)}"`:''}><span>${esc(x)}</span></label>`).join('')}</div>`;
}
function readDom(q,pre){
 if(isText(q)){const el=qs(pre+'t_'+q.id);const v=el?el.value.trim():'';return v===''?null:v}
 const el=document.querySelector(`input[name="${pre}_${q.id}"]:checked`);return el?+el.value:null;
}
function ansKey(e,pre,id){
 if(e.key!=='Enter')return;e.preventDefault();
 if(pre==='q'){if(session&&session.tmode==='q')primaryAction();else checkText(id)}
 else if(pre==='p')practiceAnswer(id);
 else if(pre==='d')dailyCheck(id);
}
function feedbackHTML(q,a){
 const ok=isRight(q,a);
 return `<div class="fb" style="margin-top:10px">${ok?'<div class="correct">✅ Correct!</div>':`<div class="bad">❌ Wrong. Your answer: ${esc(a)}</div><div class="correct">Correct answer: ${rightText(q)}</div>`}<div class="explain"><b>Explanation:</b> ${esc(q.e)}</div></div>`;
}
function checkText(id){
 const q=session.questions.find(x=>x.id===id);if(!q||session.checked[id])return;
 const a=readDom(q,'q');if(a==null)return toast('Type your answer first.');
 session.checked[id]=true;session.ans[id]=a;
 const inp=qs('qt_'+id);if(inp)inp.disabled=true;
 const b=qs('qchk_'+id);if(b)b.style.display='none';
 qs('fb_q_'+id).innerHTML=feedbackHTML(q,a);
 if(session.tmode==='q'){stopTimer();qs('submitBtn').textContent=session.bi>=batchOf().length-1?'Submit →':'Next →'}
}
function batchOf(){return session.questions.slice(session.index,session.index+PAGE)}
function getAns(q){return session.tmode==='q'?(session.ans[q.id]??null):readDom(q,'q')}

let starting=false;
// Only the shard files of the chosen lessons are loaded.
// order='random' -> random new questions; order='present' -> new questions in their original order (continues where you stopped).
// If the selection has fewer new questions than requested, old ones fill the rest and a fresh round starts (recycled=true).
async function buildPool(c,s,idx,ty,n,order){
 const ok=q=>ty==='all'||(ty==='text')===isText(q),useful=x=>ty==='all'||(ty==='text'?x.t>0:x.t<x.c);
 loadFail=new Set();
 const ls=lessonsOf(c,s,idx),rnd=order==='random',all=[],fresh=[];
 const keys=new Set(),add=q=>{if(!ok(q))return;const k=qkey(q);if(keys.has(k))return;keys.add(k);all.push(q);if(!isSeen(q))fresh.push(q)};
 const customQ=ls.flatMap(l=>l.custom);
 let sh=ls.filter(l=>l.shard&&useful(l.shard)).map(l=>l.shard);
 if(rnd){customQ.forEach(add);sh=shuffle(sh)}
 const lim=rnd?Math.max(n*3,60):n;
 for(let i=0;i<sh.length&&fresh.length<lim;i+=4){
  (await Promise.all(sh.slice(i,i+4).map(x=>loadLessonSafe(x)))).forEach(a=>a.forEach(add));
 }
 if(!rnd&&fresh.length<n)customQ.forEach(add);
 const arr=a=>rnd?shuffle(a):a;
 if(fresh.length>=n)return{list:arr(fresh).slice(0,n),recycled:false,reset:[],failed:[...loadFail]};
 // not enough unseen questions: every shard of this selection is loaded here, so `all` is complete
 // some new questions are left: show ONLY those (fewer than requested is fine)
 if(fresh.length>0)return{list:arr(fresh),recycled:false,reset:[],failed:[...loadFail]};
 // nothing new at all: start a fresh round so the selection can be practised again
 const old=arr(all).slice(0,n);
 return{list:old,recycled:old.length>0,reset:old.length?all:[],failed:[...loadFail]};
}
// How many questions of this selection have not been given in any exam yet
async function countFresh(c,s,idx,ty){
 const ok=q=>ty==='all'||(ty==='text')===isText(q),useful=x=>ty==='all'||(ty==='text'?x.t>0:x.t<x.c);
 const ls=lessonsOf(c,s,idx);
 const keys=new Set();let k=0;
 const cnt=q=>{if(!ok(q))return;const h=qkey(q);if(keys.has(h))return;keys.add(h);if(!isSeen(q))k++};
 ls.flatMap(l=>l.custom).forEach(cnt);
 const sh=ls.filter(l=>l.shard&&useful(l.shard)).map(l=>l.shard);
 for(let i=0;i<sh.length;i+=4)(await Promise.all(sh.slice(i,i+4).map(x=>loadLessonSafe(x)))).forEach(a=>a.forEach(cnt));
 return k;
}
async function startExam(){
 if(starting)return;
 const c=qs('cat').value,s=qs('sub').value,n=Math.min(+qs('count').value||10,1000),ty=qs('qtype').value,order=qs('qorder').value,les=lessonSel();
 if(les&&!les.length)return toast('Select at least one lesson.');
 starting=true;toast('Loading questions…',15000);
 let res;
 try{res=await buildPool(c,s,les,ty,n,order)}catch(e){starting=false;return toast('Could not load questions. Check your connection and try again.')}
 starting=false;hideToast();
 const selected=res.list;
 if(!selected.length)return toast(res.failed.length?'Could not load: '+res.failed.join(', ')+'. Check the file names and your connection.':'No questions available for this selection.',5000);
 if(res.recycled)res.reset.forEach(q=>{delete seen[q.id];delete seenK[qkey(q)]}); // every question of this selection was used: start a new round
 selected.forEach(q=>{seen[q.id]=1;seenK[qkey(q)]=1});put(SEEN_KEY,seen);put(SEENK_KEY,seenK);
 const tmode=qs('timerMode').value;let tval=+qs('timerVal').value;
 if(tmode==='q')tval=Math.max(5,Math.min(3600,Math.round(tval)||60));
 else if(tmode==='all')tval=Math.max(1,Math.min(600,Math.round(tval)||30));
 if(tmode!=='off'){qs('timerVal').value=tval}
 put(TIMER_KEY,{mode:tmode,val:tval});
 newSession(selected,{ty,n,les,order,cat:c,sub:s},+qs('negative').value,tmode,tval);
 if(res.failed.length)toast('⚠ '+res.failed.length+' lesson(s) could not be loaded ('+res.failed.join(', ')+'). The rest was used.',6000);
 else if(res.recycled)toast('You have completed all new questions in this selection — starting a fresh round.',4000);
 else if(selected.length<n)toast('Only '+selected.length+' new questions were left in this selection.',4000);
}
function newSession(selected,meta,neg,tmode,tval){
 session=Object.assign({id:Date.now(),questions:selected,index:0,neg,totalCorrect:0,totalWrong:0,totalSkip:0,totalRaw:0,totalScore:0,tmode,tval,remaining:tmode==='all'?tval*60000:0,bi:0,ans:{},over:false},meta);
 renderBatch();show('exam');beginTimers();
}
function timerUi(setDefault){
 const m=qs('timerMode').value,box=qs('timerValBox'),inp=qs('timerVal');
 box.style.display=m==='off'?'none':'block';
 if(m==='q'){inp.min=5;inp.max=3600;if(setDefault)inp.value=60}
 if(m==='all'){inp.min=1;inp.max=600;if(setDefault)inp.value=30}
 timerPaint();if(typeof setupSummary==='function')setupSummary();
}
function restoreTimerPref(){
 const p=get(TIMER_KEY,null);if(!p)return;
 if(['off','q','all'].includes(p.mode)){qs('timerMode').value=p.mode;timerUi(false);if(p.mode!=='off')qs('timerVal').value=p.val}
}
function qCard(q,num){
 return `<div class="q" data-q="${q.id}"><div class="qnum">Question ${num} ${isText(q)?'<span class="badge">Short answer</span>':''}</div><div class="qtext">${esc(q.q)}</div>${mkBar(q)}${answerUI(q,'q',{mc:j=>'countAnswered()',tx:'countAnswered()'})}${isText(q)?`<button class="btn good" id="qchk_${q.id}" style="margin-top:10px" onclick="checkText(${q.id})">Submit answer</button><div id="fb_q_${q.id}"></div>`:''}<div class="qairow"><button type="button" class="btn" onclick="aiAskSame(${q.id})">🤖 Ask AI about this question</button><span class="muted">Uses your question bank first</span></div></div>`;
}
function renderNav(){
 const nav=qs('qnav');
 if(session.tmode==='q'){nav.style.display='none';return}
 const s=session.index;nav.style.display='grid';
 nav.innerHTML=batchOf().map((q,i)=>`<button type="button" class="qn" id="qn_${q.id}" onclick="jumpQ(${q.id})" aria-label="Go to question ${s+i+1}">${s+i+1}</button>`).join('');
}
function jumpQ(id){const el=document.querySelector(`.q[data-q="${id}"]`);if(el)el.scrollIntoView({behavior:'smooth',block:'start'})}
function renderBatch(){
 const start=session.index,end=Math.min(start+PAGE,session.questions.length),batch=batchOf();
 session.bi=0;session.ans={};session.checked={};renderNav();
 qs('batchInfo').textContent=`${session.cat} • ${session.sub==='ALL'?'All sub-categories':session.sub}`;
 if(session.tmode==='q'){renderOne();return}
 qs('batchTitle').textContent=session.questions.length>PAGE?`Questions ${start+1}–${end} of ${session.questions.length}`:`${session.questions.length} Question${session.questions.length>1?'s':''}`;
 qs('submitBtn').textContent=`Submit ${batch.length} Question${batch.length>1?'s':''} →`;
 qs('stickyHint').textContent=session.tmode==='all'?'Whole-exam timer is running (it pauses between batches).':'Answer all you can, then submit.';
 qs('batchBar').style.width=((end/session.questions.length)*100)+'%';
 qs('questions').innerHTML=batch.map((q,i)=>qCard(q,start+i+1)).join('');
 qs('answeredInfo').textContent=`0 / ${batch.length} answered`;
}
function renderOne(){
 const start=session.index,batch=batchOf(),q=batch[session.bi],num=start+session.bi+1,last=session.bi>=batch.length-1;
 qs('batchTitle').textContent=`Question ${num} / ${session.questions.length}`;
 qs('submitBtn').textContent=isText(q)?'Submit answer →':(last?'Submit →':'Next →');
 qs('stickyHint').textContent=`${session.tval}s per question — unanswered questions are skipped when time runs out.`;
 qs('batchBar').style.width=((num-1)/session.questions.length*100)+'%';
 qs('questions').innerHTML=qCard(q,num);
 qs('answeredInfo').textContent=`${session.bi+1} of ${batch.length} on this page`;
 const t=qs('qt_'+q.id);if(t)setTimeout(()=>t.focus(),50);
}
function primaryAction(){
 if(session.tmode!=='q'){submitBatch();return}
 const q=batchOf()[session.bi];
 if(isText(q)&&!session.checked[q.id]&&readDom(q,'q')!=null){checkText(q.id);return}
 advanceOne();
}
function advanceOne(){
 stopTimer();
 const batch=batchOf(),q=batch[session.bi];
 session.ans[q.id]=readDom(q,'q');
 if(session.bi>=batch.length-1){submitBatch();return}
 session.bi++;renderOne();startQTimer();window.scrollTo(0,0);
}
function startQTimer(){startTimer('timerBadge',Date.now()+session.tval*1000,()=>{toast("⏰ Time's up for this question");advanceOne()})}
function beginTimers(){
 if(session.tmode==='q')startQTimer();
 else if(session.tmode==='all')startTimer('timerBadge',Date.now()+session.remaining,()=>{toast("⏰ Time's up!");submitBatch(true)});
 else qs('timerBadge').style.display='none';
}
function countAnswered(){
 if(session.tmode==='q')return;
 const batch=batchOf();
 let n=0;
 batch.forEach(q=>{const d=readDom(q,'q')!=null;if(d)n++;const b=qs('qn_'+q.id);if(b)b.classList.toggle('done',d)});
 qs('answeredInfo').textContent=`${n} / ${batch.length} answered`;
}
function submitBatch(timeUp){
 const left=stopTimer();if(session.tmode==='all'&&left!=null)session.remaining=left;
 const batch=batchOf(),out=[];
 batch.forEach(q=>{
  const ans=getAns(q),skipped=isSkip(q,ans),correct=isRight(q,ans);
  if(correct)session.totalCorrect++; else if(!skipped)session.totalWrong++; else session.totalSkip++;
  if(!correct&&!skipped)addWrong(q);
  if(skipped)addSkip(q);else dropSkip(q.id);
  if(correct&&wrong[q.id]){delete wrong[q.id];saveWrong()}
  if(correct&&need10[q.id]){if(bumpN10(q.id)==='done')session.n10done=(session.n10done||0)+1}
  out.push({q,ans:skipped?null:ans,correct,skipped});
 });
 if(timeUp===true){session.totalSkip+=session.questions.length-(session.index+batch.length);session.over=true}
 session.totalRaw=session.totalCorrect-(session.totalWrong*session.neg);
 session.totalScore=Math.max(0,session.totalRaw);
 lastBatch=out;
 renderResult();
 show('result');
}
function renderResult(){
 const total=session.questions.length,done=session.over?total:Math.min(session.index+PAGE,total),percent=Math.round((session.totalScore/done)*100);
 qs('finalPercent').textContent=Math.max(0,percent)+'%';
 qs('resultTitle').textContent=done<total?'Part Result':'Final Result';
 qs('resultText').textContent=session.over?`⏰ Time's up! Unanswered questions were counted as skipped (${total} total).`:done<total?`Part ${Math.floor(session.index/PAGE)+1} completed (${done} of ${total} questions so far).`:`You completed all ${total} selected questions.`;
 qs('rCorrect').textContent=session.totalCorrect;qs('rWrong').textContent=session.totalWrong;qs('rSkip').textContent=session.totalSkip;qs('rScore').textContent=session.totalScore.toFixed(2);
 const deg=Math.max(0,Math.min(360,percent*3.6));qs('ring').style.background=`conic-gradient(#7181ff 0deg,#8b5cf6 ${deg}deg,#263858 ${deg}deg)`;
 const left=total-done,nb=qs('nextBtn');
 nb.style.display=done<total?'flex':'none';
 nb.innerHTML=`<b>Next ${Math.min(PAGE,left)} Questions →</b><small>${left} left · part ${Math.floor(session.index/PAGE)+2} of ${Math.ceil(total/PAGE)}</small>`;
 qs('nextInfo').innerHTML=`<span>✅ ${done} of ${total} done</span><span>${Math.round(done/total*100)}%</span>`;
 qs('nextBar').style.width=Math.round(done/total*100)+'%';qs('nextBar').parentElement.style.display='';
 qs('nextWrap').style.display=done<total?'block':'none';
 qs('repeatBtn').style.display='none';
 if(done>=total){
  saveHistory();
  const sid=session.id;
  if(session.n10done)toast('🎉 '+session.n10done+' question(s) finished their '+N10+'× practice!',4000);
  if(!session.special)countFresh(session.cat,session.sub,session.les,session.ty).then(k=>{
   if(!session||session.id!==sid||!qs('result').classList.contains('active'))return;
   const b=qs('repeatBtn');
   if(k>0){b.innerHTML=`<b>Next ${Math.min(k,session.n)} New MCQs →</b><small>${k} new question${k>1?'s':''} left in this selection</small>`;b.style.display='flex';qs('nextInfo').textContent='';qs('nextBar').parentElement.style.display='none';qs('nextWrap').style.display='block'}
   else qs('resultText').textContent+=' All new questions in this selection are completed.';
  }).catch(()=>{});
 }
 const nSk=lastBatch.filter(x=>x.skipped).length;
 qs('batchWrong').innerHTML=(nSk?`<div class="card" style="margin-top:12px">⏭ ${nSk} skipped question${nSk>1?'s were':' was'} added to <b>More Practice › Skipped</b>.</div>`:'')+lastBatch.filter(x=>!x.correct&&!x.skipped).map(x=>wrongCard(x.q,x.ans,'This question has been added to More Practice.')).join('');
}
function nextBatch(){session.index+=PAGE;renderBatch();show('exam');beginTimers()}
function wrongCard(q,ans,note){
 return `<div class="wrong"><b>❌ ${esc(q.q)}</b><div class="bad">Your answer: ${yourText(q,ans)}</div><div class="correct">Correct answer: ${rightText(q)}</div><div class="explain"><b>Explanation:</b> ${esc(q.e)}</div>${mkBar(q)}${note?`<div class="muted" style="margin-top:7px">${note}</div>`:''}</div>`;
}
function addWrong(q){
 const w=wrong[q.id]=wrong[q.id]||{id:q.id,attempts:0,wrong:0,addedAt:Date.now()};
 w.q=q;w.wrong++;w.attempts++;saveWrong();
}
let swT;
function saveWrong(){updateBadges();clearTimeout(swT);swT=setTimeout(()=>put(KEY.wrong,wrong),50)}
let practiceLimit=20,ptab='wrong',pfCat='',pfSub='';
async function resolveWrong(){ // old saved entries have no question text: find it by id
 const miss=Object.values(wrong).filter(w=>!w.q);
 if(!miss.length)return;
 let got=[];try{if(DB()&&DB().enabled)got=await DB().getByIds(miss.map(w=>Math.abs(+w.id)))}catch(e){}
 const by=new Map(got.map(q=>[q.id,q]));
 for(const w of miss){const f=custom.find(q=>q.id===+w.id)||by.get(+w.id);if(f)w.q=f}
 saveWrong();
}
function setTab(t){ptab=t;pfCat='';pfSub='';practiceLimit=20;renderPractice()}
function setPfCat(v){pfCat=v;pfSub=v?'ALL':'';practiceLimit=20;renderPractice()}
function setPfSub(v){pfSub=v;practiceLimit=20;renderPractice()}
// questions of a tab; kind = 'wrong' | 'imp' | 'n10'
function kindStore(kind){return kind==='srch'?searched:kind==='imp'?important:kind==='n10'?need10:kind==='skip'?skipQs:wrong}
function kindQs(kind){return Object.values(kindStore(kind)).filter(w=>w.q).map(w=>reg(w.q))}
function qCat(q){return q.cat||'Other'}
function qSub(q){return q.sub||'General'}
function pFiltered(list){return list.filter(q=>(!pfCat||qCat(q)===pfCat)&&(!pfSub||pfSub==='ALL'||qSub(q)===pfSub))}
function count(list,f){const m=new Map();list.forEach(q=>{const k=f(q);m.set(k,(m.get(k)||0)+1)});return m}
// Subject tiles -> sub-category chips above the list
function renderPracticeFilter(all){
 const box=qs('practiceFilter');
 if(!all.length){box.innerHTML='';return}
 const cm=count(all,qCat);if(pfCat&&!cm.has(pfCat)){pfCat='';pfSub=''}
 if(!pfCat){
  box.innerHTML=`<div class="sectitle">Choose a subject</div><div class="catgrid ptiles">${[...cm].map(([k,n])=>{const i=Math.max(0,CAT.findIndex(x=>x.c===k));return `<button type="button" class="catcard" style="${colorOf(i)}" data-v="${esc(k)}" onclick="setPfCat(this.dataset.v)"><span class="cic">${catIcon(k)}</span><span><span class="cname">${esc(k)}</span><span class="cmeta">${n} question${n>1?'s':''}</span></span></button>`}).join('')}</div>`;
  return;
 }
 const inCat=all.filter(q=>qCat(q)===pfCat),sm=count(inCat,qSub);
 if(!pfSub||(pfSub!=='ALL'&&!sm.has(pfSub)))pfSub='ALL';
 const st=colorOf(Math.max(0,CAT.findIndex(x=>x.c===pfCat)));
 box.innerHTML=`<div class="chips"><button type="button" class="chip" onclick="setPfCat('')">‹ Subjects</button><button type="button" class="chip on" style="${st}"><span>${catIcon(pfCat)}</span><span>${esc(pfCat)}</span></button></div>
 <div class="chips" id="pfSubChips">${chipBtn(pfSub==='ALL',st,'data-v="ALL" onclick="setPfSub(this.dataset.v)"',`<span>All</span><span class="n">${inCat.length}</span>`)}${[...sm].map(([k,n])=>chipBtn(k===pfSub,st,`data-v="${esc(k)}" onclick="setPfSub(this.dataset.v)"`,`<span>${esc(k)}</span><span class="n">${n}</span>`)).join('')}</div>`;
 chipsCenter(qs('pfSubChips'));
}
function tabStore(){return kindStore(ptab)}
const PACC={wrong:'#ff5d73',imp:'#f5b942',skip:'#38bdf8',srch:'#a78bfa',n10:'#46e0aa'};
function pfb(kind,title,q,showAns){return `<div class="fbk ${kind}"><div class="fbt">${title}</div>${showAns?`<div class="fba">Correct answer: ${rightText(q)}</div>`:''}${q.e?`<div class="fbe">💡 ${esc(q.e)}</div>`:''}</div>`}
function tabScroll(){const t=document.querySelector('.ptabs .tab.active'),p=qs('ptabs');if(t&&p)p.scrollLeft=Math.max(0,t.offsetLeft-(p.clientWidth-t.offsetWidth)/2)}
async function renderPractice(more){
 if(more!==true)practiceLimit=20;
 try{await resolveWrong()}catch(e){}
 const every=kindQs(ptab);renderPracticeFilter(every);
 const ready=!!pfCat,all=ready?pFiltered(every):[],items=all.slice(0,practiceLimit);
 document.querySelectorAll('.ptabs .tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===ptab));
 tabScroll();updateBadges();
 const desc={wrong:'Wrong answers stay here until you answer that exact question correctly. Once correct, it is removed automatically.',
  imp:'Questions you starred with ☆ Important. They stay here until you un-star them.',
  skip:'Questions you left unanswered (or ran out of time on) in exams and Daily 50. Answer one here and it is removed from this list.',
  srch:'Questions you added from Search. Only the question and its explanation are shown. Tap Remove when you have learned one.',
  n10:'Questions marked “Need '+N10+'× practice”. Answer each one correctly '+N10+' times (here or in any exam) and it is finished.'};
 qs('practiceDesc').textContent=desc[ptab];
 qs('practiceActions').innerHTML=all.length?`<button type="button" class="startbar" style="--ac:${PACC[ptab]}" onclick="startMarked('${ptab}')"><span class="sb-ic">▶</span><span class="sb-t"><b>Start exam</b><small>${all.length} question${all.length>1?'s':''} · ${esc(pfCat)}${pfSub&&pfSub!=='ALL'?' › '+esc(pfSub):''}</small></span><span class="chev">›</span></button>`:'';
 const list=qs('practiceList');
 if(!every.length){
  list.innerHTML={wrong:'<div class="emptystate"><div class="eic">🎉</div><b>Nothing needs more practice</b><span>Answer a question incorrectly in an exam and it will appear here.</span></div>',
   skip:'<div class="emptystate"><div class="eic">⏭</div><b>No skipped questions</b><span>Questions you leave unanswered in an exam or Daily 50 will appear here.</span></div>',
   imp:'<div class="emptystate"><div class="eic">⭐</div><b>No important questions yet</b><span>Tap “☆ Important” on any question.</span></div>',
   srch:'<div class="emptystate"><div class="eic">🔍</div><b>Nothing added from Search yet</b><span>Search a question and tap “Add to More Practice”.</span></div>',
   n10:'<div class="emptystate"><div class="eic">🔁</div><b>Nothing to practise '+N10+' times yet</b><span>Tap “🔁 Need '+N10+'× practice” on any question.</span></div>'}[ptab];return;
 }
 if(!ready){list.innerHTML='';return}
 if(!all.length){list.innerHTML='<div class="emptystate"><div class="eic">📭</div><b>No questions here</b><span>Choose another sub-category.</span></div>';return}
 const badge=q=>ptab==='wrong'?`<span class="pbadge">Wrong ${wrong[q.id].wrong} time${wrong[q.id].wrong>1?'s':''}</span>`
  :ptab==='skip'?`<span class="pbadge">⏭ Skipped ${skipQs[q.id].count} time${skipQs[q.id].count>1?'s':''}</span>`
  :ptab==='n10'?`<span class="pbadge">🔁 ${N10-need10[q.id].left} / ${N10} done · ${need10[q.id].left} to go</span>`:'<span class="pbadge">⭐ Important</span>';
 const pcard=q=>`<div class="pcard" id="pc_${q.id}" style="--ac:${PACC[ptab]}">
  <div class="ptop2">${badge(q)}<span class="ptag">${esc(qSub(q))}</span>${isText(q)?'<span class="ptag s">Short answer</span>':''}</div>
  <div class="rq">${esc(q.q)}</div>
  ${mkBar(q)}
  ${answerUI(q,'p')}
  <div id="pr_${q.id}"></div>
  <button type="button" class="btn primary chk" onclick="practiceAnswer(${q.id})">Check answer</button>
 </div>`;
 list.innerHTML=items.map(ptab==='srch'?q=>srchPCard(q):pcard).join('')+(all.length>items.length?`<button type="button" class="morebtn" onclick="practiceLimit+=20;renderPractice(true)">Show more · ${all.length-items.length} left</button>`:'');
}
// colours the options after "Check answer" and swaps the button for "Try again" when the answer was wrong
function practicePaint(id,q,a,ok){
 const card=qs('pc_'+id);if(!card)return;
 if(isText(q)){const t=qs('pt_'+id);if(t){t.disabled=true;t.classList.add(ok?'okin':'noin')}}
 else card.querySelectorAll('label.opt').forEach((l,j)=>{l.classList.toggle('ok',j===q.a);l.classList.toggle('no',!ok&&j===a);const r=l.querySelector('input');if(r)r.disabled=true});
 const b=card.querySelector('.chk');
 if(b){if(ok)b.style.display='none';else{b.textContent='↻ Try again';b.setAttribute('onclick','renderPractice(true)')}}
}
function practiceAnswer(id){
 const rec=tabStore()[id],q=rec&&rec.q;if(!q)return;const a=readDom(q,'p');
 if(a==null)return toast(isText(q)?'Type your answer first.':'Select an answer first.');
 const box=qs('pr_'+id),ok=isRight(q,a);
 const yes=t=>pfb('yes',t,q,false),no=t=>pfb('nope',t,q,true);
 if(ptab==='wrong'){
  if(ok){delete wrong[id];saveWrong();box.innerHTML=yes('✅ Correct! Removed from More Practice.');setTimeout(()=>renderPractice(true),900)}
  else{wrong[id].wrong++;wrong[id].attempts++;saveWrong();box.innerHTML=no('❌ Still needs practice.');refreshHome()}
 }else if(ptab==='n10'){
  if(ok){const r=bumpN10(id);box.innerHTML=yes(r==='done'?'🎉 '+N10+' of '+N10+' done — this question is finished!':'✅ Correct! '+need10[id].left+' more to go.');setTimeout(()=>renderPractice(true),1100)}
  else box.innerHTML=no('❌ Not correct.');
 }else if(ptab==='skip'){
  dropSkip(id);
  if(ok)box.innerHTML=yes('✅ Correct! Removed from Skipped.');
  else{addWrong(q);box.innerHTML=no('❌ Not correct — moved to Wrong answers.')}
  setTimeout(()=>renderPractice(true),ok?900:1800);refreshHome();
 }else{
  box.innerHTML=ok?yes('✅ Correct!'):no('❌ Not correct.');
 }
 practicePaint(id,q,a,ok);
}
// ---- marks: ⭐ Important and 🔁 Need 10x practice (buttons sit on every question card)
const QREG={};
function reg(q){QREG[q.id]=q;return q}
let smT;
function saveMarks(){updateBadges();clearTimeout(smT);smT=setTimeout(()=>{put(IMP_KEY,important);put(N10_KEY,need10)},50)}
function mkBar(q){
 reg(q);const i=!!important[q.id],n=need10[q.id];
 return `<div class="mkbar"><button type="button" class="mk${i?' on':''}" data-imp="${q.id}" onclick="toggleImp(${q.id})">${i?'⭐ Important':'☆ Important'}</button><button type="button" class="mk${n?' on':''}" data-n10="${q.id}" onclick="toggleN10(${q.id})">${n?'🔁 '+n.left+' more to go':'🔁 Need '+N10+'× practice'}</button></div>`;
}
function refreshMk(id){
 const i=!!important[id],n=need10[id];
 document.querySelectorAll(`[data-imp="${id}"]`).forEach(b=>{b.classList.toggle('on',i);b.textContent=i?'⭐ Important':'☆ Important'});
 document.querySelectorAll(`[data-n10="${id}"]`).forEach(b=>{b.classList.toggle('on',!!n);b.textContent=n?'🔁 '+n.left+' more to go':'🔁 Need '+N10+'× practice'});
}
function afterMark(kind){if(qs('practice').classList.contains('active')&&ptab===kind)setTimeout(()=>renderPractice(true),350)}
function toggleImp(id){
 const q=QREG[id];if(!q)return;
 if(important[id]){delete important[id];toast('Removed from Important')}
 else{important[id]={id,q,addedAt:Date.now()};toast('⭐ Marked as important')}
 saveMarks();refreshMk(id);afterMark('imp');
}
function toggleN10(id){
 const q=QREG[id];if(!q)return;
 if(need10[id]){delete need10[id];toast('Removed from '+N10+'× practice')}
 else{need10[id]={id,q,left:N10,addedAt:Date.now()};toast('🔁 Added: answer it correctly '+N10+' times in More Practice or in any exam',3200)}
 saveMarks();refreshMk(id);afterMark('n10');
}
// a correct answer counts one step; after N10 correct answers the question is finished and removed
function bumpN10(id){
 const r=need10[id];if(!r)return null;
 r.left--;let res='step';if(r.left<=0){delete need10[id];res='done'}
 saveMarks();refreshMk(id);return res;
}
// start an exam from the questions of a tab
function startMarked(kind){
 if(!pfCat||!pfSub)return toast('Select a category and sub-category first.');
 const list=shuffle(pFiltered(kindQs(kind)));
 if(!list.length)return toast('Nothing to practise yet.');
 const label=kind==='skip'?'⏭ Skipped':kind==='srch'?'🔍 Searched':kind==='imp'?'⭐ Important':kind==='n10'?'🔁 '+N10+'× Practice':'🧠 Wrong answers';
 newSession(list,{ty:'all',n:list.length,les:null,order:'random',cat:label,sub:pfCat?pfCat+(pfSub&&pfSub!=='ALL'?' › '+pfSub:''):'All',special:kind},0,'off',0);
}
function saveHistory(){
 const h={ts:Date.now(),date:new Date().toLocaleString(),cat:session.cat,sub:session.sub,total:session.questions.length,correct:session.totalCorrect,wrong:session.totalWrong,skip:session.totalSkip,score:+session.totalScore.toFixed(2),percent:+((session.totalScore/session.questions.length)*100).toFixed(1)};
 history.unshift(h);history=history.slice(0,100);put(KEY.hist,history);
 if(window.MQ)MQ.onResult(h);   // streak / XP / badges / leaderboard (features.js)
}
function renderHistory(){
 if(!history.length){qs('historyList').innerHTML='<div class="emptystate"><div class="eic">📊</div><b>No exams completed yet</b><span>Your results will appear here.</span></div>';return}
 qs('historyList').innerHTML=history.map((h,i)=>{
  const p=Math.max(0,Math.min(100,+h.percent||0)),col=p>=70?'#46e0aa':p>=40?'#f5b942':'#ff7185';
  return `<div class="hrow"><div class="hring" style="--p:${p};--hc:${col}"><b>${Math.round(p)}%</b></div><div class="hmid"><b>#${history.length-i} ${esc(h.cat)}</b><span class="muted">${esc(h.sub)} • ${esc(h.date)}</span><span class="hst"><i class="g">✓ ${h.correct||0}</i><i class="r">✗ ${h.wrong||0}</i><i class="s">⏭ ${h.skip||0}</i></span></div><div class="hsc"><b>${h.correct||0}</b>/${h.total}</div></div>`;
 }).join('');
}
function bankGo(ci,j){const x=CAT[ci];if(!x)return;homeCat=x.c;openSetup(j)}
function renderBank(){
 qs('bankTotal').textContent=totalQ().toLocaleString();
 qs('bankCats').textContent=CAT.length;
 qs('bankSubs').textContent=CAT.reduce((a,x)=>a+x.subs.length,0);
 qs('bankDaily').textContent=Math.min(DAILY_SIZE,totalQ());
 qs('bankList').innerHTML=CAT.map((c,ci)=>`<details class="bkcat" style="${colorOf(ci)}"${ci===0?' open':''}><summary><span class="bki">${catIcon(c.c)}</span><span class="bkt"><b>${esc(c.c)}</b><small>${c.subs.length} sub-categor${c.subs.length===1?'y':'ies'}</small></span><span class="n">${catTotal(c.c).toLocaleString()}</span><span class="bkch">›</span></summary><div class="bksubs">${c.subs.map((s,j)=>`<button type="button" class="bksub" onclick="bankGo(${ci},${j})"><span class="bks-t"><b>${esc(s.n)}</b>${s.lessons.length>1?s.lessons.map(l=>`<small>${esc(l.name)} · ${l.total.toLocaleString()}</small>`).join(''):''}</span><span class="n">${s.total.toLocaleString()}</span><span class="chev">›</span></button>`).join('')}</div></details>`).join('')||'<div class="emptystate"><div class="eic">📚</div><b>No questions yet</b></div>';
}
function refreshHome(){
 qs('totalQ').textContent=totalQ().toLocaleString();qs('totalExam').textContent=history.length;qs('practiceCount').textContent=Object.keys(wrong).length+Object.keys(need10).length+Object.keys(skipQs).length;
 qs('bestScore').textContent=(history.length?Math.max(...history.map(h=>h.percent)):0)+'%';updateBadges();
}
function updateBadges(){
 const nw=Object.keys(wrong).length,ni=Object.keys(important).length,nn=Object.keys(need10).length,ns=Object.keys(skipQs).length;
 qs('wrongBadge').textContent=nw+nn+ns;
 [['tabWrong',nw],['tabImp',ni],['tabSkip',ns],['tabN10',nn],['tabSrch',Object.keys(searched).length]].forEach(([id,v])=>{const e=qs(id);if(e)e.textContent=v});
 const ok=daily&&daily.date===todayStr()&&Array.isArray(daily.qs);
 qs('dailyBadge').textContent=ok?(daily.submitted?0:daily.qs.filter(q=>daily.answers[q.id]==null).length):Math.min(DAILY_SIZE,totalQ());
 [['dailyBadge','dailyBadgeB'],['wrongBadge','wrongBadgeB']].forEach(([a,b])=>{const x=qs(b),v=qs(a).textContent;if(x){x.textContent=v;x.style.display=v==='0'?'none':'inline-block'}});
}
function resetAll(){
 toggleMore(false);closeMenu();
 dlgOpen({icon:'🗑️',title:'Reset local data?',msg:'This deletes your progress, streak, XP and badges, the Wrong, Skipped, Important, Searched and 10× lists, your exam history and today\'s Daily 50. If you are signed in, your cloud copy is reset too. Questions you added yourself are kept.',ok:'Yes, reset',onOk:doReset});
}
function doReset(){
 seen={};seenK={};MCQ_STORE.remove(SEEN_KEY);MCQ_STORE.remove(SEENK_KEY);MCQ_STORE.remove(KEY.wrong);MCQ_STORE.remove(IMP_KEY);MCQ_STORE.remove(N10_KEY);MCQ_STORE.remove(SKIP_KEY);skipQs={};MCQ_STORE.remove(SRCH_KEY);searched={};important={};need10={};MCQ_STORE.remove(KEY.hist);MCQ_STORE.remove(DAILY_KEY);MCQ_STORE.remove('mcq_daily_v1');daily=null;wrong={};history=[];
 show('home');renderPractice();toast('Local data reset.');
}

let toastT;
function toast(t,ms){const x=qs('toast');x.textContent=t;x.style.display='block';clearTimeout(toastT);toastT=setTimeout(()=>x.style.display='none',ms||1800)}
function hideToast(){clearTimeout(toastT);qs('toast').style.display='none'}
/* ---------- Timer engine ---------- */
let tmr=null;
function fmtTime(ms){const s=Math.max(0,Math.ceil(ms/1000));return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')}
function startTimer(elId,endTs,onExpire){
 stopTimer();const el=qs(elId);el.style.display='inline-block';
 const paint=()=>{const left=endTs-Date.now();el.textContent='⏱ '+fmtTime(left);el.classList.toggle('warn',left<=10000);return left};
 paint();
 tmr={endTs,h:setInterval(()=>{if(paint()<=0){stopTimer();onExpire()}},250)};
}
function stopTimer(){if(!tmr)return null;clearInterval(tmr.h);const left=Math.max(0,tmr.endTs-Date.now());tmr=null;return left}

/* ---------- App UI helpers: chips, segmented controls, bottom picker, dialog ---------- */
function chipBtn(on,style,attrs,inner){return `<button type="button" class="chip${on?' on':''}" style="${style||''}" ${attrs}>${inner}</button>`}
function chipsCenter(box){const a=box.querySelector('.chip.on');box.scrollLeft=a?Math.max(0,a.offsetLeft-(box.clientWidth-a.offsetWidth)/2):0}
// subject chips for a hidden <select> (selId); allLabel adds an "All" chip whose value is ''
function catChips(boxId,selId,allLabel){
 const box=qs(boxId),cur=qs(selId).value,pick=`onclick="chipPick('${selId}',this.dataset.v)"`;
 box.innerHTML=(allLabel?chipBtn(cur==='','',`data-v="" ${pick}`,`<span>${allLabel}</span><span class="n">${totalQ().toLocaleString()}</span>`):'')
  +CAT.map((x,i)=>chipBtn(cur===x.c,colorOf(i),`data-v="${esc(x.c)}" ${pick}`,`<span>${catIcon(x.c)}</span><span>${esc(x.c)}</span><span class="n">${catTotal(x.c).toLocaleString()}</span>`)).join('');
 chipsCenter(box);
}
// sub-category chips for the chosen subject
function subChips(boxId,catId,selId,allVal,allLabel){
 const box=qs(boxId),c=qs(catId).value;
 if(!c){box.style.display='none';box.innerHTML='';return}
 box.style.display='flex';
 const cur=qs(selId).value,st=colorOf(Math.max(0,CAT.findIndex(x=>x.c===c))),pick=`onclick="chipPick('${selId}',this.dataset.v)"`;
 box.innerHTML=chipBtn(cur===allVal,st,`data-v="${allVal}" ${pick}`,`<span>${allLabel}</span><span class="n">${catTotal(c).toLocaleString()}</span>`)
  +subsOf(c).map(s=>chipBtn(cur===s.n,st,`data-v="${esc(s.n)}" ${pick}`,`<span>${esc(s.n)}</span><span class="n">${s.total.toLocaleString()}</span>`)).join('');
 chipsCenter(box);
}
function chipPick(selId,v){
 const s=qs(selId);if(!s)return;
 s.value=v;s.dispatchEvent(new Event('change'));
 if(selId.indexOf('rd')===0)rdSync();else if(selId.indexOf('sl')===0)slSync();else srSync();
}
function segPaintAll(){
 document.querySelectorAll('.seg[data-for]').forEach(el=>{
  const s=qs(el.dataset.for);if(!s)return;
  el.innerHTML=[...s.options].map(o=>`<button type="button" data-v="${esc(o.value)}" class="${o.value===s.value?'on':''}">${esc(o.text)}</button>`).join('');
 });
}
document.addEventListener('click',e=>{
 const b=e.target.closest&&e.target.closest('.seg button');if(!b)return;
 const s=qs(b.parentElement.dataset.for);if(!s)return;
 s.value=b.dataset.v;s.dispatchEvent(new Event('change'));segPaintAll();
});
// bottom-sheet list picker (used for the Lesson field)
let pickCb=null,pickItems=[];
function openPicker(title,items,cur,cb){
 pickCb=cb;pickItems=items;qs('pickT').textContent=title;
 qs('pickList').innerHTML=items.map((it,i)=>`<button type="button" class="prow${it.v===cur?' on':''}" onclick="pickDone(${i})"><span class="pr-t">${esc(it.t)}</span>${it.n!=null?`<span class="n">${it.n.toLocaleString()}</span>`:''}<span class="pr-ck">✓</span></button>`).join('');
 qs('pickBg').style.display='block';qs('pickSheet').style.display='block';
}
function closePicker(){qs('pickBg').style.display='none';qs('pickSheet').style.display='none'}
function pickDone(i){const it=pickItems[i],cb=pickCb;closePicker();if(cb&&it)cb(it.v)}
// confirmation dialog (used by Reset Local Data)
let dlgCb=null;
function dlgOpen(o){
 qs('dlgIc').textContent=o.icon||'⚠️';qs('dlgT').textContent=o.title;qs('dlgM').textContent=o.msg;qs('dlgOk').textContent=o.ok||'OK';
 dlgCb=o.onOk;qs('dlgBg').style.display='block';qs('dlg').style.display='block';
}
function dlgClose(){dlgCb=null;qs('dlgBg').style.display='none';qs('dlg').style.display='none'}
function dlgConfirm(){const f=dlgCb;dlgClose();if(f)f()}
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closePicker();dlgClose()}});
// the sticky headers sit just under the top bar, whatever its height is on this device
function setTbh(){const t=qs('topbar');if(t)document.documentElement.style.setProperty('--tbh',t.offsetHeight+'px')}
window.addEventListener('resize',setTbh);window.addEventListener('load',setTbh);

/* ---------- Read mode ---------- */
let readList=[],readLimit=20,readHide=false,readShown=new Set(),readBusy=false,readOn=false,readTitle='';
function readView(){qs('rdPicker').style.display=readOn?'none':'block';qs('rdResults').style.display=readOn?'block':'none'}
function readInit(){
 const cv=qs('rdCat').value;
 qs('rdCat').innerHTML=CAT.map(x=>`<option value="${esc(x.c)}">${esc(x.c)} (${catTotal(x.c).toLocaleString()})</option>`).join('');
 if(cv&&cats().includes(cv))qs('rdCat').value=cv;
 readSubs(true);readView();
}
function readSubs(keep){
 const c=qs('rdCat').value,sv=keep?qs('rdSub').value:'';
 qs('rdSub').innerHTML=`<option value="ALL">All sub-categories (${catTotal(c).toLocaleString()})</option>`+subsOf(c).map(x=>`<option value="${esc(x.n)}">${esc(x.n)} (${x.total.toLocaleString()})</option>`).join('');
 if(sv&&[...qs('rdSub').options].some(o=>o.value===sv))qs('rdSub').value=sv;
 readLessons(keep);
}
function readLessons(keep){
 const c=qs('rdCat').value,s=qs('rdSub').value,list=allLessons(c,s),lv=keep?qs('rdLes').value:'';
 qs('rdLes').innerHTML=`<option value="ALL">All lessons (${list.length})</option>`+list.map((x,i)=>`<option value="${i}">${s==='ALL'?esc(x.sub)+' › ':''}${esc(x.l.name)} (${x.l.total.toLocaleString()})</option>`).join('');
 if(lv&&[...qs('rdLes').options].some(o=>o.value===lv))qs('rdLes').value=lv;
 rdSync();
}
function readSelCount(){
 const c=qs('rdCat').value,s=qs('rdSub').value,lv=qs('rdLes').value,list=allLessons(c,s);
 if(lv!=='ALL'&&list[+lv])return list[+lv].l.total;
 if(s==='ALL')return catTotal(c);
 const x=subsOf(c).find(y=>y.n===s);return x?x.total:0;
}
// repaints the chips, lesson field, segmented controls and the Start button from the hidden selects
function rdSync(){
 catChips('rdCatChips','rdCat','');
 subChips('rdSubChips','rdCat','rdSub','ALL','All');
 const c=qs('rdCat').value,s=qs('rdSub').value,list=allLessons(c,s),lv=qs('rdLes').value;
 qs('rdLesRow').style.display=list.length>1?'block':'none';
 qs('rdLesTxt').textContent=lv!=='ALL'&&list[+lv]?(s==='ALL'?list[+lv].sub+' › ':'')+list[+lv].l.name:`All lessons (${list.length})`;
 const n=readSelCount();
 qs('rdStartBtn').textContent=n?`Start reading · ${n.toLocaleString()} question${n>1?'s':''} →`:'Start reading →';
 segPaintAll();
}
function readPickLesson(){
 const c=qs('rdCat').value,s=qs('rdSub').value,list=allLessons(c,s);
 openPicker('Choose a lesson',[{v:'ALL',t:'All lessons',n:list.reduce((a,x)=>a+x.l.total,0)}].concat(list.map((x,i)=>({v:String(i),t:(s==='ALL'?x.sub+' › ':'')+x.l.name,n:x.l.total}))),qs('rdLes').value,v=>{qs('rdLes').value=v;rdSync()});
}
async function readStart(){
 if(readBusy)return;
 const c=qs('rdCat').value,s=qs('rdSub').value,lv=qs('rdLes').value,ty=qs('rdType').value,rnd=qs('rdOrder').value==='random';
 if(!c)return toast('Choose a subject first.');
 readHide=qs('rdMode').value==='hide';readShown=new Set();readLimit=20;
 const ls=lessonsOf(c,s,lv==='ALL'?null:[+lv]),all=[],keys=new Set();
 const add=q=>{if(!(ty==='all'||(ty==='text')===isText(q)))return;const k=qkey(q);if(keys.has(k))return;keys.add(k);all.push(q)};
 readBusy=true;loadFail=new Set();toast('Loading questions…',15000);
 try{
  const sh=ls.filter(l=>l.shard&&(ty==='all'||(ty==='text'?l.shard.t>0:l.shard.t<l.shard.c))).map(l=>l.shard);
  for(let i=0;i<sh.length;i+=4)(await Promise.all(sh.slice(i,i+4).map(x=>loadLessonSafe(x)))).forEach(a=>a.forEach(add));
  ls.flatMap(l=>l.custom).forEach(add);
 }catch(e){readBusy=false;return toast('Could not load questions. Check your connection and try again.')}
 readBusy=false;hideToast();
 readList=rnd?shuffle(all):all;
 readTitle=c+' › '+(s==='ALL'?'All sub-categories':s);
 readOn=true;readView();renderReadList();window.scrollTo(0,0);
 if(loadFail.size)toast('⚠ '+loadFail.size+' lesson(s) could not be loaded ('+[...loadFail].join(', ')+').',6000);
}
function readChange(){readOn=false;readView();window.scrollTo(0,0)}
function readToggleAns(){readSetAll(!readHide)}
function readCard(q,i){
 const open=!readHide||readShown.has(q.id);
 const body=isText(q)
  ?(open?`<div class="rdans">✅ <b>Answer:</b> ${rightText(q)}</div>`:'')
  :`<div class="opts"${open?'':` onclick="readReveal(${q.id})"`}>${q.o.map((x,j)=>`<div class="opt${open&&j===q.a?' ok':''}"><span class="rdl">${'ABCDEFGH'[j]||(j+1)}</span><span class="otx">${esc(x)}</span>${open&&j===q.a?'<span class="rdtick">✓</span>':''}</div>`).join('')}</div>`;
 return `<article class="rcard" id="rd_${q.id}">
  <div class="rtop"><span class="rnum">${i+1}</span><span class="rtags"><span class="ptag">${esc(qSub(q))}</span>${isText(q)?'<span class="ptag s">Short answer</span>':''}</span></div>
  <div class="rq">${esc(q.q)}</div>
  ${body}
  ${open?(q.e?`<div class="explain"><b>💡 Explanation</b><br>${esc(q.e)}</div>`:''):`<button type="button" class="reveal" onclick="readReveal(${q.id})">👁 Tap to show the answer</button>`}
  ${mkBar(q)}
 </article>`;
}
function renderReadList(){
 const n=readList.length,items=readList.slice(0,readLimit);
 qs('rdTitle').textContent=readTitle;
 qs('rdInfo').textContent=n?`Showing ${items.length} of ${n.toLocaleString()}`:'0 questions';
 qs('rdProg').style.width=n?(items.length/n*100)+'%':'0';
 const t=qs('rdTog');t.classList.toggle('on',!readHide);t.textContent=readHide?'🙈 Answers hidden':'👁 Answers shown';
 if(!n){qs('rdList').innerHTML='<div class="emptystate"><div class="eic">📭</div><b>No questions found</b><span>Try another sub-category or question type.</span></div>';return}
 qs('rdList').innerHTML=items.map((q,i)=>readCard(q,i)).join('')+(n>items.length?`<button type="button" class="morebtn" onclick="readLimit+=20;renderReadList()">Show more · ${(n-items.length).toLocaleString()} left</button>`:'');
}
function readReveal(id){
 readShown.add(id);const i=readList.findIndex(q=>q.id===id),el=qs('rd_'+id);
 if(i>=0&&el)el.outerHTML=readCard(readList[i],i);
}
function readSetAll(hide){readHide=hide;readShown=new Set();renderReadList()}

/* ---------- Add Question page ---------- */
const MQ_PAGE_SIZE=20;                       // questions shown per page in "My Questions"
let editingQuestionId=null,bulkStop=false;
const mq={page:1,cat:'',sub:'',lesson:'',kind:'all',text:''};   // "My Questions" filters

/* --- small helpers --- */
const frame=()=>Promise.race([new Promise(r=>requestAnimationFrame(r)),new Promise(r=>setTimeout(r,50))]);   // lets the browser paint (rAF is paused in background tabs, hence the timeout)
let mqRows=[],mqSeq=0,mqDupIds=new Set();                  // mqRows = the database questions on the page being shown
const findCustom=id=>custom.find(q=>String(q.id)===String(id))||mqRows.find(q=>String(q.id)===String(id));
const isDup=(x,d)=>x.source==='supabase'?mqDupIds.has(x.dbId):d.get(questionDuplicateKey(x))>1;
const isDbQuestion=x=>!!(x&&x.source==='supabase'&&x.dbId&&window.MCQ_DB&&window.MCQ_DB.enabled);
const fail=msg=>{toast(msg);return false};
function nextCustomId(){let m=100000;for(const x of custom){const n=Math.abs(Number(x&&x.id));if(Number.isFinite(n)&&n>m)m=n}return m+1}
function pickValue(selectId,customId,fallback){return qs(customId)?.value.trim()||qs(selectId)?.value.trim()||fallback}
function setSelectOrCustom(selectId,customId,value){        // value not in the list (e.g. an old custom category) goes to the "custom" box, so editing never changes it
 const sel=qs(selectId),cust=qs(customId);if(!sel)return;
 const known=[...sel.options].some(o=>o.value===value);
 sel.value=known?value:'';if(cust)cust.value=known?'':value;
}
function saveQuestionMarks(){saveSrch();saveSkip();saveWrong();saveMarks()}
function purgeQuestion(x){                                   // remove a question and everything that points at it
 custom=custom.filter(q=>String(q.id)!==String(x.id)&&!(x.dbId!=null&&String(q.dbId)===String(x.dbId)));
 mqRows=mqRows.filter(q=>String(q.id)!==String(x.id));
 [wrong,important,need10,skipQs,searched].forEach(m=>{delete m[x.id]});
}
function syncCatalog(){                                      // save custom questions and refresh every screen that shows them
 put(CUSTOM_KEY,custom);rebuildCatalog();
 const cv=qs('cat')?.value;loadCats();if(cv&&cats().includes(cv)){qs('cat').value=cv;loadSubs()}
 refreshHome();if(qs('manage')?.classList.contains('active'))renderManage();
}

/* --- coloured button states: pressed (CSS :active), busy, done, failed --- */
async function withBusy(btn,job){                            // job returns true (done) / false (failed) / anything else (neutral)
 if(btn&&btn.classList.contains('is-busy'))return false;     // ignore double taps while a save is running
 if(btn){btn.classList.remove('is-ok','is-err');btn.classList.add('is-busy');btn.disabled=true}
 let result=false;
 try{result=await job()}catch(err){console.error(err);toast('Something went wrong. Please try again.')}
 finally{
  if(btn){
   btn.classList.remove('is-busy');btn.disabled=false;
   if(result===true||result===false){btn.classList.add(result?'is-ok':'is-err');setTimeout(()=>btn.classList.remove('is-ok','is-err'),1400)}
  }
 }
 return result;
}

/* --- alert cards (replace confirm()/toasts for submit, cancel, duplicate and delete) --- */
const AC_ICON={success:'✅',danger:'🗑️',warn:'⚠️',dup:'♻️',info:'ℹ️'};
let acClose=null;
function alertCard(o){                                       // resolves true (main button) or false (cancel / Esc / outside tap)
 if(acClose)acClose(false);
 return new Promise(resolve=>{
  const kind=AC_ICON[o.kind]?o.kind:'info',wrap=document.createElement('div');
  wrap.className='acbg';
  wrap.innerHTML=`<div class="ac ac-${kind}" role="alertdialog" aria-modal="true" aria-labelledby="acT"><div class="acic">${esc(o.icon||AC_ICON[kind])}</div><h3 id="acT">${esc(o.title||'')}</h3>${o.msg?`<p class="acm">${esc(o.msg)}</p>`:''}${o.html||''}<div class="acbtns">${o.cancel?`<button type="button" class="btn" data-r="0">${esc(o.cancel)}</button>`:''}<button type="button" class="btn primary" data-r="1">${esc(o.ok||'OK')}</button></div>${o.auto?`<i class="acauto" style="animation-duration:${o.auto}ms"></i>`:''}</div>`;
  let timer=0;
  const onKey=e=>{if(e.key==='Escape')finish(false)};
  const finish=v=>{clearTimeout(timer);document.removeEventListener('keydown',onKey);wrap.classList.add('out');setTimeout(()=>wrap.remove(),160);if(acClose===finish)acClose=null;resolve(v)};
  wrap.addEventListener('click',e=>{const b=e.target.closest('[data-r]');if(b)finish(b.dataset.r==='1');else if(e.target===wrap)finish(false)});
  document.addEventListener('keydown',onKey);document.body.appendChild(wrap);acClose=finish;
  if(o.auto)timer=setTimeout(()=>finish(true),o.auto);                                  // success cards close themselves and never steal focus
  else wrap.querySelector((kind==='danger'||o.focusCancel)&&o.cancel?'[data-r="0"]':'[data-r="1"]').focus();
 });
}
function quoteHtml(d){                                       // small preview of a question (local item or database row)
 const name=d.name||d.question_name||'',text=String(d.q||d.question||''),path=[d.cat,d.sub,d.lesson].filter(Boolean).join(' › ');
 return `<div class="acquote">${name?`<b>${esc(name)}</b>`:''}<span>${esc(text.length>180?text.slice(0,180)+'…':text)}</span>${path?`<small>${esc(path)}</small>`:''}</div>`;
}
const acDuplicate=(d,edit)=>alertCard({kind:'dup',title:'Duplicate question',msg:edit?'Another question already has this text, so your changes were not saved.':'This question already exists, so it was not added.',html:quoteHtml(d),ok:'Got it'});
const acSaved=(item,title,viaDb)=>alertCard({kind:'success',title,msg:[item.cat,item.sub,item.lesson].filter(Boolean).join(' › ')+(viaDb?' · saved to the cloud database':' · saved on this device'),auto:1900});
function dbFailure(err,verb){
 if(!(err&&err.code==='DUPLICATE'))console.error('Database '+verb+' failed:',err);
 updateDbSaveStatus('⚠ Database '+verb+' failed','err');
 if(err&&err.code==='DUPLICATE')acDuplicate(err.existing||{},verb==='update');
 else alertCard({kind:'warn',title:'Database '+verb+' failed',msg:(err&&err.message)||'Check your connection and the Supabase policies. Nothing was changed.',ok:'OK'});
 return false;
}

/* --- form lists: category / sub-category / lesson --- */
function nqToggle(){const t=qs('nqType').value==='text';qs('nqMcq').style.display=t?'none':'block';qs('nqText').style.display=t?'block':'none'}
function subOptions(cat){return '<option value="">Choose sub-category</option>'+(subsOf(cat).map(x=>`<option value="${esc(x.n)}">${esc(x.n)} (${x.total.toLocaleString()})</option>`).join('')||'<option value="General">General</option>')}
function lessonSuggestions(cat,sub){
 const set=new Set();
 CAT.forEach(c=>{if(cat&&c.c!==cat)return;c.subs.forEach(s=>{if(sub&&s.n!==sub)return;(s.lessons||[]).forEach(l=>l&&l.name&&set.add(l.name))})});
 custom.forEach(x=>{if(x&&x.lesson&&(!cat||qCat(x)===cat)&&(!sub||qSub(x)===sub))set.add(x.lesson)});
 return [...set].slice(0,300);
}
function fillLessonLists(){
 [['lesDl','nqCat','nqSub'],['bulkLesDl','bulkCat','bulkSub']].forEach(([dl,c,s])=>{
  const el=qs(dl);if(el)el.innerHTML=lessonSuggestions(qs(c)?.value||'',qs(s)?.value||'').map(l=>`<option value="${esc(l)}">`).join('');
 });
}
function fillSubSelect(selectId,cat,keep){                   // rebuild sub-categories; keep the old choice when it still exists
 const sel=qs(selectId);if(!sel)return;
 const old=keep?sel.value:'';sel.innerHTML=subOptions(cat);
 sel.value=[...sel.options].some(o=>o.value===old)?old:'';
}
function refreshLists(){
 const catOpts=cats().map(c=>`<option value="${esc(c)}">${esc(c)} (${catTotal(c).toLocaleString()})</option>`).join('');
 ['nqCat','bulkCat'].forEach(id=>{
  const sel=qs(id);if(!sel)return;
  const old=sel.value;sel.innerHTML='<option value="">Choose category</option>'+catOpts+'<option value="Custom">Custom</option>';
  if([...sel.options].some(o=>o.value===old))sel.value=old;
 });
 fillSubSelect('nqSub',qs('nqCat')?.value||'',true);
 fillSubSelect('bulkSub',qs('bulkCat')?.value||'',true);
 nqChips();fillLessonLists();
}
function nqCatChange(){if(qs('nqCat')?.value&&qs('nqCatCustom'))qs('nqCatCustom').value='';fillSubSelect('nqSub',qs('nqCat')?.value||'',false);nqChips();fillLessonLists()}
function nqCatTyped(){if(qs('nqCatCustom')?.value.trim()){qs('nqCat').value='';fillSubSelect('nqSub','',false);nqChips()}}   // typing a custom category replaces the picked one
function nqSubChange(){if(qs('nqSub')?.value&&qs('nqSubCustom'))qs('nqSubCustom').value='';nqChips();fillLessonLists()}
function nqSubTyped(){if(qs('nqSubCustom')?.value.trim()){qs('nqSub').value='';nqChips()}}
function bulkCatChange(){fillSubSelect('bulkSub',qs('bulkCat')?.value||'',false);fillLessonLists()}
function setAddMode(mode){
 const single=mode!=='bulk';
 qs('nqSingle').style.display=single?'block':'none';qs('nqBulk').style.display=single?'none':'block';
 qs('nqTabSingle').classList.toggle('active',single);qs('nqTabBulk').classList.toggle('active',!single);
 if(single)nqToggle();else refreshLists();
}
// quick-pick chips under the Category / Sub-category fields
function nqChips(){
 const cv=qs('nqCat').value.trim(),sv=qs('nqSub').value.trim(),ci=CAT.findIndex(x=>x.c===cv);
 qs('nqCatChips').innerHTML=CAT.map((x,i)=>chipBtn(cv===x.c,colorOf(i),`data-v="${esc(x.c)}" onclick="nqPickCat(this.dataset.v)"`,`<span>${catIcon(x.c)}</span><span>${esc(x.c)}</span>`)).join('');
 const box=qs('nqSubChips');
 if(ci<0){box.style.display='none';box.innerHTML='';return}
 box.style.display='flex';
 box.innerHTML=CAT[ci].subs.map(s=>chipBtn(sv===s.n,colorOf(ci),`data-v="${esc(s.n)}" onclick="nqPickSub(this.dataset.v)"`,`<span>${esc(s.n)}</span>`)).join('');
}
function nqPickCat(v){qs('nqCat').value=v;nqCatChange()}
function nqPickSub(v){qs('nqSub').value=v;nqSubChange()}
function updateDbSaveStatus(msg,cls){const el=qs('dbSaveStatus');if(!el)return;el.className='dbstatus '+(cls||'');el.textContent=msg}
function updateDbBanner(){const db=DB(),on=!!(db&&db.enabled);updateDbSaveStatus(on?(db.ready?'☁️ Connected to the database · '+totalQ().toLocaleString()+' questions':'☁️ Connecting to the database…'):'⚠ Supabase is not configured — questions are saved on this device only',on?'ok':'err')}

/* --- duplicate protection: question text is normalised, so case, spacing and punctuation never matter --- */
function normalizeQuestionText(v){
 return String(v||'').toLowerCase().replace(/<[^>]*>/g,' ').normalize('NFKC')
  .replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}
const DUP_KEYS=new WeakMap();                                // cached per question object (a question that is edited becomes a new object)
function questionDuplicateKey(q){
 if(!q||typeof q!=='object')return '';
 let k=DUP_KEYS.get(q);if(k===undefined){k=normalizeQuestionText(q.q);DUP_KEYS.set(q,k)}
 return k;
}
function findDuplicateQuestion(item,exclude){
 const key=questionDuplicateKey(item);if(!key)return null;
 const exId=exclude?String(exclude.id):null,exDb=exclude&&exclude.dbId!=null?String(exclude.dbId):null;
 return custom.find(x=>{
  if(!x||questionDuplicateKey(x)!==key)return false;
  if(exId&&String(x.id)===exId)return false;
  return !(exDb&&x.dbId!=null&&String(x.dbId)===exDb);
 })||null;
}
function duplicateCounts(){const m=new Map();custom.forEach(x=>{const k=questionDuplicateKey(x);if(k)m.set(k,(m.get(k)||0)+1)});return m}
function duplicateGroups(){const g=new Map();custom.forEach(x=>{const k=questionDuplicateKey(x);if(k)(g.get(k)||g.set(k,[]).get(k)).push(x)});return [...g.values()].filter(a=>a.length>1)}
async function removeDuplicateQuestions(btn){
 return withBusy(btn,async()=>{
  let dbExtra=[];
  if(DB()?.enabled){try{dbExtra=(await DB().duplicates()).filter(d=>!d.keep)}catch(err){return dbFailure(err,'check')}}
  const removable=dbExtra.filter(d=>!d.locked),lockedLeft=dbExtra.length-removable.length;
  const groups=duplicateGroups(),extra=removable.length+groups.reduce((n,g)=>n+g.length-1,0);
  if(!extra){alertCard({kind:'success',title:'No duplicates',msg:lockedLeft?`Only locked duplicates were found (${lockedLeft}). Unlock them first.`:'Every question is unique.',auto:1800});return 'skip'}
  const go=await alertCard({kind:'warn',title:'Remove duplicates?',msg:`Found ${extra.toLocaleString()} extra question${extra===1?'':'s'}. One copy of each question (the oldest) is kept.${lockedLeft?` ${lockedLeft} locked duplicate(s) are left alone.`:''}`,ok:'Remove duplicates',cancel:'Cancel'});
  if(!go)return 'skip';
  let removed=0,failed=0;
  if(removable.length){
   try{await DB().deleteMany(removable.map(d=>d.id));removed+=removable.length;removable.forEach(d=>[wrong,important,need10,skipQs,searched].forEach(m=>{delete m[-d.id]}))}
   catch(err){console.error('Duplicate delete failed:',err);failed+=removable.length}
  }
  for(const group of groups){
   const ordered=[...group].sort((a,b)=>Math.abs(Number(a.id)||0)-Math.abs(Number(b.id)||0));
   for(const x of ordered.slice(1)){
    if(x.locked&&!await requireQuestionPin(x,'delete')){failed++;continue}
    purgeQuestion(x);removed++;
   }
  }
  saveQuestionMarks();syncCatalog();
  alertCard({kind:removed?'success':'warn',title:removed?'Duplicates removed':'Nothing removed',msg:`${removed.toLocaleString()} duplicate${removed===1?'':'s'} removed${failed?` · ${failed} could not be removed`:''}.`,auto:removed?2000:0,ok:'OK'});
  return removed>0;
 });
}

/* --- single question: build, save, edit, delete --- */
function resetQuestionForm(keepContext){
 ['nqQ','nqAns','nqExp','nqO0','nqO1','nqO2','nqO3','nqPin'].concat(keepContext?[]:['nqName','nqCatCustom','nqSubCustom']).forEach(k=>{const el=qs(k);if(el)el.value=''});
 if(qs('nqLock'))qs('nqLock').checked=false;
 if(qs('nqType'))qs('nqType').value='mcq';
 document.querySelectorAll('input[name="nqCorrect"]').forEach((r,i)=>{r.checked=i===0});
 nqToggle();
}
function setQuestionEditMode(on){
 const save=qs('nqSaveBtn'),cont=qs('nqContinueBtn'),cancel=qs('nqCancelEditBtn');
 if(save)save.textContent=on?'💾 Save Changes':'💾 Save Question';
 if(cont)cont.style.display=on?'none':'';
 if(cancel)cancel.style.display=on?'inline-flex':'none';
}
async function cancelQuestionEdit(btn){
 return withBusy(btn,async()=>{
  const discard=await alertCard({kind:'warn',title:'Cancel editing?',msg:'Your changes to this question will be discarded.',ok:'Discard changes',cancel:'Keep editing'});
  if(!discard)return 'skip';
  editingQuestionId=null;resetQuestionForm();setQuestionEditMode(false);toast('Edit cancelled');
  return 'skip';
 });
}
function startEditMine(id){
 const x=findCustom(id);
 if(!x)return toast('Question not found.');
 if(x.locked)return toast('🔒 This question is locked. Unlock it first.');
 editingQuestionId=x.id;
 setAddMode('single');
 qs('nqType').value=isText(x)?'text':'mcq';
 refreshLists();
 setSelectOrCustom('nqCat','nqCatCustom',x.cat||'Custom');
 nqCatChange();
 setSelectOrCustom('nqSub','nqSubCustom',x.sub||'General');
 qs('nqLes').value=x.lesson||'General';
 qs('nqQ').value=x.q||'';
 if(isText(x))qs('nqAns').value=(x.ans||[]).join('\n');
 else{
  [0,1,2,3].forEach(i=>{qs('nqO'+i).value=x.o?.[i]||''});
  document.querySelectorAll('input[name="nqCorrect"]').forEach((r,i)=>{r.checked=i===Number(x.a)});
 }
 qs('nqExp').value=x.e||'';qs('nqLock').checked=false;qs('nqPin').value='';qs('nqName').value=x.name||'';
 setQuestionEditMode(true);nqToggle();fillLessonLists();
 qs('manage')?.scrollIntoView({behavior:'smooth',block:'start'});
 toast('✏️ Editing question');
}
async function buildQuestionFromForm(existing){
 const t=qs('nqType').value,q=qs('nqQ').value.trim(),locked=!!qs('nqLock')?.checked,pin=qs('nqPin')?.value.trim()||'';
 if(!q)return{error:'Write the question first.'};
 if(locked&&(pin?!validPin(pin):!existing?.pinHash))return{error:'Set a 4-12 digit PIN when locking a question.'};
 const pinHash=locked?(pin?await hashPin(pin):existing.pinHash):null;
 let item={id:existing?.id??nextCustomId(),cat:pickValue('nqCat','nqCatCustom','Custom'),sub:pickValue('nqSub','nqSubCustom','General'),lesson:qs('nqLes').value.trim()||'General',name:qs('nqName')?.value.trim()||'',q,locked,pinHash};
 const e=qs('nqExp').value.trim();
 if(t==='text'){
  const ans=qs('nqAns').value.split('\n').map(x=>x.trim()).filter(Boolean);
  if(!ans.length)return{error:'Add at least one accepted answer.'};
  item={...item,t:'text',ans,e:e||('Answer: '+ans[0])};
 }else{
  const o=[0,1,2,3].map(i=>qs('nqO'+i).value.trim()),a=+document.querySelector('input[name="nqCorrect"]:checked').value;
  if(!o[a])return{error:'The option marked correct is empty.'};
  const opts=[];let na=0;o.forEach((v,i)=>{if(v){if(i===a)na=opts.length;opts.push(v)}});
  if(opts.length<2)return{error:'Add at least two options.'};
  item={...item,o:opts,a:na,e:e||('Correct answer: '+opts[na])};
 }
 if(existing){if(existing.dbId)item.dbId=existing.dbId;if(existing.source)item.source=existing.source;if(!locked)delete item.pinHash}
 return{item};
}
async function editQuestion(id){
 const existing=findCustom(id);if(!existing)return fail('Question not found.');
 if(existing.locked&&!await requireQuestionPin(existing,'edit'))return 'skip';
 const built=await buildQuestionFromForm(existing);if(built.error)return fail(built.error);
 const item=built.item,dup=findDuplicateQuestion(item,existing);
 if(dup){acDuplicate(dup,true);return false}
 const viaDb=isDbQuestion(existing);
 if(viaDb){try{await window.MCQ_DB.updateQuestion(existing.dbId,item,{cat:existing.cat,sub:existing.sub,lesson:existing.lesson});updateDbSaveStatus('☁️ Database question updated','ok')}catch(err){return dbFailure(err,'update')}}
 const i=custom.findIndex(x=>String(x.id)===String(id));
 if(i>=0)custom[i]=item;else{const j=mqRows.findIndex(x=>String(x.id)===String(id));if(j>=0)mqRows[j]=item;else if(!viaDb)return fail('Question not found.')}
 editingQuestionId=null;resetQuestionForm();setQuestionEditMode(false);syncCatalog();
 acSaved(item,'Changes saved',viaDb);
 return true;
}
const dbRow=it=>((DB()&&DB().catalog)||[]).find(r=>r.cat===it.cat&&r.sub===it.sub&&r.lesson===(it.lesson||'General'));
function noteDbSaved(it,before){                          // make the new question count in the catalog even if supabase.js did not
 const db=DB();if(!db||!Array.isArray(db.catalog))return;
 const r=dbRow(it);
 if(!r)db.catalog.push({cat:it.cat,sub:it.sub,lesson:it.lesson||'General',c:1,t:isText(it)?1:0});
 else if(r.c===before){r.c++;if(isText(it))r.t=(r.t||0)+1}
}
async function createQuestion(keepContext){
 const built=await buildQuestionFromForm();if(built.error)return fail(built.error);
 const item=built.item,dup=findDuplicateQuestion(item);
 if(dup){acDuplicate(dup);return false}
 const viaDb=!!window.MCQ_DB?.enabled;
 if(viaDb){
  try{const r0=dbRow(item),before=r0?r0.c:0,dbId=await window.MCQ_DB.saveQuestion(item);Object.assign(item,{id:-Math.abs(Number(dbId)),dbId:Number(dbId),source:'supabase'});noteDbSaved(item,before);updateDbSaveStatus('☁️ Saved to Supabase database','ok')}
  catch(err){return dbFailure(err,'save')}
 }else updateDbSaveStatus('⚠ Supabase is not connected — saved on this device only','off');
 if(!viaDb)custom.push(item);resetQuestionForm(keepContext);syncCatalog();
 acSaved(item,'Question submitted',viaDb);
 return true;
}
function addQuestion(btn,keepContext){return withBusy(btn,()=>editingQuestionId!==null?editQuestion(editingQuestionId):createQuestion(keepContext))}
function addAnotherQuestion(btn){return addQuestion(btn,true).then(ok=>{if(ok===true)qs('nqQ')?.focus()})}
async function deleteMine(id,btn){
 return withBusy(btn,async()=>{
  const target=findCustom(id);if(!target)return fail('Question not found.');
  if(target.locked&&!await requireQuestionPin(target,'delete'))return 'skip';
  const sure=await alertCard({kind:'danger',title:'Delete this question?',msg:'This cannot be undone.'+(isDbQuestion(target)?' It will also be removed from the cloud database.':''),html:quoteHtml(target),ok:'Delete',cancel:'Keep it'});
  if(!sure)return 'skip';
  if(isDbQuestion(target)){try{await window.MCQ_DB.deleteQuestion(target.dbId,{cat:target.cat,sub:target.sub,lesson:target.lesson})}catch(err){return dbFailure(err,'delete')}}
  purgeQuestion(target);saveQuestionMarks();syncCatalog();
  alertCard({kind:'danger',title:'Question deleted',msg:'It has been removed from your list.',auto:1500});
  return true;
 });
}
async function unlockMine(id,btn){
 return withBusy(btn,async()=>{
  const x=findCustom(id);if(!x)return fail('Question not found.');
  if(x.pinHash&&!await requireQuestionPin(x,'unlock'))return 'skip';   // a lock without a PIN has nothing to verify
  if(isDbQuestion(x)){try{await window.MCQ_DB.setQuestionLock(x.dbId,false,null)}catch(err){return dbFailure(err,'unlock')}}
  x.locked=false;x.pinHash=null;put(CUSTOM_KEY,custom);renderManage();toast('🔓 Question unlocked');
  return true;
 });
}

/* --- bulk import --- */
function bulkProgress(p){
 const box=qs('bulkProg');box.classList.toggle('show',!!p);if(!p)return;
 const pct=p.total?Math.round(p.done/p.total*100):0;
 qs('bulkProgLabel').textContent=p.label;qs('bulkProgPct').textContent=pct+'%';qs('bulkProgFill').style.width=pct+'%';
 qs('bulkProgStats').innerHTML=`<span class="s-ok">✔ ${p.added} added</span><span class="s-dup">♻ ${p.dupes} duplicate</span><span class="s-bad">⚠ ${p.bad} invalid</span>`;
 box.classList.toggle('done',!!p.finished);qs('bulkStopBtn').style.display=p.finished?'none':'';
}
const bulkRequestStop=()=>{bulkStop=true;qs('bulkProgLabel').textContent='Stopping…'};
function clearBulk(){qs('bulkJson').value='';qs('bulkStatus').textContent='';bulkProgress(null)}
async function bulkSettings(){
 const forceLock=!!qs('bulkLock').checked,pin=qs('bulkPin')?.value.trim()||'';
 if(forceLock&&!validPin(pin))return{error:'Set a 4-12 digit bulk PIN before locking imported questions.'};
 return{cat:pickValue('bulkCat','bulkCatCustom','Custom'),sub:pickValue('bulkSub','bulkSubCustom','General'),lesson:qs('bulkLes').value.trim()||'General',name:qs('bulkName')?.value.trim()||'',forceLock,pinHash:forceLock?await hashPin(pin):null};
}
function bulkItem(raw,cfg,id){                               // one JSON entry -> question, or null when invalid
 const q=raw||{};if(typeof q.q!=='string'||!q.q.trim())return null;
 const pinHash=cfg.forceLock?cfg.pinHash:(q.pinHash||null);
 const item={id,name:String(q.name||q.title||cfg.name),cat:String(q.cat||cfg.cat),sub:String(q.sub||cfg.sub),lesson:String(q.lesson||cfg.lesson),q:q.q.trim(),e:String(q.e||''),locked:!!pinHash&&(cfg.forceLock||!!q.locked),pinHash};
 if(q.t==='text'||Array.isArray(q.ans)){
  item.t='text';item.ans=(q.ans||[]).map(x=>String(x).trim()).filter(Boolean);
  if(!item.ans.length)return null;
 }else{
  item.o=Array.isArray(q.o)?q.o.map(x=>String(x).trim()).filter(Boolean):[];item.a=Number.isInteger(q.a)?q.a:Number(q.a);
  if(item.o.length<2||!Number.isInteger(item.a)||item.a<0||item.a>=item.o.length)return null;
 }
 if(!item.e)item.e=item.t==='text'?'Answer: '+item.ans[0]:'Correct answer: '+item.o[item.a];
 return item;
}
async function runPool(size,count,job){let next=0;const worker=async()=>{while(!bulkStop&&next<count)await job(next++)};await Promise.all(Array.from({length:Math.min(size,count)},worker))}
function bulkAddQuestions(btn){return withBusy(btn,runBulkImport)}
async function runBulkImport(){
 const raw=qs('bulkJson').value.trim();if(!raw)return fail('Paste a JSON array first.');
 let arr;try{arr=JSON.parse(raw)}catch(e){return fail('Invalid JSON: '+e.message)}
 if(arr&&!Array.isArray(arr)&&Array.isArray(arr.questions))arr=arr.questions;
 if(!Array.isArray(arr)||!arr.length)return fail('Bulk data must be a non-empty array.');
 const cfg=await bulkSettings();if(cfg.error)return fail(cfg.error);
 const db=DB(),useDb=!!(db&&db.enabled);
 bulkStop=false;
 const stat={label:'Checking questions…',done:0,total:arr.length,added:0,dupes:0,bad:0,finished:false};
 bulkProgress(stat);await frame();

 // 1) validate and drop duplicates inside the file
 const seen=new Set(custom.map(questionDuplicateKey).filter(Boolean)),base=nextCustomId(),queue=[];
 arr.forEach(r=>{
  const item=bulkItem(r,cfg,base+queue.length);
  if(!item){stat.bad++;return}
  const key=normalizeQuestionText(item.q);
  if(!key||seen.has(key)){stat.dupes++;return}
  seen.add(key);queue.push(item);
 });

 let added=[],firstError='';
 if(useDb){
  // 2) ask the database which of them already exist, then insert the rest 100 questions per request (no size limit)
  stat.label='Checking the database for duplicates…';bulkProgress(stat);await frame();
  let have;try{have=await db.existingKeys(queue.map(i=>normalizeQuestionText(i.q)))}catch(e){console.error(e);return dbFailure(e,'check')}
  const fresh=queue.filter(i=>{if(have.has(normalizeQuestionText(i.q))){stat.dupes++;return false}return true});
  stat.total=fresh.length;stat.done=0;stat.label='Saving to the database…';bulkProgress(stat);await frame();
  let lastPaint=0;
  const res=await db.saveMany(fresh,{skipDuplicateCheck:true,shouldStop:()=>bulkStop,
   onProgress:p=>{stat.done=p.done;stat.added=p.saved;if(performance.now()-lastPaint>80){lastPaint=performance.now();bulkProgress(stat)}}});
  res.saved.forEach(x=>Object.assign(x.item,{id:-Math.abs(x.dbId),dbId:x.dbId,source:'supabase'}));
  added=res.saved.map(x=>x.item);stat.bad+=res.failed;
  if(res.error)firstError=res.error.message||String(res.error);
 }else{
  stat.total=queue.length;stat.label='Adding questions…';bulkProgress(stat);
  queue.forEach(i=>custom.push(i));added=queue;stat.done=queue.length;
 }
 const stopped=bulkStop;
 stat.added=added.length;stat.finished=true;stat.label=stopped?'Stopped':'Finished';bulkProgress(stat);
 if(added.length)syncCatalog();

 // 3) summary
 qs('bulkStatus').textContent=`✅ Added ${added.length.toLocaleString()} · ♻ ${stat.dupes.toLocaleString()} duplicate${stat.dupes===1?'':'s'} skipped · ⚠ ${stat.bad.toLocaleString()} invalid/failed${stopped?' · stopped early':''}`;

 alertCard({kind:added.length?'success':'warn',title:stopped?'Import stopped':added.length?'Import complete':'Nothing was imported',msg:`${cfg.cat} › ${cfg.sub} › ${cfg.lesson}`,
  html:`<div class="acstats"><div class="s-ok"><b>${added.length.toLocaleString()}</b><span>Added</span></div><div class="s-dup"><b>${stat.dupes.toLocaleString()}</b><span>Duplicates</span></div><div class="s-bad"><b>${stat.bad.toLocaleString()}</b><span>Invalid / failed</span></div></div>${firstError?`<p class="acm">First error: ${esc(firstError)}</p>`:''}`,ok:'Done'});
 return added.length>0;
}

/* --- My Questions: filters, 20 per page --- */
function mqFillFilters(){
 const fill=(id,label,rows,cur)=>{const el=qs(id);el.innerHTML=`<option value="">${label}</option>`+rows.map(([k,n])=>`<option value="${esc(k)}">${esc(k)} (${n.toLocaleString()})</option>`).join('');el.value=rows.some(r=>r[0]===cur)?cur:'';return el.value};
 mq.cat=fill('mqCat','All categories',CAT.map(c=>[c.c,catTotal(c.c)]),mq.cat);
 const c=CAT.find(x=>x.c===mq.cat);
 mq.sub=fill('mqSub','All sub-categories',c?c.subs.map(s=>[s.n,s.total]):[],mq.sub);
 const s=c&&c.subs.find(x=>x.n===mq.sub);
 mq.lesson=fill('mqLes','All lessons',s?s.lessons.map(l=>[l.name,l.total]):[],mq.lesson);
 qs('mqKind').value=mq.kind;
}
function mqMatches(x,dups){
 if(mq.cat&&qCat(x)!==mq.cat)return false;
 if(mq.sub&&qSub(x)!==mq.sub)return false;
 if(mq.lesson&&(x.lesson||'General')!==mq.lesson)return false;
 if(mq.kind==='duplicates'&&!(isDup(x,dups)))return false;
 if(mq.kind==='locked'&&!x.locked)return false;
 if(mq.kind==='unlocked'&&x.locked)return false;
 if(mq.kind==='database'&&x.source!=='supabase')return false;
 if(mq.kind==='local'&&x.source==='supabase')return false;
 return !mq.text||[x.name,x.q,x.e].join(' ').toLowerCase().includes(mq.text);
}
function mqCard(x,dups){
 const id=esc(String(x.id)),btn=(act,cls,label)=>`<button type="button" class="btn ${cls}" data-act="${act}" data-id="${id}" onclick="mqAct(this)">${label}</button>`;
 return `<div class="mine"><div><span class="badge">${isText(x)?'Short answer':'MCQ'}</span> <span class="badge">${esc(qCat(x))}</span> <span class="badge">${esc(qSub(x))}</span> <span class="badge">${esc(x.lesson||'General')}</span>${x.locked?'<span class="badge lockbadge">🔒 Locked</span>':''}${isDup(x,dups)?'<span class="badge">♻ Duplicate</span>':''}<div class="qt">${x.name?`<b>${esc(x.name)}</b><br>`:''}${esc(x.q)}</div><div class="correct" style="font-size:14px">${rightText(x)}</div></div><div class="mineactions">${x.locked?btn('unlock','','🔓 Unlock'):btn('edit','','✏️ Edit')+btn('del','danger','Delete')}</div></div>`;
}
function mqAct(btn){const{act,id}=btn.dataset;if(act==='edit')startEditMine(id);else if(act==='del')deleteMine(id,btn);else if(act==='unlock')unlockMine(id,btn)}
function mqPager(pages){
 const el=qs('mqPager');if(pages<=1){el.innerHTML='';return}
 const p=mq.page,nums=[...new Set([1,p-1,p,p+1,pages])].filter(n=>n>=1&&n<=pages).sort((a,b)=>a-b);
 let html=`<button type="button" class="btn" ${p<=1?'disabled':''} onclick="mqGo(${p-1})">‹ Prev</button>`,last=0;
 nums.forEach(n=>{if(n-last>1)html+='<span class="gap">…</span>';html+=`<button type="button" class="btn${n===p?' on':''}" onclick="mqGo(${n})">${n}</button>`;last=n});
 el.innerHTML=html+`<button type="button" class="btn" ${p>=pages?'disabled':''} onclick="mqGo(${p+1})">Next ›</button>`;
}
async function renderMyQuestions(){
 const seq=++mqSeq,box=qs('myList'),info=qs('mqInfo'),dups=duplicateCounts(),useDb=!!(DB()&&DB().enabled)&&mq.kind!=='local';
 mqFillFilters();
 const local=mq.kind==='database'?[]:custom.filter(x=>mqMatches(x,dups)).reverse();   // saved only on this device, newest first
 let rows=[],dbTotal=0;
 if(useDb){
  if(!mqRows.length)box.innerHTML='<div class="empty">Loading…</div>';
  try{
   const r=await DB().list({cat:mq.cat,sub:mq.sub,lesson:mq.lesson,kind:mq.kind,text:mq.text,page:mq.page,pageSize:MQ_PAGE_SIZE});
   if(seq!==mqSeq)return;
   rows=r.rows;dbTotal=r.total;mqDupIds=new Set(r.dupIds||[]);
   const dbPages=Math.max(1,Math.ceil(dbTotal/MQ_PAGE_SIZE));
   if(!rows.length&&dbTotal&&mq.page>dbPages){mq.page=dbPages;return renderMyQuestions()}    // the last page became empty
  }catch(err){
   if(seq!==mqSeq)return;console.error(err);mqRows=[];
   box.innerHTML='<div class="empty">Could not load questions from the database. Check your connection and that schema.sql was run in Supabase.</div>';info.textContent='';mqPager(1);return;
  }
 }
 mqRows=rows;
 const total=(useDb?dbTotal:0)+local.length,pages=Math.max(1,Math.ceil((useDb?dbTotal:local.length)/MQ_PAGE_SIZE));
 mq.page=Math.min(Math.max(1,mq.page),pages);
 const from=(mq.page-1)*MQ_PAGE_SIZE,items=useDb?(mq.page===1?local:[]).concat(rows):local.slice(from,from+MQ_PAGE_SIZE);
 qs('myCount').textContent=totalQ().toLocaleString();
 box.innerHTML=items.map(x=>mqCard(x,dups)).join('')||'<div class="empty">No questions match these filters.</div>';
 info.textContent=total?`${total.toLocaleString()} question${total===1?'':'s'} · page ${mq.page} of ${pages.toLocaleString()}${useDb&&local.length?` · ${local.length} saved on this device only`:''}`:'';
 qs('mqDupBtn').disabled=false;
 mqPager(pages);
}
function mqSet(key,val){mq[key]=val;if(key==='cat'){mq.sub='';mq.lesson=''}else if(key==='sub')mq.lesson='';mq.page=1;renderMyQuestions()}
let mqTimer=0;
function mqSearch(v){clearTimeout(mqTimer);mqTimer=setTimeout(()=>{mq.text=v.trim().toLowerCase();mq.page=1;renderMyQuestions()},180)}
function mqReset(){Object.assign(mq,{page:1,cat:'',sub:'',lesson:'',kind:'all',text:''});qs('mqSearch').value='';renderMyQuestions()}
function mqGo(p){mq.page=p;renderMyQuestions();qs('myList').scrollIntoView({behavior:'smooth',block:'start'})}
function renderManage(){refreshLists();nqToggle();renderMyQuestions()}

/* --- database questions: supabase.js loads them, this applies them to the app --- */
let dbToastDone=false;
function applyDatabaseQuestions(e){
 const db=DB();if(!db||!db.ready)return;
 AI_E=null;syncCatalog();updateDbBanner();
 if(!dbToastDone&&!(e&&e.detail&&e.detail.cached)){dbToastDone=true;toast('☁️ '+totalQ().toLocaleString()+' questions ready')}
}
Promise.resolve().then(()=>{                                 // wait until the whole script has run
 window.addEventListener('mcqdb:ready',applyDatabaseQuestions);
 window.addEventListener('mcqdb:error',()=>{updateDbBanner();if(!(DB()&&DB().ready))toast('Cannot reach the database. Check your internet connection and try again.',5000)});
 updateDbBanner();
 if(DB()&&DB().ready)applyDatabaseQuestions({detail:{cached:DB().fromCache}});
 else if(DB()&&DB().enabled)toast('☁️ Loading questions from the database…',6000);
});

function esc(v){return String(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))}

/* ---------- Daily 50 ---------- */
const DAILY_KEY='mcq_daily_v2',DAILY_SIZE=50;
let daily=get(DAILY_KEY,null);
function todayStr(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function hashStr(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}
function rng(seed){return function(){seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function seededShuffle(a,r){a=[...a];for(let i=a.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
async function buildDaily(date){
 const r=rng(hashStr(date)),groups=[],used=new Map(),picks=[];
 CAT.forEach(c=>c.subs.forEach(s=>{if(s.total)groups.push(s)}));
 // Round-robin over sub-categories: one question from each first, then a second, and so on.
 for(let round=0;picks.length<DAILY_SIZE;round++){
  const active=groups.filter(g=>g.total>round);
  if(!active.length)break;
  for(const g of seededShuffle(active,r)){
   if(picks.length>=DAILY_SIZE)break;
   let u=used.get(g);if(!u){u=new Set();used.set(g,u)}
   let p;do{p=Math.floor(r()*g.total)}while(u.has(p));u.add(p);
   if(p>=g.base){picks.push({q:g.custom[p-g.base]});continue}
   for(const x of g.shards){if(p<x.c){picks.push({k:x.k,i:p});break}p-=x.c}
  }
 }
 const keys=[...new Set(picks.filter(x=>x.k).map(x=>x.k))],data={};
 await Promise.all(keys.map(async k=>{data[k]=await loadShard(k)}));
 return seededShuffle(picks.map(x=>x.q||(data[x.k]&&data[x.k][x.i])).filter(Boolean),r);
}
let dailyBusy=null;
function prepareDaily(){
 const t=todayStr();
 if(daily&&daily.date===t&&Array.isArray(daily.qs)){if(!daily.answers)daily.answers={};return Promise.resolve()}
 if(dailyBusy)return dailyBusy;
 return dailyBusy=buildDaily(t).then(list=>{daily={date:t,qs:list,ids:list.map(q=>q.id),answers:{},submitted:false,result:null};put(DAILY_KEY,daily)}).finally(()=>{dailyBusy=null});
}
function ensureDaily(){if(daily&&!daily.answers)daily.answers={}}
function dailyItems(){return daily&&Array.isArray(daily.qs)?daily.qs:[]}
function dailyCard(q,idx){
 const sel=daily.answers[q.id],sub=daily.submitted;
 const locked=!sub&&isText(q)&&daily.checked&&daily.checked[q.id];
 const ui=answerUI(q,'d',{sel,dis:sub||locked,mc:j=>`dailySelect(${q.id},${j})`,tx:`dailyText(${q.id},this.value)`,cls:j=>sub?(j===q.a?' ok':(j===sel?' no':'')):''});
 let result='';
 if(sub){
  const skipped=isSkip(q,sel),ok=isRight(q,sel);
  result=(ok?`<div class="correct" style="margin-top:10px">✅ Correct!</div>`
   :skipped?`<div class="muted" style="margin-top:10px">⏭ Skipped. Correct answer: ${rightText(q)}</div>`
   :`<div class="bad" style="margin-top:10px">❌ Wrong. Correct answer: ${rightText(q)}</div>`)
   +`<div class="explain"><b>Explanation:</b> ${esc(q.e)}</div>`;
 }
 return `<div class="card" id="dq_${q.id}" style="margin-bottom:12px">
  <div class="dtag"><span class="badge">#${idx+1}</span><span class="badge">${esc(q.cat)}</span><span class="badge">${esc(q.sub)}</span>${isText(q)?'<span class="badge">Short answer</span>':''}</div>
  <div class="qtext" style="margin-top:4px">${esc(q.q)}</div>
  ${mkBar(q)}
  ${ui}
  ${!sub&&isText(q)?(locked?feedbackHTML(q,sel):`<button class="btn good" style="margin-top:10px" onclick="dailyCheck(${q.id})">Submit answer</button>`):''}<div class="qairow"><button type="button" class="btn" onclick="aiAskSame(${q.id})">🤖 Ask AI about this question</button><span class="muted">AI uses your bank question first</span></div>${!sub?`<div class="dailyNextInline"><button type="button" class="btn primary" onclick="dailyPrimary()">${idx>=dailyItems().length-1?'Submit Daily Questions →':'Next question ↓'}</button></div>`:''}
  ${result}
 </div>`;
}
function dailySelect(id,j){ensureDaily();if(daily.submitted)return;daily.answers[id]=j;put(DAILY_KEY,daily);updateDailyStats()}
function dailyCheck(id){
 ensureDaily();if(daily.submitted)return;
 if(daily.answers[id]==null)return toast('Type your answer first.');
 daily.checked=daily.checked||{};daily.checked[id]=true;put(DAILY_KEY,daily);
 const items=dailyItems(),i=items.findIndex(x=>x.id===id);
 if(i>=0)qs('dq_'+id).outerHTML=dailyCard(items[i],i);
}
function dailyText(id,v){ensureDaily();if(daily.submitted)return;if(daily.checked&&daily.checked[id])return;v=v.trim();if(v==='')delete daily.answers[id];else daily.answers[id]=v;put(DAILY_KEY,daily);updateDailyStats()}
const DAILY_SEC=60;
function dailyPos(){const n=dailyItems().length;return Math.max(0,Math.min(n-1,+daily.pos||0))}
// shows ONE question with an automatic 60 s timer (after submitting, all questions are shown for review)
function dailyStep(){
 ensureDaily();const items=dailyItems(),n=items.length,row=qs('dailyTimerRow');
 if(!n){qs('dailyList').innerHTML='<div class="card empty">No questions available.</div>';return}
 if(daily.submitted){stopTimer();row.style.display='none';qs('dailyList').innerHTML=items.map((q,i)=>dailyCard(q,i)).join('');return}
 row.style.display='flex';
 const i=dailyPos();daily.pos=i;
 qs('dailyList').innerHTML=dailyCard(items[i],i);
 startTimer('dailyTimer',Date.now()+(daily.left>0?daily.left:DAILY_SEC*1000),()=>{toast("⏰ Time's up for this question");dailyNext(true)});
 const t=qs('dt_'+items[i].id);if(t&&!t.disabled)setTimeout(()=>t.focus(),50);
}
function dailyNext(auto){
 ensureDaily();if(daily.submitted)return;stopTimer();
 const n=dailyItems().length,i=dailyPos();
 if(i>=n-1){dailySubmit(true);return}
 daily.pos=i+1;daily.left=DAILY_SEC*1000;put(DAILY_KEY,daily);
 dailyStep();updateDailyStats();requestAnimationFrame(()=>{const nq=dailyItems()[dailyPos()];const el=nq&&qs('dq_'+nq.id);if(el)el.scrollIntoView({behavior:'smooth',block:'start'});});
}
function dailyPrimary(){ensureDaily();if(daily.submitted)return;if(dailyPos()>=dailyItems().length-1)dailySubmit();else dailyNext()}
function updateDailyStats(){
 const items=dailyItems(),n=items.length,answered=items.filter(q=>daily.answers[q.id]!=null).length;
 if(daily.submitted&&daily.result)qs('dailyStats').textContent=`Score ${daily.result.correct} / ${daily.result.total} (${daily.result.percent}%)`;
 else qs('dailyStats').textContent=`Question ${dailyPos()+1} / ${n} • ${answered} answered`;
 qs('dailyBar').style.width=(n?answered/n*100:0)+'%';
 qs('dailySubmitInfo').textContent=`${answered} / ${n} answered`;
 qs('dailySubmitBar').style.display='none';
 const subs=new Set(items.map(q=>q.cat+'||'+q.sub)).size;
 qs('dailyInfo').textContent=`${daily.date} • ${n} questions from ${subs} sub-categories`;
 updateBadges();
}
function renderDailyResult(){
 const box=qs('dailyResult');
 if(!daily.submitted||!daily.result){box.innerHTML='';return}
 const r=daily.result,deg=Math.max(0,Math.min(360,r.percent*3.6));
 box.innerHTML=`<div class="card" style="margin-bottom:14px;text-align:center">
  <div class="ring" style="background:conic-gradient(#7181ff 0deg,#8b5cf6 ${deg}deg,#263858 ${deg}deg)"><div class="ringin">${r.percent}%</div></div>
  <h2>Today's Score</h2>
  <div class="stats">
   <div class="card"><div class="muted">Correct</div><b>${r.correct}</b></div>
   <div class="card"><div class="muted">Wrong</div><b>${r.wrong}</b></div>
   <div class="card"><div class="muted">Skipped</div><b>${r.skip}</b></div>
   <div class="card"><div class="muted">Score</div><b>${r.correct} / ${r.total}</b></div>
  </div>
  <p class="muted">${r.wrong?`${r.wrong} wrong question${r.wrong>1?'s were':' was'} added to More Practice.`:'No wrong answers today. Great job!'}${r.skip?` ${r.skip} skipped question${r.skip>1?'s were':' was'} added to More Practice › Skipped.`:''} Scroll down to review all answers.</p>
  <button class="btn good" onclick="show('practice')">Go to More Practice</button>
 </div>`;
}
async function renderDaily(){
 if(!(daily&&daily.date===todayStr()&&Array.isArray(daily.qs)))qs('dailyList').innerHTML='<div class="card empty">Loading today\'s questions…</div>';
 try{await prepareDaily()}catch(e){qs('dailyList').innerHTML='<div class="card empty">Could not load today\'s questions. Check your connection, then open this page again.</div>';return}
 if(!qs('daily').classList.contains('active'))return;
 dailyStep();
 renderDailyResult();
 updateDailyStats();
}
function dailySubmit(force){
 ensureDaily();if(daily.submitted)return;stopTimer();
 const items=dailyItems(),n=items.length;
 if(!n)return toast('No questions available.');
 const unanswered=items.filter(q=>daily.answers[q.id]==null).length;
 if(unanswered&&force!==true&&!confirm(`${unanswered} question${unanswered>1?'s are':' is'} unanswered. Submit anyway?`))return;
 let correct=0,wrongN=0,skip=0;
 items.forEach(q=>{
  const a=daily.answers[q.id];
  if(isSkip(q,a)){skip++;addSkip(q)}
  else if(isRight(q,a)){correct++;dropSkip(q.id);if(wrong[q.id])delete wrong[q.id];if(need10[q.id])bumpN10(q.id)}
  else{wrongN++;dropSkip(q.id);addWrong(q)}
 });
 saveWrong();
 daily.submitted=true;daily.left=0;
 daily.result={correct,wrong:wrongN,skip,total:n,percent:Math.round(correct/n*100)};
 put(DAILY_KEY,daily);
 const dh={ts:Date.now(),date:new Date().toLocaleString(),cat:'Daily 50',sub:daily.date,total:n,correct,wrong:wrongN,skip,score:correct,percent:+(correct/n*100).toFixed(1)};
 history.unshift(dh);
 history=history.slice(0,100);put(KEY.hist,history);
 if(window.MQ)MQ.onResult(dh);
 renderDaily();window.scrollTo(0,0);
}

/* ---------- Search ---------- */
// Looks through every question (question text, options, answer and explanation) in all categories.
// Result cards show question + answer + explanation. "Add to More Practice" puts the question into the
// More Practice > Searched tab, where only the question and its explanation are shown.
let srchBase=null,srchP=null,srchFail=[],srchLimit=20,srchTimer=null,srchSeq=0,srchSaveT;
function saveSrch(){updateBadges();clearTimeout(srchSaveT);srchSaveT=setTimeout(()=>put(SRCH_KEY,searched),50)}
function reEsc(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}
// escapes the text and wraps the searched words in <mark>
function hl(t,toks){
 t=String(t);if(!toks.length)return esc(t);
 const re=new RegExp('('+toks.map(reEsc).join('|')+')','giu');
 return t.split(re).map((p,i)=>i%2?`<mark>${esc(p)}</mark>`:esc(p)).join('');
}
function expText(q){return q.e||('Answer: '+(isText(q)?q.ans[0]:q.o[q.a]))}
function srchEntry(q){return{q,nq:norm(q.q),all:norm([q.q].concat(isText(q)?q.ans:q.o,[q.e||'']).join(' '))}}
// Search runs on the database (server side), so it works the same with 100 or 1,000,000 questions.
function srchEnsure(){return Promise.resolve()}
function searchInit(){
 const cv=qs('srchCat').value;
 qs('srchCat').innerHTML='<option value="">All categories</option>'+CAT.map(x=>`<option value="${esc(x.c)}">${esc(x.c)} (${catTotal(x.c).toLocaleString()})</option>`).join('');
 if(cv&&cats().includes(cv))qs('srchCat').value=cv;
 srchSubs(true);
 qs('srchInfo').textContent=totalQ().toLocaleString()+' questions ready to search';
 if(norm(qs('srchQ').value).length>=2)searchRun();
 setTimeout(()=>qs('srchQ').focus(),50);
}
function srchSubs(keep){
 const c=qs('srchCat').value,sel=qs('srchSub'),sv=keep?sel.value:'';
 sel.disabled=!c;
 sel.innerHTML=`<option value="">${c?'All sub-categories':'Choose a category first'}</option>`+(c?subsOf(c).map(x=>`<option value="${esc(x.n)}">${esc(x.n)} (${x.total.toLocaleString()})</option>`).join(''):'');
 if(sv&&[...sel.options].some(o=>o.value===sv))sel.value=sv;
 srSync();
}
function srSync(){catChips('srCatChips','srchCat','All');subChips('srSubChips','srchCat','srchSub','','All sub-categories')}
function srchCatChange(){srchSubs(false);srchLimit=20;searchRun()}
function searchDebounce(){{const b=document.querySelector('#search .sbar');if(b&&qs('srchQ').value.trim().length>=2)b.classList.add('busy')}clearTimeout(srchTimer);srchTimer=setTimeout(()=>{srchLimit=20;searchRun()},250)}
function searchClear(){qs('srchQ').value='';srchLimit=20;searchRun();qs('srchQ').focus()}
async function searchRun(){
 const nq=norm(qs('srchQ').value),seq=++srchSeq,list=qs('srchList'),info=qs('srchInfo'),sbar=document.querySelector('#search .sbar');
 if(sbar)sbar.classList.add('busy');
 try{await searchRun2(nq,seq,list,info)}finally{if(seq===srchSeq&&sbar)setTimeout(()=>sbar.classList.remove('busy'),220)}
}
let srchKey='';
async function searchRun2(nq,seq,list,info){
 qs('srchClear').style.display=qs('srchQ').value?'inline-block':'none';
 if(nq.length<2){
  list.innerHTML='<div class="card empty">🔍 Type at least 2 letters of a question, answer or explanation.<br><span class="muted">Bangla and English both work.</span></div>';
  info.textContent=totalQ().toLocaleString()+' questions ready to search';
  return;
 }
 const raw=qs('srchQ').value.trim(),cat=qs('srchCat').value,sub=qs('srchSub').value,toks=nq.split(' ').filter(Boolean),hits=[];
 info.textContent='Searching…';
 const score=e=>(e.nq.includes(nq)?3:0)+(toks.every(t=>e.nq.includes(t))?2:0);   // best first: whole phrase, then every word in the question
 if(DB()&&DB().enabled){
  let found;
  try{found=await DB().search(raw,{cat,sub})}
  catch(e){if(seq===srchSeq){info.textContent='';list.innerHTML='<div class="card empty">Could not search the database. Check your connection, then try again.</div>'}return}
  if(seq!==srchSeq||!qs('search').classList.contains('active'))return;
  found.forEach(q=>hits.push([score(srchEntry(q)),q]));
 }
 for(const e of custom.map(srchEntry)){                     // questions saved only on this device
  const q=e.q;
  if(cat&&qCat(q)!==cat)continue;
  if(sub&&qSub(q)!==sub)continue;
  if(!toks.every(t=>e.all.includes(t)))continue;
  hits.push([score(e),q]);
 }
 hits.sort((a,b)=>b[0]-a[0]);
 const n=hits.length,items=hits.slice(0,srchLimit);
 info.textContent=n?`${n.toLocaleString()} result${n>1?'s':''} found${n>items.length?` • showing ${items.length}`:''}`:'No results';
 if(!n){list.innerHTML='<div class="card empty">😕 No question matches “'+esc(raw)+'”.<br><span class="muted">Try fewer or different words, or choose “All categories”.</span></div>';return}
 {const key=nq+'|'+cat+'|'+sub;list.classList.toggle('noanim',key===srchKey);srchKey=key}
 list.innerHTML=items.map(([,q],i)=>srchCard(q,i,toks)).join('')+(n>items.length?`<div style="text-align:center;margin:14px 0"><button class="btn" onclick="srchLimit+=20;searchRun()">Show more (${(n-items.length).toLocaleString()} left)</button></div>`:'');
}
function srchCard(q,i,toks){
 reg(q);const on=!!searched[q.id];
 const body=isText(q)
  ?`<div class="rdans">✅ <b>Answer:</b> ${rightText(q)}</div>`
  :`<div class="opts">${q.o.map((x,j)=>`<div class="opt${j===q.a?' ok':''}"><span class="rdl">${'ABCDEFGH'[j]||(j+1)}</span><span class="otx">${hl(x,toks)}</span>${j===q.a?'<span class="rdtick">✓</span>':''}</div>`).join('')}</div>`;
 return `<article class="rcard" style="--i:${Math.min(i,12)}">
  <div class="rtop"><span class="rnum">${i+1}</span><span class="rtags"><span class="ptag">${esc(qCat(q))}</span><span class="ptag">${esc(qSub(q))}</span>${isText(q)?'<span class="ptag s">Short answer</span>':''}</span></div>
  <div class="rq">${hl(q.q,toks)}</div>
  ${body}
  ${q.e?`<div class="explain"><b>💡 Explanation</b><br>${hl(q.e,toks)}</div>`:''}
  <button type="button" class="addbtn${on?' on':''}" data-srch="${q.id}" onclick="toggleSrch(${q.id})">${on?'✓ Added to More Practice':'➕ Add to More Practice'}</button>
 </article>`;
}
function refreshSrchBtn(id){
 const on=!!searched[id];
 document.querySelectorAll(`[data-srch="${id}"]`).forEach(b=>{b.classList.toggle('on',on);b.textContent=on?'✓ Added to More Practice':'➕ Add to More Practice'});
}
function toggleSrch(id){
 const q=QREG[id];if(!q)return;
 if(searched[id]){delete searched[id];toast('Removed from More Practice')}
 else{searched[id]={id,q,addedAt:Date.now()};toast('🔍 Added to More Practice › Searched')}
 saveSrch();refreshSrchBtn(id);
}
// More Practice > Searched tab: only the question and its explanation
function srchPCard(q){
 return `<div class="pcard" style="--ac:${PACC.srch}">
  <div class="ptop2"><span class="pbadge">🔍 Searched</span><span class="ptag">${esc(qCat(q))}</span><span class="ptag">${esc(qSub(q))}</span>${isText(q)?'<span class="ptag s">Short answer</span>':''}</div>
  <div class="rq">${esc(q.q)}</div>
  <div class="explain"><b>💡 Explanation</b><br>${esc(expText(q))}</div>
  <button type="button" class="addbtn rm" onclick="removeSrch(${q.id})">🗑 Remove</button>
 </div>`;
}
function removeSrch(id){delete searched[id];saveSrch();renderPractice(true);toast('Removed')}


/* ---------- Home flow (mobile-app style): Subjects -> Sub-categories -> Setup card -> Exam ---------- */
const CAT_COLORS=[['#4f5bd5','#7c3aed'],['#0f766e','#10b981'],['#b45309','#f59e0b'],['#be123c','#f43f5e'],['#0369a1','#38bdf8'],['#6d28d9','#d946ef']];
let homeCat=null,homeSub='ALL';
function catIcon(n){
 n=String(n).toLowerCase();
 if(/bangla|বাংলা/.test(n))return'📖';
 if(/english|ইংরেজি/.test(n))return'🔤';
 if(/civil|engineer/.test(n))return'🏗️';
 if(/math|গণিত/.test(n))return'🧮';
 if(/science|বিজ্ঞান/.test(n))return'🔬';
 if(/ict|computer/.test(n))return'💻';
 if(/history|ইতিহাস/.test(n))return'🏛️';
 if(/^general/.test(n))return'🌍';
 if(/সাধারণ|জ্ঞান/.test(n))return'💡';
 return'📚';
}
function colorOf(i){const c=CAT_COLORS[i%CAT_COLORS.length];return `--c1:${c[0]};--c2:${c[1]}`}
function renderCatGrid(){
 const g=qs('catGrid');if(!g)return;
 g.innerHTML=CAT.length?CAT.map((x,i)=>{const ns=x.subs.length;
  return `<button type="button" class="catcard" style="${colorOf(i)}" onclick="openCat(${i})"><span class="cic">${catIcon(x.c)}</span><span><span class="cname">${esc(x.c)}</span><span class="cmeta">${ns} sub-categor${ns===1?'y':'ies'} • ${catTotal(x.c).toLocaleString()} questions</span></span></button>`;
 }).join(''):'<div class="card empty" style="grid-column:1/-1">No questions yet. Add some from “Add Question”.</div>';
}
function subRow(i,icon,name,meta,j,cls){
 return `<button type="button" class="subrow${cls||''}" style="${colorOf(i)}" onclick="openSetup(${j})"><span class="sic">${icon}</span><span class="stxt"><b>${esc(name)}</b><span class="muted">${meta}</span></span><span class="chev">›</span></button>`;
}
function openCat(i){
 const x=CAT[i];if(!x)return;homeCat=x.c;
 const tot=catTotal(x.c),nl=x.subs.reduce((a,s)=>a+s.lessons.length,0);
 const hero=qs('subHero');hero.style.cssText=colorOf(i);
 hero.innerHTML=`<span class="cic">${catIcon(x.c)}</span><div><h2 style="margin:0">${esc(x.c)}</h2><div class="muted">${x.subs.length} sub-categories • ${tot.toLocaleString()} questions</div></div>`;
 qs('subList').innerHTML=(x.subs.length>1?subRow(i,'🗂️','All sub-categories',`${tot.toLocaleString()} questions • ${nl} lessons`,-1,' all'):'')+
  x.subs.map((s,j)=>subRow(i,catIcon(x.c),s.n,`${s.total.toLocaleString()} questions • ${s.lessons.length} lesson${s.lessons.length===1?'':'s'}`,j)).join('');
 show('subs');
}
function openSetup(j){
 const i=CAT.findIndex(y=>y.c===homeCat),x=CAT[i];if(!x)return;
 const s=j<0?null:x.subs[j];homeSub=s?s.n:'ALL';
 qs('cat').value=x.c;loadSubs();qs('sub').value=homeSub;loadLessons();
 const tot=s?s.total:catTotal(x.c),nl=s?s.lessons.length:x.subs.reduce((a,y)=>a+y.lessons.length,0);
 const hero=qs('setHero');hero.style.cssText=colorOf(i);
 hero.innerHTML=`<span class="cic">${catIcon(x.c)}</span><div><div class="muted">${esc(x.c)}</div><h2 style="margin:0">${s?esc(s.n):'All sub-categories'}</h2><div class="muted">${tot.toLocaleString()} questions • ${nl} lesson${nl===1?'':'s'}</div></div>`;
 segPaintAll();timerUi(false);setupSummary();show('setup');
}

/* ---------- Mobile web app (PWA): install, online-only, bottom navigation ---------- */
let deferredInstall=null;
const INSTALL_KEY='mcq_install_dismissed_v1';
function isStandalone(){return (window.matchMedia&&matchMedia('(display-mode: standalone)').matches)||navigator.standalone===true}
function isIOS(){return /iphone|ipad|ipod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)}
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e;installUi()});
window.addEventListener('appinstalled',()=>{deferredInstall=null;installUi();toast('✅ App installed')});
function installUi(){
 const done=isStandalone(),can=!!deferredInstall&&!done,ios=isIOS()&&!done;
 qs('installCard').style.display=(!done&&!get(INSTALL_KEY,0)&&(can||ios))?'flex':'none';
 qs('installBtn').style.display=can?'inline-block':'none';
 qs('installTxt').textContent=can?'Add it to your home screen: it opens full-screen like a real app. An internet connection is required.':'On iPhone / iPad: tap the Share button, then “Add to Home Screen”.';
 qs('installBtnSheet').style.display=can?'block':'none';
 qs('iosHint').style.display=ios?'block':'none';
}
async function installApp(){
 if(!deferredInstall)return;
 deferredInstall.prompt();try{await deferredInstall.userChoice}catch(e){}
 deferredInstall=null;installUi();toggleMore(false);
}
function dismissInstall(){put(INSTALL_KEY,1);installUi()}
// bottom "More" sheet (mobile)
function toggleMore(force,noHist){
 const was=qs('moreSheet').style.display!=='none';
 const open=force!==undefined?force:!was;
 qs('moreSheet').style.display=open?'block':'none';qs('sheetBg').style.display=open?'block':'none';
 const b=document.querySelector('.bnbtn[data-view="more"]');if(b)b.setAttribute('aria-expanded',String(open));
 if(open&&!was&&!noHist&&!moreEntry){
  // give the sheet its own history entry so the phone Back button closes it first
  navIdx++;try{window.history.pushState({v:(window.history.state&&window.history.state.v)||'home',i:navIdx,more:1},'');moreEntry=true}catch(e){navIdx--}
 }else if(!open&&was&&moreEntry){
  moreEntry=false;
  if(!noHist){ignorePop++;navIdx--;try{window.history.back()}catch(e){ignorePop--}}
 }
}
document.addEventListener('keydown',e=>{if(e.key==='Escape')toggleMore(false)});
if(window.matchMedia)matchMedia('(max-width:820px)').addEventListener('change',()=>toggleMore(false));
// connection status: the app needs the internet, so tell the person clearly when it is gone
function netUi(){
 const off=!navigator.onLine;
 qs('netChip').style.display=off?'inline-block':'none';
 const b=qs('offBar');if(b)b.style.display=off?'flex':'none';
 document.body.classList.toggle('is-offline',off);
}
window.addEventListener('online',()=>{netUi();toast('✅ Back online')});
window.addEventListener('offline',()=>{netUi();toast('No internet connection. MCQ Master needs the internet to work.',4000)});
netUi();
// service worker (needs https or localhost) + "new version" bar
if('serviceWorker' in navigator&&(location.protocol==='https:'||location.hostname==='localhost'||location.hostname==='127.0.0.1')){
 const had=!!navigator.serviceWorker.controller;
 window.addEventListener('load',()=>{
  navigator.serviceWorker.register('sw.js').catch(()=>{});
  if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().catch(()=>{}); // keep progress from being auto-cleared
 });
 navigator.serviceWorker.addEventListener('controllerchange',()=>{if(had)qs('updBar').style.display='flex'});
}


/* =====================================================================
   Exam setup page helpers
   ===================================================================== */
function timerPaint(){
 const m=qs('timerMode').value,v=+qs('timerVal').value;
 qs('timerValLbl').textContent=m==='q'?'seconds per question':'minutes in total';
 const pre=m==='q'?[30,45,60,90,120]:[10,20,30,60,90];
 qs('timerPresets').innerHTML=pre.map(x=>chipBtn(x===v,'',`onclick="timerPreset(${x})"`,`<span>${m==='q'?x+'s':x+' min'}</span>`)).join('');
}
function timerPreset(x){qs('timerVal').value=x;timerPaint();setupSummary()}
function timerStep(d){
 const m=qs('timerMode').value,i=qs('timerVal');let v=Math.round(+i.value)||0;
 const st=m==='q'?((d>0?v>=60:v>60)?15:5):((d>0?v>=10:v>10)?5:1);
 const lo=m==='q'?5:1,hi=m==='q'?3600:600;
 i.value=Math.max(lo,Math.min(hi,v+d*st));timerPaint();setupSummary();
}
function fmtDur(sec){
 sec=Math.round(sec);if(sec<60)return sec+'s';
 const m=Math.floor(sec/60),s=sec%60;if(m<60)return m+(s?'m '+s+'s':' min');
 const h=Math.floor(m/60);return h+'h'+(m%60?' '+(m%60)+'m':'');
}
// the four tiles at the top of the setup page follow every choice
function setupSummary(){
 if(!qs('tkQ'))return;
 const list=allLessons(qs('cat').value,qs('sub').value),ch=[...document.querySelectorAll('.lchk')];
 const avail=ch.filter(e=>e.checked).reduce((a,e)=>a+(list[+e.value]?list[+e.value].l.total:0),0);
 let n=+qs('count').value||10;if(avail)n=Math.min(n,avail);
 const m=qs('timerMode').value,v=+qs('timerVal').value||0,ng=+qs('negative').value;
 qs('tkQ').textContent=n.toLocaleString();
 qs('tkM').textContent=n.toLocaleString();
 qs('tkN').textContent=ng?'−'+ng.toFixed(2):'None';
 if(m==='off'){qs('tkT').textContent='No limit';qs('tkTl').textContent='Timer'}
 else if(m==='q'){qs('tkT').textContent=fmtDur(n*v);qs('tkTl').textContent=v+'s each'}
 else{qs('tkT').textContent=fmtDur(v*60);qs('tkTl').textContent='Whole exam'}
}
document.addEventListener('click',e=>{if(e.target.closest&&e.target.closest('#setup'))setTimeout(setupSummary,0)},true); // capture: the clicked button is re-rendered by the segmented control
document.addEventListener('input',e=>{if(e.target.closest&&e.target.closest('#setup'))setupSummary()});

/* =====================================================================
   Question Slider: one question at a time, automatic timer, answer + explanation
   ===================================================================== */
const SL_MAX=200;
let sl=null,slOn=false,slBusy=false;
function slView(){qs('slPicker').style.display=slOn?'none':'block';qs('slRun').style.display=slOn?'block':'none'}
function slInit(){
 const cv=qs('slCat').value;
 qs('slCat').innerHTML=CAT.map(x=>`<option value="${esc(x.c)}">${esc(x.c)} (${catTotal(x.c).toLocaleString()})</option>`).join('');
 if(cv&&cats().includes(cv))qs('slCat').value=cv;
 slSubs(true);slOn=false;slView();
}
function slSubs(keep){
 const c=qs('slCat').value,sv=keep?qs('slSub').value:'';
 qs('slSub').innerHTML='<option value="ALL">All sub-categories</option>'+subsOf(c).map(x=>`<option value="${esc(x.n)}">${esc(x.n)}</option>`).join('');
 if(sv&&[...qs('slSub').options].some(o=>o.value===sv))qs('slSub').value=sv;
 slSync();
}
function slCount(){const c=qs('slCat').value,s=qs('slSub').value;if(s==='ALL')return catTotal(c);const x=subsOf(c).find(y=>y.n===s);return x?x.total:0}
function slSync(){
 catChips('slCatChips','slCat','');
 subChips('slSubChips','slCat','slSub','ALL','All');
 const n=Math.min(slCount(),SL_MAX);
 qs('slStartBtn').textContent=n?`Start slider · ${n} question${n>1?'s':''} →`:'Start slider →';
 segPaintAll();
}
async function slStart(){
 if(slBusy)return;
 const c=qs('slCat').value,s=qs('slSub').value;if(!c)return toast('Choose a subject first.');
 slBusy=true;loadFail=new Set();toast('Loading questions…',15000);
 const ls=lessonsOf(c,s,null),all=[],keys=new Set(),add=q=>{const k=qkey(q);if(keys.has(k))return;keys.add(k);all.push(q)};
 try{
  const sh=ls.filter(l=>l.shard).map(l=>l.shard);
  for(let i=0;i<sh.length;i+=4)(await Promise.all(sh.slice(i,i+4).map(x=>loadLessonSafe(x)))).forEach(a=>a.forEach(add));
  ls.flatMap(l=>l.custom).forEach(add);
 }catch(e){slBusy=false;return toast('Could not load questions. Check your connection and try again.')}
 slBusy=false;hideToast();
 if(!all.length)return toast('No questions found for this selection.');
 slOpen((qs('slOrd').value==='random'?shuffle(all):all).slice(0,SL_MAX),c+' › '+(s==='ALL'?'All sub-categories':s));
 if(loadFail.size)toast('⚠ '+loadFail.size+' lesson(s) could not be loaded.',5000);
}
function slOpen(list,title){
 slStop();
 sl={list,i:0,title,sec:+qs('slSec').value||60,rev:qs('slRev').value||'half',left:0,paused:false,shown:false,last:Date.now(),h:null,done:false};
 slOn=true;slView();qs('slPlay').textContent='❚❚';slRender(1);
 sl.h=setInterval(slTick,100);window.scrollTo(0,0);
}
function slStop(){if(sl&&sl.h)clearInterval(sl.h);sl=null;slOn=false}
function slExit(){slStop();slView();window.scrollTo(0,0)}
function slRestart(){if(!sl)return;const L=sl.list,t=sl.title;slOpen(L,t)}
function slRender(dir){
 const q=sl.list[sl.i],n=sl.list.length;
 sl.left=sl.sec*1000;sl.shown=false;sl.last=Date.now();
 qs('slTitle').textContent=sl.title;qs('slInfo').textContent=`Question ${sl.i+1} of ${n}`;
 qs('slProg').style.width=((sl.i+1)/n*100)+'%';
 const opts=isText(q)
  ?'<button type="button" class="reveal" onclick="slReveal()">👁 Show answer</button>'
  :`<div class="opts">${q.o.map((x,j)=>`<div class="opt slopt" onclick="slReveal(${j})"><span class="rdl">${'ABCDEFGH'[j]||j+1}</span><span class="otx">${esc(x)}</span></div>`).join('')}</div>`;
 qs('slStage').innerHTML=`<article class="slcard ${dir<0?'in-p':'in-n'}" id="slCard"><div class="rtop"><span class="rnum">${sl.i+1}</span><span class="rtags"><span class="ptag">${esc(qCat(q))}</span><span class="ptag">${esc(qSub(q))}</span></span></div><div class="rq slq">${esc(q.q)}</div>${opts}<div id="slAns"></div>${mkBar(q)}</article>`;
 slPaint();
 if(sl.rev==='now')slReveal();
}
function slReveal(j){
 if(!sl||sl.shown||sl.done)return;
 const q=sl.list[sl.i],card=qs('slCard');if(!card)return;
 sl.shown=true;
 if(isText(q)){const b=card.querySelector('.reveal');if(b)b.remove()}
 else card.querySelectorAll('.slopt').forEach((o,k)=>{o.classList.toggle('ok',k===q.a);o.classList.toggle('no',j!=null&&k===j&&j!==q.a);o.onclick=null});
 qs('slAns').innerHTML=`<div class="rdans" style="margin-top:14px">✅ <b>Answer:</b> ${rightText(q)}</div>${q.e?`<div class="explain"><b>💡 Explanation</b><br>${esc(q.e)}</div>`:''}`;
}
function slPaint(){
 const ms=Math.max(0,sl.left);
 qs('slRing').style.strokeDashoffset=String(100*(1-ms/(sl.sec*1000)));
 qs('slSecs').textContent=Math.ceil(ms/1000);
 qs('slRingW').classList.toggle('warn',ms<=Math.min(10000,sl.sec*1000/3));
}
function slTick(){
 if(!sl||sl.paused||sl.done)return;
 const now=Date.now();sl.left-=Math.min(now-sl.last,500);sl.last=now;
 if(!sl.shown&&sl.rev==='half'&&sl.left<=sl.sec*500)slReveal();
 if(sl.left<=0){slGo(1);return}
 slPaint();
}
function slGo(d){
 if(!sl||sl.done)return;
 const ni=sl.i+d;if(ni<0)return;
 if(ni>=sl.list.length){slFinish();return}
 sl.i=ni;slRender(d);window.scrollTo(0,0);
}
function slPause(){
 if(!sl||sl.done)return;
 sl.paused=!sl.paused;sl.last=Date.now();qs('slPlay').textContent=sl.paused?'▶':'❚❚';
}
function slFinish(){
 sl.done=true;clearInterval(sl.h);
 qs('slStage').innerHTML=`<div class="emptystate"><div class="eic">🎉</div><b>Slider finished</b><span>You went through ${sl.list.length} question${sl.list.length>1?'s':''}.</span><div class="aiacts" style="justify-content:center"><button type="button" class="aiact p" onclick="slRestart()">↻ Play again</button><button type="button" class="aiact" onclick="slExit()">Choose another</button></div></div>`;
 qs('slInfo').textContent='Finished';qs('slSecs').textContent='✓';qs('slRing').style.strokeDashoffset='0';qs('slProg').style.width='100%';
}
{
 const st=qs('slStage');let x0=0,y0=0;
 st.addEventListener('touchstart',e=>{x0=e.touches[0].clientX;y0=e.touches[0].clientY},{passive:true});
 st.addEventListener('touchend',e=>{const t=e.changedTouches[0],dx=t.clientX-x0,dy=t.clientY-y0;if(Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.5)slGo(dx<0?1:-1)},{passive:true});
}
document.addEventListener('visibilitychange',()=>{if(sl)sl.last=Date.now()});
document.addEventListener('keydown',e=>{
 if(!sl||!qs('slider').classList.contains('active')||(e.target.closest&&e.target.closest('input,textarea')))return;
 if(e.key==='ArrowRight')slGo(1);else if(e.key==='ArrowLeft')slGo(-1);else if(e.key===' '){e.preventDefault();slPause()}
});

/* =====================================================================
   MCQ AI: reads the whole question bank, decides what you want, sorts, answers, quizzes.
   Reads your question bank. If a Google Gemini API key is saved it can also answer anything else.
   ===================================================================== */
const AI_CFG_KEY='mcq_ai_cfg_v1';
let aiCfg=get(AI_CFG_KEY,{});if(!aiCfg||typeof aiCfg!=='object'||Array.isArray(aiCfg))aiCfg={};
const AI={busy:false,started:false,mid:0,lists:{},hist:[]};
const AI_STOP=new Set(('the a an is are was were of in on at to for and or me my i you we it its be by as with from this that these those do does did can could would should please have has had give tell show find about what which who whom how when where why many much there their them some any all mcq mcqs question questions ' +
 'এর এই ওই একটি একটা হয় হলো হল জন্য থেকে সম্পর্কে প্রশ্ন প্রশ্নগুলো প্রশ্নের কোন কোনটি কোনটা কী কি আমাকে আমার আমি দাও দেখাও বলো বল ও এবং বা').split(' '));
const AI_CMD=new Set('sort group arrange order quiz test practice practise exam mock slide slideshow slider explain answer list collect search display top first latest alphabetical alphabetically weak wrong skipped important mistakes mistake meaning define definition কুইজ পরীক্ষা সাজাও তালিকা খুঁজ ব্যাখ্যা'.split(' '));
// English words people type for the Bangla sub-category names
const AI_ALIAS={synonym:'সমার্থক',synonyms:'সমার্থক',antonym:'বিপরীত',antonyms:'বিপরীত',opposite:'বিপরীত',opposites:'বিপরীত',idiom:'বাগধারা',idioms:'বাগধারা',sandhi:'সন্ধি',compound:'সমাস',case:'কারক',maths:'math',mathematics:'math','গণিত':'math',mensuration:'mensuration'};

function aiStem(t){
 if(/^[a-z]+$/.test(t))return t.length>4&&t.endsWith('s')?t.slice(0,-1):t;
 for(const s of ['গুলো','গুলি','ের','র','কে','তে','টি','টা','য়','ে'])if(t.endsWith(s)&&t.length-s.length>=2)return t.slice(0,-s.length);
 return t;
}
function aiHit(all,t){return all.includes(t)||all.includes(aiStem(t))}
function aiAns(q){return isText(q)?q.ans[0]:q.o[q.a]}
function aiMd(s){return esc(s).replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/\n/g,'<br>')}
// MCQ AI works on a balanced sample (up to 150 questions per sub-category, 6000 in total), loaded once from the database.
let AI_E=null,AI_P=null;
function aiIndex(){
 const all=()=>AI_E.concat(custom.map(srchEntry));
 if(AI_E)return Promise.resolve(all());
 if(!AI_P)AI_P=(async()=>{
  const out=[],keys=new Set(),PER_SUB=150,CAP=6000,subs=CAT.flatMap(c=>c.subs);
  const work=async s=>{for(let got=0,i=0,order=shuffle(s.shards);i<order.length&&got<PER_SUB&&out.length<CAP;i++){
   (await loadLessonSafe(order[i])).forEach(q=>{const h=qkey(q);if(keys.has(h))return;keys.add(h);out.push(srchEntry(q));got++});
  }};
  for(let i=0;i<subs.length;i+=4)await Promise.all(subs.slice(i,i+4).map(work));
  AI_E=out;
 })().finally(()=>{AI_P=null});
 return AI_P.then(all);
}

// safe calculator: only digits and + - * / ( ) . are ever evaluated
function aiCalc(raw){
 let s=raw.replace(/[০-৯]/g,d=>BN.indexOf(d)).toLowerCase().replace(/^\s*(what is|what's|calculate|compute|solve|find|কত|হিসাব করো)\s+/,'').replace(/[=?\s]+$/,'').trim();
 if(s.length>80)return null;
 const m=s.match(/^([\d.]+)\s*%\s*of\s*([\d.]+)$/);
 if(m){const v=(+m[1])*(+m[2])/100;return isFinite(v)?{expr:s,val:+v.toFixed(8)}:null}
 s=s.replace(/×/g,'*').replace(/÷/g,'/').replace(/\^/g,'**').replace(/(\d)\s*x\s*(\d)/g,'$1*$2');
 if(!/^[\d\s+\-*/().]+$/.test(s)||!/\d/.test(s)||!/[+*/]|\d\s*-\s*[\d(]/.test(s))return null;
 try{const v=Function('"use strict";return ('+s+')')();return typeof v==='number'&&isFinite(v)?{expr:raw.trim().replace(/[=?]+$/,''),val:+v.toFixed(8)}:null}catch(e){return null}
}
// ---- topic matching: everything comes from the database, so a new sub-category works with no code change ----
function aiLev(a,b,max){
 if(Math.abs(a.length-b.length)>max)return max+1;
 let p=[...Array(b.length+1).keys()];
 for(let i=1;i<=a.length;i++){const c=[i];let m=i;for(let j=1;j<=b.length;j++){const v=Math.min(p[j]+1,c[j-1]+1,p[j-1]+(a[i-1]===b[j-1]?0:1));c.push(v);if(v<m)m=v}if(m>max)return max+1;p=c}
 return p[b.length];
}
function aiTokEq(a,b){                                       // same word: plural / suffix / one-two typos ("surveing" = "surveying")
 if(a===b)return true;
 const x=aiStem(a),y=aiStem(b);
 if(x===y||(x.length>=4&&y.length>=4&&(x.startsWith(y)||y.startsWith(x))))return true;
 const k=x.length>=9?2:1;
 return /^[a-z]+$/.test(x)&&/^[a-z]+$/.test(y)&&Math.min(x.length,y.length)>=5&&aiLev(x,y,k)<=k;
}
function aiSig(name){return norm(name).split(' ').filter(t=>t.length>=2&&!AI_STOP.has(t)&&!/^\d+$/.test(t))}
function aiAllSubs(){const o=[];CAT.forEach(c=>c.subs.forEach(s=>o.push(s.n)));return o}
function aiRandSub(){const a=aiAllSubs();return a.length?a[Math.floor(Math.random()*a.length)]:'math'}
// finds the category / sub-category / lesson named in the message (typed words and their built-in aliases are both tried)
function aiTopic(toks,raw){
 let cat=null,sub=null,les=null;const used=new Set();
 const alts=[...new Set([...(toks||[]),...(raw||[])])],eq=t=>alts.some(w=>aiTokEq(w,t)),nq=' '+alts.join(' ')+' ';
 for(const c of CAT){const n=norm(c.c);if(n&&nq.includes(' '+n+' ')){cat=c.c;n.split(' ').forEach(t=>used.add(t));break}}
 if(!cat&&toks.includes('civil')){const c=CAT.find(x=>/civil/i.test(x.c));if(c){cat=c.c;used.add('civil')}}
 let best=null;
 const consider=(c,sb,names,lesson)=>{
  const st=[...new Set(names.flatMap(aiSig))];if(!st.length)return;
  const hit=st.filter(eq),ratio=hit.length/st.length;if(ratio<0.5)return;
  const rawHit=st.some(t=>(raw||[]).some(w=>aiTokEq(w,t))),sc=ratio+hit.length*0.01+(rawHit?0.1:0)+(lesson?-0.05:0);
  if(!best||sc>best.sc)best={c:c.c,n:sb.n,les:lesson?names[0]:null,sc,w:alts.filter(w=>st.some(t=>aiTokEq(w,t)))};
 };
 for(const c of CAT){
  if(cat&&c.c!==cat)continue;
  for(const sb of c.subs){consider(c,sb,[sb.n],false);(sb.lessons||[]).forEach(l=>consider(c,sb,[l.name],true))}
 }
 if(best){cat=best.c;sub=best.n;les=best.les;best.w.forEach(t=>used.add(t));(raw||[]).forEach(r=>{if(used.has(r))used.add(AI_ALIAS[r]||r)})}
 return{cat,sub,les,used};
}
// closest sub-categories to some words (for "did you mean" buttons)
function aiNear(words,k){
 const ws=(words||[]).filter(w=>w.length>=3&&!AI_STOP.has(w)),out=[];
 CAT.forEach(c=>c.subs.forEach(sb=>{
  const st=[...new Set([sb.n,c.c].concat((sb.lessons||[]).map(l=>l.name)).flatMap(aiSig))];let sc=0;
  ws.forEach(w=>st.forEach(t=>{if(aiTokEq(w,t))sc+=2;else if(t.length>=3&&(t.includes(w)||w.includes(t)))sc+=1;else if(/^[a-z]+$/.test(w)&&/^[a-z]+$/.test(t)&&w[0]===t[0]&&aiLev(w,t,3)<=3)sc+=0.5}));
  out.push({n:sb.n,sc});
 }));
 const r=out.filter(x=>x.sc>0).sort((a,b)=>b.sc-a.sc).slice(0,k);
 return r.length?r.map(x=>x.n):aiAllSubs().slice(0,k);
}
function aiSuggestHTML(words){
 const near=aiNear(words,6);if(!near.length)return '';
 return '<div class="flab" style="margin:10px 0 4px">Subjects in your bank</div><div class="aiacts">'+near.map(n=>`<button type="button" class="aiact p" data-v="${esc('Ask about '+n)}" onclick="aiAsk(this.dataset.v)">${esc(n)}</button>`).join('')+'<button type="button" class="aiact" data-v="list subjects" onclick="aiAsk(this.dataset.v)">All subjects</button></div>';
}
// the "decision": reads the message and picks what to do
function aiPlan(text){
 const raw=text.trim(),p={raw,intent:'answer',sort:'rel',n:null,cat:null,sub:null,toks:[]};
 const calc=aiCalc(raw);if(calc){p.intent='calc';p.calc=calc;return p}
 const rawW=norm(raw).split(' ').filter(Boolean),words=rawW.map(w=>AI_ALIAS[w]||w),nq=words.join(' ');
 p.nq=nq;p.words=words;
 const tp=aiTopic(words,rawW);p.cat=tp.cat;p.sub=tp.sub;
 const nm=nq.match(/(\d{1,3})\s*(?:questions?|qs?|mcqs?|টি|টা)/)||nq.match(/(?:top|first|next)\s+(\d{1,3})/);
 if(nm)p.n=Math.max(1,Math.min(200,+nm[1]));
 p.toks=words.filter(t=>!AI_STOP.has(t)&&!AI_CMD.has(t)&&!tp.used.has(t)&&!(nm&&t===nm[1])&&!/^[a-z]$/.test(t));
 if(/alphabet|a to z|a z|বর্ণানুক্রম/.test(nq))p.sort='az';
 else if(/weak|wrong|ভুল|দুর্বল/.test(nq))p.sort='weak';
 else if(/group|topic|by sub|বিষয়/.test(nq))p.sort='group';
 const my=/(^| )(my|mine)( |$)|আমার/.test(nq),verb=/(^| )(list|show|sort|display|find|collect|arrange)( |$)|দেখাও|তালিকা|সাজাও/.test(nq);
 if(/^(hi|hello|hey|hii|help|salam)( |$)|^(সালাম|হ্যালো|হাই|সাহায্য)|what can you do|who are you/.test(nq))p.intent='help';
 else if(/(how many|total|count|কতগুলো|কতটি|কয়টি|কত)/.test(nq)&&/(question|mcq|প্রশ্ন|categor|subject|sub)/.test(nq))p.intent='stats';
 else if(/slide|slideshow|autoplay|স্লাইড/.test(nq))p.intent='slide';
 else if(/quiz|test me|practice|practise|exam|mock|কুইজ|পরীক্ষা|প্র্যাকটিস|অনুশীলন/.test(nq))p.intent='quiz';
 else if((my||verb)&&/(wrong|mistake|weak|skipp|important|ভুল|দুর্বল|স্কিপ|গুরুত্বপূর্ণ)/.test(nq))p.intent='weak';
 else if(verb||/(^| )(all|sorted)( |$)/.test(nq)&&(p.cat||p.toks.length)){p.intent=(!p.toks.length&&!p.cat)?'queue':'list'}
 else if(!p.toks.length&&(p.cat||p.sub))p.intent='list';
 return p;
}
// relevance ranking over every question
function aiRank(E,p){
 const out=[];
 for(const e of E){
  const q=e.q;
  if(p.cat&&qCat(q)!==p.cat)continue;
  if(p.sub&&qSub(q)!==p.sub)continue;
  if(!p.toks.length){out.push({q,s:0,cov:1});continue}
  let m=0,mq=0;
  for(const t of p.toks)if(aiHit(e.all,t)){m++;if(aiHit(e.nq,t))mq++}
  if(!m)continue;
  const n=p.toks.length;
  out.push({q,cov:m/n,s:m/n*3+mq/n*2+(e.nq.includes(p.nq)?4:0)});
 }
 return out.sort((a,b)=>b.s-a.s);
}
function aiWeakList(p){
 const m=new Map();
 const add=(st,f,tag)=>Object.values(st).forEach(r=>{
  if(!r.q)return;const q=reg(r.q);
  if(p.cat&&qCat(q)!==p.cat)return;if(p.sub&&qSub(q)!==p.sub)return;
  const x=m.get(q.id)||{q,s:0,tags:[]};x.s+=f(r);x.tags.push(tag);m.set(q.id,x);
 });
 add(wrong,r=>3+(r.wrong||1),'wrong');add(skipQs,r=>2+(r.count||1),'skipped');add(need10,()=>2,'10× practice');add(important,()=>1,'important');
 return[...m.values()].sort((a,b)=>b.s-a.s);
}
function aiSortList(items,p){
 const a=items.slice();
 if(p.sort==='az')a.sort((x,y)=>x.q.q.localeCompare(y.q.q));
 else if(p.sort==='weak'){const w=new Map(aiWeakList({}).map(x=>[x.q.id,x.s]));a.sort((x,y)=>(w.get(y.q.id)||0)-(w.get(x.q.id)||0))}
 else if(p.sort==='group')a.sort((x,y)=>(qCat(x.q)+qSub(x.q)).localeCompare(qCat(y.q)+qSub(y.q)));
 return a;
}
const AI_SORTNAME={rel:'best match',az:'A → Z',weak:'what you got wrong most',group:'sub-category'};

/* ----- rendering ----- */
function aiScroll(){requestAnimationFrame(()=>window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'}))}
function aiPush(role,html){
 const d=document.createElement('div');d.className='aim '+role;
 d.innerHTML=role==='bot'?`<span class="aiav">✦</span><div class="aib">${html}</div>`:`<div class="aib">${html}</div>`;
 qs('aiChat').appendChild(d);aiScroll();return d;
}
function aiTyping(){return aiPush('bot','<span class="aidots"><i></i><i></i><i></i></span>')}
function aiCard(q){
 reg(q);
 const body=isText(q)?`<div class="rdans">✅ <b>Answer:</b> ${rightText(q)}</div>`
  :`<div class="opts">${q.o.map((x,j)=>`<div class="opt${j===q.a?' ok':''}"><span class="rdl">${'ABCDEFGH'[j]||j+1}</span><span class="otx">${esc(x)}</span>${j===q.a?'<span class="rdtick">✓</span>':''}</div>`).join('')}</div>`;
 return `<div class="aicard"><div class="rtags" style="margin-bottom:8px"><span class="ptag">${esc(qCat(q))}</span><span class="ptag">${esc(qSub(q))}</span></div><div class="rq">${esc(q.q)}</div>${body}${q.e?`<div class="explain"><b>💡 Explanation</b><br>${esc(q.e)}</div>`:''}${mkBar(q)}</div>`;
}
function aiItem(q,i,tags){
 reg(q);
 return `<details class="aiq"><summary><span class="aiqn">${i+1}</span><span class="aiqt">${esc(q.q)}<small>✓ ${esc(aiAns(q))}</small>${tags&&tags.length?`<span class="aitags">${tags.map(t=>`<span class="ptag s">${esc(t)}</span>`).join('')}</span>`:''}</span></summary><div class="aiqx">${q.e?`<div class="explain" style="margin-top:0"><b>💡 Explanation</b><br>${esc(q.e)}</div>`:''}${mkBar(q)}</div></details>`;
}
function aiListHTML(L,from,to){
 let out='',last='';
 L.qs.slice(from,to).forEach((q,k)=>{
  if(L.group){const g=qCat(q)+' › '+qSub(q);if(g!==last){out+=`<div class="aigh">${esc(g)}</div>`;last=g}}
  out+=aiItem(q,from+k,L.tags&&L.tags[q.id]);
 });
 return out;
}
const AI_PAGE=8;
// types the whole reply (text, question cards, lists) a few characters at a time
async function aiTypeIn(root){
 if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)return;
 const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.data.trim()?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT}),nodes=[];
 let nd;while(nd=w.nextNode())nodes.push({n:nd,t:nd.data});
 const total=nodes.reduce((a,x)=>a+x.t.length,0);if(!total)return;
 nodes.forEach(x=>{x.n.data=''});
 root.classList.add('typing');
 const tick=22,budget=Math.min(4200,Math.max(600,total*16)),step=Math.max(1,Math.ceil(total/(budget/tick)));
 let k=0;
 while(k<nodes.length){
  let left=step;
  while(left>0&&k<nodes.length){const x=nodes[k],cur=x.n.data.length,take=Math.min(left,x.t.length-cur);x.n.data=x.t.slice(0,cur+take);left-=take;if(cur+take>=x.t.length)k++}
  aiScroll();await new Promise(r=>setTimeout(r,tick));
 }
 root.classList.remove('typing');
}
async function aiReply(r){
 const d=aiPush('bot','<div class="ait"></div>'),t=d.querySelector('.ait'),body=d.querySelector('.aib');
 t.innerHTML=aiMd(r.lead||'');const plain=t.textContent;
 let extra=r.html||'';
 if(r.list&&r.list.qs.length){
  const id=++AI.mid,L=r.list;AI.lists[id]=L;L.shown=Math.min(AI_PAGE,L.qs.length);
  const n=L.qs.length;
  extra+=(L.noList?'':`<div class="ailist" id="ail_${id}">${aiListHTML(L,0,L.shown)}</div>`)+`<div class="aiacts" id="aia_${id}">`
   +(r.acts===false?'':`<button type="button" class="aiact p" onclick="aiPractice(${id})">▶ Practice ${Math.min(n,100)}</button><button type="button" class="aiact" onclick="aiSlide(${id})">🎞️ Slideshow</button>`)
   +(L.extraActs||'')
   +(!L.noList&&n>L.shown?`<button type="button" class="aiact" id="aim_${id}" onclick="aiMoreList(${id})">Show more · ${n-L.shown} left</button>`:'')+'</div>';
 }
 if(extra){const w=document.createElement('div');w.innerHTML=extra;body.appendChild(w)}
 AI.hist.push({role:'assistant',content:plain});
 aiScroll();
 await aiTypeIn(body);
 aiScroll();
}
function aiMoreList(id){
 const L=AI.lists[id];if(!L)return;
 const from=L.shown;L.shown=Math.min(L.qs.length,from+AI_PAGE);
 qs('ail_'+id).insertAdjacentHTML('beforeend',aiListHTML(L,from,L.shown));
 const b=qs('aim_'+id);if(b){if(L.shown>=L.qs.length)b.remove();else b.textContent='Show more · '+(L.qs.length-L.shown)+' left'}
}
function aiPractice(id){
 const L=AI.lists[id];if(!L)return;
 const list=shuffle(L.qs).slice(0,100);
 newSession(list,{ty:'all',n:list.length,les:null,order:'random',cat:'🤖 AI quiz',sub:L.title,special:'ai'},0,'off',0);
}
function aiSlide(id){
 const L=AI.lists[id];if(!L)return;
 const list=L.qs.slice(0,SL_MAX),t=L.title;
 show('slider');slOpen(list,t);
}

/* ----- brain ----- */
const AI_GEM_DEFAULT='gemini-3.8';
// asks Google which Flash models this key can use, newest first (cached for the session)
let aiGemCache=null;
async function aiGemList(){
 if(aiGemCache)return aiGemCache;
 const res=await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',{headers:{'x-goog-api-key':aiCfg.key}});
 if(!res.ok)return[];
 const j=await res.json(),ver=n=>parseFloat((n.match(/gemini-([\d.]+)/)||[0,0])[1]);
 const ok=(j.models||[]).filter(m=>(m.supportedGenerationMethods||[]).includes('generateContent')).map(m=>m.name.replace(/^models\//,'')).filter(n=>/^gemini-[\d.]+-flash(-lite)?(-latest)?$/.test(n));
 ok.sort((a,b)=>ver(b)-ver(a)||(a.includes('lite')?1:0)-(b.includes('lite')?1:0));
 return aiGemCache=ok;
}
const aiSleep=ms=>new Promise(r=>setTimeout(r,ms));
async function aiCloud(text,ctxQs){
 // Google Gemini (Generative Language API)
 const ctx=ctxQs.length?'Relevant questions from the student\'s question bank:\n'+ctxQs.map((q,i)=>`${i+1}. ${q.q} | Options: ${isText(q)?'(typed answer)':q.o.join(' / ')} | Correct: ${aiAns(q)} | Note: ${q.e||''}`).join('\n')+'\n\n':'';
 const sys='You are MCQ AI, a friendly study assistant inside an MCQ practice app for exam students. Answer clearly and briefly in the same language the student writes in (Bangla or English). Use the question-bank context when it is relevant and say which option is correct. If you are unsure, say so.';
 const turns=AI.hist.slice(-7,-1).map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:String(m.content||'')}]}));
 while(turns.length&&turns[0].role!=='user')turns.shift();
 const contents=[];
 for(const t of turns){const l=contents[contents.length-1];if(l&&l.role===t.role)l.parts[0].text+='\n'+t.parts[0].text;else contents.push(t)}
 if(contents.length&&contents[contents.length-1].role==='user')contents.pop();
 contents.push({role:'user',parts:[{text:ctx+text}]});
 const body=JSON.stringify({systemInstruction:{parts:[{text:sys}]},contents,generationConfig:{temperature:0.3}});
 const call=m=>fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(m)+':generateContent',{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':aiCfg.key},body});
 const typed=aiCfg.model&&/^gemini/i.test(aiCfg.model)?aiCfg.model.replace(/^models\//,''):'';
 let model=typed||aiCfg.auto||AI_GEM_DEFAULT,res=null,tried=new Set(),queue=[model];
 // 404 = model retired, 429/500/503 = busy. Retry the same model once, then try other Flash models.
 while(queue.length){
  model=queue.shift();if(tried.has(model))continue;tried.add(model);
  for(let k=0;k<2;k++){
   res=await call(model);
   if(res.ok||![429,500,503].includes(res.status))break;
   await aiSleep(1200*(k+1));
  }
  if(res.ok){if(!typed&&model!==(aiCfg.auto||AI_GEM_DEFAULT)){aiCfg.auto=model;put(AI_CFG_KEY,aiCfg)}break}
  if([404,429,500,503].includes(res.status)&&!queue.length){
   const more=(await aiGemList().catch(()=>[])).filter(m=>!tried.has(m)).slice(0,3);queue.push(...more);
  }
 }
 if(!res.ok){let m='';try{const e=await res.json();m=e.error&&e.error.message||''}catch(x){}throw new Error('Gemini returned '+res.status+(m?': '+m.slice(0,160):''))}
 const j=await res.json(),c=j.candidates&&j.candidates[0],out=c&&c.content&&c.content.parts&&c.content.parts.map(p=>p.text||'').join('').trim();
 if(!out)throw new Error(j.promptFeedback&&j.promptFeedback.blockReason?'blocked: '+j.promptFeedback.blockReason:'Empty reply');
 return out;
}
function aiScope(p){return p.sub?p.cat+' › '+p.sub:p.cat||'all subjects'}
async function aiHandle(p,E){
 const scope=aiScope(p);
 if(p.intent==='help')return{lead:"I'm MCQ AI. I read every question in your bank and decide what to do with your message. Try:",html:`<div class="aistat">${[
  ['Ask a question','“synonym of অগ্নি”, “sum of angles of a triangle”'],
  ['Find and sort','“show Algebra questions A to Z”'],
  ['Your weak spots','“sort my weak questions”'],
  ['Chat quiz','“start quiz”, “Ask question”, “Ask about math”, then A/B/C/D, hint, explain, skip, next, score, stop'],
  ['Question sets','“Next 10”, “Random 10”, “Mix 10”: numbered MCQs with an answer key'],
  ['All prompts','Say “commands” to see every prompt you can use'],
  ['Quiz or slideshow','“quiz me on Geometry”, “slideshow of Math”'],
  ['Count','“how many questions in English?”'],
  ['Calculate','“15% of 240”, “(12+8)*3”']].map(x=>`<div class="aisr"><b>${x[0]}</b><span>${esc(x[1])}</span></div>`).join('')}</div>`};
 if(p.intent==='calc')return{lead:`${p.calc.expr} = **${p.calc.val.toLocaleString('en-US',{maximumFractionDigits:8})}**`};
 if(p.intent==='stats'){
  const cs=CAT.filter(c=>!p.cat||c.c===p.cat);
  if(p.cat&&!p.sub){const c=cs[0];return{lead:`**${c.c}** has **${catTotal(c.c).toLocaleString()}** questions in ${c.subs.length} sub-categor${c.subs.length===1?'y':'ies'}.`,html:`<div class="aistat">${c.subs.map(s=>`<div class="aisr"><b>${esc(s.n)}</b><span>${s.total.toLocaleString()}</span></div>`).join('')}</div>`}}
  if(p.sub){const s=subsOf(p.cat).find(x=>x.n===p.sub);return{lead:`**${p.sub}** (${p.cat}) has **${s.total.toLocaleString()}** questions in ${s.lessons.length} lesson${s.lessons.length===1?'':'s'}.`}}
  return{lead:`Your bank has **${totalQ().toLocaleString()}** questions in ${CAT.length} subjects. You have taken ${history.length} exam${history.length===1?'':'s'}, and ${Object.keys(wrong).length} wrong and ${Object.keys(skipQs).length} skipped questions are waiting in More Practice.`,html:`<div class="aistat">${CAT.map(c=>`<div class="aisr"><b>${esc(c.c)}</b><span>${catTotal(c.c).toLocaleString()}</span></div>`).join('')}</div>`};
 }
 if(p.intent==='weak'||p.intent==='queue'){
  let items=aiWeakList(p),lead,tags={};
  items.forEach(x=>tags[x.q.id]=x.tags);
  let qsList=items.map(x=>x.q);
  if(!qsList.length&&p.intent==='weak')return{lead:`Nothing here yet${p.cat?' for '+scope:''}. Wrong, skipped, important and 10× questions appear after you take an exam. Want a quiz instead?`,html:'<div class="aiacts"><button type="button" class="aiact p" onclick="aiAsk(\'Quiz me on '+esc(p.cat||CAT[0]&&CAT[0].c||'')+'\')">Quiz me</button></div>'};
  if(p.intent==='queue'){
   const fresh=E.filter(e=>!isSeen(e.q)&&!tags[e.q.id]).map(e=>e.q);
   qsList=qsList.concat(shuffle(fresh).slice(0,Math.max(0,15-qsList.length)));
   lead=`I sorted your bank by what you need most: wrong first, then skipped, 10× and important, then questions you have not seen yet. Here are the top ${Math.min(qsList.length,p.n||qsList.length)}.`;
  }else lead=`You have **${qsList.length}** weak question${qsList.length>1?'s':''}${p.cat?' in '+scope:''}, sorted by how often you missed them.`;
  if(p.n)qsList=qsList.slice(0,p.n);
  return{lead,list:{qs:qsList,title:'Weak questions',tags}};
 }
 if(p.intent==='quiz'||p.intent==='slide'||p.intent==='list'){
  let hits=aiRank(E,p);
  if(!hits.length)return{lead:`I could not find questions${p.toks.length?' about “'+p.toks.join(' ')+'”':''} in ${scope}. Pick a subject below or try different words.`,html:aiSuggestHTML(p.words||p.toks)};
  let arr=aiSortList(hits,p.intent==='list'?p:{sort:'rel'}),qsList=arr.map(x=>x.q);
  const title=(p.toks.length?p.toks.join(' ')+' · ':'')+scope;
  if(p.intent==='quiz'){
   const n=Math.min(p.n||10,qsList.length);
   qsList=(p.toks.length?qsList.slice(0,Math.max(n*2,n)):qsList);qsList=shuffle(qsList).slice(0,n);
   return{lead:`Your quiz is ready: **${n}** question${n>1?'s':''} from ${title}. Start it as an exam, or watch them as a slideshow first.`,list:{qs:qsList,title},acts:true};
  }
  if(p.intent==='slide'){
   const qq=(p.n?qsList.slice(0,p.n):qsList);
   return{lead:`I picked **${qq.length}** question${qq.length>1?'s':''} from ${title} for a timed slideshow. Each one slides in, then shows its answer and explanation.`,list:{qs:qq,title}};
  }
  if(p.n)qsList=qsList.slice(0,p.n);
  return{lead:`I found **${qsList.length.toLocaleString()}** question${qsList.length>1?'s':''} in ${title}${p.toks.length||p.sort!=='rel'?'':', in bank order'}${p.sort!=='rel'?', sorted '+AI_SORTNAME[p.sort]:p.toks.length?', best match first':''}.`,list:{qs:qsList,title,group:p.sort==='group'}};
 }
 // answer
 const hits=aiRank(E,p),top=hits[0];
 const cloudy=aiCfg.key&&/(^| )(why|how|explain|difference|compare|example|define|meaning)( |$)|কেন|কীভাবে|ব্যাখ্যা|পার্থক্য/.test(p.nq);
 if(top&&top.cov>=0.7&&!(cloudy&&top.cov<1)){
  const q=top.q,rel=hits.slice(1).filter(x=>x.cov>=0.5&&x.s>=top.s*0.6&&x.q.id!==q.id).slice(0,3).map(x=>x.q);
  return{lead:`The answer is **${aiAns(q)}**.`+(q.e&&q.e.length<160?' '+q.e:''),html:aiCard(q),list:rel.length?{qs:rel,title:'Related'}:null,acts:false};
 }
 if(aiCfg.key){
  const ctx=hits.slice(0,6).map(x=>x.q);
  try{return{lead:await aiCloud(p.raw,ctx),html:'<div class="muted" style="font-size:11px;margin-top:8px">via Google Gemini</div>'}}
  catch(e){return{lead:/ 50[03] | 429 /.test(' '+e.message+' ')?'Gemini is busy right now (high demand). I tried other models too. Please send your question again in a minute.':'Gemini could not answer ('+e.message+'). Check your key and connection in ⚙ settings.'}}
 }
 if(top&&top.cov>=0.34)return{lead:'I could not find an exact match, but these are the closest questions in your bank:',list:{qs:hits.slice(0,5).map(x=>x.q),title:'Closest matches'},acts:false};
 return{lead:'I could not find that in your question bank. I only know what is in your MCQs, so try keywords from the question, or add a Gemini API key in ⚙ settings to answer anything.',html:aiSuggestHTML(p.words||p.toks)};
}

/* =====================================================================
   MCQ AI chat quiz: understands short commands in Bangla and English
   (start, next, hint, explain, skip, score, stop, easy, hard, A/B/C/D, "20 questions",
   subject names). State lives in AIQ; everything is read from the online database.
   ===================================================================== */
const AICTX={cat:null,sub:null,used:new Set()};
const AIB={last:null};
const AIQ={streak:0,best:0,t0:0,endless:false,on:false,qs:[],i:0,cur:null,answered:false,hints:0,right:[],wrong:[],skipped:[],cat:null,sub:null,diff:null,n:10,used:new Set(),last:null};
const AIQ_LET={a:0,b:1,c:2,d:3,e:4,'এ':0,'বি':1,'সি':2,'ডি':3,'1':0,'2':1,'3':2,'4':3,'5':4};
const AIQ_NOISE=new Set('my answer ans is i choose pick say option opt the correct উত্তর আমার সঠিক অপশন আমি বলছি হবে হলো হল এটাই'.split(' '));
const AIQ_FILL=new Set(('mcq mcqs question questions প্রশ্ন প্রশ্নগুলো quiz কুইজ test টেস্ট exam পরীক্ষা start begin শুরু কর করুন করো দাও দিন দেন দিতে চাই give me let s lets খেলি খেলবো চালু level লেভেল a the one টি টা আরও আরো more next পরের চলো চল play প্রশ্নটি ask about mix mixed random অবশ্যই ' +
 'easy সহজ সহজটা hard কঠিন কঠিনটা bangla বাংলা english ইংরেজি math গণিত gk জিকে').split(' '));
const AIQ_WORDNUM={'দশ':10,'বিশ':20,'ত্রিশ':30,'পঞ্চাশ':50,'একশ':100,'একশো':100};
const AIQ_SUBJ={bangla:/বাংলা|bangla|bengali/i,english:/ইংরেজি|english/i,math:/গণিত|math/i,gk:/সাধারণ|\bgk\b|general/i};
const AIQ_R={
 stop:/(^| )(stop|quit|exit|থামো|থামুন|থাম|বন্ধ|শেষ)( |$)|বের হব/,
 score:/(^| )(score|result|results|স্কোর|রেজাল্ট|ফলাফল)( |$)|কত পেয়েছি|কত নম্বর|আমার নম্বর/,
 hint:/hint|clue|হিন্ট|ইঙ্গিত|ক্লু|সাহায্য( কর| করুন)?( |$)/,
 explain:/(^| )(explain|explanation|why|ব্যাখ্যা|কেন|কারণ|সমাধান)( |$)|বুঝিয়ে|বুঝাও/,
 skip:/(^| )(skip|বাদ|স্কিপ|এড়িয়ে)( |$)|উত্তর দেব না|করতে চাই না/,
 next:/^(next|continue|go on|go next|another|more|নেক্সট|পরের|পরেরটা|পরেরটায়|পরেরটিতে|চালিয়ে|এগিয়ে|আরেকটা|আরেকটি|আরও|আরো|নতুন)( |$)|give me next|give another/,
 start:/(^| )(start|begin|restart|শুরু|খেলি|খেলবো|চালু)( |$)|(পরীক্ষা|টেস্ট|test|exam) (দাও|দিন|দিতে)|প্রশ্ন (দাও|দিন|দেন|করুন|করো|কর)( |$)|দিতে চাই/
};
function aiqLen(nq){return nq?nq.split(' ').length:0}
function aiqDScore(q,ws){return q.q.length*0.5+(isText(q)?q.ans.join('').length:q.o.join('').length*0.3)+(ws.has(q.id)?40:0)}
function aiqPick(pool,n,diff){
 pool=shuffle(pool);
 if(!diff)return pool.slice(0,n);
 const ws=new Set(Object.values(wrong).map(r=>r&&r.q&&r.q.id));
 const sorted=pool.slice().sort((a,b)=>aiqDScore(a,ws)-aiqDScore(b,ws));
 const k=Math.max(Math.min(n,sorted.length),Math.ceil(sorted.length*0.4));
 return shuffle(diff==='easy'?sorted.slice(0,k):sorted.slice(-k)).slice(0,n);
}
function aiqPool(E,o,excl){
 const seen=new Set(),out=[];
 for(const e of E){const q=e.q;if(seen.has(q.id)||(excl&&excl.has(q.id)))continue;seen.add(q.id);
  if(o.cat&&qCat(q)!==o.cat)continue;if(o.sub&&qSub(q)!==o.sub)continue;out.push(q)}
 return out;
}
// reads "Bangla easy 20 questions" style messages. Returns null when other words are left over
function aiqParse(text){
 let nq=norm(text).replace(/general knowledge|সাধারণ জ্ঞানের?|সাধারণ জ্ঞান/g,'gk');
 const NOKEY=/(without|no|hide) answers?|উত্তর ছাড়াই?|answer ছাড়াই?/g,nokey=NOKEY.test(nq);if(nokey)nq=nq.replace(NOKEY,' ').replace(/\s+/g,' ').trim();
 const rawW=nq.split(' ').filter(Boolean),words=rawW.map(w=>/^(অংক|অংকের|অঙ্ক|অঙ্কের)$/.test(w)?'math':(AI_ALIAS[w]||w));
 nq=words.join(' ');
 const o={nokey,n:null,diff:null,cat:null,sub:null,subjKey:null,more:/(^| )(more|next|আরও|আরো|পরের)( |$)/.test(nq),start:AIQ_R.start.test(nq),ask:/(^| )ask( |$)/.test(nq),mix:/(^| )(mix|mixed|মিক্স)( |$)/.test(nq),rand:/(^| )(random|র‍্যান্ডম|র্যান্ডম)( |$)/.test(nq)};
 const nm=nq.match(/(\d{1,3})\s*(?:টি|টা)?/);if(nm)o.n=Math.max(1,Math.min(100,+nm[1]));
 else for(const w in AIQ_WORDNUM)if(new RegExp('(^| )'+w+'(টি|টা)?( |$)').test(nq)){o.n=AIQ_WORDNUM[w];break}
 if(/(^| )(easy|সহজ|সহজটা)( |$)/.test(nq))o.diff='easy';else if(/(^| )(hard|কঠিন|কঠিনটা)( |$)/.test(nq))o.diff='hard';
 for(const k of ['bangla','english','math','gk']){
  const hit=k==='bangla'?/বাংলা|bangla|bengali/.test(nq):k==='english'?/english|ইংরেজি/.test(nq):k==='math'?/(^| )math( |$)|গণিত/.test(nq):/(^| )(gk|জিকে)( |$)/.test(nq);
  if(hit){o.subjKey=k;const c=CAT.find(x=>AIQ_SUBJ[k].test(x.c));if(c)o.cat=c.c;break}
 }
 const tp=aiTopic(words,rawW);if(!o.cat&&tp.cat)o.cat=tp.cat;if(tp.sub)o.sub=tp.sub;
 let rest=words.filter(w=>!AIQ_FILL.has(w)&&!tp.used.has(w)&&!/^\d+(টি|টা)?$/.test(w)&&!/^(দশ|বিশ|ত্রিশ|পঞ্চাশ|একশ|একশো)(টি|টা)?$/.test(w)&&!/^[a-z]$/.test(w));
 o.pure=rest.length===0&&(o.start||o.subjKey||o.diff||o.n||AIQ_R.next.test(nq)||o.ask||o.mix||o.rand||/(^| )(quiz|mcq|mcqs|কুইজ|প্রশ্ন|questions?|test|টেস্ট)( |$)/.test(nq));
 o.words=words;o.nq=nq;return o;
}
function aiqReset(){AIQ.lq=null;AIQ.lname=null;AIQ.deadline=0;AIQ.streak=0;AIQ.best=0;AIQ.t0=Date.now();AIQ.endless=false;AIQ.on=false;AIQ.qs=[];AIQ.i=0;AIQ.cur=null;AIQ.answered=false;AIQ.hints=0;AIQ.right=[];AIQ.wrong=[];AIQ.skipped=[];AIQ.used=new Set()}
function aiqActs(extra){
 return '<div class="aiacts">'+(extra||'')+'<button type="button" class="aiact" onclick="aiAsk(\'hint\')">💡 Hint</button><button type="button" class="aiact" onclick="aiAsk(\'skip\')">⏭ Skip</button><button type="button" class="aiact" onclick="aiAsk(\'score\')">📊 Score</button><button type="button" class="aiact" onclick="aiAsk(\'stop\')">⏹ Stop</button></div>';
}
function aiqCard(q){
 reg(q);
 const id=esc(String(q.id));
 const body=isText(q)?'<div class="muted" style="font-size:13px">✍️ Type your answer</div>'
  :'<div class="opts">'+q.o.map((x,j)=>`<button type="button" class="opt aiopt" data-q="${id}" data-l="${'ABCDEFGH'[j]||j+1}" onclick="aiPick(this)"><span class="rdl">${'ABCDEFGH'[j]||j+1}</span><span class="otx">${esc(x)}</span></button>`).join('')+'</div>';
 return `<div class="aicard"><div class="rtags" style="margin-bottom:8px"><span class="ptag">${esc(qCat(q))}</span><span class="ptag">${esc(qSub(q))}</span></div><div class="rq">${esc(q.q)}</div>${body}</div>`+aiqActs();
}
function aiPick(b){
 if(!AIQ.on||!AIQ.cur||String(AIQ.cur.id)!==b.dataset.q||AIQ.answered){toast('That question is already closed');return}
 aiAsk(b.dataset.l);
}
function aiqLeft(){if(!AIQ.deadline)return '';const s=Math.max(0,Math.round((AIQ.deadline-Date.now())/1000));return `⏱ ${Math.floor(s/60)}:${String(s%60).padStart(2,'0')} left · `}
function aiqShow(prefix){
 const q=AIQ.cur=AIQ.qs[AIQ.i];AIQ.answered=false;AIQ.hints=0;AIQ.used.add(q.id);
 return{lead:(prefix?prefix+'\n':'')+aiqLeft()+(AIQ.endless?`**Question ${AIQ.i+1}**`:`**Question ${AIQ.i+1} of ${AIQ.qs.length}**`),html:aiqCard(q)};
}
function aiqLabel(){
 if(AIQ.lname)return 'lesson “'+AIQ.lname+'”'+(AIQ.sub?' · '+AIQ.sub:'');
 return (AIQ.cat?(AIQ.sub?AIQ.cat+' › '+AIQ.sub:AIQ.cat):'all subjects')+(AIQ.diff?' · '+AIQ.diff:'');
}
async function aiqStart(o){
 const E=o.pool?o.pool.map(srchEntry):await aiIndex();
 const cat=o.cat||null,sub=o.sub||null,diff=o.diff||null,n=o.n||10;
 if(o.subjKey&&!cat)return{lead:`I could not find a ${o.subjKey==='gk'?'General Knowledge':o.subjKey==='bangla'?'Bangla':o.subjKey==='english'?'English':'Math'} category in your question bank. Available: ${CAT.map(c=>c.c).join(', ')}.`};
 const pool=aiqPool(E,{cat,sub});
 if(!pool.length)return{lead:o.subjKey&&!cat?`I could not find a ${o.subjKey==='gk'?'General Knowledge':o.subjKey} category in your question bank. Try Bangla, English or Math.`:'I could not find questions for that. Try another subject.'};
 const picks=aiqPick(pool,n,diff);
 aiqReset();AIF.on=false;Object.assign(AIQ,{on:true,qs:picks,cat,sub,diff,n:picks.length,endless:!!o.ask,lq:o.pool||null,lname:o.lname||null});AIQ.last={cat,sub,diff,n};AICTX.cat=cat;AICTX.sub=sub;
 if(o.ask)return aiqShow(o.bn?'অবশ্যই 😄 উত্তর A, B, C বা D দিয়ে দিন। চাইলে hint, skip বা stop বলুন।':'Sure 😄 Answer with A, B, C or D. Say hint, skip or stop any time.');
 return aiqShow(`Starting a quiz: **${picks.length}** question${picks.length>1?'s':''} from ${aiqLabel()}. Answer with A, B, C or D. You can also say hint, skip, score or stop.${diff?'\n(Difficulty is an estimate: harder = longer questions and ones you got wrong before.)':''}`);
}
function aiqAnswerLine(q){return aiAns(q)}
function aiqScoreHTML(){
 const t=AIQ.right.length+AIQ.wrong.length+AIQ.skipped.length;
 return `<div class="aistat"><div class="aisr"><b>✅ Correct</b><span>${AIQ.right.length}</span></div><div class="aisr"><b>❌ Wrong</b><span>${AIQ.wrong.length}</span></div><div class="aisr"><b>⏭ Skipped</b><span>${AIQ.skipped.length}</span></div><div class="aisr"><b>Left</b><span>${Math.max(0,AIQ.qs.length-t)}</span></div></div>`;
}
function aiqFinish(stopped){
 const done=AIQ.right.length+AIQ.wrong.length+AIQ.skipped.length;
 AIQ.on=false;
 if(!done)return{lead:'Quiz stopped. You did not answer any question yet.',html:'<div class="aiacts"><button type="button" class="aiact p" onclick="aiAsk(\'start quiz\')">▶ New quiz</button></div>'};
 const pct=Math.round(AIQ.right.length/done*100);
 const msg=pct>=80?'Excellent work! 🎉':pct>=50?'Good effort, keep practising.':'Keep going, review the ones you missed below.';
 const miss=AIQ.wrong.concat(AIQ.skipped),tags={};AIQ.wrong.forEach(q=>tags[q.id]=['wrong']);AIQ.skipped.forEach(q=>tags[q.id]=['skipped']);
 return{lead:`${stopped?'Quiz stopped.':'Quiz finished!'} You scored **${AIQ.right.length} / ${done}** (${pct}%). ${msg}`,
  html:aiqScoreHTML()+'<div class="aiacts"><button type="button" class="aiact p" onclick="aiAsk(\'start quiz\')">▶ New quiz</button><button type="button" class="aiact" onclick="aiAsk(\'next\')">🔁 Same subject, new questions</button></div>',
  list:miss.length?{qs:miss,title:'Missed questions',tags}:null};
}
function aiqAdvance(prefix){
 if(AIQ.deadline&&Date.now()>AIQ.deadline){const r=aiqFinish(false);r.lead='⏱ Time is up! '+(prefix?prefix+'\n':'')+r.lead;return r}
 if(AIQ.i+1>=AIQ.qs.length){
  if(AIQ.endless)return aiqExtend(1,true).then(r=>r&&r.html?r:aiqFinish(false));
  return aiqFinish(false);
 }
 AIQ.i++;return aiqShow(prefix);
}
async function aiqExtend(n,quiet){
 const E=AIQ.lq?AIQ.lq.map(srchEntry):await aiIndex();
 const pool=aiqPool(E,{cat:AIQ.cat,sub:AIQ.sub},AIQ.used),picks=aiqPick(pool,n,AIQ.diff);
 const wasOver=AIQ.i>=AIQ.qs.length;
 if(!picks.length)return{lead:'There are no more new questions in this selection. Say “start quiz” for a fresh set.'};
 AIQ.qs=AIQ.qs.concat(picks);AIQ.n=AIQ.qs.length;
 const lead=quiet?'':`Added **${picks.length}** more question${picks.length>1?'s':''}. The quiz now has ${AIQ.qs.length}.`;
 return AIQ.answered||wasOver?aiqAdvance(lead):{lead};
}
function aiqGrade(q,text,letterIdx){
 if(isText(q))return q.ans.some(a=>normA(a)===normA(text));
 return letterIdx===q.a;
}

// ---- printed question sets: "Next 10", "Random 10", "Mix 10" ----
const AIB_DIG='০১২৩৪৫৬৭৮৯';
function aiqMix(E,n,used){
 const g={};aiqPool(E,{},used).forEach(q=>{(g[qCat(q)]=g[qCat(q)]||[]).push(q)});
 const lists=Object.values(g).map(a=>shuffle(a)),out=[];
 for(let i=0;out.length<n&&lists.some(a=>i<a.length);i++)lists.forEach(a=>{if(i<a.length&&out.length<n)out.push(a[i])});
 return shuffle(out);
}
function aiSetHTML(S,withKey){
 const num=S.num,L='ABCDEFGH';
 return '<div class="aiset">'+S.qs.map((q,i)=>`<div class="aisq"><b class="n">${num(i+1)}.</b> ${esc(q.q)}`+(isText(q)?'<div class="aiso">✍️ (typed answer)</div>':q.o.map((x,j)=>`<div class="aiso">${L[j]||j+1}) ${esc(x)}</div>`).join(''))+'</div>').join('')+'</div>'
  +(withKey?aiKeyHTML(S):'');
}
function aiKeyHTML(S){const L='ABCDEFGH';return `<div class="aikey"><b>${S.bn?'উত্তর:':'Answers:'}</b><br>${S.qs.map((q,i)=>`${S.num(i+1)}-${esc(isText(q)?aiAns(q):(L[q.a]||q.a+1))}`).join(', ')}</div>`}
async function aiSetRun(kind,o){
 const E=await aiIndex(),n=Math.min(o.n||10,50);
 let cat=o.cat||null,sub=o.sub||null;
 if(o.subjKey&&!cat)return{lead:`I could not find a ${o.subjKey==='gk'?'General Knowledge':o.subjKey==='bangla'?'Bangla':o.subjKey==='english'?'English':'Math'} category in your question bank. Available: ${CAT.map(c=>c.c).join(', ')}.`};
 if(kind==='mix'){cat=null;sub=null}else if(!cat){cat=AICTX.cat;sub=AICTX.sub}
 AICTX.cat=cat;AICTX.sub=sub;
 const pick=()=>kind==='mix'?aiqMix(E,n,AICTX.used):aiqPick(aiqPool(E,{cat,sub},AICTX.used),n,o.diff);
 let picks=pick(),again=false;
 if(!picks.length){AICTX.used=new Set();picks=pick();again=true}
 if(!picks.length)return{lead:'I could not find questions for that. Try another subject.',html:aiSuggestHTML(o.words)};
 picks.forEach(q=>AICTX.used.add(q.id));
 picks.forEach(reg);
 const bn=picks.filter(q=>/[\u0980-\u09FF]/.test(q.q)).length>picks.length/2;
 const num=x=>bn?String(x).replace(/\d/g,d=>AIB_DIG[d]):String(x);
 const N=picks.length;
 const title=kind==='mix'?(bn?`Random Mix — ${num(N)}টি MCQ`:`Random Mix — ${N} MCQ`)
  :kind==='random'?`Random ${N} ${cat||'All'} MCQ`
  :(bn?`পরের ${num(N)}টি MCQ`:`Next ${N} MCQ`);
 const S=AIB.last={qs:picks,title,bn,num,nokey:!!o.nokey};
 const acts='<button type="button" class="aiact" onclick="aiAsk(\'Next 10\')">Next 10</button><button type="button" class="aiact" onclick="aiAsk(\'Random 10\')">Random 10</button><button type="button" class="aiact" onclick="aiAsk(\'Mix 10\')">Mix 10</button>';
 const note=o.nokey?'\n(Answers are hidden. Send yours like “1-B 2-A 3-C” and I will mark them, or say “answers”.)':'';
 return{lead:'**'+title+'**'+(again?'\n(You have seen every question here, so I started over.)':'')+note,html:aiSetHTML(S,!o.nokey),list:{qs:picks,title,noList:true,extraActs:acts}};
}

/* =====================================================================
   50 extra prompts (Bangla + English). Each entry: [id, test(nq,text), needs, handler]
   needs: 'quiz' = a quiz is running, 'last' = a quiz was played, 'set' = a printed set exists
   ===================================================================== */
const aiIsBn=t=>/[\u0980-\u09FF]/.test(t);
const aiNum=(t,bn)=>bn?String(t).replace(/\d/g,d=>AIB_DIG[d]):String(t);
const aiList=(qs,title,tags)=>{const id=++AI.mid;AI.lists[id]={qs,title,tags};return id};
function aiRows(rows){return '<div class="aistat">'+rows.map(r=>`<div class="aisr"><b>${esc(r[0])}</b><span>${esc(r[1])}</span></div>`).join('')+'</div>'}
function aiReviewHTML(q){
 reg(q);
 const body=isText(q)?`<div class="rdans">✅ <b>Answer:</b> ${esc(aiAns(q))}</div>`:'<div class="opts">'+q.o.map((x,j)=>`<div class="opt${j===q.a?' ok':''}"><span class="rdl">${'ABCDEFGH'[j]||j+1}</span><span class="otx">${esc(x)}</span></div>`).join('')+'</div>';
 return `<div class="aicard"><div class="rq">${esc(q.q)}</div>${body}${q.e?`<div class="explain"><b>💡 Explanation</b><br>${esc(q.e)}</div>`:''}</div>`;
}
function aiHistStats(){
 const h=history||[],by={};
 h.forEach(x=>{const b=by[x.cat]=by[x.cat]||{n:0,p:0};b.n++;b.p+=x.percent||0});
 const wc={};Object.values(wrong).forEach(r=>{if(r&&r.q){const c=qCat(reg(r.q));wc[c]=(wc[c]||0)+(r.wrong||1)}});
 return{h,by,wc,avg:h.length?h.reduce((a,x)=>a+(x.percent||0),0)/h.length:0,best:h.length?Math.max(...h.map(x=>x.percent||0)):0};
}
const AI_NAV={search:[/(search|সার্চ|অনুসন্ধান)/,'Search'],history:[/(history|results?|হিস্ট্রি|ফলাফল)/,'History'],bank:[/(bank|ব্যাংক|ব্যাঙ্ক)/,'Question Bank'],practice:[/(practice|practise|প্র্যাকটিস)/,'More Practice'],daily:[/(daily|ডেইলি)/,'Daily 50'],slider:[/(slider|slideshow|স্লাইডার)/,'Question Slider'],read:[/(^| )(read|reading|রিড)( |$)|পড়ার/,'Read'],manage:[/(add question|new question|manage|প্রশ্ন যোগ|প্রশ্ন যুক্ত)/,'Add Question'],home:[/(home|dashboard|হোম|ড্যাশবোর্ড)/,'Home']};
const AI_TIPS_EN=['Revise wrong answers within 24 hours. That is when they stick.','Study in 25-minute blocks with a 5-minute break.','Say the explanation out loud. If you can teach it, you know it.','Do a short quiz every day. Small and regular beats one long session.','Practise with a timer so exam speed feels normal.','Sleep well before the exam. Memory is stored while you sleep.','Start with your weakest subject while your mind is fresh.','Skip hard questions first, then come back. Never get stuck.','Write formulas and dates on one page and read it every morning.','Mix subjects in one session. It trains your brain to switch fast.'];
const AI_TIPS_BN=['ভুল উত্তরগুলো ২৪ ঘণ্টার মধ্যে আবার পড়ুন। তখনই মনে থাকে।','২৫ মিনিট পড়ুন, ৫ মিনিট বিরতি নিন।','ব্যাখ্যাটা জোরে বলুন। অন্যকে বোঝাতে পারলে আপনি জানেন।','প্রতিদিন অল্প কুইজ দিন। নিয়মিত অল্প অভ্যাস বড় একদিনের চেয়ে ভালো।','টাইমার দিয়ে অনুশীলন করুন, তাহলে পরীক্ষার গতি স্বাভাবিক লাগবে।','পরীক্ষার আগে ভালো ঘুমান। ঘুমের সময় স্মৃতি জমা হয়।','সবচেয়ে দুর্বল বিষয় দিয়ে শুরু করুন, মাথা যখন সতেজ।','কঠিন প্রশ্ন আগে এড়িয়ে যান, পরে ফিরে আসুন। আটকে থাকবেন না।','সূত্র আর তারিখ এক পাতায় লিখে প্রতিদিন সকালে পড়ুন।','এক বসায় বিভিন্ন বিষয় মেশান। মস্তিষ্ক দ্রুত বদলাতে শেখে।'];
const AI_MOT_EN=['You are closer than you think. Keep going! 💪','Every question you practise is one less surprise in the exam.','Mistakes are just marks you have not collected yet.','Small steps every day beat big plans you never start.','Stay calm, stay consistent. You have got this! 🌟'];
const AI_MOT_BN=['আপনি যা ভাবছেন তার চেয়ে অনেক কাছে আছেন। চালিয়ে যান! 💪','প্রতিটি অনুশীলিত প্রশ্ন পরীক্ষায় একটি অবাক হওয়ার সুযোগ কমায়।','ভুল মানে শুধু সেই নম্বর, যা এখনও তোলা হয়নি।','প্রতিদিনের ছোট পদক্ষেপ বড় পরিকল্পনার চেয়ে ভালো।','শান্ত থাকুন, নিয়মিত থাকুন। আপনি পারবেন! 🌟'];
const aiPickOne=a=>a[Math.floor(Math.random()*a.length)];
function aiLastList(){return AIQ.qs&&AIQ.qs.length&&(AIQ.right.length+AIQ.wrong.length+AIQ.skipped.length)?{qs:AIQ.qs,title:'Quiz questions'}:AIB.last?{qs:AIB.last.qs,title:AIB.last.title}:null}
async function aiRevealCur(){
 const q=AIQ.cur,reveal=!AIQ.answered;
 if(reveal){AIQ.answered=true;AIQ.skipped.push(q);AIQ.streak=0}
 return{lead:`${reveal?'(Counted as skipped.) ':''}The answer is **${aiAns(q)}**.${q.e?'\n💡 '+q.e:''}`,html:'<div class="aiacts"><button type="button" class="aiact p" onclick="aiAsk(\'next\')">Next ▶</button></div>'};
}
const AIX=[
 // ---- quiz helpers (1-14) ----
 ['repeat',n=>/(^| )(repeat|again|resend)( |$)|আবার (দাও|বল|বলো|দেখাও)|প্রশ্নটা? আবার|প্রশ্নটি আবার/.test(n),'quiz',async()=>{
   const q=AIQ.cur;if(AIQ.answered)return{lead:'You already answered this one. Say “next” for the next question.'};
   return{lead:`**Question ${AIQ.i+1}${AIQ.endless?'':' of '+AIQ.qs.length}** (again)`,html:aiqCard(q)}}],
 ['5050',n=>/(^| )(50 50|fifty fifty|5050)( |$)|অপশন (বাদ|কাটো|কেটে)/.test(n),'quiz',async()=>{
   const q=AIQ.cur;if(AIQ.answered)return{lead:'You already answered this one.'};
   if(isText(q)||q.o.length<3)return{lead:'50:50 only works on multiple-choice questions with 3 or more options.'};
   AIQ.hints=Math.max(AIQ.hints,1);
   const other=shuffle(q.o.map((x,j)=>j).filter(j=>j!==q.a))[0],ks=[q.a,other].sort();
   return{lead:`50:50: the answer is **${'ABCDEFGH'[ks[0]]}** or **${'ABCDEFGH'[ks[1]]}**.`}}],
 ['reveal',n=>/(^| )(show answer|reveal|reveal answer|what is the answer|tell me the answer)( |$)|উত্তর (বলো|বল|দেখাও|কী|কি)( |$)|সঠিক উত্তর দেখাও/.test(n)&&!/hint|হিন্ট|ক্লু|clue/.test(n),'quiz',aiRevealCur],
 ['prev',n=>/^(previous|prev|go back|back)( question)?$|আগের (প্রশ্ন|টা|টি|প্রশ্নটি)|আগেরটা|পিছনে যাও/.test(n),'quiz',async()=>{
   if(AIQ.i<1)return{lead:'This is the first question.'};
   const q=AIQ.qs[AIQ.i-1];return{lead:`**Question ${AIQ.i}** (review)`,html:aiReviewHTML(q)}}],
 ['restart',n=>/(^| )(restart|retry|replay|try again)( quiz)?( |$)|আবার শুরু|পুনরায় শুরু|রিস্টার্ট/.test(n),'last',async(x,t)=>aiqStart(Object.assign({},AIQ.last||{},{ask:AIQ.endless,bn:aiIsBn(t)}))],
 ['left',n=>/(^| )(left|remaining|বাকি)( |$)|কয়টি বাকি|কয়টা বাকি|কতগুলো বাকি/.test(n),'quiz',async()=>{
   if(AIQ.endless)return{lead:'This quiz has no fixed length. Say “stop” when you want the result.'};
   const left=AIQ.qs.length-AIQ.i-(AIQ.answered?1:0);return{lead:`**${left}** question${left===1?'':'s'} left${AIQ.answered?'':' (including this one)'}.`}}],
 ['accuracy',n=>/(^| )(accuracy|percentage|percent)( |$)|শতকরা|সঠিকের হার|কত শতাংশ/.test(n),'last',async()=>{
   const t=AIQ.right.length+AIQ.wrong.length;if(!t)return{lead:'No answers yet, so no accuracy to show.'};
   return{lead:`Your accuracy is **${Math.round(AIQ.right.length/t*100)}%** (${AIQ.right.length} of ${t} answered).`}}],
 ['streak',n=>/(^| )(streak|in a row)( |$)|পরপর সঠিক|ধারাবাহিক/.test(n),'last',async()=>({lead:`Current streak: **${AIQ.streak}** correct in a row. Best this quiz: **${AIQ.best}**. 🔥`})],
 ['quizwrong',n=>/(quiz|কুইজ)\w* (mistakes?|wrong|ভুল)|(mistakes?|wrong)\w* (in|of) (this )?quiz|এই কুইজের ভুল/.test(n),'last',async()=>{
   if(!AIQ.wrong.length)return{lead:'No wrong answers in this quiz so far. 🎉'};
   const tags={};AIQ.wrong.forEach(q=>tags[q.id]=['wrong']);return{lead:`You got **${AIQ.wrong.length}** wrong in this quiz:`,list:{qs:AIQ.wrong.slice(),title:'Wrong in this quiz',tags}}}],
 ['quizskip',n=>/(quiz|কুইজ)\w* (skipped|skip|স্কিপ)|এই কুইজের স্কিপ/.test(n),'last',async()=>{
   if(!AIQ.skipped.length)return{lead:'You have not skipped any question in this quiz.'};
   const tags={};AIQ.skipped.forEach(q=>tags[q.id]=['skipped']);return{lead:`You skipped **${AIQ.skipped.length}** in this quiz:`,list:{qs:AIQ.skipped.slice(),title:'Skipped in this quiz',tags}}}],
 ['slidethis',n=>/(slide|slideshow|স্লাইড).*(this|these|quiz|set|এই|এগুলো|কুইজ|সেট)|(this|these|এই|এগুলো) (slide|slideshow|স্লাইড)/.test(n),'any',async()=>{
   const L=aiLastList();if(!L)return{lead:'There is nothing to show yet. Start a quiz or say “Next 10” first.'};
   const id=aiList(L.qs,L.title);setTimeout(()=>aiSlide(id),600);return{lead:'Opening these as a timed slideshow…'}}],
 ['practicethis',n=>/(practice|practise|exam|প্র্যাকটিস|পরীক্ষা).*(these|this set|this quiz|এগুলো|এই সেট|এই কুইজ)|(these|এগুলো) (practice|প্র্যাকটিস)/.test(n),'any',async()=>{
   const L=aiLastList();if(!L)return{lead:'There is nothing to practise yet. Start a quiz or say “Next 10” first.'};
   const id=aiList(L.qs,L.title);setTimeout(()=>aiPractice(id),600);return{lead:'Starting a practice exam with these questions…'}}],
 ['harder',n=>/^(make it )?(harder|more difficult)$|আরও কঠিন|কঠিন করো|কঠিন কর$/.test(n),'any',async(x,t)=>AIQ.on?aiQuizCmd('hard'):aiSetRun('next',{n:10,diff:'hard'})],
 ['easier',n=>/^(make it )?(easier|simpler)$|আরও সহজ|সহজ করো|সহজ কর$/.test(n),'any',async(x,t)=>AIQ.on?aiQuizCmd('easy'):aiSetRun('next',{n:10,diff:'easy'})],
 // ---- printed sets (15-20) ----
 ['key',n=>/(^| )(answers|answer key|key|show all answers)( |$)|উত্তরমালা|উত্তরগুলো|উত্তর গুলো/.test(n),'set',async()=>({lead:`**${AIB.last.bn?'উত্তর':'Answer key'}**`,html:aiKeyHTML(AIB.last)})],
 ['ansN',n=>/^(answer|ans|উত্তর)( of| for)? \d{1,2}$|^\d{1,2} (নম্বর|নং|number|no)( প্রশ্নের)? (উত্তর|answer)$/.test(n),'setidle',async(x,t,n)=>{
   const k=+(n.match(/\d{1,2}/)[0]),q=AIB.last.qs[k-1];if(!q)return{lead:`The last set has only ${AIB.last.qs.length} questions.`};
   return{lead:`Answer ${k}: **${aiAns(q)}**`}}],
 ['explN',n=>/^(explain|ব্যাখ্যা|why)( of| for)? \d{1,2}$|^\d{1,2} (নম্বর|নং|number|no)( প্রশ্নের)? (ব্যাখ্যা|explanation)$/.test(n),'setidle',async(x,t,n)=>{
   const k=+(n.match(/\d{1,2}/)[0]),q=AIB.last.qs[k-1];if(!q)return{lead:`The last set has only ${AIB.last.qs.length} questions.`};
   return{lead:`Question ${k}: the answer is **${aiAns(q)}**.${q.e?'\n💡 '+q.e:'\nThere is no saved explanation for this one.'}`}}],
 ['setagain',n=>/(show|print)( the)?( last)? set again|set again|আবার সেট|সেটটা আবার/.test(n),'set',async()=>{const S=AIB.last;return{lead:'**'+S.title+'**',html:aiSetHTML(S,!S.nokey)}}],
 ['nokeyhint',n=>/^(hide|without) (the )?(key|answers)$|উত্তর লুকাও|উত্তর লুকিয়ে/.test(n),'set',async()=>{const S=AIB.last;return{lead:'**'+S.title+'** (answers hidden)',html:aiSetHTML(S,false)}}],
 // ---- stats (21-30) ----
 ['progress',n=>/(^| )(my )?(progress|অগ্রগতি|প্রোগ্রেস)( |$)/.test(n),null,async(x,t)=>{
   const S=aiHistStats();return{lead:'Here is your progress:',html:aiRows([['Exams taken',history.length],['Average score',S.h.length?Math.round(S.avg)+'%':'-'],['Best score',S.h.length?Math.round(S.best)+'%':'-'],['Wrong list',Object.keys(wrong).length],['Skipped list',Object.keys(skipQs).length]])}}],
 ['best',n=>/(best|highest|top|সর্বোচ্চ|সেরা) (score|result|marks|স্কোর|নম্বর)/.test(n),null,async()=>{const S=aiHistStats();return{lead:S.h.length?`Your best exam score is **${Math.round(S.best)}%**.`:'You have not completed an exam yet.'}}],
 ['avg',n=>/(average|avg|গড়) ?(score|marks|result|স্কোর|নম্বর)|গড় (স্কোর|নম্বর)/.test(n),null,async()=>{const S=aiHistStats();return{lead:S.h.length?`Your average over ${S.h.length} exam${S.h.length>1?'s':''} is **${Math.round(S.avg)}%**.`:'You have not completed an exam yet.'}}],
 ['lastexam',n=>/(last|latest|recent|শেষ|সর্বশেষ|গত) (exam|test|result|পরীক্ষা|ফল|ফলাফল)/.test(n),null,async()=>{
   const h=history[0];if(!h)return{lead:'You have not completed an exam yet.'};
   return{lead:`Your last exam: **${h.cat}** › ${h.sub}, **${h.correct||0}/${h.total}** (${Math.round(h.percent||0)}%).`,html:aiRows([['Correct',h.correct||0],['Wrong',h.wrong||0],['Skipped',h.skip||0],['Date',h.date||'']])}}],
 ['wrongcount',n=>/(how many|কয়টি|কতগুলো|কয়টা).*(wrong|ভুল|skipped|স্কিপ)|wrong count/.test(n),null,async()=>({lead:`You have **${Object.keys(wrong).length}** wrong, **${Object.keys(skipQs).length}** skipped and **${Object.keys(important).length}** important questions saved. They wait in More Practice.`})],
 ['weakest',n=>/(weakest|weak) (subject|category|topic)|দুর্বল (বিষয়|সাবজেক্ট|টপিক)|সবচেয়ে দুর্বল/.test(n),null,async()=>{
   const S=aiHistStats(),rows=Object.entries(S.wc).sort((a,b)=>b[1]-a[1]);
   if(rows.length)return{lead:`Your weakest subject is **${rows[0][0]}** (${rows[0][1]} wrong answers logged).`,html:aiRows(rows.slice(0,5).map(r=>[r[0],r[1]+' wrong']))};
   const hs=Object.entries(S.by).map(([c,b])=>[c,b.p/b.n]).sort((a,b)=>a[1]-b[1]);
   return hs.length?{lead:`Your lowest average is **${hs[0][0]}** (${Math.round(hs[0][1])}%).`}:{lead:'I need some exam results first. Take an exam and ask again.'}}],
 ['strongest',n=>/(strongest|strong|best) (subject|category)|সবচেয়ে (ভালো|ভাল|শক্তিশালী) বিষয়|শক্তিশালী বিষয়/.test(n),null,async()=>{
   const S=aiHistStats(),hs=Object.entries(S.by).map(([c,b])=>[c,b.p/b.n]).sort((a,b)=>b[1]-a[1]);
   return hs.length?{lead:`Your strongest subject is **${hs[0][0]}** (${Math.round(hs[0][1])}% average).`,html:aiRows(hs.slice(0,5).map(r=>[r[0],Math.round(r[1])+'%']))}:{lead:'I need some exam results first. Take an exam and ask again.'}}],
 ['subjects',n=>/^(list |show |all |my )?(subjects?|categories|subject list)$|বিষয়ের তালিকা|সব বিষয়|বিষয়গুলো/.test(n),null,async()=>({lead:`You have **${CAT.length}** subjects:`,html:aiRows(CAT.map(c=>[c.c,catTotal(c.c).toLocaleString()+' questions']))})],
 ['topics',n=>/(^| )(topics?|subtopics?|sub categories|chapters?|টপিক|অধ্যায়|উপবিষয়)( |$)/.test(n),'cat',async(x,t,n,o)=>{
   const subs=subsOf(o.cat);return{lead:`**${o.cat}** has ${subs.length} topic${subs.length>1?'s':''}:`,html:aiRows(subs.map(s=>[s.n,s.total.toLocaleString()]))}}],
 ['dailystat',n=>/(daily|ডেইলি) ?(50)? ?(status|progress|score|left|বাকি|অবস্থা)|^(আজকের ডেইলি|daily status)$/.test(n),null,async()=>{
   const ok=daily&&daily.date===todayStr()&&Array.isArray(daily.qs);
   if(!ok)return{lead:`Today's Daily 50 has not been started. **${Math.min(DAILY_SIZE,totalQ())}** questions are waiting.`,html:'<div class="aiacts"><button type="button" class="aiact p" onclick="aiAsk(\'open daily\')">Open Daily 50</button></div>'};
   if(daily.submitted)return{lead:'You already submitted today\'s Daily 50. Come back tomorrow!'};
   const left=daily.qs.filter(q=>daily.answers[q.id]==null).length;return{lead:`Daily 50: **${daily.qs.length-left}** answered, **${left}** left.`,html:'<div class="aiacts"><button type="button" class="aiact p" onclick="aiAsk(\'open daily\')">Continue</button></div>'}}],
 // ---- navigation (31-39) are generated below ----
 // ---- utility (40-50) ----
 ['clear',n=>/(clear|reset|new|delete) (the |this )?(chat|conversation)|চ্যাট (মুছ|ক্লিয়ার|রিসেট)|নতুন চ্যাট|new chat/.test(n),null,async()=>{aiWelcome();return{lead:'Chat cleared. Ask me anything!'}}],
 ['thanks',n=>n.split(' ').length<=4&&/(^| )(thanks|thank you|thx|ty|well done|good job|great|awesome|nice)( |$)|ধন্যবাদ|শুকরিয়া|থ্যাংক|দারুণ|চমৎকার|অসাধারণ/.test(n),null,async(x,t)=>({lead:aiIsBn(t)?'আপনাকেও ধন্যবাদ! আরেকটা কুইজ দেবেন? 😊':'You are welcome! Want another quiz? 😊'})],
 ['bye',n=>n.split(' ').length<=3&&/^(bye|goodbye|good bye|see you|cya|good night)|^(বিদায়|টাটা|শুভরাত্রি|আল্লাহ হাফেজ|খোদা হাফেজ)/.test(n),null,async(x,t)=>({lead:aiIsBn(t)?'বিদায়! নিয়মিত অনুশীলন করতে ভুলবেন না। 👋':'Goodbye! Keep practising a little every day. 👋'})],
 ['motivate',n=>/(motivate|motivation|inspire|encourage|cheer me up|উৎসাহ|অনুপ্রেরণা|মোটিভেশন)/.test(n),null,async(x,t)=>({lead:aiPickOne(aiIsBn(t)?AI_MOT_BN:AI_MOT_EN)})],
 ['tip',n=>n.split(' ').length<=5&&/(^| )(tip|tips|advice)( |$)|টিপস|পরামর্শ|কৌশল/.test(n),null,async(x,t)=>({lead:(aiIsBn(t)?'পড়ার টিপ: ':'Study tip: ')+aiPickOne(aiIsBn(t)?AI_TIPS_BN:AI_TIPS_EN)})],
 ['datetime',n=>/^(what is |whats |what s )?(the )?(today s |todays |current )?(date|time|day)( today| now)?$|^(আজকের তারিখ|আজ কত তারিখ|এখন কয়টা বাজে|এখন সময়|সময় কত|আজকের দিন)$/.test(n),null,async(x,t)=>{
   const d=new Date(),bn=aiIsBn(t),loc=bn?'bn-BD':'en-GB';
   return{lead:`**${d.toLocaleDateString(loc,{weekday:'long',day:'numeric',month:'long',year:'numeric'})}**, ${d.toLocaleTimeString(loc,{hour:'2-digit',minute:'2-digit'})}`}}],
 ['commands',n=>/(^| )(commands?|all commands|command list|what can i say|prompts?|কমান্ড|প্রম্পট)( |$)|কী বলতে পারি|কি বলতে পারি/.test(n),null,async()=>aiCommandsReply()],
 ['surprise',n=>/(surprise me|any question|anything)$|সারপ্রাইজ|যেকোনো একটা|যেকোনো প্রশ্ন/.test(n),null,async(x,t)=>aiqStart({n:1,ask:true,bn:aiIsBn(t)})],
 ['resetscore',n=>/(reset|clear|zero)( my)? (score|points)|স্কোর (রিসেট|মুছ|শূন্য)/.test(n),'last',async()=>{AIQ.right=[];AIQ.wrong=[];AIQ.skipped=[];AIQ.streak=0;AIQ.best=0;return{lead:'Score reset to zero. The quiz goes on.'}}],
 ['swap',n=>/(swap|replace|change|পাল্টা|বদল|বদলাও|বদলে)\w* (this |the )?(question|প্রশ্ন)|প্রশ্ন (বদলাও|পাল্টাও|বদলে দাও)|প্রশ্নটা বদলাও/.test(n),'quiz',async()=>{
   if(AIQ.answered)return{lead:'You already answered this one. Say “next” for a new question.'};
   const E=await aiIndex(),pool=aiqPool(E,{cat:AIQ.cat,sub:AIQ.sub},AIQ.used),p=aiqPick(pool,1,AIQ.diff);
   if(!p.length)return{lead:'There are no other questions to swap in.'};
   AIQ.qs[AIQ.i]=p[0];return aiqShow('Swapped for a new question.')}],
 ['timetaken',n=>/(time taken|how long|elapsed)|কতক্ষণ|সময় (লাগছে|লেগেছে|লাগল)|কত সময়/.test(n),'last',async()=>{
   const sec=Math.max(0,Math.round((Date.now()-AIQ.t0)/1000));return{lead:`You have been on this quiz for **${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}** (minutes:seconds).`}}]
];
// navigation prompts: "open search", "go to history", "খোলো ডেইলি" ...
Object.entries(AI_NAV).forEach(([view,[re,label]])=>{
 AIX.push(['nav_'+view,n=>/(^| )(open|go to|goto|take me to|visit|খোলো|খুলুন|খুলো|যাও|চলো)( |$)/.test(n)&&re.test(n),null,async()=>{setTimeout(()=>show(view),700);return{lead:`Opening **${label}**…`}}]);
});
function aiCommandsReply(){
 const g=[
  ['Quiz in chat',['Ask question','Ask about math','repeat','50 50','show answer','previous','restart','how many left','accuracy','streak','swap question','time taken','reset score','harder','easier']],
  ['Sets and marking',['Next 10','Random 10','Mix 10','Next 10 without answers','answers','answer 3','explain 3','set again','practice these','slide these']],
  ['Quiz review',['quiz mistakes','quiz skipped','revise','practice my weak topics']],
  ['Lessons and search',['lesson 1','ask lesson 1','find '+aiRandSub().toLowerCase(),'new subjects','compare '+aiAllSubs().slice(0,2).join(' and ')]],
  ['Study modes',['flashcards','flashcards '+aiRandSub().toLowerCase(),'timed quiz 10 in 5 minutes','star this','read this question','time left']],
  ['Your stats',['my progress','best score','average score','last exam','how many wrong','weakest subject','strongest subject','list subjects','topics of math','daily status']],
  ['Open a page',['open search','open history','open bank','open practice','open daily','open slider','open read','add question page','go home']],
  ['Extras',['motivate me','study tip','what is the date','clear chat','surprise me','thanks','bye']]];
 const ex={'add question page':'open add question'};
 return{lead:'Here are the prompts I understand. Tap one to try it. After a set, send your answers like “1-B 2-A 3-C” and I will mark them. Bangla works too, for example “আগের প্রশ্ন”, “আমার অগ্রগতি”, “সার্চ খোলো”.',
  html:g.map(([t,a])=>`<div class="flab" style="margin:10px 0 4px">${esc(t)}</div><div class="aiacts">`+a.map(x=>`<button type="button" class="aiact" data-v="${esc(ex[x]||x)}" onclick="aiAsk(this.dataset.v)">${esc(x)}</button>`).join('')+'</div>').join('')};
}
// "1-B 2-A 3-C" marks the last printed set
function aiMarkSet(nq){
 const S=AIB.last;if(!S)return null;
 const rest=nq.replace(/^(check|mark|grade|my answers?|answers?|আমার উত্তর|উত্তর|চেক)\s+/,'');
 const had=rest!==nq,re=/(\d{1,2})\s*([a-h]|এ|বি|সি|ডি)(?=\s|$)/g;
 if(!/^((\d{1,2}\s*([a-h]|এ|বি|সি|ডি))\s*)+$/.test(rest))return null;
 const pairs=[...rest.matchAll(re)];if(pairs.length<2&&!(had&&pairs.length))return null;
 const ans={};pairs.forEach(m=>{ans[+m[1]]=AIQ_LET[m[2]]});
 let ok=0,tot=0;const bad=[],lines=[];
 S.qs.forEach((q,i)=>{
  if(isText(q))return;tot++;const a=ans[i+1];
  if(a===q.a)ok++;else{bad.push(q);lines.push(`${S.num(i+1)}. ${a==null?'no answer':'your '+'ABCDEFGH'[a]} → <b>${'ABCDEFGH'[q.a]}</b>`)}
 });
 const pct=tot?Math.round(ok/tot*100):0,tags={};bad.forEach(q=>tags[q.id]=['review']);
 return{lead:`You scored **${ok} / ${tot}** (${pct}%). ${pct>=80?'Excellent! 🎉':pct>=50?'Good effort.':'Keep practising, review the ones below.'}`,
  html:bad.length?`<div class="aikey" style="background:#2a1520;border-color:#7a2e43"><b>To review:</b><br>${lines.join('<br>')}</div>`:'',
  list:bad.length?{qs:bad,title:'To review',tags}:null};
}

// ================= advanced prompts =================
// ---- flashcards: question on the front, "flip" shows the answer, then "got it" or "again" ----
const AIF={on:false,deck:[],known:[],total:0,again:0,label:''};
const aiFlashBtns=(...b)=>'<div class="aiacts">'+b.map(([t,c,p])=>`<button type="button" class="aiact${p?' p':''}" onclick="aiAsk('${c}')">${t}</button>`).join('')+'</div>';
function aiFlashFront(){
 const q=AIF.deck[0];if(!q)return aiFlashEnd();
 return{lead:`🃏 **Known ${AIF.known.length} / ${AIF.total}** · ${AIF.label}\n${q.q}`,html:aiFlashBtns(['🔄 Flip','flip',1],['Stop','stop flashcards'])};
}
function aiFlashEnd(){
 AIF.on=false;
 return{lead:`🃏 Flashcards finished. You knew **${AIF.known.length} / ${AIF.total}** cards${AIF.again?` and asked to see ${AIF.again} again`:''}.`,html:aiFlashBtns(['🃏 New deck','flashcards',1],['▶ Start a quiz','start quiz'])};
}
function aiFlashCmd(nq){
 const q=AIF.deck[0];if(!q)return null;
 if(/^(stop|end|exit|quit|finish|done|বন্ধ|থামো)( flash ?cards?)?$/.test(nq)||/^stop flash/.test(nq))return aiFlashEnd();
 if(/^(flip|show|reveal|answer|show answer|turn|উত্তর|দেখাও)$/.test(nq))
  return{lead:`**Answer:** ${aiAns(q)}${q.e?'\n💡 '+q.e:''}`,html:aiFlashBtns(['✅ Got it','got it',1],['🔁 Again','again'],['Stop','stop flashcards'])};
 if(/^(got it|know|i know|known|easy|yes|correct|ok|okay|next|পেরেছি|জানি|হ্যাঁ)$/.test(nq)){AIF.known.push(AIF.deck.shift());return aiFlashFront()}
 if(/^(again|repeat|don t know|dont know|no|hard|forgot|জানি না|আবার)$/.test(nq)){AIF.again++;AIF.deck.push(AIF.deck.shift());return aiFlashFront()}
 return null;
}
// ---- helpers for the prompts below ----
const aiInTarget=(q,t)=>(!t.cat||qCat(q)===t.cat)&&(!t.sub||qSub(q)===t.sub);
function aiWrongBySub(){const m=new Map();Object.values(wrong).forEach(r=>{if(r&&r.q){const x=reg(r.q),k=qCat(x)+'\u0001'+qSub(x);m.set(k,(m.get(k)||0)+(r.wrong||1))}});return [...m].map(([k,n])=>{const [c,sb]=k.split('\u0001');return{cat:c,sub:sb,n}}).sort((a,b)=>b.n-a.n)}
async function aiLessonQs(l){let a=[];if(l.shard)a=await loadLessonSafe(l.shard);return a.concat(l.custom||[])}
AIX.unshift(
 ['flashstart',n=>/(^| )(flash ?cards?|ফ্ল্যাশ ?কার্ড)( |$)/.test(n),null,async(o,t)=>{
  const E=await aiIndex(),pool=aiqPool(E,{cat:o.cat,sub:o.sub});
  if(!pool.length)return{lead:'I could not find questions for flashcards on that.',html:aiSuggestHTML(o.words)};
  AIQ.on=false;AIF.deck=shuffle(pool).slice(0,Math.min(o.n||10,30));AIF.known=[];AIF.total=AIF.deck.length;AIF.again=0;AIF.on=true;
  AIF.label=o.sub||o.cat||'all subjects';
  const r=aiFlashFront();r.lead='Flashcards: I show the question, you think, then say **flip**. Mark each card **got it** or **again**.\n'+r.lead;return r;
 }],
 ['lessonq',n=>/^(ask |quiz |show |list |search |find |open |practice )?(me )?(about |from |of |in |on )?(lesson|chapter|অধ্যায়|পাঠ) .+/.test(n),null,async(o,t,nq)=>{
  const m=nq.match(/(?:lesson|chapter|অধ্যায়|পাঠ)\s+(.+)$/);if(!m)return null;
  const askMode=/^(ask|quiz|practice)/.test(nq),q=m[1].trim(),w=q.split(' ').filter(x=>x&&!AI_STOP.has(x)),all=[];
  CAT.forEach(c=>{if(o.cat&&c.c!==o.cat)return;c.subs.forEach(sb=>{if(o.sub&&sb.n!==o.sub)return;(sb.lessons||[]).forEach(l=>all.push({c:c.c,s:sb.n,l}))})});
  if(!all.length)return{lead:'No lessons found'+(o.sub?' in '+o.sub:'')+'.',html:aiSuggestHTML(w)};
  let pick=null;const num=q.match(/^(\d{1,3})$/);
  if(num&&o.sub)pick=all[+num[1]-1]||null;
  if(!pick){let best=0;all.forEach(x=>{const st=aiSig(x.l.name);if(!st.length)return;const hit=st.filter(t=>w.some(v=>aiTokEq(v,t))).length,r=hit/st.length,sc=r+hit*0.01+(norm(x.l.name)===norm(q)?1:0);if(r>=0.5&&sc>best){best=sc;pick=x}})}
  if(!pick&&o.sub&&aiSig(o.sub).some(t=>w.some(v=>aiTokEq(v,t))))return null;
  if(!pick){
   const near=all.map(x=>({x,sc:aiSig(x.l.name).filter(t=>w.some(v=>aiTokEq(v,t)||(v.length>=3&&(t.includes(v)||v.includes(t))))).length})).filter(y=>y.sc>0).sort((a,b)=>b.sc-a.sc).slice(0,6).map(y=>y.x),list=near.length?near:all.slice(0,6);
   return{lead:`I could not find a lesson called “${q}”. ${near.length?'Closest lessons:':'Some lessons you have:'}`,html:'<div class="aiacts">'+list.map(x=>`<button type="button" class="aiact p" data-v="${esc('lesson '+x.l.name)}" onclick="aiAsk(this.dataset.v)">${esc(x.l.name)}</button>`).join('')+'</div>'};
  }
  const arr=await aiLessonQs(pick.l);
  if(!arr.length)return{lead:`Lesson **${pick.l.name}** (${pick.s}) has no questions I could load.`};
  if(askMode)return aiqStart({cat:pick.c,sub:pick.s,pool:arr,lname:pick.l.name,n:1,ask:true,bn:aiIsBn(t)});
  return{lead:`Lesson **${pick.l.name}** (${pick.c} › ${pick.s}) has **${arr.length.toLocaleString()}** question${arr.length>1?'s':''}.`,
   html:`<div class="aiacts"><button type="button" class="aiact p" data-v="${esc('ask lesson '+pick.l.name)}" onclick="aiAsk(this.dataset.v)">❓ Ask me one by one</button></div>`,list:{qs:arr,title:pick.l.name+' · '+pick.s}};
 }],
 ['compare',n=>/(^| )(compare|versus|vs|তুলনা)( |$)/.test(n),null,async(o,t,nq)=>{
  const parts=nq.replace(/^(compare|তুলনা( করো)?) /,'').split(/ (?:and|vs|versus|with|to|এবং|ও) /).map(x=>x.trim()).filter(Boolean).slice(0,2);
  const tg=parts.map(p=>{const w=p.split(' '),tp=aiTopic(w,w);return tp.sub?{cat:tp.cat,sub:tp.sub,name:tp.sub}:tp.cat?{cat:tp.cat,sub:null,name:tp.cat}:null});
  if(tg.length<2||!tg[0]||!tg[1])return{lead:'Say it like “compare surveying and estimation”. I need two subjects from your bank.',html:aiSuggestHTML(nq.split(' '))};
  const S=aiHistStats(),count=x=>CAT.filter(c=>!x.cat||c.c===x.cat).flatMap(c=>c.subs).filter(sb=>!x.sub||sb.n===x.sub),
   met=x=>{const subs=count(x);return{total:subs.reduce((a,sb)=>a+sb.total,0),lessons:subs.reduce((a,sb)=>a+(sb.lessons||[]).length,0),
    wrong:Object.values(wrong).filter(r=>r&&r.q&&aiInTarget(reg(r.q),x)).length,star:Object.values(important).filter(r=>r&&r.q&&aiInTarget(reg(r.q),x)).length,avg:S.by[x.cat]?Math.round(S.by[x.cat].p/S.by[x.cat].n)+'%':'–'}},
   a=met(tg[0]),b=met(tg[1]),row=(l,k)=>[l,`${a[k]}  vs  ${b[k]}`];
  return{lead:`**${tg[0].name}** vs **${tg[1].name}**`,html:aiRows([row('Questions','total'),row('Lessons','lessons'),row('In your wrong list','wrong'),row('Starred ⭐','star'),row('Exam average (category)','avg')])};
 }],
 ['timed',n=>/(^| )(timed|speed round|challenge|time limit|টাইমড)( |$)/.test(n)&&!/^(time|timed) (taken|left)/.test(n),null,async(o,t,nq)=>{
  const mm=nq.match(/(\d+)\s*(?:min|mins|minute|minutes|মিনিট)/),mins=mm?Math.min(60,Math.max(1,+mm[1])):5,cm=nq.replace(mm?mm[0]:'','').match(/(\d{1,3})/),n=cm?Math.min(50,Math.max(3,+cm[1])):10;
  const r=await aiqStart({cat:o.cat,sub:o.sub,n,bn:aiIsBn(t)});
  if(AIQ.on){AIQ.deadline=Date.now()+mins*60000;r.lead=`⏱ **Timed challenge:** ${n} questions in ${mins} minute${mins>1?'s':''}. The clock is running!\n`+r.lead.replace(/^Starting a quiz:[^\n]*\n?/,'')}
  return r;
 }],
 ['timeleft',n=>/(time left|remaining time|how much time|কত সময় বাকি|সময় বাকি)/.test(n),null,async()=>{
  if(!AIQ.deadline||!AIQ.on)return{lead:'There is no timed challenge running. Say “timed quiz 10 in 5 minutes” to start one.'};
  const s=Math.max(0,Math.round((AIQ.deadline-Date.now())/1000));return{lead:`⏱ **${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}** left.`};
 }],
 ['weakpractice',n=>/(practice|quiz|test|drill|revise)\s+(me\s+)?(on\s+|in\s+|with\s+)?(my\s+)?(weak|weakest)/.test(n)||/দুর্বল.*(প্র্যাকটিস|কুইজ|অনুশীলন)/.test(n),null,async(o,t)=>{
  const w=aiWrongBySub();if(!w.length)return{lead:'Your wrong list is empty, so I cannot tell what is weak yet. Take an exam or a quiz first.'};
  const top=w[0];return aiqStart({cat:top.cat,sub:top.sub,n:10,bn:aiIsBn(t)}).then(r=>{r.lead=`Your weakest sub-category is **${top.sub}** (${top.n} wrong answers logged).\n`+r.lead;return r});
 }],
 ['star',n=>/(^| )(star|bookmark|save this|mark (this )?(as )?important|favou?rite)( |$)|গুরুত্বপূর্ণ (করো|মার্ক)|ইম্পরট্যান্ট/.test(n)&&aiqLen(n)<=5,'last',async()=>{
  const q=AIQ.cur;reg(q);if(important[q.id])return{lead:'This question is already in your **Important** list ⭐'};
  toggleImp(q.id);return{lead:'⭐ Added to your **Important** list.'};
 }],
 ['speak',n=>/(^| )(read (this |the )?(question|aloud|out)|read it|speak|পড়ে শোনাও|জোরে পড়ো)( |$)/.test(n),'last',async(o,t)=>{
  if(!('speechSynthesis' in window))return{lead:'Your browser cannot read aloud.'};
  const q=AIQ.cur,txt=q.q+(isText(q)?'':'. '+q.o.map((x,i)=>'ABCDEFGH'[i]+'. '+x).join('. ')),u=new SpeechSynthesisUtterance(txt);
  u.lang=/[\u0980-\u09FF]/.test(txt)?'bn-BD':'en-US';speechSynthesis.cancel();speechSynthesis.speak(u);
  return{lead:'🔊 Reading the question aloud. Say **stop reading** to silence it.'};
 }],
 ['stopidle',n=>/^(stop|end|quit|exit|বন্ধ|থামো)$/.test(n),null,async()=>AIQ.on||AIF.on?null:{lead:'Nothing is running right now. Say “start quiz”, “Ask question” or “flashcards” to begin.'}],
 ['stopspeak',n=>/(stop|quiet|silence|cancel) (reading|speaking|voice)|চুপ|পড়া বন্ধ/.test(n),null,async()=>{if('speechSynthesis' in window)speechSynthesis.cancel();return{lead:'🔇 Stopped.'}}],
 ['revise',n=>/^(revise|revision|recap|review( this)? session|রিভিশন|পুনরালোচনা)$/.test(n),null,async()=>{
  const seen=[...AIQ.right,...AIQ.wrong,...AIQ.skipped];
  if(!seen.length)return{lead:`Nothing to revise yet. Say “Ask question” or “Ask about ${aiRandSub()}”, answer a few, then say “revise”.`};
  const tags={};AIQ.right.forEach(q=>tags[q.id]=['right']);AIQ.skipped.forEach(q=>tags[q.id]=['skipped']);AIQ.wrong.forEach(q=>tags[q.id]=['wrong']);
  return{lead:`Revision: **${seen.length}** question${seen.length>1?'s':''} (${AIQ.right.length} right, ${AIQ.wrong.length} wrong, ${AIQ.skipped.length} skipped). Tap one to see its answer and explanation.`,list:{qs:seen,title:'Revision',tags}};
 }],
 ['newsubs',n=>/^(new (subjects?|topics?|categories|sub categories)|latest (subjects?|topics?)|recently added|what s new|whats new|নতুন (বিষয়|টপিক)|নতুন কী)$/.test(n),null,async()=>{
  const rows=[];CAT.forEach(c=>c.subs.forEach(sb=>rows.push([c.c,sb])));const last=rows.slice(-6).reverse();
  return{lead:'The most recently added sub-categories in your question bank:',html:aiRows(last.map(([c,sb])=>[sb.n+' ('+c+')',sb.total.toLocaleString()]))+'<div class="aiacts">'+last.map(([c,sb])=>`<button type="button" class="aiact p" data-v="${esc('Ask about '+sb.n)}" onclick="aiAsk(this.dataset.v)">Ask about ${esc(sb.n)}</button>`).join('')+'</div>'};
 }],
 ['whereis',n=>/^(find|where is|where s|which subject has|which category has|কোন বিষয়ে)\s+\S+/.test(n)&&n.split(' ').length<=5,null,async(o,t,nq)=>{
  const w=nq.replace(/^(find|where is|where s|which subject has|which category has|কোন বিষয়ে)\s+/,'').split(' ').filter(x=>x.length>=2);
  if(!w.length)return null;
  const E=await aiIndex(),cnt=new Map();
  E.forEach(e=>{if(w.some(x=>aiHit(e.all,x))){const k=qCat(e.q)+' › '+qSub(e.q);cnt.set(k,(cnt.get(k)||0)+1)}});
  const top=[...cnt].sort((a,b)=>b[1]-a[1]).slice(0,8);
  if(!top.length)return{lead:`No question mentions “${w.join(' ')}”.`,html:aiSuggestHTML(w)};
  return{lead:`“${w.join(' ')}” appears in these sub-categories:`,html:aiRows(top.map(([k,v])=>[k,v+' question'+(v>1?'s':'')]))};
 }]
);
async function aiX(o,nq,text,act){
 const bn=aiIsBn(text);
 for(const [id,test,needs,fn] of AIX){
  if(!test(nq,text))continue;
  if(needs==='quiz'&&!act)continue;
  if(needs==='last'&&!AIQ.cur)continue;
  if(needs==='set'&&!AIB.last)continue;
  if(needs==='setidle'&&(!AIB.last||act))continue;
  if(needs==='any'&&!(AIQ.cur||AIB.last))continue;
  if(needs==='cat'&&!o.cat)continue;
  const r=await fn(o,text,nq,o);if(r)return r;
 }
 return null;
}
// returns a reply object when the message is a quiz command, otherwise null
async function aiQuizCmd(text){
 const o=aiqParse(text),nq=o.nq,short=aiqLen(nq)<=7,act=AIQ.on&&AIQ.cur;
 if(AIF.on){const fr=aiFlashCmd(nq);if(fr)return fr}
 if(nq&&AIB.last&&!(act&&!AIQ.answered&&aiqLen(nq)<=1)){const mk=aiMarkSet(nq);if(mk)return mk}
 if(!nq||!short)return null;
 // printed sets: Next 10 / Random 10 / Mix 10 (a running multi-question quiz keeps "next 10" as "add 10 questions")
 {
  let kind=o.pure?(o.mix?'mix':o.rand?'random':(o.more&&o.n&&/(^| )(next|more|পরের|আরও|আরো)( |$)/.test(nq))?'next':null):null;
  if(kind==='next'&&act&&!AIQ.endless)kind=null;
  if(kind)return aiSetRun(kind,o);
 }
 // 1. commands that only make sense while a quiz exists
 {const xr=await aiX(o,nq,text,act);if(xr)return xr}
 if(act||AIQ.cur){
  if(AIQ_R.stop.test(nq)&&(act||/quiz|কুইজ|পরীক্ষা|টেস্ট|test/.test(nq))){
   if(!act)return{lead:'No quiz is running right now. Say “start quiz” to begin one.'};
   return aiqFinish(true);
  }
  if(AIQ_R.score.test(nq)&&!/sort|list|show my wrong/.test(nq)){
   const t=AIQ.right.length+AIQ.wrong.length+AIQ.skipped.length;
   if(!t)return{lead:'No score yet. Answer a question first.'};
   return{lead:`Your score: **${AIQ.right.length} / ${t}** (${Math.round(AIQ.right.length/t*100)}%)${act?`, question ${AIQ.i+1} of ${AIQ.qs.length}`:''}.`,html:aiqScoreHTML()};
  }
 }
 if(act){
  const q=AIQ.cur;
  if(AIQ_R.hint.test(nq)){
   if(AIQ.answered)return{lead:'You already answered this one. Say “next” for the next question.'};
   AIQ.hints++;
   if(isText(q)){const a=q.ans[0];return{lead:`Hint: the answer starts with “${a.slice(0,AIQ.hints)}” and has ${a.length} characters.`}}
   const wrongIdx=q.o.map((x,j)=>j).filter(j=>j!==q.a);
   if(AIQ.hints===1){const rm=shuffle(wrongIdx).slice(0,Math.min(2,wrongIdx.length-1)).sort();return{lead:`Hint: it is not ${rm.map(j=>'**'+'ABCDEFGH'[j]+'**').join(' or ')}.`}}
   const a=aiAns(q);return{lead:`Hint: the answer starts with “${a.slice(0,Math.min(2,a.length))}” and has ${a.length} characters.`+(q.e?'':'')};
  }
  if(AIQ_R.explain.test(nq)){
   const reveal=!AIQ.answered;
   if(reveal){AIQ.answered=true;AIQ.skipped.push(q)}
   return{lead:`${reveal?'(Counted as skipped.) ':''}The answer is **${aiqAnswerLine(q)}**.${q.e?'\n💡 '+q.e:'\nThere is no saved explanation for this question.'}`,html:aiqActs('<button type="button" class="aiact p" onclick="aiAsk(\'next\')">Next ▶</button>').replace(/<button[^>]*hint[^>]*>.*?<\/button>|<button[^>]*skip[^>]*>.*?<\/button>/g,'')};
  }
  if(AIQ_R.skip.test(nq)){
   if(AIQ.answered)return aiqAdvance();
   AIQ.skipped.push(q);AIQ.answered=true;
   return aiqAdvance(`Skipped. (Answer: **${aiqAnswerLine(q)}**)`);
  }
 }
 // 2. counts, subjects, difficulty, start and next
 const isNext=AIQ_R.next.test(nq)&&!o.n&&(o.pure||/^(next|পরের|আরেক|আরও|আরো|নতুন)/.test(nq))&&!o.subjKey&&!o.diff;
 if(act&&o.n&&o.more&&!o.subjKey)return aiqExtend(o.n);
 if(act&&isNext){
  if(!AIQ.answered){AIQ.skipped.push(AIQ.cur);AIQ.answered=true;return aiqAdvance(`Skipped. (Answer: **${aiqAnswerLine(AIQ.cur)}**)`)}
  return aiqAdvance();
 }
 if(act&&o.pure&&o.diff&&!o.n&&!o.subjKey&&!o.cat){
  // switch difficulty for the questions that have not been shown yet
  const E=await aiIndex(),left=Math.max(1,AIQ.qs.length-AIQ.i-1);
  AIQ.diff=o.diff;
  const picks=aiqPick(aiqPool(E,{cat:AIQ.cat,sub:AIQ.sub},AIQ.used),left,o.diff);
  if(!picks.length)return{lead:'No other questions are left in this selection.'};
  AIQ.qs=AIQ.qs.slice(0,AIQ.i+1).concat(picks);AIQ.n=AIQ.qs.length;
  const lead=`Switched to **${o.diff}** questions.`;
  return AIQ.answered?aiqAdvance(lead):{lead:lead+' The next ones will be '+o.diff+'. Keep answering this one.'};
 }
 if(act&&!o.pure){
  // 3. an answer to the current question
  const q=AIQ.cur;
  if(AIQ.answered){
   if(/^(a|b|c|d|এ|বি|সি|ডি|1|2|3|4)$/.test(words2(nq)))return{lead:'You already answered this one. Say “next” for the next question.'};
  }else{
   let li=null;
   if(!isText(q)){
    const core=nq.split(' ').filter(w=>!AIQ_NOISE.has(w)||(w==='a'&&nq.split(' ').filter(x=>!AIQ_NOISE.has(x)).length===0));
    const tok=core.length===1?core[0]:null;
    if(tok!==null&&tok in AIQ_LET&&AIQ_LET[tok]<q.o.length)li=AIQ_LET[tok];
    else{const hit=q.o.findIndex(x=>normA(x)===normA(text));if(hit>=0)li=hit}
    if(li===null)return null;
   }
   return aiqRespond(q,text,li);
  }
 }
 // 3b. letter answers where the parser called the message "pure" (e.g. "A") are handled here
 if(act&&!AIQ.answered){
  const q=AIQ.cur;
  if(isText(q)&&!AIQ_R.start.test(nq)&&!o.subjKey)return aiqRespond(q,text,null);
  if(!isText(q)){
   const core=nq.split(' ').filter(w=>!AIQ_NOISE.has(w)),tok=core.length===1?core[0]:(nq==='a'?'a':null);
   if(tok!==null&&tok in AIQ_LET&&AIQ_LET[tok]<q.o.length)return aiqRespond(q,text,AIQ_LET[tok]);
  }
 }
 // 4. start a new quiz (or a "next question" when no quiz is running)
 if(!act){
  if(o.pure&&o.n&&o.more&&AIQ.last&&!o.subjKey)return aiqStart(Object.assign({},AIQ.last,{n:o.n}));
  const nextOnly=AIQ_R.next.test(nq)&&o.pure&&!o.subjKey&&!o.diff&&!o.n;
  if(nextOnly)return aiqStart(AIQ.last||{n:10});
  if(o.pure&&(o.start||o.ask||o.subjKey||o.diff||o.n||nextOnly||/(^| )(quiz|mcq|mcqs|কুইজ|questions?|প্রশ্ন)( |$)/.test(nq))){
   const prev=AIQ.last||{};
   return aiqStart({cat:o.cat,sub:o.sub,diff:o.diff,n:o.ask?1:(o.n||10),subjKey:o.subjKey,ask:o.ask,bn:/[\u0980-\u09FF]/.test(text)});
  }
 }else if(o.pure&&(o.start||o.subjKey||o.n||o.diff||o.ask)){
  // restart with new settings while a quiz is running
  return aiqStart({cat:o.cat,sub:o.sub,diff:o.diff,n:o.ask?1:(o.n||10),subjKey:o.subjKey,ask:o.ask,bn:/[\u0980-\u09FF]/.test(text)});
 }
 return null;
}
function words2(nq){return nq.split(' ').filter(w=>!AIQ_NOISE.has(w)).join(' ')}
function aiqRespond(q,text,li){
 const ok=aiqGrade(q,text,li);AIQ.answered=true;
 (ok?AIQ.right:AIQ.wrong).push(q);
 if(ok){AIQ.streak++;AIQ.best=Math.max(AIQ.best,AIQ.streak)}else AIQ.streak=0;
 const last=AIQ.i+1>=AIQ.qs.length&&!AIQ.endless;
 const lead=ok?'✅ **Correct!**':`❌ **Not quite.** The right answer is **${aiqAnswerLine(q)}**.`;
 const exp=q.e?`<div class="explain"><b>💡 Explanation</b><br>${esc(q.e)}</div>`:'';
 return{lead:lead+(ok&&q.e&&q.e.length<140?' '+q.e:''),html:(ok&&q.e&&q.e.length<140?'':exp)+'<div class="aiacts"><button type="button" class="aiact p" onclick="aiAsk(\'next\')">'+(last?'See result':'Next ▶')+'</button><button type="button" class="aiact" onclick="aiAsk(\'score\')">📊 Score</button><button type="button" class="aiact" onclick="aiAsk(\'stop\')">⏹ Stop</button></div>'};
}

function currentQuestionForAI(){
 try{
  if(AIQ&&AIQ.cur)return AIQ.cur;
  if(daily&&Array.isArray(daily.qs)&&qs('daily')?.classList.contains('active'))return daily.qs[dailyPos()];
  if(sl&&sl.list&&qs('slider')?.classList.contains('active'))return sl.list[sl.i];
  if(session&&Array.isArray(session.qs)&&qs('exam')?.classList.contains('active'))return session.qs[session.i||0];
 }catch(e){}
 return null;
}
function findQuestionById(id){
 const n=Number(id);let q=custom.find(x=>Number(x.id)===n||Number(x.dbId)===n);if(q)return q;
 for(const p of [daily&&daily.qs,session&&session.questions,typeof sl!=='undefined'&&sl&&sl.list,typeof AIQ!=='undefined'&&AIQ&&AIQ.qs]){if(!Array.isArray(p))continue;const f=p.find(x=>x&&Number(x.id)===n);if(f)return f}
 return null;
}
function aiAskSame(id){
 const q=findQuestionById(id)||currentQuestionForAI();
 if(!q)return show('ai');
 show('ai');
 setTimeout(()=>aiAsk(q.q),120);
}
function aiAskSameFromCurrent(){aiAskSame(null)}

async function aiAsk(text){
 text=String(text||'').trim();if(!text||AI.busy)return;
 AI.busy=true;aiPush('user',esc(text));AI.hist.push({role:'user',content:text});
 const typing=aiTyping();
 try{
  let r=await aiQuizCmd(text);
  if(!r){
   const p=aiPlan(text);
   const E=(p.intent==='help'||p.intent==='calc')?[]:await aiIndex();
   r=await aiHandle(p,E);
  }
  typing.remove();await aiReply(r);
 }catch(e){
  typing.remove();await aiReply({lead:'I could not read the questions just now. Check your connection and try again.'});
 }
 AI.busy=false;
}
function aiSugs(){
 const a=CAT.map(c=>c.c),m=a.find(x=>/math/i.test(x))||a[0]||'Math';
 const s=['Ask question','Ask AI this question','Explain the same question','Why are the other options wrong?','Make 5 similar questions','Make a harder version','Give me a hint','Mix 10 from my database','Find duplicate questions','Show my weakest topic','How many questions do I have?','Start quiz','Quiz me on '+m,'Show '+m+' questions','Slideshow of '+m,'What is 15% of 240?'];
 qs('aiSug').innerHTML=s.map(t=>chipBtn(false,'',`data-v="${esc(t)}" onclick="aiAsk(this.dataset.v)"`,`<span>${esc(t)}</span>`)).join('');
}
function aiWelcome(){
 qs('aiChat').innerHTML='';AI.hist=[];AI.lists={};aiqReset();AIQ.last=null;AICTX.cat=AICTX.sub=null;AICTX.used=new Set();AIB.last=null;
 aiPush('bot',aiMd("Hi! I'm **MCQ AI**. I read every question in your bank, sort them, answer them and quiz you. Ask me anything, or tap a suggestion below."));
 aiSugs();
}
function aiInit(){
 qs('aiStatus').textContent=aiCfg.key?'Gemini on · also reads your MCQ bank':'Reads your MCQ bank';
 if(!AI.started){AI.started=true;aiWelcome()}
 srchEnsure().catch(()=>{}); // warm up the index while the person reads the welcome
}
function aiToggleSet(){
 const b=qs('aiSet'),o=b.style.display==='none';b.style.display=o?'block':'none';
 if(o){qs('aiKey').value=aiCfg.key||'';qs('aiModel').value=/^gemini/i.test(aiCfg.model||'')?aiCfg.model:''}
}
function aiSaveCfg(){
 aiCfg={key:qs('aiKey').value.trim(),model:qs('aiModel').value.trim(),auto:''};
 put(AI_CFG_KEY,aiCfg);qs('aiSet').style.display='none';aiInit();toast(aiCfg.key?'Online AI connected':'Saved');
}
function aiClearCfg(){aiCfg={};try{MCQ_STORE.remove(AI_CFG_KEY)}catch(e){}qs('aiSet').style.display='none';aiInit();toast('Key removed')}
function aiGrow(t){t.style.height='auto';t.style.height=Math.min(120,t.scrollHeight)+'px'}
function aiKey(e){if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();aiSend()}}
function aiSend(){const t=qs('aiIn'),v=t.value;t.value='';aiGrow(t);aiAsk(v)}


loadCats();refreshHome();restoreTimerPref();installUi();netUi();setTbh();
segPaintAll();setupSummary();
// home-screen shortcuts open a page directly: index.html?view=daily | search | practice | read | bank | history | manage
{const v=new URLSearchParams(location.search).get('view');if(v&&['daily','search','practice','read','bank','history','manage','ai','slider'].includes(v))show(v)}




/* ---- animated placeholder in the Search bar ---- */
(function(){
 const EX=['Search questions…','Try: স্বাধীনতা','Try: synonym','Try: tense','Try: ২৫%','Try: ত্রিভুজ','Try: capital','Try: বাংলা সাহিত্য'];
 let ei=0,ci=0,del=false,timer=null;
 const reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
 function tick(){
  const inp=qs('srchQ'),v=qs('search');
  if(!inp||!v||!v.classList.contains('active')||inp.value){if(inp)inp.placeholder='Search questions…';timer=null;return}
  const t=EX[ei];
  if(!del){ci++;inp.placeholder=t.slice(0,ci)+'▍';if(ci>=t.length){del=true;timer=setTimeout(tick,1300);return}}
  else{ci--;inp.placeholder=t.slice(0,ci)+'▍';if(ci<=0){del=false;ei=(ei+1)%EX.length}}
  timer=setTimeout(tick,del?28:70);
 }
 function kick(){if(reduce||timer)return;ci=0;del=false;timer=setTimeout(tick,500)}
 document.addEventListener('focusout',e=>{if(e.target&&e.target.id==='srchQ')setTimeout(kick,300)});
 document.addEventListener('input',e=>{if(e.target&&e.target.id==='srchQ'&&!e.target.value)kick()});
 new MutationObserver(()=>{const v=qs('search');if(v&&v.classList.contains('active'))kick();else{clearTimeout(timer);timer=null}}).observe(document.getElementById('search'),{attributes:true,attributeFilter:['class']});
 if(qs('search').classList.contains('active'))kick();
})();
