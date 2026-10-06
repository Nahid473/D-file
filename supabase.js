/* MCQ Master — Supabase Database Bridge
 * PUBLIC READ + PUBLIC WRITE · no Supabase Auth · no admin role
 *
 * Required extra columns on public.questions:
 *   question_name text, subcategory text, lesson text, locked boolean default false, pin_hash text
 *
 * This file only talks to the database. It never touches the app's own variables:
 * when the questions are loaded it fires a "mcqdb:ready" event and script.js applies them
 * (a failed load fires "mcqdb:error").
 *
 * Never put a service_role/secret key in this file.
 */
(function () {
  "use strict";

  const SUPABASE_URL = "https://uypwmhdzaondcuqboxqf.supabase.co";
  const SUPABASE_KEY = "sb_publishable_v2assRvENFB0ibgeMaMDiA_-AiXHWzf";

  const PAGE_SIZE = 1000;        // Supabase returns at most 1000 rows per request, so everything is read page by page
  const KEY_CACHE_MS = 60000;    // how long the duplicate index is reused

  const QUESTION_SELECT = `
    id, category_id, question, question_name, subcategory, lesson, difficulty, explanation,
    locked, pin_hash,
    categories ( id, name ),
    question_options ( option_key, option_text, is_correct )`;

  const MCQ_DB = (window.MCQ_DB = {
    enabled: false,
    ready: false,
    client: null,
    questions: [],
    error: null
  });

  /* ---------- helpers ---------- */

  function isConfigured() {
    return SUPABASE_URL.indexOf("YOUR_") !== 0 && SUPABASE_KEY.indexOf("YOUR_") !== 0;
  }

  // Same normaliser as script.js, so a duplicate is judged the same way in the app and in the database.
  function normalize(value) {
    if (typeof window.normalizeQuestionText === "function") return window.normalizeQuestionText(value);
    return String(value || "").toLowerCase().replace(/<[^>]*>/g, " ").normalize("NFKC")
      .replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  }

  function requireClient() {
    if (!MCQ_DB.enabled || !MCQ_DB.client) throw new Error("Supabase is not configured");
    return MCQ_DB.client;
  }

  function requireMcq(item) {
    if (!item || item.t === "text") {
      throw new Error("Short-answer questions are not supported by the current SQL schema");
    }
  }

  function duplicateError(row, message) {
    const err = new Error(message + (row.question_name ? " (" + row.question_name + ")" : ""));
    err.code = "DUPLICATE";
    err.existing = row;
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

  function mapRow(row) {
    const options = Array.isArray(row.question_options)
      ? row.question_options.slice().sort((a, b) => String(a.option_key).localeCompare(String(b.option_key)))
      : [];
    const answer = options.findIndex(o => o.is_correct === true);

    return {
      id: -Math.abs(Number(row.id)),
      dbId: Number(row.id),
      t: "mcq",
      name: String(row.question_name || ""),
      cat: row.categories && row.categories.name ? row.categories.name : "Database",
      sub: String(row.subcategory || "Database MCQs"),
      lesson: String(row.lesson || "Supabase Database"),
      q: String(row.question || ""),
      o: options.map(o => String(o.option_text || "")),
      a: answer >= 0 ? answer : 0,
      e: String(row.explanation || ""),
      difficulty: row.difficulty || "easy",
      locked: row.locked === true,
      pinHash: row.pin_hash ? String(row.pin_hash) : null,
      source: "supabase"
    };
  }

  function questionPayload(item, categoryId) {
    return {
      category_id: categoryId,
      question: item.q,
      question_name: item.name || "",
      subcategory: item.sub || "General",
      lesson: item.lesson || "General",
      difficulty: item.difficulty || "easy",
      explanation: item.e || "",
      locked: item.locked === true,
      pin_hash: item.locked && item.pinHash ? String(item.pinHash) : null
    };
  }

  /* ---------- categories (looked up once, then remembered) ---------- */

  const categoryIds = new Map();

  async function getCategoryId(client, name) {
    if (categoryIds.has(name)) return categoryIds.get(name);

    const found = await client.from("categories").select("id,name").eq("name", name).limit(1);
    if (found.error) throw found.error;

    let id;
    if (found.data && found.data.length) {
      id = found.data[0].id;
    } else {
      const created = await client.from("categories")
        .insert({ name: name, description: "MCQ category" }).select("id").single();
      if (created.error) throw created.error;
      id = created.data.id;
    }
    categoryIds.set(name, id);
    return id;
  }

  /* ---------- duplicate index: normalised question text -> database row ---------- */

  let keyIndex = null;
  let keyIndexAt = 0;

  async function fetchQuestionKeys(force) {
    if (!force && keyIndex && Date.now() - keyIndexAt < KEY_CACHE_MS) return keyIndex;
    const client = requireClient();
    const rows = await readPaged(() =>
      client.from("questions").select("id,question,question_name").order("id", { ascending: true }));
    const index = new Map();
    for (const row of rows) {
      const key = normalize(row.question);
      if (key && !index.has(key)) index.set(key, row);
    }
    keyIndex = index;
    keyIndexAt = Date.now();
    return index;
  }

  function indexForget(dbId) {
    if (!keyIndex) return;
    for (const [key, row] of keyIndex) if (String(row.id) === String(dbId)) keyIndex.delete(key);
  }

  function indexRemember(dbId, item) {
    if (!keyIndex) return;
    const key = normalize(item.q);
    if (key) keyIndex.set(key, { id: dbId, question: item.q, question_name: item.name || "" });
  }

  async function findDuplicate(item, excludeDbId) {
    const hit = (await fetchQuestionKeys(false)).get(normalize(item.q));
    return hit && String(hit.id) !== String(excludeDbId) ? hit : null;
  }

  /* ---------- options ---------- */

  async function writeOptions(client, dbId, item, isNew) {
    if (!isNew) {
      const del = await client.from("question_options").delete().eq("question_id", dbId);
      if (del.error) throw del.error;
    }
    const rows = (item.o || []).map((text, i) => ({
      question_id: dbId,
      option_key: String.fromCharCode(65 + i),
      option_text: text,
      is_correct: i === item.a
    }));
    const ins = await client.from("question_options").insert(rows);
    if (ins.error) throw ins.error;
  }

  /* ---------- load ---------- */

  async function loadDatabaseQuestions() {
    if (!isConfigured()) {
      console.warn("Supabase is not configured. Add your Project URL and Publishable/anon key in supabase.js.");
      return;
    }
    if (!window.supabase || !window.supabase.createClient) {
      console.error("Supabase JS library did not load.");
      return;
    }

    MCQ_DB.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    MCQ_DB.enabled = true;

    try {
      const rows = await readPaged(() =>
        MCQ_DB.client.from("questions").select(QUESTION_SELECT).order("id", { ascending: true }));
      MCQ_DB.questions = rows.map(mapRow)
        .filter(q => q.q && q.o.length >= 2 && q.a >= 0 && q.a < q.o.length);
      MCQ_DB.error = null;
      MCQ_DB.ready = true;
      window.dispatchEvent(new CustomEvent("mcqdb:ready", { detail: { count: MCQ_DB.questions.length } }));
    } catch (err) {
      MCQ_DB.error = err;
      console.error("Supabase database error:", err);
      window.dispatchEvent(new CustomEvent("mcqdb:error", { detail: err }));
    }
  }

  /* ---------- write API (used by script.js) ---------- */

  // opts.skipDuplicateCheck: the caller already checked (bulk import does it once for the whole file).
  MCQ_DB.saveQuestion = async function (item, opts) {
    const client = requireClient();
    requireMcq(item);

    if (!(opts && opts.skipDuplicateCheck)) {
      const dup = await findDuplicate(item);
      if (dup) throw duplicateError(dup, "Duplicate question already exists in the database");
    }

    const categoryId = await getCategoryId(client, item.cat || "Custom");
    const inserted = await client.from("questions").insert(questionPayload(item, categoryId)).select("id").single();
    if (inserted.error) throw inserted.error;

    const dbId = inserted.data.id;
    try {
      await writeOptions(client, dbId, item, true);
    } catch (err) {
      await client.from("questions").delete().eq("id", dbId);   // never leave a question without options
      throw err;
    }
    indexRemember(dbId, item);
    return dbId;
  };

  MCQ_DB.updateQuestion = async function (dbId, item) {
    const client = requireClient();
    requireMcq(item);

    const dup = await findDuplicate(item, dbId);
    if (dup) throw duplicateError(dup, "Another database question already has the same question text");

    const categoryId = await getCategoryId(client, item.cat || "Custom");
    const updated = await client.from("questions").update(questionPayload(item, categoryId)).eq("id", dbId);
    if (updated.error) throw updated.error;

    // Make sure the row is still readable: catches a missing UPDATE policy (RLS) that would change nothing.
    const check = await client.from("questions").select("id").eq("id", dbId).maybeSingle();
    if (check.error) throw check.error;
    if (!check.data) throw new Error("Question update affected no database row. Check Supabase UPDATE policy.");

    await writeOptions(client, dbId, item, false);
    indexForget(dbId);
    indexRemember(dbId, item);
    return dbId;
  };

  // Update only lock/PIN. Unlocking does not rewrite the question options.
  MCQ_DB.setQuestionLock = async function (dbId, locked, pinHash) {
    const client = requireClient();
    const result = await client.from("questions")
      .update({ locked: locked === true, pin_hash: locked === true && pinHash ? String(pinHash) : null })
      .eq("id", dbId);
    if (result.error) throw result.error;
    return dbId;
  };

  MCQ_DB.deleteQuestion = async function (dbId) {
    const client = requireClient();

    const options = await client.from("question_options").delete().eq("question_id", dbId);
    if (options.error) throw options.error;
    const result = await client.from("questions").delete().eq("id", dbId);
    if (result.error) throw result.error;

    // If the row is still there, a policy is blocking DELETE.
    const check = await client.from("questions").select("id").eq("id", dbId).maybeSingle();
    if (check.error) throw check.error;
    if (check.data) throw new Error("Question was not deleted. Check Supabase DELETE policy.");
    indexForget(dbId);
  };

  MCQ_DB.fetchQuestionKeys = fetchQuestionKeys;
  MCQ_DB.reload = loadDatabaseQuestions;

  loadDatabaseQuestions();
})();
