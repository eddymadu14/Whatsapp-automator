// WhatsAppManager.js (robust version)
import pkg from "whatsapp-web.js";
import sessionStore from "./sessionStore.js";
import WhatsAppSession from "../models/WhatsAppSession.js";
import { logger } from "../utils/logger.js";
import { handleIncomingMessage } from "../utils/message.dispatcher.js";

const { Client } = pkg;

const clients = new Map();       // userId -> client
const readyClients = new Set();  // userId -> ready

export function getClient(userId) {
  const key = String(userId);
  if (!clients.has(key) || !readyClients.has(key)) return null;
  return clients.get(key);
}

export function setClient(userId, client) {
  clients.set(String(userId), client);
}

export async function destroyClient(userId, logout = false) {
  const key = String(userId);
  const client = clients.get(key);
  if (!client) return;

  try {
    if (logout) await client.logout();
    await client.destroy();
  } catch (err) {
    logger.error(`[WA:${userId}] Destroy error: ${err.message}`);
  }

  clients.delete(key);
  readyClients.delete(key);
}

export async function waitForClientReady(userId, timeout = 60000) {
  const key = String(userId);
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (readyClients.has(key)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error(`WhatsApp client not ready for user ${userId}`);
}

export async function initWhatsAppUser(userId) {
  const key = String(userId);

  if (clients.has(key)) {
    logger.info(`[WA:${userId}] Client already initialized`);
    return clients.get(key);
  }

  // 🔹 Load existing session using sessionStore
  const existingSession = await sessionStore.get(userId);

  const client = new Client({
    session: existingSession || undefined,
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  /* ------------------ EVENTS ------------------ */

  // 🔹 Save session on authentication
  client.on("authenticated", async (session) => {
    if (!session || typeof session !== "object") {
      logger.warn(`[WA:${userId}] Authenticated event received invalid session data`);
      console.log(`[WA:${userId}] Raw authenticated payload:`, session);
      return;
    }

    logger.info(`[WA:${userId}] Authenticated, saving session`);
    await sessionStore.set(userId, session);
  });

  // 🔹 Client is ready
  client.on("ready", async () => {
    readyClients.add(key);
    logger.info(`[WA:${userId}] Ready`);

    // Capture session if not already saved
    if (client?.session && typeof client.session === "object") {
      await sessionStore.set(userId, client.session);
    }

    // Update status in Mongo directly
    await WhatsAppSession.updateOne(
      { userId },
      { connected: true, requiresQR: false, qr: null },
      { upsert: true }
    );
  });

  // 🔹 QR generated
  client.on("qr", async (qr) => {
    logger.info(`[WA:${userId}] QR generated`);

    await WhatsAppSession.updateOne(
      { userId },
      { connected: false, requiresQR: true, qr },
      { upsert: true }
    );
  });

  // 🔹 Disconnected
  client.on("disconnected", async (reason) => {
    logger.warn(`[WA:${userId}] Disconnected: ${reason}`);

    readyClients.delete(key);
    clients.delete(key);

    // Remove stored session completely
    await sessionStore.remove(userId);

    // Update status in Mongo
    await WhatsAppSession.updateOne(
      { userId },
      { connected: false, requiresQR: true, qr: null }
    );
  });

  /* ---------------- MESSAGE PIPELINE ---------------- */

  client.on("message", async (msg) => {
    try {
      if (!msg?.body) return;

      logger.debug(`[WA:${userId}] Incoming message from ${msg.from}`);
      await handleIncomingMessage({ userId, client, msg });
    } catch (err) {
      logger.error(`[WA:${userId}] Message handler error: ${err.message}`);
    }
  });

  /* -------------------------------------------------- */

  await client.initialize();
  setClient(userId, client);

  logger.info(`[WA:${userId}] Client initialized (awaiting ready)`);

  return client;
}

export async function initAllWhatsAppUsers() {
  const sessions = await WhatsAppSession.find({ connected: true });
  logger.info(`[WA] Restoring ${sessions.length} sessions`);

  for (const session of sessions) {
    try {
      await initWhatsAppUser(session.userId);
      logger.info(`[WA:${session.userId}] Restore initiated`);
    } catch (err) {
      logger.error(`[WA:${session.userId}] Restore failed: ${err.message}`);
    }
  }
}