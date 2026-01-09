/**
 * Worker KV Session Manager
 * Handles WhatsApp session persistence
 */

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      // ----- Load API key from Worker secrets -----
      // Works in dev & production
      const API_KEY = env.API_KEY; 
      const auth = request.headers.get("Authorization") || "";

      if (auth !== `Bearer ${API_KEY}`) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      // ----- SAVE SESSION -----
      if (request.method === "POST" && url.pathname === "/session/save") {
        const body = await request.json();
        const { userId, session } = body;

        if (!userId || !session) {
          return new Response(
            JSON.stringify({ error: "userId and session required" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        await env.KV.put(
          userId,
          JSON.stringify({ session, updatedAt: Date.now() }),
          { expirationTtl: 60 * 60 * 24 * 7 } // 7 days
        );

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // ----- GET SESSION -----
      if (request.method === "GET" && url.pathname.startsWith("/session/get/")) {
        const userId = url.pathname.split("/").pop();
        const data = await env.KV.get(userId);

        if (!data) {
          return new Response(JSON.stringify({ session: null }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(data, { headers: { "Content-Type": "application/json" } });
      }

      // ----- DELETE SESSION -----
      if (request.method === "DELETE" && url.pathname.startsWith("/session/delete/")) {
        const userId = url.pathname.split("/").pop();
        await env.SESSIONS_KV.delete(userId);

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // ----- LIST ALL SESSIONS -----
      if (request.method === "GET" && url.pathname === "/session/list") {
        const list = [];
        // List all keys
        for await (const { name, metadata } of env.KV.list()) {
          const value = await env.KV.get(name);
          list.push({ userId: name, session: JSON.parse(value) });
        }

        return new Response(JSON.stringify(list), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};