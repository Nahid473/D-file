/* MCQ Master — Supabase Database Bridge
 * PUBLIC READ + PUBLIC WRITE
 * NO SUPABASE AUTH
 * NO ADMIN ROLE
 *
 * Required extra columns on public.questions:
 *   question_name text
 *   subcategory text
 *   lesson text
 *   locked boolean default false
 *   pin_hash text
 *
 * Never put a service_role/secret key in this file.
 */
(function () {
  "use strict";

  const SUPABASE_URL = "https://uypwmhdzaondcuqboxqf.supabase.co";
  const SUPABASE_KEY = "sb_publishable_v2assRvENFB0ibgeMaMDiA_-AiXHWzf";

  window.MCQ_DB = {
    enabled: false,
    ready: false,
    client: null,
    questions: [],
    error: null
  };

  function isConfigured() {
    return SUPABASE_URL.indexOf("YOUR_") !== 0 &&
           SUPABASE_KEY.indexOf("YOUR_") !== 0;
  }

  function mapRow(row) {
    const opts = Array.isArray(row.question_options)
      ? row.question_options.slice().sort(function (a, b) {
          return String(a.option_key).localeCompare(String(b.option_key));
        })
      : [];

    const answerIndex = opts.findIndex(function (o) {
      return o.is_correct === true;
    });

    const category = row.categories && row.categories.name
      ? row.categories.name
      : "Database";

    return {
      id: -Math.abs(Number(row.id)),
      dbId: Number(row.id),
      t: "mcq",
      name: String(row.question_name || ""),
      cat: category,
      sub: String(row.subcategory || "Database MCQs"),
      lesson: String(row.lesson || "Supabase Database"),
      q: String(row.question || ""),
      o: opts.map(function (o) { return String(o.option_text || ""); }),
      a: answerIndex >= 0 ? answerIndex : 0,
      e: String(row.explanation || ""),
      difficulty: row.difficulty || "easy",
      locked: row.locked === true,
      pinHash: row.pin_hash ? String(row.pin_hash) : null,
      source: "supabase"
    };
  }

  async function loadDatabaseQuestions() {
    if (!isConfigured()) {
      console.warn("Supabase is not configured. Add your Project URL and Publishable/anon key in supabase.js.");
      return;
    }

    if (!window.supabase || !window.supabase.createClient) {
      console.error("Supabase JS library did not load.");
      return;
    }

    const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    window.MCQ_DB.enabled = true;
    window.MCQ_DB.client = client;

    try {
      const { data, error } = await client
        .from("questions")
        .select(`
          id,
          category_id,
          question,
          question_name,
          subcategory,
          lesson,
          difficulty,
          explanation,
          locked,
          pin_hash,
          categories ( id, name ),
          question_options ( option_key, option_text, is_correct )
        `)
        .order("id", { ascending: true });

      if (error) throw error;

      const rows = Array.isArray(data) ? data : [];
      const mapped = rows.map(mapRow).filter(function (q) {
        return q.q && q.o.length >= 2 && q.a >= 0 && q.a < q.o.length;
      });

      window.MCQ_DB.questions = mapped;
      window.MCQ_DB.ready = true;

      let tries = 0;
      const timer = setInterval(function () {
        tries++;
        if (typeof custom !== "undefined" &&
            typeof rebuildCatalog === "function" &&
            typeof refreshHome === "function") {
          clearInterval(timer);

          // Make localStorage match the database exactly for Supabase questions.
          // This removes questions that were deleted directly from Supabase.
          const localNonDb = custom.filter(function (q) { return !q || q.source !== "supabase"; });
          custom = localNonDb.concat(mapped);
          put(CUSTOM_KEY, custom);

          rebuildCatalog();
          if (typeof loadCats === "function") loadCats();
          if (typeof refreshLists === "function") refreshLists();
          refreshHome();

          if (typeof toast === "function") {
            toast("☁️ " + mapped.length + " database questions loaded");
          }
        }
        if (tries > 200) clearInterval(timer);
      }, 50);

    } catch (err) {
      window.MCQ_DB.error = err;
      console.error("Supabase database error:", err);
      if (typeof toast === "function") toast("Database connection failed");
    }
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

  async function getCategoryId(client, name) {
    let { data: cats, error: catError } = await client
      .from("categories")
      .select("id,name")
      .eq("name", name)
      .limit(1);

    if (catError) throw catError;

    if (cats && cats.length) return cats[0].id;

    const insCat = await client
      .from("categories")
      .insert({ name: name, description: "MCQ category" })
      .select("id")
      .single();

    if (insCat.error) throw insCat.error;
    return insCat.data.id;
  }

  async function replaceOptions(client, dbId, item) {
    const del = await client
      .from("question_options")
      .delete()
      .eq("question_id", dbId);
    if (del.error) throw del.error;

    const options = (item.o || []).map(function (text, i) {
      return {
        question_id: dbId,
        option_key: String.fromCharCode(65 + i),
        option_text: text,
        is_correct: i === item.a
      };
    });

    const ins = await client.from("question_options").insert(options);
    if (ins.error) throw ins.error;
  }

  window.MCQ_DB.saveQuestion = async function (item) {
    if (!window.MCQ_DB.enabled || !window.MCQ_DB.client) {
      throw new Error("Supabase is not configured");
    }
    if (!item || item.t === "text") {
      throw new Error("Short-answer questions are not supported by the current SQL schema");
    }

    const client = window.MCQ_DB.client;
    const categoryId = await getCategoryId(client, item.cat || "Custom");

    const insQ = await client
      .from("questions")
      .insert(questionPayload(item, categoryId))
      .select("id")
      .single();

    if (insQ.error) throw insQ.error;

    const dbId = insQ.data.id;
    try {
      await replaceOptions(client, dbId, item);
    } catch (err) {
      await client.from("questions").delete().eq("id", dbId);
      throw err;
    }

    return dbId;
  };

  // Update only lock/PIN fields. Unlocking does not rewrite question options.
  window.MCQ_DB.setQuestionLock = async function (dbId, locked, pinHash) {
    if (!window.MCQ_DB.enabled || !window.MCQ_DB.client) {
      throw new Error("Supabase is not configured");
    }
    const result = await window.MCQ_DB.client
      .from("questions")
      .update({
        locked: locked === true,
        pin_hash: locked === true && pinHash ? String(pinHash) : null
      })
      .eq("id", dbId);
    if (result.error) throw result.error;
    return dbId;
  };

  window.MCQ_DB.updateQuestion = async function (dbId, item) {
    if (!window.MCQ_DB.enabled || !window.MCQ_DB.client) {
      throw new Error("Supabase is not configured");
    }
    if (!item || item.t === "text") {
      throw new Error("Short-answer questions are not supported by the current SQL schema");
    }

    const client = window.MCQ_DB.client;
    const categoryId = await getCategoryId(client, item.cat || "Custom");

    const upd = await client
      .from("questions")
      .update(questionPayload(item, categoryId))
      .eq("id", dbId);

    if (upd.error) throw upd.error;

    // Verify the row is still readable after the update. This catches RLS/no-row cases.
    const check = await client
      .from("questions")
      .select("id")
      .eq("id", dbId)
      .maybeSingle();
    if (check.error) throw check.error;
    if (!check.data) throw new Error("Question update affected no database row. Check Supabase UPDATE policy.");

    await replaceOptions(client, dbId, item);
    return dbId;
  };

  window.MCQ_DB.deleteQuestion = async function (dbId) {
    if (!window.MCQ_DB.enabled || !window.MCQ_DB.client) {
      throw new Error("Supabase is not configured");
    }

    const client = window.MCQ_DB.client;
    const delOptions = await client
      .from("question_options")
      .delete()
      .eq("question_id", dbId);
    if (delOptions.error) throw delOptions.error;

    const result = await client
      .from("questions")
      .delete()
      .eq("id", dbId);
    if (result.error) throw result.error;

    // Verify deletion. If the row is still present, RLS/policy is blocking DELETE.
    const check = await client
      .from("questions")
      .select("id")
      .eq("id", dbId)
      .maybeSingle();
    if (check.error) throw check.error;
    if (check.data) throw new Error("Question was not deleted. Check Supabase DELETE policy.");
  };

  window.MCQ_DB.reload = loadDatabaseQuestions;

  loadDatabaseQuestions();
})();
