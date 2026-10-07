/* MCQ Master · features.js
 * Dashboard (streak, daily goal, XP/level) · Progress charts · Achievements · Leaderboard
 * Accounts + cloud sync (Supabase Auth) · Light/Dark theme + font size · Splash screen
 *
 * Loaded AFTER script.js. It needs: supabase.js (MCQ_DB.client), plus.css, schema_accounts.sql.
 * Nothing here breaks the app when the account tables are missing: sync / leaderboard just show a message.
 */
(function () {
  "use strict";

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
  const isObj = v => v && typeof v === "object" && !Array.isArray(v);
  const num = n => (+n || 0).toLocaleString();

  const PK = "mcq_plus_v1", TK = "mcq_theme_v1", META = "mcq_sync_meta_v1";
  // everything that is progress (the AI key and your own saved questions are NOT synced)
  const SYNC_KEYS = ["mcq_more_practice_v2", "mcq_history_v2", "mcq_important_v1", "mcq_need10_v1", "mcq_seen_v1",
    "mcq_seenk_v1", "mcq_skipped_v1", "mcq_searched_v1", "mcq_daily_v2", "mcq_timer_pref_v1", PK];

  const _get = Storage.prototype.getItem, _set = Storage.prototype.setItem, _rm = Storage.prototype.removeItem;
  const rd = (k, f) => { try { const v = JSON.parse(_get.call(localStorage, k)); return v == null ? f : v; } catch (e) { return f; } };
  const sb = () => (window.MCQ_DB && MCQ_DB.enabled && MCQ_DB.client) || null;
  const toast = (t, ms) => { if (typeof window.toast === "function") window.toast(t, ms); };

  /* =========================================================
     1. THEME + FONT SIZE
     ========================================================= */
  const FONTS = [["Small", .92], ["Normal", 1], ["Large", 1.12], ["Extra large", 1.25]];
  const theme = () => Object.assign({ mode: "dark", fs: 1 }, rd(TK, {}));
  function applyTheme() {
    const t = theme();
    const light = t.mode === "light" || (t.mode === "auto" && window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches);
    const root = document.documentElement;
    root.classList.toggle("theme-light", light);
    root.style.setProperty("--mq-zoom", t.fs);
    const m1 = document.querySelector('meta[name="theme-color"]'), m2 = document.querySelector('meta[name="color-scheme"]');
    if (m1) m1.setAttribute("content", light ? "#eef2fa" : "#0a1020");
    if (m2) m2.setAttribute("content", light ? "light" : "dark");
  }
  if (window.matchMedia) matchMedia("(prefers-color-scheme: light)").addEventListener("change", applyTheme);
  function setTheme(mode) { const t = theme(); t.mode = mode; _set.call(localStorage, TK, JSON.stringify(t)); applyTheme(); renderAccount(); }
  function setFont(v) { const t = theme(); t.fs = +v; _set.call(localStorage, TK, JSON.stringify(t)); applyTheme(); renderAccount(); setTimeout(() => window.dispatchEvent(new Event("resize")), 50); }

  /* =========================================================
     2. PROGRESS DATA (streak, goal, XP, charts, badges)
     ========================================================= */
  const dayKey = d => { d = d || new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const dn = k => Math.round(new Date(k + "T00:00:00").getTime() / 864e5);
  function normP(p) {
    p = isObj(p) ? p : {};
    p.days = isObj(p.days) ? p.days : {}; p.cats = isObj(p.cats) ? p.cats : {};
    p.trend = Array.isArray(p.trend) ? p.trend : []; p.badges = isObj(p.badges) ? p.badges : {};
    p.goal = +p.goal || 50;
    return p;
  }
  let P = normP(rd(PK, {}));
  const saveP = () => { try { localStorage.setItem(PK, JSON.stringify(P)); } catch (e) {} };

  const levelOf = xp => { const L = Math.floor(Math.sqrt(xp / 150)) + 1, base = 150 * (L - 1) ** 2, next = 150 * L * L; return { L, base, next, pct: Math.max(0, Math.min(100, Math.round((xp - base) / (next - base) * 100))) }; };

  function streaks() {
    const ks = Object.keys(P.days).filter(k => (P.days[k].a || 0) > 0).sort();
    let best = 0, run = 0, prev = null;
    for (const k of ks) { const n = dn(k); run = (prev !== null && n - prev === 1) ? run + 1 : 1; if (run > best) best = run; prev = n; }
    const gap = prev === null ? 99 : dn(dayKey()) - prev;
    return { cur: gap <= 1 ? run : 0, best };
  }
  function summary() {
    let a = 0, c = 0, e = 0, x = 0, p = 0, d = 0, gd = 0;
    for (const k in P.days) { const v = P.days[k]; a += v.a || 0; c += v.c || 0; e += v.e || 0; x += v.x || 0; p += v.p || 0; d += v.d || 0; gd += v.g ? 1 : 0; }
    const st = streaks(), lv = levelOf(x);
    return { a, c, e, x, p, d, gd, acc: a ? Math.round(c / a * 100) : 0, cur: st.cur, best: st.best, L: lv.L, lv };
  }
  const todayA = () => (P.days[dayKey()] && P.days[dayKey()].a) || 0;
  function weekKey() { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dayKey(d); }
  function weekXp() { const wk = weekKey(); let s = 0; for (const k in P.days) if (k >= wk) s += P.days[k].x || 0; return s; }

  const BADGES = [
    { id: "first", i: "🎯", n: "First Steps", d: "Finish your first exam", t: s => s.e >= 1 },
    { id: "a100", i: "💯", n: "Century", d: "Answer 100 questions", t: s => s.a >= 100 },
    { id: "a500", i: "📚", n: "Bookworm", d: "Answer 500 questions", t: s => s.a >= 500 },
    { id: "a1000", i: "🧠", n: "Brainiac", d: "Answer 1,000 questions", t: s => s.a >= 1000 },
    { id: "a5000", i: "🏛️", n: "Scholar", d: "Answer 5,000 questions", t: s => s.a >= 5000 },
    { id: "s3", i: "🔥", n: "On Fire", d: "3-day streak", t: s => s.best >= 3 },
    { id: "s7", i: "⚡", n: "Week Warrior", d: "7-day streak", t: s => s.best >= 7 },
    { id: "s30", i: "🌋", n: "Unstoppable", d: "30-day streak", t: s => s.best >= 30 },
    { id: "perf", i: "🏆", n: "Perfectionist", d: "100% in an exam of 10+ questions", t: s => s.p >= 1 },
    { id: "d50", i: "📅", n: "Daily Driver", d: "Finish a Daily 50", t: s => s.d >= 1 },
    { id: "goal7", i: "🎖️", n: "Goal Getter", d: "Reach your daily goal on 7 days", t: s => s.gd >= 7 },
    { id: "acc80", i: "🎓", n: "Sharp Mind", d: "80% accuracy over 200+ answers", t: s => s.a >= 200 && s.acc >= 80 },
    { id: "l5", i: "⭐", n: "Rising Star", d: "Reach level 5", t: s => s.L >= 5 },
    { id: "l10", i: "👑", n: "Master", d: "Reach level 10", t: s => s.L >= 10 }
  ];
  let freshBadges = new Set();
  function checkBadges(silent) {
    const s = summary(); let any = false;
    for (const b of BADGES) {
      if (!P.badges[b.id] && b.t(s)) {
        P.badges[b.id] = Date.now(); any = true; freshBadges.add(b.id);
        if (!silent) toast("🏅 Badge unlocked: " + b.n, 3500);
      }
    }
    if (any) saveP();
  }

  // called by script.js every time an exam / Daily 50 is finished
  function onResult(h) {
    if (!h || !(h.total > 0)) return;
    const k = dayKey(), v = P.days[k] || (P.days[k] = { a: 0, c: 0, e: 0, x: 0, g: 0, p: 0, d: 0 });
    const c = +h.correct || 0, w = +h.wrong || 0, gain = c * 10 + w * 2 + 20;
    v.a += c + w; v.c += c; v.e++; v.x += gain;
    if (+h.percent >= 100 && h.total >= 10) v.p = (v.p || 0) + 1;
    if (h.cat === "Daily 50") v.d = (v.d || 0) + 1;
    const hit = !v.g && v.a >= P.goal; if (hit) v.g = 1;
    const ct = P.cats[h.cat] || (P.cats[h.cat] = { a: 0, c: 0 }); ct.a += c + w; ct.c += c;
    P.trend.push({ t: h.ts || Date.now(), p: +h.percent || 0, n: h.cat }); P.trend = P.trend.slice(-40);
    saveP();
    toast("+" + gain + " XP" + (hit ? " · 🎯 Daily goal reached!" : ""), 2600);
    checkBadges(); renderHome(); queueBoard();
  }

  /* ---------- home dashboard card ---------- */
  function renderHome() {
    const el = $("plusHome"); if (!el) return;
    const s = summary(), a = todayA(), pct = Math.min(1, a / P.goal);
    const bars = []; let mx = Math.max(P.goal, 1);
    for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const k = dayKey(d), v = (P.days[k] && P.days[k].a) || 0; bars.push({ v, today: i === 0 }); if (v > mx) mx = v; }
    el.innerHTML = `<div class="pl-card pl-home" role="button" tabindex="0" onclick="show('stats')" onkeydown="if(event.key==='Enter')show('stats')">
      <div class="pl-ring"><svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="plGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6375ff"/><stop offset="1" stop-color="#46e0aa"/></linearGradient></defs><circle class="bg" cx="50" cy="50" r="46"/><circle class="fg" id="plRingFg" cx="50" cy="50" r="46" style="stroke-dashoffset:289"/></svg>
        <div class="ct"><b>${num(a)}</b><span>of ${P.goal} today</span></div></div>
      <div class="pl-side">
        <div class="pl-chips"><span class="pl-chip ${s.cur ? "hot" : ""}"><span class="${s.cur ? "fl" : ""}">🔥</span>${s.cur} day${s.cur === 1 ? "" : "s"}</span><span class="pl-chip">⭐ Level ${s.L}</span></div>
        <div class="pl-xp"><i style="width:0" id="plXpFg"></i></div>
        <div class="pl-xpt"><span>${num(s.x)} XP</span><span>${num(s.lv.next - s.x)} to Lv ${s.L + 1}</span></div>
        <div class="pl-week" aria-label="Last 7 days">${bars.map(b => `<i class="${b.v ? "on" : ""} ${b.today ? "today" : ""}" style="height:${Math.max(4, Math.round(b.v / mx * 34))}px"></i>`).join("")}</div>
      </div></div>`;
    setTimeout(() => {
      const r = $("plRingFg"), x = $("plXpFg");
      if (r) r.style.strokeDashoffset = String(289 * (1 - pct));
      if (x) x.style.width = s.lv.pct + "%";
    }, 60);
  }

  /* ---------- progress view ---------- */
  function barsSVG() {
    const n = 14, W = 320, L = 6, R = 6, top = 14, base = 100, slot = (W - L - R) / n, data = [];
    for (let i = n - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const k = dayKey(d); data.push({ day: d.getDate(), a: (P.days[k] && P.days[k].a) || 0 }); }
    const max = Math.max(P.goal, ...data.map(x => x.a), 1) * 1.1, y = v => base - (v / max) * (base - top);
    const bars = data.map((x, i) => { const h = Math.max(x.a ? 2 : 0, base - y(x.a)), bx = L + i * slot + (slot - 14) / 2;
      return `<rect class="plbar ${x.a >= P.goal ? "hit" : ""}" x="${bx.toFixed(1)}" y="${(base - h).toFixed(1)}" width="14" height="${h.toFixed(1)}" rx="4" style="animation-delay:${i * 35}ms"/>` +
        (x.a ? `<text x="${(bx + 7).toFixed(1)}" y="${(base - h - 3).toFixed(1)}" text-anchor="middle" style="font-size:8px">${x.a}</text>` : "") +
        `<text x="${(bx + 7).toFixed(1)}" y="114" text-anchor="middle" style="font-size:8px">${x.day}</text>`; }).join("");
    return `<svg class="pl-chart pl-bars" viewBox="0 0 ${W} 120" role="img" aria-label="Questions answered per day, last 14 days"><line class="goal" x1="${L}" x2="${W - R}" y1="${y(P.goal).toFixed(1)}" y2="${y(P.goal).toFixed(1)}"/><text x="${W - R}" y="${(y(P.goal) - 3).toFixed(1)}" text-anchor="end" style="fill:#f5b942;font-size:8px">goal ${P.goal}</text>${bars}</svg>`;
  }
  function lineSVG() {
    const pts = P.trend.slice(-20);
    if (pts.length < 2) return `<div class="pl-empty">📈<b>Not enough data yet</b>Finish at least 2 exams to see your accuracy trend.</div>`;
    const W = 320, L = 28, R = 8, top = 10, bot = 112, n = pts.length;
    const X = i => L + (W - L - R) * (i / (n - 1)), Y = p => bot - (Math.max(0, Math.min(100, p)) / 100) * (bot - top);
    const line = pts.map((p, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(p.p).toFixed(1)).join(" ");
    const area = line + ` L${X(n - 1).toFixed(1)} ${bot} L${X(0).toFixed(1)} ${bot} Z`;
    const grid = [0, 50, 100].map(v => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#243153" stroke-width="1"/><text x="${L - 5}" y="${Y(v) + 3}" text-anchor="end">${v}%</text>`).join("");
    return `<svg class="pl-chart" viewBox="0 0 ${W} 124" role="img" aria-label="Exam accuracy trend"><defs><linearGradient id="plArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#46e0aa" stop-opacity=".35"/><stop offset="1" stop-color="#46e0aa" stop-opacity="0"/></linearGradient></defs>${grid}<path class="pl-area" d="${area}"/><path class="pl-line" d="${line}"/>${pts.map((p, i) => `<circle class="pl-dot" cx="${X(i).toFixed(1)}" cy="${Y(p.p).toFixed(1)}" r="3"><title>${esc(p.n || "")} ${Math.round(p.p)}%</title></circle>`).join("")}</svg>`;
  }
  function renderStats() {
    const el = $("statsBody"); if (!el) return;
    const s = summary(), a = todayA();
    const cats = Object.entries(P.cats).filter(([, v]) => v.a > 0).sort((x, y) => y[1].a - x[1].a).slice(0, 8);
    const col = p => p >= 70 ? "#46e0aa" : p >= 40 ? "#f5b942" : "#ff7185";
    el.innerHTML = `
      <div class="pl-tiles"><div class="pl-tile"><b>${num(s.a)}</b><span>Answered</span></div><div class="pl-tile"><b>${s.acc}%</b><span>Accuracy</span></div>
        <div class="pl-tile"><b>🔥 ${s.cur}</b><span>Current streak</span></div><div class="pl-tile"><b>🏅 ${s.best}</b><span>Best streak</span></div></div>
      <div class="pl-card"><div class="pl-hd"><h3>⭐ Level ${s.L}</h3><span class="muted">${num(s.x)} XP</span></div>
        <div class="pl-xp"><i style="width:${s.lv.pct}%"></i></div><div class="pl-xpt"><span>${num(s.x - s.lv.base)} / ${num(s.lv.next - s.lv.base)} XP</span><span>Lv ${s.L + 1}</span></div>
        <p class="muted" style="font-size:12px;margin:10px 0 0">+10 XP per correct answer, +2 per wrong answer, +20 for finishing an exam.</p></div>
      <div class="pl-card"><div class="pl-hd"><h3>🎯 Daily goal</h3><span class="muted">${num(a)} / ${P.goal} today</span></div>
        <div class="pl-seg">${[10, 25, 50, 100, 150].map(g => `<button type="button" class="${P.goal === g ? "on" : ""}" onclick="MQ.setGoal(${g})">${g}</button>`).join("")}</div></div>
      <div class="pl-card"><h3>📊 Questions per day <span class="muted" style="font-weight:400">(last 14 days)</span></h3>${barsSVG()}</div>
      <div class="pl-card"><h3>📈 Exam accuracy <span class="muted" style="font-weight:400">(last 20 exams)</span></h3>${lineSVG()}</div>
      <div class="pl-card pl-cats"><h3>🗂️ Accuracy by subject</h3>${cats.length ? cats.map(([n, v]) => { const p = Math.round(v.c / v.a * 100); return `<div class="row"><span title="${esc(n)}">${esc(n)}</span><div class="track"><i style="width:${p}%;background:${col(p)}"></i></div><small>${p}%</small></div>`; }).join("") : `<div class="pl-empty">🗂️<b>No data yet</b>Finish an exam to see how you do in each subject.</div>`}</div>
      <div class="pl-card"><div class="pl-hd"><h3>🏅 Achievements</h3><button type="button" class="pl-link" onclick="MQ.boardTab('badges');show('board')">See all ›</button></div>
        <p class="muted" style="margin:0">${Object.keys(P.badges).length} of ${BADGES.length} unlocked</p></div>`;
  }
  function setGoal(g) {
    P.goal = +g; const v = P.days[dayKey()]; if (v && v.a >= P.goal) v.g = 1;
    saveP(); renderStats(); renderHome(); queueBoard();
  }

  /* =========================================================
     3. LEADERBOARD + ACHIEVEMENTS
     ========================================================= */
  let bTab = "rank", bMode = "all", bRows = null, bErr = "", bLoading = false;
  const displayName = () => (user && ((user.user_metadata && user.user_metadata.display_name) || (user.email || "").split("@")[0])) || "Learner";
  const errText = e => {
    const m = String((e && (e.message || e.error_description)) || e || "");
    if (e && (e.code === "42P01" || e.code === "PGRST205" || /relation .* does not exist|schema cache/i.test(m))) return "Accounts are not set up yet. Run schema_accounts.sql in the Supabase SQL Editor.";
    if (/Invalid login/i.test(m)) return "Wrong email or password.";
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "No internet connection.";
    return m || "Something went wrong.";
  };
  function boardRow() {
    const s = summary();
    return { user_id: user.id, display_name: displayName().slice(0, 24), xp: s.x, level: s.L, answered: s.a, correct: s.c, streak: s.cur, week_key: weekKey(), week_xp: weekXp(), updated_at: new Date().toISOString() };
  }
  let boardT = 0;
  function queueBoard() { if (!user) return; clearTimeout(boardT); boardT = setTimeout(pushBoard, 2500); }
  async function pushBoard() {
    if (!user || !sb() || !navigator.onLine) return;
    try { const { error } = await sb().from("leaderboard").upsert(boardRow(), { onConflict: "user_id" }); if (error) throw error; }
    catch (e) { console.warn("leaderboard:", e); }
  }
  async function loadBoard() {
    const c = sb(); bErr = ""; bRows = null; bLoading = true; renderBoard(true);
    if (!c) { bLoading = false; bErr = "The database is not connected."; return renderBoard(true); }
    try {
      const col = bMode === "week" ? "week_xp" : "xp";
      let q = c.from("leaderboard").select("user_id,display_name,xp,level,answered,correct,streak,week_xp,week_key").gt(col, 0);
      if (bMode === "week") q = q.eq("week_key", weekKey());
      const { data, error } = await q.order(col, { ascending: false }).limit(50);
      if (error) throw error;
      bRows = data || [];
    } catch (e) { bErr = errText(e); }
    bLoading = false; renderBoard(true);
  }
  function renderBoard(fromLoad) {
    const el = $("boardBody"); if (!el) return;
    const tabs = `<div class="pl-tabs"><button type="button" class="${bTab === "rank" ? "on" : ""}" onclick="MQ.boardTab('rank')">🏆 Leaderboard</button><button type="button" class="${bTab === "badges" ? "on" : ""}" onclick="MQ.boardTab('badges')">🏅 Achievements</button></div>`;
    if (bTab === "badges") {
      const s = summary();
      el.innerHTML = tabs + `<p class="muted" style="margin:0 0 12px">${Object.keys(P.badges).length} of ${BADGES.length} unlocked · ${num(s.x)} XP · Level ${s.L}</p><div class="bdgs">` +
        BADGES.map((b, i) => { const on = !!P.badges[b.id]; return `<div class="bdg ${on ? "on" : "off"} ${freshBadges.has(b.id) ? "new" : ""}" style="animation-delay:${i * 30}ms"><span class="bi2">${b.i}</span><b>${esc(b.n)}</b><small>${esc(b.d)}</small></div>`; }).join("") + `</div>`;
      freshBadges = new Set(); return;
    }
    if (!fromLoad && bRows === null && !bLoading) { loadBoard(); return; }
    const seg = `<div class="pl-seg" style="margin-bottom:14px"><button type="button" class="${bMode === "all" ? "on" : ""}" onclick="MQ.boardMode('all')">All time</button><button type="button" class="${bMode === "week" ? "on" : ""}" onclick="MQ.boardMode('week')">This week</button></div>`;
    let body;
    if (bLoading) body = Array.from({ length: 6 }, () => `<span class="skel skelrow"></span>`).join("");
    else if (bErr) body = `<div class="pl-empty">⚠️<b>Cannot load the leaderboard</b>${esc(bErr)}<div class="pl-btns" style="justify-content:center;margin-top:12px"><button type="button" class="btn" onclick="MQ.refreshBoard()">Try again</button></div></div>`;
    else if (!bRows || !bRows.length) body = `<div class="pl-empty">🏁<b>No one is on the board yet</b>Finish an exam while signed in to be the first.</div>`;
    else body = bRows.map((r, i) => { const me = user && r.user_id === user.id, v = bMode === "week" ? r.week_xp : r.xp;
      return `<div class="lb-row ${me ? "me" : ""}" style="animation-delay:${Math.min(i, 12) * 35}ms"><div class="lb-rank">${i < 3 ? ["🥇", "🥈", "🥉"][i] : i + 1}</div><div class="lb-name"><b>${esc(r.display_name)}${me ? " (you)" : ""}</b><small>Lv ${r.level} · ${num(r.answered)} answered · 🔥 ${r.streak}</small></div><div class="lb-xp">${num(v)}<small>XP</small></div></div>`; }).join("");
    const join = user ? "" : `<div class="pl-card" style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap"><div><b>Join the leaderboard</b><div class="muted" style="font-size:13px">Sign in to appear here and sync your progress.</div></div><button type="button" class="btn primary" onclick="show('account')">Sign in</button></div>`;
    el.innerHTML = tabs + join + seg + body;
  }

  /* =========================================================
     4. ACCOUNT (Supabase Auth) + CLOUD SYNC
     ========================================================= */
  let user = null, recovery = false, accMode = "in", syncState = "idle", syncNote = "", seq = 0, syncBusy = false, pushT = 0, applying = false;
  const metaGet = () => rd(META, {});
  const metaSet = m => _set.call(localStorage, META, JSON.stringify(m));
  const snapshot = () => { const o = {}; for (const k of SYNC_KEYS) { const v = _get.call(localStorage, k); if (v != null) o[k] = v; } return o; };

  function setSync(st, note) { syncState = st; syncNote = note || ""; const e = $("plSync"); if (e) { e.className = "pl-sync " + (st === "busy" ? "busy" : st === "err" ? "err" : ""); e.innerHTML = `<i></i>${esc(st === "busy" ? "Syncing…" : st === "err" ? (note || "Sync failed") : "Synced")}`; } }

  // every change to a progress key marks the account dirty and uploads it a moment later
  function dirty() { if (!user || applying) return; seq++; const m = metaGet(); m.uid = user.id; m.dirty = true; metaSet(m); setSync("busy"); clearTimeout(pushT); pushT = setTimeout(push, 3500); }
  Storage.prototype.setItem = function (k, v) { _set.call(this, k, v); if (this === window.localStorage && SYNC_KEYS.indexOf(k) >= 0) dirty(); };
  Storage.prototype.removeItem = function (k) { _rm.call(this, k); if (this === window.localStorage && SYNC_KEYS.indexOf(k) >= 0) dirty(); };

  async function push() {
    if (!user || !sb()) return;
    if (!navigator.onLine) return setSync("err", "Offline");
    if (syncBusy) { clearTimeout(pushT); pushT = setTimeout(push, 1500); return; }
    syncBusy = true; const mySeq = seq;
    try {
      const at = new Date().toISOString();
      const { error } = await sb().from("user_data").upsert({ user_id: user.id, data: { v: 1, items: snapshot() }, updated_at: at }, { onConflict: "user_id" });
      if (error) throw error;
      metaSet({ uid: user.id, at, dirty: seq !== mySeq });
      if (seq !== mySeq) { clearTimeout(pushT); pushT = setTimeout(push, 800); } else setSync("ok");
    } catch (e) { console.warn("sync push:", e); setSync("err", errText(e)); }
    finally { syncBusy = false; }
  }

  function mergePlus(a, b) {
    a = normP(a); b = normP(b); const o = normP({}); o.goal = a.goal;
    for (const k of new Set([...Object.keys(a.days), ...Object.keys(b.days)])) {
      const x = a.days[k] || {}, y = b.days[k] || {}, r = {};
      for (const f of ["a", "c", "e", "x", "g", "p", "d"]) r[f] = Math.max(x[f] || 0, y[f] || 0);
      o.days[k] = r;
    }
    for (const k of new Set([...Object.keys(a.cats), ...Object.keys(b.cats)])) { const x = a.cats[k] || {}, y = b.cats[k] || {}; o.cats[k] = { a: Math.max(x.a || 0, y.a || 0), c: Math.max(x.c || 0, y.c || 0) }; }
    const seen = new Set(); o.trend = [...a.trend, ...b.trend].filter(t => t && !seen.has(t.t) && seen.add(t.t)).sort((p, q) => p.t - q.t).slice(-40);
    for (const k of new Set([...Object.keys(a.badges), ...Object.keys(b.badges)])) o.badges[k] = Math.min(a.badges[k] || Infinity, b.badges[k] || Infinity);
    return o;
  }
  function mergeHist(a, b) {
    const seen = new Set(), key = h => [h && (h.ts || h.date), h && h.cat, h && h.sub, h && h.total, h && h.correct].join("|");
    return [...a, ...b].filter(h => h && !seen.has(key(h)) && seen.add(key(h))).sort((x, y) => (y.ts || 0) - (x.ts || 0)).slice(0, 100);
  }
  function mergeVal(k, a, b) {
    if (k === PK) return mergePlus(a, b);
    if (k === "mcq_history_v2" && Array.isArray(a) && Array.isArray(b)) return mergeHist(a, b);
    if (Array.isArray(a) && Array.isArray(b)) return [...new Set([...a, ...b])];
    if (isObj(a) && isObj(b)) { if (k === "mcq_daily_v2") return a.date === b.date ? (b.submitted && !a.submitted ? b : a) : (String(a.date || "") >= String(b.date || "") ? a : b); return Object.assign({}, b, a); }
    return a;
  }
  function mergeAll(L, C) {
    const out = {};
    for (const k of new Set([...Object.keys(L), ...Object.keys(C)])) {
      if (L[k] == null) { out[k] = C[k]; continue; } if (C[k] == null || L[k] === C[k]) { out[k] = L[k]; continue; }
      try { out[k] = JSON.stringify(mergeVal(k, JSON.parse(L[k]), JSON.parse(C[k]))); } catch (e) { out[k] = L[k]; }
    }
    return out;
  }
  function applyItems(next, local) {
    let changed = false; applying = true;
    for (const k of SYNC_KEYS) {
      if (next[k] != null && next[k] !== local[k]) { _set.call(localStorage, k, next[k]); changed = true; }
      else if (next[k] == null && local[k] != null) { _rm.call(localStorage, k); changed = true; }
    }
    applying = false; return changed;
  }
  const safeToReload = () => { const v = document.querySelector(".view.active"); return !!v && ["home", "stats", "board", "account", "history", "practice", "bank"].indexOf(v.id) >= 0; };

  async function pull() {
    if (!user || !sb()) return;
    if (!navigator.onLine) return setSync("err", "Offline");
    setSync("busy");
    try {
      const { data: row, error } = await sb().from("user_data").select("data,updated_at").eq("user_id", user.id).maybeSingle();
      if (error) throw error;
      if (!row) { await push(); return; }                                   // first time for this account: upload this device
      const m = metaGet(), local = snapshot(), cloud = (row.data && row.data.items) || {};
      const same = m.uid === user.id && m.at && new Date(m.at).getTime() === new Date(row.updated_at).getTime();
      if (same) { if (m.dirty) await push(); else setSync("ok"); return; }
      let next, mustPush = false;
      if (m.uid !== user.id) { next = mergeAll(local, cloud); mustPush = true; }          // first sign-in on this device: combine both
      else if (!m.dirty) next = cloud;                                                    // another device saved newer progress
      else { next = mergeAll(local, cloud); mustPush = true; }
      const changed = applyItems(next, local);
      P = normP(rd(PK, {}));
      metaSet({ uid: user.id, at: row.updated_at, dirty: mustPush });
      if (mustPush) await push(); else setSync("ok");
      if (changed) {
        if (safeToReload()) { toast("☁️ Progress synced", 1400); setTimeout(() => location.reload(), 700); }
        else toast("☁️ Progress synced from another device. Reload to see it.", 4000);
      }
    } catch (e) { console.warn("sync pull:", e); setSync("err", errText(e)); }
  }

  function wireAuth() {
    const c = sb(); if (!c || !c.auth) return renderAccount();
    c.auth.onAuthStateChange((ev, s) => {
      const prev = user && user.id; user = (s && s.user) || null;
      if (ev === "PASSWORD_RECOVERY") { recovery = true; setTimeout(() => { setGate(false); show("account"); }, 0); }
      setTimeout(() => {                                                   // never call Supabase inside this callback
        if (gateChecked && !recovery) { if (user && gateOpen) { setGate(false); show("home"); } else if (!user && !gateOpen) setGate(true); }
        renderAccount(); checkAdmin();
        if (user && user.id !== prev) pull().then(() => { checkBadges(true); renderHome(); pushBoard(); });
      }, 0);
    });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && user) { const m = metaGet(); if (!m.dirty) pull(); } });
    window.addEventListener("online", () => { if (user) pull(); });
  }

  const val = id => ($(id) && $(id).value || "").trim();
  function msg(t, kind) { const e = $("plMsg"); if (e) { e.textContent = t || ""; e.className = "pl-msg " + (kind || ""); } }
  const authReady = () => { if (!sb() || !sb().auth) { msg("The database is not connected.", "err"); return false; } if (!navigator.onLine) { msg("No internet connection.", "err"); return false; } return true; };
  async function signIn() {
    const email = val("plEmail"), password = $("plPass") ? $("plPass").value : "";
    if (!email || !password) return msg("Enter your email and password.", "err"); if (!authReady()) return;
    msg("Signing in…");
    const { error } = await sb().auth.signInWithPassword({ email, password });
    if (error) msg(errText(error), "err"); else msg("");
  }
  async function signUp() {
    const email = val("plEmail"), password = $("plPass") ? $("plPass").value : "", name = val("plName");
    if (name && (name.length < 3 || name.length > 20)) return msg("Display name must be 3-20 characters.", "err");
    if (!email) return msg("Enter your email.", "err"); if (password.length < 6) return msg("Password needs at least 6 characters.", "err"); if (!authReady()) return;
    msg("Creating your account…");
    const { data, error } = await sb().auth.signUp({ email, password, options: { data: { display_name: name || email.split("@")[0] }, emailRedirectTo: location.origin + location.pathname } });
    if (error) return msg(errText(error), "err");
    if (data.user && data.user.identities && !data.user.identities.length) return msg("This email is already registered. Please sign in.", "err");
    if (!data.session) msg("✅ Account created. Check your email and tap the confirmation link, then sign in.", "ok");
  }
  async function forgot() {
    const email = val("plEmail"); if (!email) return msg("Type your email first, then tap “Forgot password”.", "err"); if (!authReady()) return;
    const { error } = await sb().auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) msg(errText(error), "err"); else msg("✅ Password reset link sent. Check your email.", "ok");
  }
  async function savePass() {
    const p = $("plPass") ? $("plPass").value : ""; if (p.length < 6) return msg("Password needs at least 6 characters.", "err");
    const { error } = await sb().auth.updateUser({ password: p });
    if (error) msg(errText(error), "err"); else { recovery = false; toast("✅ Password changed"); renderAccount(); }
  }
  async function editName() {
    const n = prompt("Display name (3-20 characters). It is shown on the leaderboard:", displayName()); if (n === null) return;
    const t = n.trim(); if (t.length < 3 || t.length > 20) return toast("Display name must be 3-20 characters.", 2800);
    const { data, error } = await sb().auth.updateUser({ data: { display_name: t } });
    if (error) return toast(errText(error), 3000);
    user = data.user || user; await saveProfile({ display_name: t }); renderAccount(); pushBoard(); toast("✅ Name updated");
  }
  function signOut() {
    dlgOpen({ icon: "👋", title: "Sign out?", msg: "Your progress is saved in your account. It will be removed from this device and comes back when you sign in again.", ok: "Sign out", onOk: async () => {
      toast("Saving…", 1500); clearTimeout(pushT); await push();
      try { await sb().auth.signOut(); } catch (e) {}
      applying = true; for (const k of SYNC_KEYS) _rm.call(localStorage, k); _rm.call(localStorage, META); applying = false;
      location.reload();
    } });
  }
  const syncNow = () => { if (!user) return; pull().then(() => { if (syncState === "ok") toast("☁️ Up to date"); }); };

  /* ---------- profile saved in the database (table: profiles) ---------- */
  let prof = null;
  const profile = () => { const m = (user && user.user_metadata) || {}; return { avatar: (prof && prof.avatar) || m.avatar || "", bio: (prof && prof.bio) || m.bio || "" }; };
  async function loadProfile() {
    prof = null; const c = sb(); if (!c || !user) return;
    try {
      const { data, error } = await c.from("profiles").select("display_name,avatar,bio").eq("user_id", user.id).maybeSingle();
      if (error) throw error;
      if (data) prof = data;
      else { const m = user.user_metadata || {}; prof = { display_name: displayName(), avatar: m.avatar || "", bio: m.bio || "" }; await saveProfile({}); }
    } catch (e) { console.warn("profile:", e); }
  }
  async function saveProfile(patch) {
    const c = sb(); if (!c || !user) return false;
    prof = Object.assign({ display_name: displayName(), avatar: "", bio: "" }, prof || {}, patch);
    const { error } = await c.from("profiles").upsert({ user_id: user.id, display_name: String(prof.display_name || displayName()).slice(0, 24), avatar: prof.avatar || "", bio: prof.bio || "", updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (error) { toast(errText(error), 3500); return false; }
    return true;
  }
  async function fillProfileStats() {
    const c = sb(); if (!c || !user) return;
    try {
      const mine = summary().x, [a, b] = await Promise.all([
        c.from("leaderboard").select("user_id", { count: "exact", head: true }).gt("xp", mine),
        isAdmin ? c.from("leaderboard").select("user_id", { count: "exact", head: true }) : Promise.resolve({})]);
      const r = $("plRank"), p = $("plPlayers");
      if (r && a.count != null) r.textContent = mine > 0 ? "#" + (a.count + 1) : "–";
      if (p && b.count != null) p.textContent = num(b.count);
    } catch (e) {}
  }
  async function setAvatar(e) {
    if (await saveProfile({ avatar: e })) { renderAccount(); toast("✅ Avatar saved"); }
  }
  async function editBio() {
    const n = prompt("Short bio (up to 120 characters):", profile().bio); if (n === null) return;
    if (await saveProfile({ bio: n.trim().slice(0, 120) })) { renderAccount(); toast("✅ Bio saved"); }
  }
  function renderAccount() {
    const el = $("accountBody"); if (!el) return;
    const t = theme();
    const appearance = `<div class="pl-card"><h3>🎨 Appearance</h3>
      <div class="muted" style="font-size:13px;margin-bottom:8px">Theme</div>
      <div class="pl-seg" style="margin-bottom:16px">${[["dark", "🌙 Dark"], ["light", "☀️ Light"], ["auto", "🌓 Auto"]].map(([m, l]) => `<button type="button" class="${t.mode === m ? "on" : ""}" onclick="MQ.setTheme('${m}')">${l}</button>`).join("")}</div>
      <div class="muted" style="font-size:13px;margin-bottom:8px">Font size</div>
      <div class="pl-seg">${FONTS.map(([l, v]) => `<button type="button" class="${t.fs === v ? "on" : ""}" onclick="MQ.setFont(${v})">${l}</button>`).join("")}</div></div>`;
    let acct;
    if (recovery && user) {
      acct = `<div class="pl-card"><h3>🔑 Choose a new password</h3><input id="plPass" class="pl-input" type="password" placeholder="New password (6+ characters)" autocomplete="new-password"><button type="button" class="btn primary" onclick="MQ.savePass()">Save password</button><div id="plMsg" class="pl-msg"></div></div>`;
    } else if (user) {
      const nm = displayName(), s = summary(), meta = profile(), av = meta.avatar || nm.charAt(0).toUpperCase();
      const joined = user.created_at ? new Date(user.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
      const AVS = ["😀", "😎", "🤓", "🦁", "🐯", "🦊", "🐼", "🚀", "🎯", "📚", "⚡", "🌟"];
      acct = `<div class="pl-card pl-prof"><div class="pl-user"><div class="pl-av big">${esc(av)}</div><div><b>${esc(nm)}</b> <span class="pl-role ${isAdmin ? "adm" : ""}">${isAdmin ? "🛡️ Admin" : "👤 User"}</span><br><span class="muted" style="font-size:13px">${esc(user.email || "")}</span>${joined ? `<br><span class="muted" style="font-size:12px">Member since ${esc(joined)}</span>` : ""}<br><span class="pl-sync" id="plSync"><i></i>Synced</span></div></div>
        ${meta.bio ? `<p class="muted" style="margin:12px 0 0;font-size:14px">${esc(meta.bio)}</p>` : ""}
        <div class="pl-tiles" style="margin-top:14px"><div class="pl-tile"><b id="plRank">–</b><span>Rank</span></div><div class="pl-tile"><b>${num(s.a)}</b><span>Answered</span></div><div class="pl-tile"><b>${s.acc}%</b><span>Accuracy</span></div><div class="pl-tile"><b>🔥 ${s.best}</b><span>Best streak</span></div></div>
        <div class="pl-chips"><span class="pl-chip">⭐ Level ${s.L}</span><span class="pl-chip">✨ ${num(s.x)} XP</span><span class="pl-chip">🔥 ${s.cur} day${s.cur === 1 ? "" : "s"}</span><span class="pl-chip">🏅 ${Object.keys(P.badges).length}/${BADGES.length}</span></div>
        <div class="muted" style="font-size:13px;margin:14px 0 8px">Choose your avatar</div>
        <div class="pl-avs">${AVS.map(e => `<button type="button" class="${meta.avatar === e ? "on" : ""}" onclick="MQ.setAvatar('${e}')">${e}</button>`).join("")}</div>
        <div class="pl-btns"><button type="button" class="btn" onclick="MQ.editName()">✏️ Change name</button><button type="button" class="btn" onclick="MQ.editBio()">📝 Edit bio</button><button type="button" class="btn" onclick="MQ.syncNow()">☁️ Sync now</button><button type="button" class="btn" onclick="show('board')">🏆 Leaderboard</button><button type="button" class="btn" onclick="MQ.signOut()">Sign out</button></div></div>
        ${isAdmin ? `<div class="pl-card pl-adm"><div class="pl-hd"><h3>🛡️ Admin panel</h3><span class="pl-role adm">Admin</span></div>
          <div class="pl-tiles"><div class="pl-tile"><b>${typeof totalQ === "function" ? num(totalQ()) : "–"}</b><span>Questions</span></div><div class="pl-tile"><b id="plPlayers">–</b><span>Players</span></div></div>
          <div class="pl-btns"><button type="button" class="btn primary" onclick="show('manage')">✍️ Add / manage questions</button><button type="button" class="btn" onclick="show('board')">👥 Players</button></div></div>` : ""}`;
    } else {
      const up = accMode === "up";
      acct = `<div class="pl-card"><h3>${up ? "✨ Create your account" : "👤 Sign in"}</h3>
        <p class="muted" style="margin:0 0 14px;font-size:13px">Sync your progress between phone and computer, and join the leaderboard.</p>
        <div class="pl-tabs"><button type="button" class="${up ? "" : "on"}" onclick="MQ.authMode('in')">Sign in</button><button type="button" class="${up ? "on" : ""}" onclick="MQ.authMode('up')">Create account</button></div>
        ${up ? `<input id="plName" class="pl-input" maxlength="20" placeholder="Display name (shown on the leaderboard)" autocomplete="nickname">` : ""}
        <input id="plEmail" class="pl-input" type="email" placeholder="Email" autocomplete="email" inputmode="email">
        <input id="plPass" class="pl-input" type="password" placeholder="Password" autocomplete="${up ? "new-password" : "current-password"}" onkeydown="if(event.key==='Enter')${up ? "MQ.signUp()" : "MQ.signIn()"}">
        <div class="pl-btns"><button type="button" class="btn primary" onclick="${up ? "MQ.signUp()" : "MQ.signIn()"}">${up ? "Create account" : "Sign in"}</button>${up ? "" : `<button type="button" class="pl-link" onclick="MQ.forgot()">Forgot password?</button>`}</div>
        <div id="plMsg" class="pl-msg"></div></div>`;
    }
    el.innerHTML = acct + appearance;
    if (user) { setSync(syncState === "idle" ? "ok" : syncState, syncNote); fillProfileStats(); }
  }

  /* =========================================================
     4b. LOGIN GATE: sign in / register first, the app opens only after login
     ========================================================= */
  let gateMode = "in", gateOpen = false, gateChecked = false;
  const gmsg = (t, k) => { const e = $("agMsg"); if (e) { e.textContent = t || ""; e.className = "pl-msg " + (k || ""); } };
  function setGate(open) {
    gateOpen = open;
    const g = $("authGate"); if (g) g.style.display = open ? "flex" : "none";
    document.body.classList.toggle("gated", open);
    if (!open) { hideSplash(); renderHome(); }
  }
  function gateSetMode(m) {
    gateMode = m; const up = m === "up";
    $("agTabIn").classList.toggle("on", !up); $("agTabUp").classList.toggle("on", up);
    $("agName").style.display = up ? "" : "none"; $("agForgot").style.display = up ? "none" : "";
    $("agGo").textContent = up ? "Create account" : "Sign in";
    $("agPass").autocomplete = up ? "new-password" : "current-password"; gmsg("");
  }
  async function gateGo() {
    const email = val("agEmail"), password = $("agPass").value, name = val("agName"), up = gateMode === "up";
    if (!email || !password) return gmsg("Enter your email and password.", "err");
    if (up && name && (name.length < 3 || name.length > 20)) return gmsg("Display name must be 3-20 characters.", "err");
    if (up && password.length < 6) return gmsg("Password needs at least 6 characters.", "err");
    if (!sb() || !sb().auth) return gmsg("The database is not connected.", "err");
    if (!navigator.onLine) return gmsg("No internet connection.", "err");
    const btn = $("agGo"); btn.disabled = true; gmsg(up ? "Creating your account…" : "Signing in…");
    try {
      if (up) {
        const { data, error } = await sb().auth.signUp({ email, password, options: { data: { display_name: name || email.split("@")[0] }, emailRedirectTo: location.origin + location.pathname } });
        if (error) return gmsg(errText(error), "err");
        if (data.user && data.user.identities && !data.user.identities.length) return gmsg("This email is already registered. Please sign in.", "err");
        if (!data.session) { gateSetMode("in"); gmsg("✅ Account created. Check your email, tap the confirmation link, then sign in.", "ok"); }
      } else {
        const { error } = await sb().auth.signInWithPassword({ email, password });
        if (error) return gmsg(errText(error), "err");
      }
    } finally { btn.disabled = false; }
  }
  async function gateForgot() {
    const email = val("agEmail"); if (!email) return gmsg("Type your email first, then tap “Forgot password”.", "err");
    if (!sb() || !sb().auth) return gmsg("The database is not connected.", "err");
    const { error } = await sb().auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) gmsg(errText(error), "err"); else gmsg("✅ Password reset link sent. Check your email.", "ok");
  }
  // first screen: decide between the login page and the dashboard
  async function initGate() {
    const c = sb();
    if (!c || !c.auth) { setGate(false); return; }                       // database not configured: do not lock the app
    document.body.classList.add("gated");                                // hide the app until we know who is signed in
    try { const { data } = await c.auth.getSession(); if (data && data.session) user = data.session.user; } catch (e) {}
    gateChecked = true;
    if (user) { setGate(false); renderAccount(); checkAdmin(); pull().then(() => { checkBadges(true); renderHome(); pushBoard(); }); }
    else if (!navigator.onLine && metaGet().uid) setGate(false);          // offline with a remembered account: let the person in
    else { setGate(true); hideSplash(); }
  }

  /* ---------- admin: only admins may add / edit / delete questions (enforced in Supabase, hidden here) ---------- */
  let isAdmin = false;
  function applyAdmin() { document.body.classList.toggle("is-admin", isAdmin); renderAccount(); }
  async function checkAdmin() {
    isAdmin = false; await loadProfile();
    if (user && sb()) {
      try { const { data } = await sb().from("admins").select("user_id").eq("user_id", user.id).maybeSingle(); isAdmin = !!data; }
      catch (e) { isAdmin = false; }
    }
    applyAdmin();
  }

  /* =========================================================
     5. SPLASH SCREEN
     ========================================================= */
  function hideSplash() {
    const s = $("splash"); if (!s || s.dataset.done) return; s.dataset.done = "1";
    setTimeout(() => { s.classList.add("out"); setTimeout(() => s.remove(), 600); }, Math.max(0, 900 - performance.now()));
  }

  /* =========================================================
     6. START
     ========================================================= */
  const NEWV = { stats: renderStats, board: () => { if (bTab === "rank") bRows = null; renderBoard(false); }, account: renderAccount };
  const _show = window.show;
  window.show = function (id, fromPop) {
    if (id === "manage" && !isAdmin) { toast("🔒 Only the admin can add or edit questions.", 3000); id = "home"; arguments[0] = id; }
    const r = _show.apply(this, arguments);
    if (NEWV[id]) NEWV[id](); else if (id === "home") renderHome();
    return r;
  };
  const _doReset = window.doReset;                                          // "Reset Local Data" also clears streak / XP / badges
  if (typeof _doReset === "function") window.doReset = function () { const r = _doReset.apply(this, arguments); P = normP({}); saveP(); renderHome(); queueBoard(); return r; };

  window.MQ = {
    onResult, setTheme, setFont, setGoal, signIn, signUp, forgot, savePass, editName, signOut, syncNow,
    authMode: m => { accMode = m; renderAccount(); },
    gateMode: gateSetMode, gateGo, gateForgot, setAvatar, editBio,
    boardTab: t => { bTab = t; renderBoard(false); },
    boardMode: m => { bMode = m; loadBoard(); },
    refreshBoard: () => loadBoard()
  };

  applyTheme();
  checkBadges(true); renderHome(); renderAccount();
  window.addEventListener("mcqdb:ready", hideSplash); window.addEventListener("mcqdb:error", hideSplash);
  if (!(window.MCQ_DB && MCQ_DB.enabled) || MCQ_DB.ready) window.addEventListener("load", hideSplash);
  setTimeout(hideSplash, 6000);
  wireAuth();
  initGate();
})();
