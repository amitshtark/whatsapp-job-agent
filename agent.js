import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import { USER_PREFERENCES } from "./config.js";

dotenv.config();

// --- אתחול והגדרות קבועות ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const DEBOUNCE_MS = 2500;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";

const ALLOWED_GROUPS = new Set(
  (process.env.ALLOWED_GROUP_JIDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const messageBuffers = new Map();
let messageSequence = 0;

let activeSock = null;
let isReconnecting = false;
let reconnectTimer = null;

// --- Gemini request with retry for 503 / 429 ---
async function callGeminiWithRetry(params, maxRetries = 4) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      const serialized = `${err?.message || ""} ${JSON.stringify(err || {})}`;
      const isRetryable =
        serialized.includes("503") ||
        serialized.includes("429") ||
        serialized.includes("UNAVAILABLE") ||
        serialized.includes("RESOURCE_EXHAUSTED");
      if (!isRetryable || attempt === maxRetries) throw err;
      const delayMs = attempt * 3000;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// --- Binary forwarding classification ---
const responseSchema = {
  type: Type.OBJECT,
  properties: {
    should_forward: {
      type: Type.BOOLEAN,
      description: "True for a job matching or plausibly/borderline matching the candidate profile; false for a clear non-job or obvious mismatch."
    }
  },
  required: ["should_forward"]
};

async function shouldForwardWithGemini(messageText, imageBuffers) {
  const prompt = `
You are a binary forwarding classifier for incoming WhatsApp group messages.

Candidate profile:
- Target roles: ${USER_PREFERENCES.targetRoles.join(", ")}
- Experience: up to ${USER_PREFERENCES.maxExperienceYears} years
- Clear exclusions: ${USER_PREFERENCES.excludedKeywords.join(", ")}

Return should_forward=true only for a job matching or plausibly/borderline matching this profile. Return false for clear non-jobs and obvious mismatches. If job or candidate fit is uncertain, return true. Do not extract, summarize, rewrite, or return any message fields.

WhatsApp message text:
---
${messageText}
---
`;

  const contents = [prompt];
  for (const img of imageBuffers) {
    contents.push({
      inlineData: {
        data: img.buffer.toString("base64"),
        mimeType: img.mimeType
      }
    });
  }

  const response = await callGeminiWithRetry({
    model: GEMINI_MODEL,
    contents,
    config: {
      responseMimeType: "application/json",
      responseSchema,
      temperature: 0.1
    }
  });

  const result = JSON.parse(response.text);
  if (typeof result.should_forward !== "boolean") {
    throw new Error("Gemini response is missing boolean should_forward");
  }
  return result.should_forward;
}

async function sendTelegramAlert(groupName, senderPhone, messagePhone, date, messageText) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn("⚠️ חסרים פרטי TELEGRAM_BOT_TOKEN או TELEGRAM_CHAT_ID ב-.env");
    return;
  }

  const message = `group name: ${groupName}
sender phone number: ${senderPhone}
phone number in message: ${messagePhone}
date: ${date}
message: ${messageText}`;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("❌ שגיאה בשליחת הודעת טלגרם:", errText);
    } else {
      console.log(`✅ נשלחה התראה לטלגרם עבור ${groupName}.`);
    }
  } catch (err) {
    console.error("❌ שגיאה בשליחת הודעת טלגרם:", err.message);
  }
}

// --- Process messages batched by group and sender ---
async function processBufferedMessages(bufferKey) {
  const bundle = messageBuffers.get(bufferKey);
  messageBuffers.delete(bufferKey);
  if (!bundle) return;

  const parts = bundle.parts.sort((a, b) => a.sequence - b.sequence);
  const messageText = parts.map((part) => part.text).filter(Boolean).join("\n");
  const imageBuffers = parts.flatMap((part) => part.images);
  try {
    const shouldForward = await shouldForwardWithGemini(messageText, imageBuffers);
    if (shouldForward) {
      await sendTelegramAlert(
        bundle.groupName,
        bundle.senderPhone,
        extractPhoneNumberFromText(messageText),
        bundle.date,
        messageText
      );
    }
  } catch (err) {
    console.error("❌ שגיאה בסיווג או העברת הודעה:", err.message);
  }
}

function phoneFromIdentifier(identifier) {
  if (typeof identifier !== "string" && typeof identifier !== "number" &&
      typeof identifier !== "bigint") return null;

  const value = String(identifier).trim();
  if (!value) return null;

  let phone = value;
  if (value.includes("@")) {
    const [user, server] = value.split("@");
    if (!["s.whatsapp.net", "c.us"].includes(server?.toLowerCase())) return null;
    phone = user.split(":")[0];
  } else {
    phone = value.split(":")[0];
    if (!/^\+?\d+$/.test(phone)) return null;
  }

  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
}

function extractSenderPhone(msg, user) {
  const key = msg.key || {};
  const candidates = [];
  const addPhoneFields = (record) => {
    if (!record || typeof record !== "object") return;
    for (const [field, value] of Object.entries(record)) {
      if (/(pn|jid|lid|participant|sender|phone)/i.test(field)) {
        candidates.push(value);
      }
    }
  };

  if (key.fromMe) {
    candidates.push(user?.id, user?.pn, user?.jid, user?.phoneNumber, user?.lid);
    addPhoneFields(user);
  }
  candidates.push(
    key.participant,
    key.participantAlt,
    msg.participant,
    msg.participantPn,
    msg.participantJid,
    msg.participantLid
  );
  addPhoneFields(msg);
  addPhoneFields(key);
  if (!key.fromMe) {
    candidates.push(user?.id, user?.pn, user?.jid, user?.phoneNumber, user?.lid);
    addPhoneFields(user);
  }

  for (const candidate of candidates) {
    const phone = phoneFromIdentifier(candidate);
    if (phone) return phone;
  }
  return "unknown";
}

function extractPhoneNumberFromText(text) {
  const candidates = text.match(/(?<!\d)\+?\d(?:[\d\s().-]{5,}\d)(?!\d)/g) || [];
  for (const candidate of candidates) {
    const digits = candidate.replace(/\D/g, "");
    const isInternational = candidate.trim().startsWith("+") &&
      digits.length >= 8 && digits.length <= 15;
    const isIsraeliMobile = /^05\d{8}$/.test(digits);
    const isIsraeliLandline = /^0(?:2|3|4|8|9)\d{7}$/.test(digits) ||
      /^07\d{8}$/.test(digits);
    if (isInternational || isIsraeliMobile || isIsraeliLandline) {
      return candidate.trim();
    }
  }
  return "empty";
}

function formatMessageDate(timestamp) {
  const formatInJerusalem = (date) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
  };

  let value;
  try {
    if (typeof timestamp === "bigint") {
      value = Number(timestamp);
    } else if (typeof timestamp === "number" || typeof timestamp === "string") {
      value = Number(timestamp);
    } else if (timestamp && typeof timestamp === "object") {
      if (typeof timestamp.toNumber === "function") {
        value = timestamp.toNumber();
      } else if (timestamp.seconds !== undefined) {
        value = Number(timestamp.seconds);
      } else if (timestamp.low !== undefined && timestamp.high !== undefined) {
        value = Number((BigInt(timestamp.high) << 32n) | BigInt(timestamp.low >>> 0));
      }
    }

    if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid message timestamp");
    const milliseconds = value > 1e12 ? value : value * 1000;
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) throw new Error("Invalid message date");
    return formatInJerusalem(date);
  } catch {
    return formatInJerusalem(new Date());
  }
}

function unwrapMessageContent(message) {
  let content = message;
  for (let depth = 0; depth < 5; depth++) {
    const wrapped =
      content?.ephemeralMessage?.message ||
      content?.viewOnceMessage?.message ||
      content?.viewOnceMessageV2?.message ||
      content?.viewOnceMessageV2Extension?.message ||
      content?.documentWithCaptionMessage?.message ||
      content?.editedMessage?.message;
    if (!wrapped) break;
    content = wrapped;
  }
  return content || {};
}

function scheduleReconnect(delayMs = 8000) {
  if (isReconnecting) return;
  isReconnecting = true;

  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    isReconnecting = false;
    startWhatsAppAgent();
  }, delayMs);
}

// --- WhatsApp connection and message handling ---
async function startWhatsAppAgent() {
  if (activeSock) {
    try {
      activeSock.ev.removeAllListeners("connection.update");
      activeSock.ev.removeAllListeners("messages.upsert");
      activeSock.ev.removeAllListeners("creds.update");
      activeSock.end(undefined);
    } catch {}
    activeSock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState("./wa_auth_session");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000
  });

  activeSock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 סרוק את קוד ה-QR הבא באמצעות וואטסאפ (מכשירים מקושרים):\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`⚠️ החיבור לוואטסאפ נסגר (קוד ${statusCode}). מתחבר מחדש: ${shouldReconnect}`);
      if (shouldReconnect) {
        const delay = statusCode === 408 ? 10000 : 5000;
        scheduleReconnect(delay);
      }
    } else if (connection === "open") {
      isReconnecting = false;
      const groups = await sock.groupFetchAllParticipating();
      const watchedCount = Object.values(groups).filter(
        (g) => ALLOWED_GROUPS.size === 0 || ALLOWED_GROUPS.has(g.id)
      ).length;
      console.log(`🎧 מאזין ל-${watchedCount} קבוצות משרות בזמן אמת...`);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || !remoteJid.endsWith("@g.us")) continue;
      if (ALLOWED_GROUPS.size > 0 && !ALLOWED_GROUPS.has(remoteJid)) continue;

      const content = unwrapMessageContent(msg.message);
      const messageText =
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption ||
        "";

      const isImage = Boolean(content.imageMessage);
      const senderJid = msg.key.participant || msg.key.participantAlt || msg.participant || "";
      const sequence = messageSequence++;
      const bufferKey = `${remoteJid}_${senderJid || msg.key.id || `unknown_${sequence}`}`;
      let bundle = messageBuffers.get(bufferKey);

      if (!bundle) {
        bundle = {
          groupName: remoteJid,
          senderPhone: extractSenderPhone(msg, sock.user),
          date: formatMessageDate(msg.messageTimestamp),
          parts: [],
          pending: 0,
          timer: null
        };
        messageBuffers.set(bufferKey, bundle);
      }
      if (bundle.senderPhone === "unknown") {
        bundle.senderPhone = extractSenderPhone(msg, sock.user);
      }
      const part = { sequence, text: messageText, images: [] };
      bundle.parts.push(part);
      bundle.pending++;
      if (bundle.timer) clearTimeout(bundle.timer);

      if (bundle.parts.length === 1) {
        try {
          const meta = await sock.groupMetadata(remoteJid);
          bundle.groupName = meta.subject || remoteJid;
        } catch (err) {
          console.warn(`⚠️ לא ניתן לקבל את שם הקבוצה (${remoteJid}):`, err.message);
        }
      }

      if (isImage) {
        try {
          const buffer = await downloadMediaMessage(msg, "buffer", {});
          const mimeType = content.imageMessage.mimetype || "image/jpeg";
          part.images.push({ buffer, mimeType });
        } catch (err) {
          console.warn("⚠️ לא ניתן להוריד תמונה מההודעה:", err.message);
        }
      }

      bundle.pending--;
      if (bundle.pending === 0) {
        bundle.timer = setTimeout(() => processBufferedMessages(bufferKey), DEBOUNCE_MS);
      }
    }
  });
}

startWhatsAppAgent();