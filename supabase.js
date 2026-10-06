/* MCQ Master — Supabase Database Bridge
 * PUBLIC READ + PUBLIC WRITE
 * NO SUPABASE AUTH
 * NO ADMIN ROLE
 * NO admin_users / UUID CHECK
 * Never put a service_role/secret key in this file.
 */
(function () {
  "use strict";

  const SUPABASE_URL = "https://uypwmhdzaondcuqboxqf.supabase.co/rest/v1/";
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
          difficulty,
          explanation,
          categories ( id, name ),
          question_options ( option_key, option_text, is_correct )
        `)
        .order("id", { ascending: true });

      if (error) throw error;

      const rows = Array.isArray(data) ? data : [];
      const mapped = rows.map(function (row) {
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
          cat: category,
          sub: "Database MCQs",
          lesson: "Supabase Database",
          q: String(row.question || ""),
          o: opts.map(function (o) { return String(o.option_text || ""); }),
          a: answerIndex >= 0 ? answerIndex : 0,
          e: String(row.explanation || ""),
          difficulty: row.difficulty || "easy",
          source: "supabase"
        };
      }).filter(function (q) {
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

          const existing = new Set(
            custom.filter(function (q) { return q && q.source === "supabase"; })
              .map(function (q) { return String(q.dbId); })
          );

          mapped.forEach(function (q) {
            if (!existing.has(String(q.dbId))) custom.push(q);
          });

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

  window.MCQ_DB.saveQuestion = async function (item) {
    if (!window.MCQ_DB.enabled || !window.MCQ_DB.client) {
      throw new Error("Supabase is not configured");
    }

    if (!item || item.t === "text") {
      throw new Error("Short-answer questions are not supported by the current SQL schema");
    }

    const client = window.MCQ_DB.client;

    let { data: cats, error: catError } = await client
      .from("categories")
      .select("id,name")
      .eq("name", item.cat)
      .limit(1);

    if (catError) throw catError;

    let categoryId;

    if (cats && cats.length) {
      categoryId = cats[0].id;
    } else {
      const insCat = await client
        .from("categories")
        .insert({
          name: item.cat,
          description: "MCQ category"
        })
        .select("id")
        .single();

      if (insCat.error) throw insCat.error;
      categoryId = insCat.data.id;
    }

    const insQ = await client
      .from("questions")
      .insert({
        category_id: categoryId,
        question: item.q,
        difficulty: item.difficulty || "easy",
        explanation: item.e || ""
      })
      .select("id")
      .single();

    if (insQ.error) throw insQ.error;

    const dbId = insQ.data.id;

    const options = (item.o || []).map(function (text, i) {
      return {
        question_id: dbId,
        option_key: String.fromCharCode(65 + i),
        option_text: text,
        is_correct: i === item.a
      };
    });

    const insO = await client
      .from("question_options")
      .insert(options);

    if (insO.error) {
      await client.from("questions").delete().eq("id", dbId);
      throw insO.error;
    }

    return dbId;
  };

  window.MCQ_DB.deleteQuestion = async function (dbId) {
    if (!window.MCQ_DB.enabled || !window.MCQ_DB.client) {
      throw new Error("Supabase is not configured");
    }

    const { error } = await window.MCQ_DB.client
      .from("questions")
      .delete()
      .eq("id", dbId);

    if (error) throw error;
  };

  window.MCQ_DB.reload = loadDatabaseQuestions;

  loadDatabaseQuestions();
})();