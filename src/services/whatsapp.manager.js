import pkg from "whatsapp-web.js";
import { logger } from "../utils/logger.js";
import { handleIncomingMessage } from "../utils/message.dispatcher.js";
import { saveSession, loadSession, loadAllSessions, deleteSession } from "./sessionStore.js";

const { Client } = pkg;

/* -------------------- MEMORY -------------------- */
const clients = new Map();
const readyClients = new Set();

/* -------------------- PUBLIC API -------------------- */
export function getClient(userId) {
  const k = String(userId);
  return readyClients.has(k) ? clients.get(k) : null;
}

export async function waitForClientReady(userId, timeout = 60000) {
  const k = String(userId);
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (readyClients.has(k)) return true;
    await new Promise(r => setTimeout(r, 1000));
  }

  throw new Error(`Client not ready: ${userId}`);
}

export async function destroyClient(userId, logout = false) {
  const k = String(userId);
  const client = clients.get(k);
  if (!client) return;

  try {
    if (logout) await client.logout();
    await client.destroy();
  } catch (err) {
    logger.error(`[WA:${userId}] Destroy failed`);
  }

  clients.delete(k);
  readyClients.delete(k);
}

/* -------------------- INIT USER -------------------- */
export async function initWhatsAppUser(userId, preloadedSession = null) {
  const k = String(userId);
  if (clients.has(k)) return clients.get(k);

  const session = preloadedSession || await loadSession(userId);

  const client = new Client({
    session: session || undefined,
    puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
  });

  /* -------------------- EVENTS -------------------- */
  client.on("authenticated", async session => {
    try {
      await saveSession(userId, JSON.parse(JSON.stringify(session)));
      logger.info(`[WA:${userId}] Authenticated`);
    } catch (e) {
      logger.error(`[WA:${userId}] Auth save failed`);
    }
  });

  client.on("ready", async () => {
    readyClients.add(k);
    logger.info(`[WA:${userId}] Ready`);

    try {
      const s = client.getSession?.();
      if (s) await saveSession(userId, JSON.parse(JSON.stringify(s)));
    } catch (_) {}
  });

  client.on("qr", async qr => {
    await saveSession(userId, null); // session is null until authenticated
    logger.info(`[WA:${userId}] QR required`);
  });

  client.on("disconnected", async reason => {
    readyClients.delete(k);
    clients.delete(k);

    await saveSession(userId, null);
    logger.warn(`[WA:${userId}] Disconnected: ${reason}`);
  });

  client.on("message", async msg => {
    if (!msg?.body) return;
    await handleIncomingMessage({ userId, client, msg });
  });

  /* -------------------- AUTO DESTROY IF NOT READY -------------------- */
  setTimeout(async () => {
    if (!readyClients.has(k)) {
      await destroyClient(userId, true);
      await saveSession(userId, null);
    }
  }, 90_000);

  await client.initialize();
  clients.set(k, client);

  return client;
}

/* -------------------- RESTORE ALL -------------------- */
export async function initAllWhatsAppUsers() {
  const sessions = await loadAllSessions();
  logger.info(`[WA] Restoring ${sessions.length} sessions from Worker KV`);

  for (const s of sessions) {
    try {
      const decrypted = s.session ? JSON.parse(s.session) : null;
      await initWhatsAppUser(s.userId, decrypted);
    } catch (e) {
      logger.error(`[WA:${s.userId}] Restore failed: ${e.message}`);
    }
  }
}