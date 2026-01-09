import fetch from "node-fetch";
import WhatsAppSession from "../models/WhatsAppSession.js";
import { encrypt, decrypt } from "../utils/crypto.utils.js";

/**
 * Lazy-load Worker KV config
 */
function getWorkerConfig() {
  const WORKER_BASE = process.env.WORKER_BASE_URL;
  const WORKER_API_KEY = process.env.WORKER_API_KEY;

  if (!WORKER_BASE || !WORKER_API_KEY) {
    throw new Error("WORKER_BASE_URL or WORKER_API_KEY not defined in .env");
  }

  return { WORKER_BASE, WORKER_API_KEY };
}

/**
 * Generic fetch wrapper for Worker KV endpoints
 */
async function workerFetch(path, options = {}) {
  const { WORKER_BASE, WORKER_API_KEY } = getWorkerConfig();

  const url = new URL(path, WORKER_BASE).toString();

  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${WORKER_API_KEY}`,
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(text);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

/**
 * Save session to Worker KV and Mongo
 */
export async function saveSession(userId, session) {
  const encrypted = encrypt(session);

  // Worker KV first
  try {
    await workerFetch("/session/save", {
      method: "POST",
      body: JSON.stringify({ userId, session: encrypted }),
    });
  } catch (e) {
    if (e.status === 401) {
      console.error(`[WA:${userId}] Worker KV Unauthorized: Check API_KEY`);
    } else {
      console.warn(`[WA:${userId}] Worker KV save failed: ${e.message}`);
    }
  }

  // Mongo backup
  await WhatsAppSession.updateOne(
    { userId },
    { session: encrypted, connected: true, requiresQR: false, qr: null },
    { upsert: true }
  );
}

/**
 * Load session from Worker KV first, then fallback to Mongo
 */
export async function loadSession(userId) {
  try {
    const data = await workerFetch(`/session/get/${userId}`);
    if (data?.session) return decrypt(data.session);
  } catch (e) {
    if (e.status === 401) {
      console.error(`[WA:${userId}] Worker KV Unauthorized: Check API_KEY`);
    } else if (e.status !== 404) {
      console.warn(`[WA:${userId}] Worker KV read failed: ${e.message}`);
    }
  }

  // Fallback to Mongo
  const mongo = await WhatsAppSession.findOne({ userId }).lean();
  if (!mongo?.session) return null;

  const decrypted = decrypt(mongo.session);

  // Rehydrate Worker KV asynchronously
  try {
    await workerFetch("/session/save", {
      method: "POST",
      body: JSON.stringify({ userId, session: encrypt(decrypted) }),
    });
  } catch (_) {}

  return decrypted;
}

/**
 * Load all sessions (Worker KV first)
 */
export async function loadAllSessions() {
  try {
    const sessions = await workerFetch("/session/list");
    return sessions.map((s) => ({ userId: s.userId, session: s.session }));
  } catch (e) {
    if (e.status === 401) {
      console.error(`[WA] Worker KV Unauthorized: Check API_KEY`);
    } else {
      console.warn(`[WA] Failed to load all sessions from Worker KV: ${e.message}`);
    }
    return [];
  }
}

/**
 * Delete session from Worker KV and Mongo
 */
export async function deleteSession(userId) {
  // Worker KV
  try {
    await workerFetch(`/session/delete/${userId}`, { method: "DELETE" });
  } catch (e) {
    if (e.status === 401) {
      console.error(`[WA:${userId}] Worker KV Unauthorized: Check API_KEY`);
    } else {
      console.warn(`[WA:${userId}] Worker KV delete failed: ${e.message}`);
    }
  }

  // Mongo
  await WhatsAppSession.updateOne(
    { userId },
    { session: null, connected: false, requiresQR: true, qr: null }
  );
}