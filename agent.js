import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import fs from "fs";
import crypto from "crypto";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import { USER_PREFERENCES } from "./config.js";

dotenv.config();

// --- אתחול והגדרות קבועות ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const SEEN_FILE_PATH = "./whatsapp_seen.json";
const DEBOUNCE_MS = (Number(process.env.DEBOUNCE_SECONDS) || 40) * 1000;
const GITHUB_REFRESH_MS = 30 * 60 * 1000; // רענון משרות מהאתר כל 30 דקות

const ALLOWED_GROUPS = new Set(
  (process.env.ALLOWED_GROUP_JIDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// זיכרון פנימי למניעת כפילויות וצבירת הודעות
let githubJobsCache = [];
let lastGithubFetch = 0;
const messageBuffers = new Map(); // key: `${groupJid}_${senderJid}`

// --- 1. ניהול זיכרון מקומי (whatsapp_seen.json) ---
function loadSeenJobs() {
  if (!fs.existsSync(SEEN_FILE_PATH)) {
    return { fingerprints: {}, textHashes: {} };
  }
  try {
    const data = JSON.parse(fs.readFileSync(SEEN_FILE_PATH, "utf-8"));
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const [k, v] of Object.entries(data.fingerprints || {})) {
      if (v.timestamp < cutoff) delete data.fingerprints[k];
    }
    for (const [k, ts] of Object.entries(data.textHashes || {})) {
      if (ts < cutoff) delete data.textHashes[k];
    }
    return data;
  } catch (err) {
    console.error("⚠️ שגיאה בטעינת whatsapp_seen.json, מאתחל מחדש:", err.message);
    return { fingerprints: {}, textHashes: {} };
  }
}

function saveSeenJobs(seenData) {
  fs.writeFileSync(SEEN_FILE_PATH, JSON.stringify(seenData, null, 2), "utf-8");
}

let seenState = loadSeenJobs();

// --- 2. משיכת משרות מהאתר הציבורי ב-GitHub (קריאה בלבד) ---
async function refreshGithubJobsIfNeeded() {
  const url = process.env.GITHUB_JOBS_RAW_URL;
  if (!url) return;
  if (Date.now() - lastGithubFetch < GITHUB_REFRESH_MS && githubJobsCache.length > 0) {
    return;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    githubJobsCache = Array.isArray(data) ? data : data.jobs || Object.values(data);
    lastGithubFetch = Date.now();
    console.log(`🔄 סונכרנו ${githubJobsCache.length} משרות קיימות מתוך GitHub.`);
  } catch (err) {
    console.warn(`⚠️ לא ניתן למשוך משרות מ-GitHub כעת (${err.message}). ממשיך עם Cache קיים.`);
  }
}

function buildExistingJobsContext() {
  const recentWhatsapp = Object.values(seenState.fingerprints)
    .slice(-60)
    .map((j) => `[WhatsApp] Company: ${j.company} | Role: ${j.title} | Contact: ${j.contact}`);

  const siteJobs = githubJobsCache.slice(0, 250).map((j) => {
    const comp = j.company || j.company_name || "Unknown";
    const title = j.title || j.role || j.name || "Unknown";
    return `[CareerSite] Company: ${comp} | Role: ${title}`;
  });

  return [...siteJobs, ...recentWhatsapp].join("\n");
}

// --- 3. סינון ראשוני מהיר (לפני קריאת AI) ---
function passesPreFilter(combinedText, hasImage) {
  const clean = combinedText.trim().toLowerCase();
  if (hasImage && clean.length < 25) return true;
  if (clean.length < 25) return false;

  const hasKeyword = USER_PREFERENCES.preFilterKeywords.some((kw) =>
    clean.includes(kw.toLowerCase())
  );
  return hasKeyword;
}

// --- 4. ניתוח, סינון ובדיקת כפילויות מול Gemini ---
const responseSchema = {
  type: Type.OBJECT,
  properties: {
    is_job_posting: {
      type: Type.BOOLEAN,
      description: "True ONLY if the message is offering one or more tech job positions."
    },
    matches_candidate_profile: {
      type: Type.BOOLEAN,
      description: "True if the role matches Software/Fullstack/Backend/Frontend/AI Engineer AND requires <= 2 years of experience (or is Junior/Entry/Student/Grad)."
    },
    is_duplicate_of_existing: {
      type: Type.BOOLEAN,
      description: "True if this exact role at this company already appears in the provided Existing Jobs list."
    },
    normalized_company: {
      type: Type.STRING,
      description: "Company name in lowercase English without suffixes (e.g., 'wiz', 'monday', 'lightricks'). If confidential/not mentioned, return 'unknown'."
    },
    role_category: {
      type: Type.STRING,
      description: "One of: 'fullstack', 'backend', 'frontend', 'ai_engineer', 'software_engineer', 'other'."
    },
    job_title: {
      type: Type.STRING,
      description: "Clean job title (e.g., 'Junior Full Stack Developer')."
    },
    experience_required: {
      type: Type.STRING,
      description: "Short note on required experience (e.g., '0-2 years', 'Graduate', 'Not specified')."
    },
    location: {
      type: Type.STRING,
      description: "Job location if mentioned (e.g., 'תל אביב / היברידי')."
    },
    contact_identifier: {
      type: Type.STRING,
      description: "Normalized email, link, or phone number to apply (lowercase). If none, return 'none'."
    },
    summary_hebrew: {
      type: Type.STRING,
      description: "2-3 concise bullet points in Hebrew summarizing tech stack, requirements, and how to apply."
    }
  },
  required: [
    "is_job_posting",
    "matches_candidate_profile",
    "is_duplicate_of_existing",
    "normalized_company",
    "role_category",
    "job_title",
    "experience_required",
    "location",
    "contact_identifier",
    "summary_hebrew"
  ]
};

async function analyzeJobWithGemini(combinedText, imageBuffers) {
  await refreshGithubJobsIfNeeded();
  const existingContext = buildExistingJobsContext();

  const prompt = `
You are an expert technical recruiter and job-matching agent for a Computer Science B.Sc. graduate & AI Engineer in Israel.

CANDIDATE TARGET PROFILE:
- Desired Roles: ${USER_PREFERENCES.targetRoles.join(", ")}
- Experience Level: Junior / Graduate / Entry-level / Up to ${USER_PREFERENCES.maxExperienceYears} years of experience. (Reject roles strictly requiring 3+ years).
- Excluded Roles: QA Manual, IT/Helpdesk, Product, Marketing, Sales, DevOps-only (unless software/AI focused).

EXISTING JOBS ALREADY TRACKED (Career Pages & Previous WhatsApp Alerts):
${existingContext || "None yet."}

TASK:
Analyze the attached WhatsApp message (and any attached flyer image).
1. Determine if it is a job posting and if it fits the candidate profile.
2. Check if this job is already listed in the EXISTING JOBS list above (match by company + same role category/title).
3. Extract normalized metadata for deduplication and a clean Hebrew summary.

WHATSAPP MESSAGE TEXT:
---
${combinedText}
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

  const response = await ai.models.generateContent({
    model: "gemini-flash-lite-latest",
    contents,
    config: {
      responseMimeType: "application/json",
      responseSchema,
      temperature: 0.1
    }
  });

  return JSON.parse(response.text);
}

// --- 5. שליחת התראה מעוצבת לטלגרם ---
async function sendTelegramAlert(jobAnalysis, groupName, rawText) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn("⚠️ חסרים פרטי TELEGRAM_BOT_TOKEN או TELEGRAM_CHAT_ID ב-.env");
    return;
  }

  const companyDisplay =
    jobAnalysis.normalized_company === "unknown"
      ? "חברה חסויה / חברת השמה"
      : jobAnalysis.normalized_company.toUpperCase();

  const message = `🎯 *משרה חדשה מוואטסאפ!*

🏢 *חברה:* ${escapeMarkdown(companyDisplay)}
💻 *תפקיד:* ${escapeMarkdown(jobAnalysis.job_title)}
⏳ *ניסיון נדרש:* ${escapeMarkdown(jobAnalysis.experience_required)}
📍 *מיקום:* ${escapeMarkdown(jobAnalysis.location || "לא צוין")}
👥 *קבוצת מקור:* ${escapeMarkdown(groupName)}

📋 *תקציר ודרישות:*
${escapeMarkdown(jobAnalysis.summary_hebrew)}

📬 *איך מגישים:* \`${escapeMarkdown(jobAnalysis.contact_identifier)}\`

---
📝 *הודעה מקורית:*
_${escapeMarkdown(rawText.slice(0, 500))}${rawText.length > 500 ? "..." : ""}_`;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "Markdown"
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("❌ שגיאה בשליחת הודעת טלגרם:", errText);
  } else {
    console.log(`✅ נשלחה התראה לטלגרם: ${companyDisplay} - ${jobAnalysis.job_title}`);
  }
}

function escapeMarkdown(text = "") {
  return String(text).replace(/([_*`\[])/g, "\\$1");
}

// --- 6. עיבוד Batch של הודעות שנצברו מאותו שולח ---
async function processBufferedMessages(bufferKey) {
  const bundle = messageBuffers.get(bufferKey);
  messageBuffers.delete(bufferKey);
  if (!bundle) return;

  const combinedText = bundle.texts.join("\n---\n").trim();
  const hasImage = bundle.images.length > 0;

  if (combinedText.length > 30) {
    const textHash = crypto.createHash("sha256").update(combinedText).digest("hex");
    if (seenState.textHashes[textHash]) {
      console.log(`⏭️ דילוג: טקסט זהה כבר נסרק בעבר מקבוצה אחרת (${bundle.groupName}).`);
      return;
    }
    seenState.textHashes[textHash] = Date.now();
    saveSeenJobs(seenState);
  }

  if (!passesPreFilter(combinedText, hasImage)) {
    return;
  }

  console.log(`🔍 מנתח הודעה מתוך "${bundle.groupName}" באמצעות Gemini...`);

  try {
    const result = await analyzeJobWithGemini(combinedText, bundle.images);

    if (!result.is_job_posting || !result.matches_candidate_profile) {
      console.log(`➖ לא רלוונטי לפרופיל (${result.job_title || "לא משרה"}).`);
      return;
    }

    const comp = (result.normalized_company || "unknown").toLowerCase().trim();
    const cat = (result.role_category || "other").toLowerCase().trim();
    const contact = (result.contact_identifier || "none").toLowerCase().trim();

    const fingerprint =
      comp !== "unknown"
        ? `company::${comp}::${cat}`
        : `contact::${contact}::${cat}`;

    if (seenState.fingerprints[fingerprint] || result.is_duplicate_of_existing) {
      console.log(`♻️ משרה כפולה נחסמה: ${comp} - ${result.job_title} (${fingerprint})`);
      return;
    }

    seenState.fingerprints[fingerprint] = {
      company: comp,
      title: result.job_title,
      contact,
      group: bundle.groupName,
      timestamp: Date.now()
    };
    saveSeenJobs(seenState);

    await sendTelegramAlert(result, bundle.groupName, combinedText);
  } catch (err) {
    console.error("❌ שגיאה בניתוח הודעה מול Gemini:", err.message);
  }
}

// --- 7. חיבור ל-WhatsApp והאזנה לאירועים ---
async function startWhatsAppAgent() {
  const { state, saveCreds } = await useMultiFileAuthState("./wa_auth_session");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false
  });

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
        setTimeout(startWhatsAppAgent, 5000);
      }
    } else if (connection === "open") {
      console.log("✅ מחובר לוואטסאפ בהצלחה!");
      await refreshGithubJobsIfNeeded();

      const groups = await sock.groupFetchAllParticipating();
      console.log("\n📋 רשימת קבוצות הוואטסאפ שלך (העתק את ה-JID הרלוונטיים ל-ALLOWED_GROUP_JIDS ב-.env):");
      Object.values(groups).forEach((g) => {
        const isWatched = ALLOWED_GROUPS.size === 0 || ALLOWED_GROUPS.has(g.id);
        console.log(`   ${isWatched ? "🟢 [מאזין]" : "⚪ [מתעלם]"} ${g.subject}  -->  ${g.id}`);
      });
      console.log("\n🎧 מאזין להודעות חדשות בזמן אמת...\n");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || !remoteJid.endsWith("@g.us")) continue;
      if (msg.key.fromMe) continue;

      if (ALLOWED_GROUPS.size > 0 && !ALLOWED_GROUPS.has(remoteJid)) continue;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
        "";

      const isImage = Boolean(msg.message?.imageMessage);
      if (!text && !isImage) continue;

      const sender = msg.key.participant || "unknown_sender";
      const bufferKey = `${remoteJid}_${sender}`;

      let groupName = remoteJid;
      try {
        const meta = await sock.groupMetadata(remoteJid);
        groupName = meta.subject;
      } catch {}

      if (!messageBuffers.has(bufferKey)) {
        messageBuffers.set(bufferKey, {
          groupName,
          texts: [],
          images: [],
          timer: null
        });
      }

      const bundle = messageBuffers.get(bufferKey);
      if (text) bundle.texts.push(text);

      if (isImage && bundle.images.length < 2) {
        try {
          const buffer = await downloadMediaMessage(msg, "buffer", {});
          const mimeType = msg.message.imageMessage.mimetype || "image/jpeg";
          bundle.images.push({ buffer, mimeType });
        } catch (err) {
          console.warn("⚠️ לא ניתן להוריד תמונה מההודעה:", err.message);
        }
      }

      if (bundle.timer) clearTimeout(bundle.timer);
      bundle.timer = setTimeout(() => {
        processBufferedMessages(bufferKey);
      }, DEBOUNCE_MS);
    }
  });
}

startWhatsAppAgent();
