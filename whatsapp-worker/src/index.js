/**
 * Worker KV Session Manager – FULL HARD DEBUG
 * Uses KV_BINDING (matches wrangler.jsonc)
 * No silent failures. Everything logs.
 */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      console.log("══════════════════════════════════════");
      console.log("🔹 REQUEST START");
      console.log("🔹 URL:", url.toString());
      console.log("🔹 Method:", request.method);

      // Dump headers safely
      const headersDump = {};
      for (const [k, v] of request.headers.entries()) {
        headersDump[k] = v;
      }
      console.log("🔹 Headers:", headersDump);

      console.log("🔹 ENV KEYS:", Object.keys(env));

      // ───────────────── API KEY DEBUG ─────────────────
      let API_KEY = env.API_KEY;
      const DEV_API_KEY = "g8F9P3RQjbN9pNcDNK3lkoOFr9XAoIn9";

      if (!API_KEY) {
        console.warn("⚠️ API_KEY missing in env — using DEV_API_KEY");
        API_KEY = DEV_API_KEY;
      }

      const authHeader = request.headers.get("Authorization");
      console.log("🔹 Authorization header:", authHeader);
      console.log("🔹 Expected header:", `Bearer ${API_KEY}`);

      if (authHeader !== `Bearer ${API_KEY}`) {
        console.error("❌ AUTH FAILED");
        return new Response(
          JSON.stringify({
            error: "Unauthorized",
            received: authHeader,
            expected: `Bearer ${API_KEY}`,
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }

      console.log("✅ AUTH PASSED");

      // ───────────────── KV BINDING CHECK ─────────────────
      if (!env.KV_BINDING) {
        console.error("❌ KV_BINDING NOT FOUND IN ENV");
        return new Response(
          JSON.stringify({
            error: "KV_BINDING missing",
            envKeys: Object.keys(env),
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      console.log("✅ KV_BINDING FOUND");

      // ───────────────── AUTO-SEED DEV SESSION ─────────────────
      const DEV_TOKEN = "g8F9P3RQjbN9pNcDNK3lkoOFr9XAoIn9";

      const existing = await env.KV_BINDING.get(DEV_TOKEN);
      console.log("🔹 Existing dev token value:", existing);

      if (!existing) {
        const seedPayload = {
          session: "dev-session",
          userId: "dev-user",
          updatedAt: Date.now(),
        };

        await env.KV_BINDING.put(
          DEV_TOKEN,
          JSON.stringify(seedPayload),
          { expirationTtl: 60 * 60 * 24 * 7 }
        );

        console.log("✅ DEV SESSION AUTO-SEEDED:", seedPayload);
      }

      // ───────────────── SAVE SESSION ─────────────────
      if (request.method === "POST" && url.pathname === "/session/save") {
        const body = await request.json();
        console.log("🔹 SAVE BODY:", body);

        const { userId, session } = body || {};

        if (!userId || !session) {
          console.error("❌ INVALID SAVE PAYLOAD");
          return new Response(
            JSON.stringify({ error: "userId and session required" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        const payload = {
          session,
          updatedAt: Date.now(),
        };

        await env.KV_BINDING.put(
          userId,
          JSON.stringify(payload),
          { expirationTtl: 60 * 60 * 24 * 7 }
        );

        console.log("✅ SESSION SAVED:", { userId, payload });

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // ───────────────── GET SESSION ─────────────────
      if (request.method === "GET" && url.pathname.startsWith("/session/get/")) {
        const userId = url.pathname.split("/").pop();
        console.log("🔹 GET userId:", userId);

        const raw = await env.KV_BINDING.get(userId);
        console.log("🔹 RAW KV VALUE:", raw);

        if (!raw) {
          console.warn("⚠️ SESSION NOT FOUND");
          return new Response(JSON.stringify({ session: null }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          console.error("❌ JSON PARSE FAILED:", e);
          return new Response(
            JSON.stringify({ error: "Corrupt session JSON" }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }

        console.log("✅ SESSION LOADED:", parsed);

        return new Response(JSON.stringify(parsed), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // ───────────────── DELETE SESSION ─────────────────
      if (
        request.method === "DELETE" &&
        url.pathname.startsWith("/session/delete/")
      ) {
        const userId = url.pathname.split("/").pop();
        console.log("🔹 DELETE userId:", userId);

        await env.KV_BINDING.delete(userId);

        console.log("✅ SESSION DELETED");

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // ───────────────── LIST SESSIONS ─────────────────
      if (request.method === "GET" && url.pathname === "/session/list") {
        const results = [];

        const listed = await env.KV_BINDING.list();
        console.log("🔹 KV LIST:", listed);

        for (const key of listed.keys) {
          const value = await env.KV_BINDING.get(key.name);
          results.push({
            key: key.name,
            value: value ? JSON.parse(value) : null,
          });
        }

        console.log("✅ SESSION LIST RESULT:", results);

        return new Response(JSON.stringify(results), {
          headers: { "Content-Type": "application/json" },
        });
      }

      console.warn("⚠️ ROUTE NOT FOUND");
      return new Response(JSON.stringify({ error: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("🔥 WORKER CRASH:", err);
      return new Response(
        JSON.stringify({
          error: err.message,
          stack: err.stack,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};