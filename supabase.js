/* MCQ Master — Supabase database engine (the ONLY source of questions)
 * PUBLIC READ + PUBLIC WRITE · no Supabase Auth · run schema.sql once in the Supabase SQL editor.
 *
 * How it scales to 100,000+ questions:
 *   ONLINE ONLY: nothing is stored on the device. The internet connection is required, and every
 *   start reads fresh data from Supabase, so all devices always see the same questions.
 *   1. On start only a tiny CATALOG is read (category / sub-category / lesson + counts, one RPC call).
 *   2. Question text is read lazily, one lesson at a time (paged 1000 rows per request),
 *      kept only in memory for a few minutes (LRU) so moving between screens is quick.
 *   3. Manage / Search read one page from the server, never the whole table.
 *   4. Bulk import inserts 100 questions per request.
 *
 * script.js never touches the network: it only calls MCQ_DB.* and listens to
 * "mcqdb:ready" (catalog available / changed) and "mcqdb:error".
 * Never put a service_role/secret key in this file.
 */
(function () {
  "use strict";

  const SUPABASE_URL = "https://uypwmhdzaondcuqboxqf.supabase.co";
  const SUPABASE_KEY = "sb_publishable_v2assRvENFB0ibgeMaMDiA_-AiXHWzf";

  const PAGE_SIZE = 1000;            // rows per read request (Supabase maximum)
  const INSERT_BATCH = 100;          // questions per insert request
  const LESSON_TTL = 5 * 60e3;       // a lesson kept in memory is trusted this long (and only while its size is unchanged)
  const LESSON_LRU = 40;             // lessons kept in memory

  const LESSON_SELECT = `
    id, question, question_name, subcategory, lesson, difficulty, explanation,
    locked, pin_hash, qtype, answers,
    question_options ( option_key, option_text, is_correct )`;
  const FULL_SELECT = LESSON_SELECT.replace("id, question,", "id, category_id, question,") + `, categories ( id, name )`;

  const MCQ_DB = (window.MCQ_DB = {
    enabled: false, ready: false, fromCache: false /* always false: online only */,
    client: null, catalog: [], error: null
  });

  /* ---------- helpers ---------- */

  const isConfigured = () => SUPABASE_URL.indexOf("YOUR_") !== 0 && SUPABASE_KEY.indexOf("YOUR_") !== 0;
  const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

  // Same normaliser as script.js, so "duplicate" means the same thing in the app and in the database.
  function normalize(value) {
    if (typeof window.normalizeQuestionText === "function") return window.normalizeQuestionText(value);
    return String(value || "").toLowerCase().replace(/<[^>]*>/g, " ").normalize("NFKC")
      .replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  }

  function requireClient() {
    if (!MCQ_DB.enabled || !MCQ_DB.client) throw new Error("Supabase is not configured");
    return MCQ_DB.client;
  }

  function duplicateError(row, message) {
    const err = new Error(message);
    err.code = "DUPLICATE";
    err.existing = row ? {
      name: row.question_name || "", q: row.question || "",
      cat: row.categories && row.categories.name, sub: row.subcategory, lesson: row.lesson
    } : {};
    return err;
  }

  async function readPaged(buildQuery) {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      const batch = Array.isArray(data) ? data : [];
      for (const row of batch) rows.push(row);
      if (batch.length < PAGE_SIZE) return rows;
    }
  }

  const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
  const likeEscape = s => String(s).replace(/[\\%_]/g, m => "\\" + m).replace(/[,()]/g, " ");

  /* ---------- row <-> app question ---------- */

  function mapRow(row, over) {
    over = over || {};
    const base = {
      id: -Math.abs(Number(row.id)),
      dbId: Number(row.id),
      name: String(row.question_name || ""),
      cat: over.cat || (row.categories && row.categories.name) || "Database",
      sub: String(over.sub || row.subcategory || "General"),
      lesson: String(over.lesson || row.lesson || "General"),
      q: String(row.question || ""),
      e: String(row.explanation || ""),
      difficulty: row.difficulty || "easy",
      locked: row.locked === true,
      pinHash: row.pin_hash ? String(row.pin_hash) : null,
      source: "supabase"
    };
    if (row.qtype === "text") {
      const ans = Array.isArray(row.answers) ? row.answers.map(x => String(x).trim()).filter(Boolean) : [];
      return Object.assign(base, { t: "text", ans });
    }
    const options = Array.isArray(row.question_options)
      ? row.question_options.slice().sort((a, b) => String(a.option_key).localeCompare(String(b.option_key)))
      : [];
    const answer = options.findIndex(o => o.is_correct === true);
    return Object.assign(base, {
      t: "mcq",
      o: options.map(o => String(o.option_text || "")),
      a: answer >= 0 ? answer : 0
    });
  }

  const isValid = q => q.q && (q.t === "text" ? q.ans.length > 0 : q.o.length >= 2 && q.a >= 0 && q.a < q.o.length);

  function questionPayload(item, categoryId) {
    const text = item.t === "text";
    return {
      category_id: categoryId,
      question: item.q,
      question_name: item.name || "",
      subcategory: item.sub || "General",
      lesson: item.lesson || "General",
      difficulty: item.difficulty || "easy",
      explanation: item.e || "",
      qtype: text ? "text" : "mcq",
      answers: text ? item.ans : null,
      qkey: normalize(item.q),
      locked: item.locked === true,
      pin_hash: item.locked && item.pinHash ? String(item.pinHash) : null
    };
  }

  /* ---------- categories ---------- */

  const catByName = new Map();
  let catsLoaded = false;

  async function loadCategories(force) {
    if (catsLoaded && !force) return;
    const { data, error } = await requireClient().from("categories").select("id,name");
    if (error) throw error;
    catByName.clear();
    (data || []).forEach(r => catByName.set(r.name, r.id));
    catsLoaded = true;
  }

  async function getCategoryId(name, create) {
    await loadCategories();
    if (catByName.has(name)) return catByName.get(name);
    if (!create) return null;
    const made = await requireClient().from("categories")
      .insert({ name, description: "MCQ category" }).select("id").single();
    if (made.error) throw made.error;
    catByName.set(name, made.data.id);
    return made.data.id;
  }

  /* ---------- catalog: category / sub-category / lesson + counts ---------- */

  const sumCatalog = rows => rows.reduce((n, r) => n + r.c, 0);
  MCQ_DB.total = () => sumCatalog(MCQ_DB.catalog);

  async function fetchCatalog() {
    const client = requireClient();
    const rpc = await client.rpc("mcq_catalog");
    if (!rpc.error && Array.isArray(rpc.data)) {
      return rpc.data.map(r => ({
        cat: String(r.category), sub: String(r.subcategory || "General"), lesson: String(r.lesson || "General"),
        c: Number(r.total) || 0, t: Number(r.texts) || 0, first: Number(r.first_id) || 0
      }));
    }
    // Fallback when schema.sql was not run yet: scan only 4 small columns (slow for huge banks).
    console.warn("mcq_catalog() is missing: run schema.sql in Supabase. Falling back to a slow scan.", rpc.error);
    await loadCategories(true);
    const names = new Map([...catByName].map(([n, id]) => [id, n]));
    const rows = await readPaged(() =>
      client.from("questions").select("id,category_id,subcategory,lesson,qtype").order("id", { ascending: true }));
    const m = new Map();
    for (const r of rows) {
      const cat = names.get(r.category_id) || "Database", sub = r.subcategory || "General", lesson = r.lesson || "General";
      const k = cat + "\u0001" + sub + "\u0001" + lesson;
      let x = m.get(k);
      if (!x) m.set(k, x = { cat, sub, lesson, c: 0, t: 0, first: Number(r.id) });
      x.c++; if (r.qtype === "text") x.t++;
    }
    return [...m.values()].sort((a, b) => a.first - b.first);
  }

  try { localStorage.removeItem("mcq_catalog_v2"); } catch (e) {}   // old offline copy from earlier versions

  let catalogBusy = null;
  async function loadCatalog(force) {
    if (!MCQ_DB.enabled) return;
    if (catalogBusy) return catalogBusy;
    return (catalogBusy = (async () => {
      try {
        const rows = await fetchCatalog();
        const changed = JSON.stringify(rows) !== JSON.stringify(MCQ_DB.catalog);
        MCQ_DB.catalog = rows; MCQ_DB.error = null; MCQ_DB.fromCache = false;
        const first = !MCQ_DB.ready;
        MCQ_DB.ready = true;
        if (changed || first || force) emit("mcqdb:ready", { count: sumCatalog(rows), cached: false });
      } catch (err) {
        MCQ_DB.error = err;
        console.error("Supabase catalog error:", err);
        emit("mcqdb:error", err);
      }
    })().finally(() => { catalogBusy = null; }));
  }

  let refreshTimer = 0;
  function refreshCatalogSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => loadCatalog(true), 700); }

  /* ---------- lessons: network, with a short in-memory cache ---------- */

  const lessonMem = new Map(), lessonPending = new Map();
  const lessonKey = (cat, sub, lesson) => cat + "\u0001" + sub + "\u0001" + lesson;

  // remove the old offline database left by earlier versions
  try { indexedDB.deleteDatabase("mcqdb-cache"); } catch (e) {}

  function remember(key, rows, c) {
    lessonMem.delete(key); lessonMem.set(key, { rows, c, at: Date.now() });
    while (lessonMem.size > LESSON_LRU) lessonMem.delete(lessonMem.keys().next().value);
  }

  async function fetchLesson(sh) {
    const client = requireClient();
    const catId = await getCategoryId(sh.cat, false);
    if (catId == null) return [];
    const rows = await readPaged(() =>
      client.from("questions").select(LESSON_SELECT)
        .eq("category_id", catId).eq("subcategory", sh.sub).eq("lesson", sh.lesson)
        .order("id", { ascending: true }));
    return rows.map(r => mapRow(r, { cat: sh.cat, sub: sh.sub, lesson: sh.lesson })).filter(isValid);
  }

  // sh = { cat, sub, lesson, c }  (c = size from the catalog, used to detect a changed lesson)
  MCQ_DB.loadLesson = function (sh, force) {
    const key = lessonKey(sh.cat, sh.sub, sh.lesson);
    const hit = force ? null : lessonMem.get(key);
    if (hit && hit.c === sh.c && Date.now() - hit.at < LESSON_TTL) { remember(key, hit.rows, hit.c); return Promise.resolve(hit.rows); }
    if (lessonPending.has(key)) return lessonPending.get(key);
    const p = (async () => {
      if (!navigator.onLine) throw new Error("No internet connection");
      const rows = await fetchLesson(sh);     // online only: an error is shown, never old data
      remember(key, rows, sh.c);
      return rows;
    })().finally(() => lessonPending.delete(key));
    lessonPending.set(key, p);
    return p;
  };

  MCQ_DB.invalidateLesson = function (cat, sub, lesson) {
    const key = lessonKey(cat, sub || "General", lesson || "General");
    lessonMem.delete(key);
  };
  MCQ_DB.clearCache = function () { lessonMem.clear(); };

  /* ---------- server-side reading: Manage list, search, by id ---------- */

  MCQ_DB.list = async function (o) {
    const client = requireClient();
    const size = o.pageSize || 20, page = Math.max(1, o.page || 1);
    let q = client.from("questions").select(FULL_SELECT, { count: "exact" });
    if (o.cat) {
      const id = await getCategoryId(o.cat, false);
      if (id == null) return { rows: [], total: 0 };
      q = q.eq("category_id", id);
    }
    if (o.sub) q = q.eq("subcategory", o.sub);
    if (o.lesson) q = q.eq("lesson", o.lesson);
    if (o.kind === "locked") q = q.eq("locked", true);
    if (o.kind === "unlocked") q = q.eq("locked", false);
    let dupIds = [];
    if (o.kind === "duplicates") {
      dupIds = (await MCQ_DB.duplicates()).map(d => d.id);
      if (!dupIds.length) return { rows: [], total: 0, dupIds };
      q = q.in("id", dupIds.slice(0, 500));
    }
    if (o.text) { const t = "%" + likeEscape(o.text) + "%"; q = q.or(`question.ilike.${t},question_name.ilike.${t}`); }
    const { data, error, count } = await q.order("id", { ascending: false }).range((page - 1) * size, page * size - 1);
    if (error) throw error;
    return { rows: (data || []).map(r => mapRow(r)).filter(isValid), total: count || 0, dupIds };
  };

  // every word must appear in the question OR in the explanation
  MCQ_DB.search = async function (text, o) {
    const client = requireClient();
    o = o || {};
    const toks = String(text || "").trim().split(/\s+/).filter(Boolean).slice(0, 6);
    if (!toks.length) return [];
    let catId = null;
    if (o.cat) { catId = await getCategoryId(o.cat, false); if (catId == null) return []; }
    const run = col => {
      let q = client.from("questions").select(FULL_SELECT);
      toks.forEach(t => { q = q.ilike(col, "%" + likeEscape(t) + "%"); });
      if (catId != null) q = q.eq("category_id", catId);
      if (o.sub) q = q.eq("subcategory", o.sub);
      return q.order("id", { ascending: true }).limit(o.limit || 300);
    };
    const [a, b] = await Promise.all([run("question"), run("explanation")]);
    if (a.error) throw a.error;
    const seen = new Set(), out = [];
    for (const r of [].concat(a.data || [], b.error ? [] : (b.data || []))) {
      if (seen.has(r.id)) continue; seen.add(r.id);
      const m = mapRow(r); if (isValid(m)) out.push(m);
    }
    return out;
  };

  MCQ_DB.getByIds = async function (dbIds) {
    const client = requireClient(), out = [];
    for (const part of chunk([...new Set(dbIds.map(Number).filter(n => n > 0))], 200)) {
      const { data, error } = await client.from("questions").select(FULL_SELECT).in("id", part);
      if (error) throw error;
      (data || []).forEach(r => { const m = mapRow(r); if (isValid(m)) out.push(m); });
    }
    return out;
  };

  /* ---------- duplicates (by normalised question text) ---------- */

  MCQ_DB.duplicates = async function () {            // [{id, keep, locked}] for every row that shares its text with another
    const { data, error } = await requireClient().rpc("mcq_duplicates");
    if (error) throw error;
    return (data || []).map(r => ({ id: Number(r.id), keep: r.keep === true, locked: r.locked === true }));
  };

  async function existingKeys(keys) {                // Set of the keys that already exist in the database
    const client = requireClient(), found = new Set();
    const uniq = [...new Set(keys.filter(Boolean))];
    for (const part of chunk(uniq, 500)) {
      const rpc = await client.rpc("mcq_existing_keys", { keys: part });
      if (!rpc.error) { (rpc.data || []).forEach(r => found.add(r.qkey)); continue; }
      // fallback (RPC missing): small GET batches so the URL stays short
      for (const small of chunk(part, 25)) {
        const { data, error } = await client.from("questions").select("qkey").in("qkey", small);
        if (error) throw error;
        (data || []).forEach(r => found.add(r.qkey));
      }
    }
    return found;
  }
  MCQ_DB.existingKeys = existingKeys;

  async function findDuplicate(item, excludeDbId) {
    const key = normalize(item.q); if (!key) return null;
    let q = requireClient().from("questions").select("id,question,question_name,subcategory,lesson,categories(name)").eq("qkey", key).limit(1);
    if (excludeDbId != null) q = q.neq("id", excludeDbId);
    const { data, error } = await q;
    if (error) throw error;
    return data && data[0] ? data[0] : null;
  }

  /* ---------- writing ---------- */

  async function writeOptions(client, dbId, item, isNew) {
    if (!isNew) {
      const del = await client.from("question_options").delete().eq("question_id", dbId);
      if (del.error) throw del.error;
    }
    if (item.t === "text") return;
    const rows = (item.o || []).map((text, i) => ({
      question_id: dbId, option_key: String.fromCharCode(65 + i), option_text: text, is_correct: i === item.a
    }));
    const ins = await client.from("question_options").insert(rows);
    if (ins.error) throw ins.error;
  }

  MCQ_DB.saveQuestion = async function (item, opts) {
    const res = await MCQ_DB.saveMany([item], { skipDuplicateCheck: !!(opts && opts.skipDuplicateCheck) });
    if (res.duplicates.length) {
      const row = await findDuplicate(item).catch(() => null);
      throw duplicateError(row, "Duplicate question already exists in the database");
    }
    if (!res.saved.length) throw res.error || new Error("Could not save the question");
    return res.saved[0].dbId;
  };

  /* Bulk insert: 100 questions + their options per round trip.
     o.onProgress({done,total}) · o.shouldStop() · o.skipDuplicateCheck
     returns { saved:[{item,dbId}], duplicates:[{item,row}], failed:n, error } */
  MCQ_DB.saveMany = async function (items, o) {
    o = o || {};
    const client = requireClient();
    const res = { saved: [], duplicates: [], failed: 0, error: null };
    let todo = items;

    if (!o.skipDuplicateCheck) {
      const keys = items.map(it => normalize(it.q)), have = await existingKeys(keys), inFile = new Set();
      todo = [];
      for (let i = 0; i < items.length; i++) {
        const k = keys[i];
        if (!k || have.has(k) || inFile.has(k)) { res.duplicates.push({ item: items[i], row: null }); continue; }
        inFile.add(k); todo.push(items[i]);
      }
    }

    let done = 0;
    for (const part of chunk(todo, INSERT_BATCH)) {
      if (o.shouldStop && o.shouldStop()) break;
      let ids = [];
      try {
        const payload = [];
        for (const it of part) payload.push(questionPayload(it, await getCategoryId(it.cat || "Custom", true)));
        const ins = await client.from("questions").insert(payload).select("id");
        if (ins.error) throw ins.error;
        ids = (ins.data || []).map(r => r.id);
        if (ids.length !== part.length) throw new Error("The database did not return every new question id");
        const optRows = [];
        part.forEach((it, i) => {
          if (it.t === "text") return;
          (it.o || []).forEach((text, j) => optRows.push({
            question_id: ids[i], option_key: String.fromCharCode(65 + j), option_text: text, is_correct: j === it.a
          }));
        });
        if (optRows.length) {
          for (const oc of chunk(optRows, 1000)) {
            const oi = await client.from("question_options").insert(oc);
            if (oi.error) throw oi.error;
          }
        }
        part.forEach((it, i) => {
          res.saved.push({ item: it, dbId: Number(ids[i]) });
          MCQ_DB.invalidateLesson(it.cat || "Custom", it.sub, it.lesson);
        });
      } catch (err) {
        console.error("Batch save failed:", err);
        if (ids.length) {                               // never leave questions without options
          await client.from("question_options").delete().in("question_id", ids);
          await client.from("questions").delete().in("id", ids);
        }
        res.failed += part.length; res.error = res.error || err;
      }
      done += part.length;
      if (o.onProgress) o.onProgress({ done, total: todo.length, saved: res.saved.length });
    }
    if (res.saved.length) refreshCatalogSoon();
    return res;
  };

  MCQ_DB.updateQuestion = async function (dbId, item, oldLoc) {
    const client = requireClient();
    const dup = await findDuplicate(item, dbId);
    if (dup) throw duplicateError(dup, "Another database question already has the same question text");

    const categoryId = await getCategoryId(item.cat || "Custom", true);
    const updated = await client.from("questions").update(questionPayload(item, categoryId)).eq("id", dbId);
    if (updated.error) throw updated.error;

    const check = await client.from("questions").select("id").eq("id", dbId).maybeSingle();   // catches a missing UPDATE policy
    if (check.error) throw check.error;
    if (!check.data) throw new Error("Question update affected no database row. Check Supabase UPDATE policy.");

    await writeOptions(client, dbId, item, false);
    if (oldLoc) MCQ_DB.invalidateLesson(oldLoc.cat, oldLoc.sub, oldLoc.lesson);
    MCQ_DB.invalidateLesson(item.cat || "Custom", item.sub, item.lesson);
    refreshCatalogSoon();
    return dbId;
  };

  MCQ_DB.setQuestionLock = async function (dbId, locked, pinHash) {
    const result = await requireClient().from("questions")
      .update({ locked: locked === true, pin_hash: locked === true && pinHash ? String(pinHash) : null })
      .eq("id", dbId);
    if (result.error) throw result.error;
    return dbId;
  };

  MCQ_DB.deleteMany = async function (dbIds, loc) {
    const client = requireClient();
    for (const part of chunk(dbIds, 100)) {
      const o = await client.from("question_options").delete().in("question_id", part);
      if (o.error) throw o.error;
      const r = await client.from("questions").delete().in("id", part);
      if (r.error) throw r.error;
    }
    const left = await client.from("questions").select("id").in("id", dbIds.slice(0, 100)).limit(1);   // still there = a policy blocks DELETE
    if (left.error) throw left.error;
    if (left.data && left.data.length) throw new Error("Question was not deleted. Check Supabase DELETE policy.");
    if (loc) MCQ_DB.invalidateLesson(loc.cat, loc.sub, loc.lesson); else MCQ_DB.clearCache();
    refreshCatalogSoon();
  };
  MCQ_DB.deleteQuestion = (dbId, loc) => MCQ_DB.deleteMany([dbId], loc);

  MCQ_DB.reload = () => loadCatalog(true);

  /* ---------- start ---------- */

  function start() {
    if (!isConfigured()) { console.warn("Supabase is not configured. Add your URL and publishable key in supabase.js."); return; }
    if (!window.supabase || !window.supabase.createClient) { console.error("Supabase JS library did not load."); emit("mcqdb:error", new Error("Supabase library missing")); return; }
    MCQ_DB.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    MCQ_DB.enabled = true;
    loadCatalog(false);
    // keep the data fresh like a real online app: reload when the connection returns or the tab is opened again
    let lastSeen = Date.now();
    window.addEventListener("online", () => { lessonMem.clear(); loadCatalog(true); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastSeen > 60e3 && navigator.onLine) loadCatalog(false);
      lastSeen = Date.now();
    });
  }
  start();
})();
