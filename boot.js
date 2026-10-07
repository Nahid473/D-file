/* MCQ Master · boot.js
 * 1) MCQ_STORE: replaces localStorage. State lives in memory and is saved to the database (table user_data).
 * 2) Login gate: shows Sign in / Register first. After login the progress is loaded from the database,
 *    and only then script.js and features.js are started.
 * Loaded after supabase.js. Admin rights are NOT decided here: they come from the `admins` table (see schema_admin.sql).
 */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const sb = () => (window.MCQ_DB && MCQ_DB.enabled && MCQ_DB.client) || null;

  /* ---------- database-backed store (same API as localStorage: get / set / remove) ---------- */
  const mem = new Map();
  window.MCQ_STORE = {
    meta: {}, onChange: null,
    get: k => (mem.has(k) ? mem.get(k) : null),
    set(k, v, silent) { mem.set(k, String(v)); if (!silent && this.onChange) this.onChange(k); },
    remove(k, silent) { mem.delete(k); if (!silent && this.onChange) this.onChange(k); },
    keys: () => [...mem.keys()],
    load(items) { mem.clear(); for (const k in items || {}) mem.set(k, items[k]); }
  };

  const errText = e => {
    const m = String((e && (e.message || e.error_description)) || e || "");
    if (e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|schema cache/i.test(m))) return "TABLE";
    if (/Invalid login/i.test(m)) return "Wrong email or password.";
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "No internet connection.";
    return m || "Something went wrong.";
  };
  const msg = (t, k) => { const e = $("agMsg"); if (e) { e.textContent = t || ""; e.className = "pl-msg " + (k || ""); } };
  const val = id => ($(id) && $(id).value || "").trim();
  const hideSplash = () => { const s = $("splash"); if (s) { s.classList.add("out"); setTimeout(() => s.remove(), 600); } };

  /* ---------- strong password rules (passwords are hashed by Supabase Auth on the server, never in this app) ---------- */
  const RULES = [["At least 10 characters", p => p.length >= 10], ["An uppercase letter (A-Z)", p => /[A-Z]/.test(p)], ["A lowercase letter (a-z)", p => /[a-z]/.test(p)], ["A number (0-9)", p => /\d/.test(p)], ["A symbol (! @ # $ …)", p => /[^A-Za-z0-9\s]/.test(p)]];
  const WEAK = /password|passw0rd|qwerty|123456|654321|abcdef|letmein|iloveyou|admin|welcome|111111|000000/i;
  function pwIssues(p, email) {
    p = String(p || ""); const out = RULES.filter(r => !r[1](p)).map(r => r[0]);
    if (/\s/.test(p)) out.push("No spaces");
    if (WEAK.test(p) || /^(.)\1+$/.test(p)) out.push("Not a common or easy-to-guess password");
    const lp = String(email || "").split("@")[0].toLowerCase(); if (lp.length >= 3 && p.toLowerCase().indexOf(lp) >= 0) out.push("Must not contain your email name");
    return out;
  }
  window.MQ_PW = { issues: pwIssues, rules: RULES };
  function meter() {
    const p = $("agPass").value, met = RULES.filter(r => r[1](p)).length, bad = pwIssues(p, val("agEmail")).length, ok = bad === 0;
    const pct = p ? Math.max(8, Math.round(met / RULES.length * 100) - (ok ? 0 : 8)) : 0;
    const m = $("agMeter"); m.firstElementChild.style.width = pct + "%"; m.className = "pwm " + (ok ? (p.length >= 14 ? "great" : "good") : met >= 4 ? "mid" : "low");
    $("agRules").innerHTML = RULES.map(r => `<span class="${r[1](p) ? "ok" : ""}">${r[1](p) ? "✓" : "○"} ${r[0]}</span>`).join("") + `<em>${ok ? (p.length >= 14 ? "Very strong password" : "Strong password") : "Weak password"}</em>`;
  }

  /* ---------- gate ---------- */
  let mode = "in", entered = false, entering = false;
  function setMode(m) {
    mode = m; const up = m === "up";
    $("agTabIn").classList.toggle("on", !up); $("agTabUp").classList.toggle("on", up);
    $("agName").style.display = up ? "" : "none"; $("agForgot").style.display = up ? "none" : "";
    $("agPass2").style.display = up ? "" : "none"; $("agMeter").style.display = up ? "" : "none"; $("agRules").style.display = up ? "" : "none"; if (up) meter();
    $("agGo").textContent = up ? "Create account" : "Sign in";
    $("agPass").autocomplete = up ? "new-password" : "current-password"; msg("");
  }
  async function go() {
    const email = val("agEmail"), password = $("agPass").value, name = val("agName"), up = mode === "up", c = sb();
    if (!email || !password) return msg("Enter your email and password.", "err");
    if (up && name && (name.length < 3 || name.length > 20)) return msg("Display name must be 3-20 characters.", "err");
    if (up) { const bad = pwIssues(password, email); if (bad.length) return msg("Choose a stronger password: " + bad.join(", ") + ".", "err"); if (password !== $("agPass2").value) return msg("The two passwords do not match.", "err"); }
    if (!c || !c.auth) return msg("The database is not connected.", "err");
    if (!navigator.onLine) return msg("No internet connection.", "err");
    const btn = $("agGo"); btn.disabled = true; msg(up ? "Creating your account…" : "Signing in…");
    try {
      if (up) {
        const { data, error } = await c.auth.signUp({ email, password, options: { data: { display_name: name || email.split("@")[0] }, emailRedirectTo: location.origin + location.pathname } });
        if (error) return msg(errText(error), "err");
        if (data.user && data.user.identities && !data.user.identities.length) return msg("This email is already registered. Please sign in.", "err");
        if (!data.session) { setMode("in"); msg("✅ Account created. Check your email, tap the confirmation link, then sign in.", "ok"); }
      } else {
        const { error } = await c.auth.signInWithPassword({ email, password });
        if (error) return msg(errText(error), "err");
      }
    } finally { btn.disabled = false; }
  }
  async function google() {                                 // Google sign-in / registration in one step
    const c = sb(); if (!c || !c.auth) return msg("The database is not connected.", "err");
    if (!navigator.onLine) return msg("No internet connection.", "err");
    msg("Opening Google…");
    const { error } = await c.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: "select_account" } } });
    if (error) msg(/provider is not enabled|Unsupported provider/i.test(error.message || "") ? "Google login is not enabled in Supabase yet." : errText(error), "err");
  }
  async function forgot() {
    const email = val("agEmail"), c = sb(); if (!email) return msg("Type your email first, then tap “Forgot password”.", "err");
    if (!c || !c.auth) return msg("The database is not connected.", "err");
    const { error } = await c.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) msg(errText(error), "err"); else msg("✅ Password reset link sent. Check your email.", "ok");
  }
  window.MQ_GATE = { mode: setMode, go, forgot, google, meter };
  function showGate() { $("authGate").style.display = "flex"; document.body.classList.add("gated"); hideSplash(); }

  /* ---------- load the signed-in person's progress from the database, then start the app ---------- */
  function loadScript(src) { return new Promise((ok, no) => { const s = document.createElement("script"); s.src = src; s.async = false; s.onload = ok; s.onerror = () => no(new Error("Cannot load " + src)); document.body.appendChild(s); }); }
  async function enter(user) {
    if (entered || entering) return; entering = true;
    const c = sb();
    try {
      const { data, error } = await c.from("user_data").select("data,updated_at").eq("user_id", user.id).maybeSingle();
      if (error) throw error;
      MCQ_STORE.load(data && data.data && data.data.items);
      MCQ_STORE.meta = { uid: user.id, at: data ? data.updated_at : null, dirty: false };
    } catch (e) {
      if (errText(e) !== "TABLE") {                       // real failure (e.g. offline): do not start with empty progress that could overwrite the cloud copy
        entering = false; showGate(); return msg("Cannot load your progress: " + errText(e) + " Try again.", "err");
      }
    }
    window.MCQ_USER = user; entered = true;
    $("authGate").style.display = "none"; document.body.classList.remove("gated");
    try { await loadScript("script.js"); await loadScript("features.js"); } catch (e) { console.error(e); }
  }

  async function start() {
    const c = sb();
    if (!c || !c.auth) { await loadScript("script.js"); await loadScript("features.js"); return; }   // database not configured: do not lock the app
    document.body.classList.add("gated");
    c.auth.onAuthStateChange((ev, s) => {
      if (ev === "PASSWORD_RECOVERY") window.MCQ_RECOVERY = true;
      if (s && s.user && !entered) setTimeout(() => enter(s.user), 0);        // never call Supabase inside this callback
    });
    let session = null; try { session = (await c.auth.getSession()).data.session; } catch (e) {}
    if (session) enter(session.user); else if (!entered) showGate();
  }
  start();
})();
