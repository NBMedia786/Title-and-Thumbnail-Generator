
//last try 



//server.js - Hostinger Ubuntu-friendly backend for Title + Thumbnail Generator

import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import zlib from 'zlib';
import crypto from 'crypto';

import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { GoogleGenAI } from '@google/genai'; // New SDK for image generation
import mammoth from 'mammoth';

// --- ESM helpers ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Env & config ---
const PORT = Number(process.env.PORT || 3002);
const HOST = '0.0.0.0';

const API_KEY = process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  console.error('ERROR: GOOGLE_API_KEY missing in .env');
  process.exit(1);
}

const MODEL_NAME = process.env.MODEL || 'gemini-2.5-pro';

// Gold Standard paths (same as your current project)
const GS_JSON_PATH = process.env.GS_JSON_PATH || 'assets/DATASET1.JSON';
const GS_CSV_PATH = process.env.GS_CSV_PATH || 'assets/top100_titles_thumbnails.csv';
const GS_DOCX_PATH =
  process.env.GS_DOCX_PATH || 'assets/VIRAL CRIME-NICHE MASTER KEYWORD.txt';

// Caps for GS content to avoid 400 "invalid argument" on big prompts
const GS_CAP_JSON = 180_000;
const GS_CAP_CSV = 120_000;
const GS_CAP_KW = 120_000;

// History config
const HIST_DIR = path.resolve(__dirname, process.env.HIST_DIR || './data/history');
const HISTORY_LIMIT_BYTES = BigInt(
  process.env.HISTORY_LIMIT_BYTES || 21_474_836_480n // ~20GB default
);

// --- Gemini clients ---
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GOOGLE_API_KEY);
// Initialize new SDK for image generation
const genAIImage = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

// Wait until a Files API file is ACTIVE before using it with Gemini
async function waitForFileActive(fileName, {
  timeoutMs = 5 * 60 * 1000,   // 5 minutes max
  initialDelayMs = 1000,       // 1s
  maxDelayMs = 10_000          // 10s
} = {}) {
  const start = Date.now();
  let delay = initialDelayMs;

  let file = await fileManager.getFile(fileName);
  while (file.state !== 'ACTIVE') {
    if (file.state === 'FAILED') {
      throw new Error(`Files API: file ${fileName} is in FAILED state`);
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(`Files API: file ${fileName} did not become ACTIVE in time (last state=${file.state})`);
    }

    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(maxDelayMs, Math.floor(delay * 1.5));
    file = await fileManager.getFile(fileName);
  }

  return file;
}

// --- Express setup ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// Static: /public for index.html + history.js (same UI as before)
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// --- Multer for local uploads (no yt-dlp, no ytdl-core) ---
const MAX_FILE_SIZE = Number(process.env.MULTER_MAX_FILE_SIZE || 2_147_483_648); // 2GB
const UPLOADS_DIR = path.join(__dirname, 'public/uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => cb(null, `upload_${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9.]/g, '_')}`)
  }),
  limits: { fileSize: MAX_FILE_SIZE }
});

// --- Helpers ---
function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.resolve(__dirname, p);
}

// --- Gold Standards loader ---
let GOLD_STANDARDS = {
  jsonText: null,
  csvText: null,
  kwText: null
};

async function loadGoldStandards() {
  const jsonPath = resolvePath(GS_JSON_PATH);
  const csvPath = resolvePath(GS_CSV_PATH);
  const kwPath = resolvePath(GS_DOCX_PATH);

  // JSON
  try {
    const raw = await fs.promises.readFile(jsonPath, 'utf-8');
    JSON.parse(raw); // validate
    GOLD_STANDARDS.jsonText = raw.slice(0, GS_CAP_JSON);
    console.log('[GS] Loaded JSON:', jsonPath, 'len=', GOLD_STANDARDS.jsonText.length);
  } catch (err) {
    console.warn('[GS] JSON load failed:', err.message);
    GOLD_STANDARDS.jsonText = null;
  }

  // CSV
  try {
    const raw = await fs.promises.readFile(csvPath, 'utf-8');
    GOLD_STANDARDS.csvText = raw.slice(0, GS_CAP_CSV);
    console.log('[GS] Loaded CSV:', csvPath, 'len=', GOLD_STANDARDS.csvText.length);
  } catch (err) {
    console.warn('[GS] CSV load failed:', err.message);
    GOLD_STANDARDS.csvText = null;
  }

  // Keywords: txt or docx
  try {
    let text = '';
    if (kwPath.toLowerCase().endsWith('.docx')) {
      const buf = await fs.promises.readFile(kwPath);
      const res = await mammoth.extractRawText({ buffer: buf });
      text = res.value || '';
    } else {
      text = await fs.promises.readFile(kwPath, 'utf-8');
    }
    GOLD_STANDARDS.kwText = text.slice(0, GS_CAP_KW);
    console.log('[GS] Loaded keywords:', kwPath, 'len=', GOLD_STANDARDS.kwText.length);
  } catch (err) {
    console.warn('[GS] Keywords load failed:', err.message);
    GOLD_STANDARDS.kwText = null;
  }

  if (!GOLD_STANDARDS.jsonText && !GOLD_STANDARDS.csvText && !GOLD_STANDARDS.kwText) {
    console.warn('[GS] WARNING: No Gold Standards loaded. Model will still run, but quality may drop.');
  }
}
// === GS STATUS ENDPOINT ===
app.get("/api/gs-status", (_req, res) => {
  const json = !!GOLD_STANDARDS.jsonText;
  const csv = !!GOLD_STANDARDS.csvText;
  const doc = !!GOLD_STANDARDS.kwText;

  res.json({
    serverGS: {
      json,
      csv,
      doc,
      all: json && csv && doc,
    },
  });
});

function buildGSIngestParts() {
  const parts = [];

  parts.push({
    text:
      "=== GOLD STANDARD ANALYSIS FRAMEWORK ===\n\n" +
      "You are about to receive THREE gold standard datasets containing the most successful true-crime YouTube titles, thumbnails, and keywords. " +
      "These represent proven, high-performing content from top channels (Dr.Insanity, EWU, M7CS, Mysterious 7).\n\n" +
      "YOUR TASK: Deeply analyze these datasets to extract actionable patterns. You MUST:\n\n" +
      "1. PSYCHOLOGICAL TRIGGERS - Identify the 5-7 most common psychological triggers used across examples:\n" +
      "   • Curiosity Gap (withholding key information)\n" +
      "   • Negativity Bias (shocking/disturbing elements)\n" +
      "   • Specificity (concrete details that add authenticity)\n" +
      "   • Emotional Intensity (peak emotional moments)\n" +
      "   • Violation of Norms (family betrayal, unexpected perpetrators)\n" +
      "   • Authority/Procedural Elements (cops, detectives, evidence)\n\n" +
      "2. TITLE FORMULAS - Extract the top 10 title patterns/structures:\n" +
      "   • [Persona] + [Realizes/Discovers] + [Horrifying Secret]\n" +
      "   • [Authority] + [Find/Discover] + [Shocking Object] + [Location]\n" +
      "   • When [Persona] + [Action] + [Unexpected Outcome]\n" +
      "   • [Relationship] + [Emotional Reaction] + After [Discovery]\n" +
      "   (Note the exact patterns you see repeated)\n\n" +
      "3. KEYWORD COMBINATIONS - Note the most effective keyword pairings from the master list:\n" +
      "   • Which persona + action + emotion combinations appear most?\n" +
      "   • Which curiosity triggers are most powerful?\n" +
      "   • Which evidence/device tokens add the most impact?\n\n" +
      "4. THUMBNAIL STRATEGIES - Understand visual approaches:\n" +
      "   • Emotional close-ups (shock, horror, realization)\n" +
      "   • Scene of discovery (dark settings, police presence)\n" +
      "   • Juxtaposition (ordinary person vs. horrific act)\n" +
      "   • High contrast, somber color palettes\n\n" +
      "5. TITLE-THUMBNAIL SYNERGY - How do successful examples create synergy?\n" +
      "   • Title promises revelation → Thumbnail shows emotional impact\n" +
      "   • Title states discovery → Thumbnail shows moment of discovery\n" +
      "   • Title creates curiosity gap → Thumbnail provides visual intrigue\n\n" +
      "CRITICAL: You will use these extracted patterns to generate new titles and thumbnails. " +
      "Each suggestion you make MUST reference specific gold standard patterns and explain which psychological triggers you're applying.\n\n" +
      "Now, carefully study the following gold standard data:\n"
  });

  if (GOLD_STANDARDS.jsonText) {
    parts.push({
      text: '\n\n=== DATASET 1: DETAILED CASE STUDIES ===\n' +
        'This contains in-depth analysis of 100+ successful videos with psychological breakdowns.\n\n' +
        GOLD_STANDARDS.jsonText
    });
  }
  if (GOLD_STANDARDS.csvText) {
    parts.push({
      text: '\n\n=== DATASET 2: TOP 100 VIRAL TITLES ===\n' +
        'These are proven high-performing titles from the top true-crime channels.\n\n' +
        GOLD_STANDARDS.csvText
    });
  }
  if (GOLD_STANDARDS.kwText) {
    parts.push({
      text: '\n\n=== DATASET 3: MASTER KEYWORD LIBRARY ===\n' +
        'Categorized keywords and proven combination formulas.\n\n' +
        GOLD_STANDARDS.kwText
    });
  }

  parts.push({
    text:
      '\n\n=== ANALYSIS COMPLETE ===\n' +
      'You have now studied all three gold standard datasets. ' +
      'Internally note the patterns, formulas, triggers, and strategies you identified. ' +
      'Do NOT respond yet. Wait for the video content and final generation instructions. ' +
      'When you generate titles and thumbnails, you MUST explicitly apply these gold standard patterns and reference specific examples that inspired your suggestions.'
  });

  return parts;
}

function isYouTubeUrl(url) {
  if (!url) return false;
  const u = url.toString().trim();
  return (
    /^https?:\/\/(www\.)?youtube\.com\/watch/.test(u) ||
    /^https?:\/\/youtu\.be\//.test(u)
  );
}

function buildVideoParts({ videoSource, fileUri, fileMime, displayName }) {
  const parts = [];

  const analysisInstruction =
    '\n\n=== VIDEO ANALYSIS REQUIREMENTS ===\n' +
    'Before generating titles and thumbnails, THOROUGHLY ANALYZE this video:\n\n' +
    '1. IDENTIFY KEY ELEMENTS:\n' +
    '   • People: Names, relationships, roles (victim, suspect, detective, family member)\n' +
    '   • Locations: Specific places, settings (house, garage, street, interrogation room)\n' +
    '   • Events: What happened, timeline, sequence of discoveries\n' +
    '   • Evidence: Physical items, recordings, testimonies mentioned\n\n' +
    '2. EXTRACT EMOTIONAL PEAKS:\n' +
    '   • Shocking moments (discoveries, revelations, confessions)\n' +
    '   • High-tension scenes (confrontations, arrests, interrogations)\n' +
    '   • Emotional reactions (realizations, breakdowns, denials)\n' +
    '   • Procedural highlights (police work, investigation breakthroughs)\n\n' +
    '3. NOTE SPECIFIC DETAILS:\n' +
    '   • Exact names and ages (if mentioned)\n' +
    '   • Specific locations and settings\n' +
    '   • Concrete objects and evidence\n' +
    '   • Actual relationships and connections\n' +
    '   • Real timeline and sequence\n\n' +
    '4. DETERMINE CORE ANGLE:\n' +
    '   • Shocking Twist/Revelation 😱 (unexpected discoveries, hidden secrets)\n' +
    '   • Human Element (Killer Psychology) 🧠 (perpetrator mindset, lack of remorse)\n' +
    '   • Procedural Deep-Dive 🕵️‍♂️ (investigation tactics, evidence analysis)\n' +
    '   • Injustice & Outrage 😠 (victims, heroic rescues, justice served)\n\n' +
    'CRITICAL: Use ONLY these specific, authentic details in your titles. ' +
    'Do NOT fabricate names, events, or details not present in the video.\n';

  // Case 1: YouTube URL → use as file_data file_uri (official pattern)
  if (videoSource && isYouTubeUrl(videoSource)) {
    parts.push({
      text:
        `Here is the YouTube video to analyze:\n${videoSource}\n` +
        analysisInstruction
    });
    parts.push({
      fileData: {
        fileUri: videoSource
      }
    });
    return parts;
  }

  // Case 2: Uploaded local file via Files API
  if (fileUri) {
    parts.push({
      text:
        `Here is the uploaded video file "${displayName || 'video'}".\n` +
        analysisInstruction
    });
    parts.push({
      fileData: {
        fileUri,
        mimeType: fileMime || 'video/mp4'
      }
    });
    return parts;
  }

  // Fallback: no file, just text context
  parts.push({
    text:
      'No direct video source is attached. Use only the text instructions and Gold Standard data.'
  });
  return parts;
}

function buildFinalInstruction({ strategistPrompt, videoSource, topic, titleHint, contextText, packageCount = 10, packageNum = 1 }) {
  const base =
    strategistPrompt ||
    'You are a YouTube title & thumbnail strategist for long-form true-crime videos. ' +
    `Given the video and the GOLD STANDARD patterns you analyzed, generate ${packageCount} strong ` +
    'Title + Thumbnail idea packages for this video.';

  const contextInfo =
    '\n\n=== VIDEO CONTEXT ===\n' +
    'VIDEO SOURCE: ' + (videoSource || 'uploaded file / unknown') + '\n' +
    'TOPIC (optional): ' + (topic || '(none)') + '\n' +
    'TITLE/ANGLE HINT (optional): ' + (titleHint || '(none)') + '\n' +
    'ADDITIONAL CONTEXT (optional): ' + (contextText || '(none)');

  const goldStandardRequirements =
    '\n\n=== GOLD STANDARD APPLICATION REQUIREMENTS ===\n' +
    'For EACH title and thumbnail package you generate, you MUST:\n\n' +
    '1. APPLY PROVEN PATTERNS:\n' +
    '   • Use title formulas from the gold standards (e.g., "[Persona] Realizes [Authority] Discovered [Horrifying Secret]")\n' +
    '   • Incorporate 3-5 keywords from the Master Keyword Library\n' +
    '   • Follow psychological trigger strategies from the case studies\n' +
    '   • Match visual strategies documented in successful thumbnails\n\n' +
    '2. REFERENCE SPECIFIC EXAMPLES:\n' +
    '   • Cite 1-2 similar gold standard titles that inspired your suggestion\n' +
    '   • Explain which psychological triggers you\'re applying (Curiosity Gap, Negativity Bias, etc.)\n' +
    '   • Show how your title-thumbnail pair creates synergy\n\n' +
    '3. USE MASTER KEYWORDS:\n' +
    '   • Persona words: Mom, Dad, Cops, Teen, Killer, Detective, etc.\n' +
    '   • Action verbs: Realizes, Discovers, Finds, Exposes, etc.\n' +
    '   • Emotional adjectives: Horrifying, Disturbing, Evil, Shocking, etc.\n' +
    '   • Objects/Secrets: Secret, Body, Murder, House of Horrors, etc.\n' +
    '   • Curiosity triggers: When, After, Moment, Until, etc.\n\n' +
    '4. EXPLAIN YOUR STRATEGY:\n' +
    '   • For each package, include a brief "Strategy" section explaining:\n' +
    '     - Which gold standard pattern you followed\n' +
    '     - Which psychological triggers you applied\n' +
    '     - Why this title-thumbnail combination will perform well\n';

  const outputFormat =
    '\n\n=== OUTPUT FORMAT ===\n' +
    'Provide CLEAN HTML only (no markdown, no code fences, no <script> or <style> tags).\n\n' +
    (packageCount === 1
      ? '• Generate ONE (1) Title + Thumbnail package with strategy explanation.\n'
      : '• Start with a brief "Video Summary & Core Angles" section (2-3 sentences).\n' +
      '• Then provide EXACTLY ' + packageCount + ' Title + Thumbnail packages.\n' +
      '• For each package, include:\n' +
      '  - Package number heading: <h2>Package X</h2>\n' +
      '  - Core Angle classification: <p><strong>Core Angle:</strong> [One of: Shocking Twist/Revelation 😱 | Human Element (Killer Psychology) 🧠 | Procedural Deep-Dive 🕵️‍♂️ | Injustice & Outrage 😠]</p>\n' +
      '  - Title (bold): <p><strong>Title:</strong> Your title here</p>\n' +
      '  - Thumbnail description (detailed visual strategy): <p><strong>Thumbnail Description:</strong> ...</p>\n' +
      '  - Strategy explanation: <p><strong>Strategy:</strong> Explain which gold standard patterns and triggers you used</p>\n' +
      '  - Gold standard references: <p><strong>Gold Standard References:</strong> Cite 1-2 similar successful examples</p>\n' +
      '\n' +
      'IMPORTANT: Ensure variety across packages - use different core angles and patterns.\n');

  const qualityRules =
    '\n\n=== QUALITY RULES ===\n' +
    '• Use ONLY information from the video + GOLD STANDARD patterns.\n' +
    '• Do NOT invent fake cases, people, or events.\n' +
    '• Do NOT use generic clickbait - follow the crime/psychology focus from gold standards.\n' +
    '• Ensure every title contains specific, authentic details from the video.\n' +
    '• Create strong title-thumbnail synergy as demonstrated in the case studies.\n' +
    '• Prioritize psychological triggers that match the video\'s content and tone.\n';

  const fewShotExamples =
    '\n\n=== EXAMPLE OUTPUT FORMAT ===\n' +
    'Here are 2 examples showing the EXACT format and depth expected:\n\n' +
    '--- EXAMPLE 1 ---\n' +
    '<h2>Package 1</h2>\n' +
    '<p><strong>Core Angle:</strong> Shocking Twist/Revelation 😱</p>\n' +
    '<p><strong>Title:</strong> Mom Realizes Police Discovered Her Horrifying Secret</p>\n' +
    '<p><strong>Thumbnail Description:</strong> Close-up of a woman\'s face in intense distress/shock, captured in police custody. High-contrast lighting emphasizes her panicked expression. Muted color palette (grays, dark blues) creates somber mood. Police presence visible in blurred background. Emotion conveyed: Panic, despair, dawning horror of being caught.</p>\n' +
    '<p><strong>Strategy:</strong> This follows the "[Persona] Realizes [Authority] Discovered [Horrifying Secret]" pattern from gold standards. Applies three key psychological triggers: (1) <em>Curiosity Gap</em> - withholds what the secret is, (2) <em>Negativity Bias</em> - "horrifying" amplifies shock value, (3) <em>Violation of Norms</em> - maternal figure with dark secret creates cognitive dissonance. Uses 5 master keywords: Mom (persona), Realizes (action), Police (authority), Discovered (action), Horrifying (emotion), Secret (object). Title-thumbnail synergy: Title promises revelation → Thumbnail shows emotional impact of that revelation.</p>\n' +
    '<p><strong>Gold Standard References:</strong> Inspired by "Mom Realizes Police Discovered Her Horrifying Secret" (DATASET1.JSON case study) and "Dad Realizes Cops Discovered His Horrifying Secret" (top100_titles_thumbnails.csv). Both use identical pattern with 95%+ effectiveness in crime niche.</p>\n\n' +
    '--- EXAMPLE 2 ---\n' +
    '<h2>Package 2</h2>\n' +
    '<p><strong>Core Angle:</strong> Human Element (Killer Psychology) 🧠</p>\n' +
    '<p><strong>Title:</strong> When Teen Killer Realizes She\'s Been Caught</p>\n' +
    '<p><strong>Thumbnail Description:</strong> Close-up of teenage girl\'s face showing shock and despair in interrogation room. Dramatic lighting from above creates shadows emphasizing distress. Context cues: police presence, institutional setting. Emotion: Shock, fear, weight of consequences, the "moment of truth" captured.</p>\n' +
    '<p><strong>Strategy:</strong> Follows "When [Persona] [Realizes/Discovers] [Consequence]" pattern. Applies: (1) <em>Curiosity Gap</em> - what did she do?, (2) <em>Emotional Intensity</em> - focuses on pivotal realization moment, (3) <em>Specificity</em> - "Teen" adds shock factor of youth. Uses 4 keywords: When (curiosity trigger), Teen (persona), Killer (persona/object), Realizes (action), Caught (consequence). Synergy: Title promises dramatic moment → Thumbnail delivers visual proof of that emotional peak.</p>\n' +
    '<p><strong>Gold Standard References:</strong> Based on "When Teen Killers Realize They\'ve Been Caught" (DATASET1.JSON) and "When A Teen Killer Realizes She\'s Been Caught" (top100_titles_thumbnails.csv). Pattern proven effective for youthful offender content.</p>\n\n' +
    'YOUR OUTPUT MUST MATCH THIS STRUCTURE AND DEPTH.\n';

  let finalPrompt = base + contextInfo + goldStandardRequirements + fewShotExamples + outputFormat + qualityRules;

  // FORCE OVERRIDE for single package regeneration
  if (packageCount === 1) {
    finalPrompt +=
      '\n\n!!! IMPORTANT OVERRIDE !!!\n' +
      'IGNORE any previous instructions to generate 10 packages.\n' +
      'For this specific response, generate ONLY ONE (1) Title + Thumbnail package.\n' +
      'Do NOT include a video summary.\n' +
      'Do NOT include multiple packages.\n' +
      'Output ONLY the HTML for this single package, starting with the <h2> tag.\n' +
      `Label this package as "<h2>Package ${packageNum}</h2>" in the heading.\n` +
      'Include the title, thumbnail description, strategy explanation, and gold standard references.\n';
  }

  return finalPrompt;
}

function normalizeHtmlServer(raw) {
  if (!raw) return '';
  let txt = String(raw).trim();
  // remove ```html fences
  txt = txt.replace(/```(?:html)?/gi, '').trim();
  // remove script/style tags
  txt = txt.replace(/<script[\s\S]*?<\/script>/gi, '');
  txt = txt.replace(/<style[\s\S]*?<\/style>/gi, '');
  return txt;
}

// --- History store (gzip to save space) ---
class HistoryStore {
  constructor(dir, limitBytes) {
    this.dir = dir;
    this.indexPath = path.join(dir, 'index.json');
    this.limit = BigInt(limitBytes);
  }

  async _ensureDir() {
    await fs.promises.mkdir(this.dir, { recursive: true });
    try {
      await fs.promises.access(this.indexPath);
    } catch {
      await fs.promises.writeFile(
        this.indexPath,
        JSON.stringify({ items: [] }, null, 2),
        'utf-8'
      );
    }
  }

  async _readIndex() {
    await this._ensureDir();
    try {
      const raw = await fs.promises.readFile(this.indexPath, 'utf-8');
      const j = JSON.parse(raw);
      return j && Array.isArray(j.items) ? j : { items: [] };
    } catch {
      return { items: [] };
    }
  }

  async _writeIndex(idx) {
    await fs.promises.writeFile(this.indexPath, JSON.stringify(idx, null, 2), 'utf-8');
  }

  async _computeUsedBytes(idx) {
    let total = 0n;
    for (const it of idx.items) {
      if (typeof it.size_bytes === 'number') total += BigInt(it.size_bytes);
    }
    return total;
  }

  async _purgeIfNeeded(idx) {
    let used = await this._computeUsedBytes(idx);
    if (used <= this.limit) return { used, limit: this.limit };

    idx.items.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    while (used > this.limit && idx.items.length > 0) {
      const victim = idx.items.shift();
      try {
        if (victim.file_path) await fs.promises.unlink(victim.file_path);
      } catch {
        // ignore
      }
      used = await this._computeUsedBytes(idx);
    }
    await this._writeIndex(idx);
    return { used, limit: this.limit };
  }

  async stats() {
    const idx = await this._readIndex();
    const used = await this._computeUsedBytes(idx);
    return {
      used: Number(used),
      limit: Number(this.limit),
      items: idx.items.length
    };
  }

  async save(html, meta) {
    await this._ensureDir();
    const idx = await this._readIndex();

    const id = crypto.randomUUID();
    const created_at = Date.now();
    const gzPath = path.join(this.dir, `${id}.json.gz`);

    const payload = {
      html,
      meta: {
        id,
        title: meta.title || meta.displayName || meta.videoSource || 'Untitled',
        created_at,
        size_bytes: Buffer.byteLength(html || '', 'utf-8'),
        videoSource: meta.videoSource || null,
        playback: meta.playback || null
      },
      ts: created_at
    };

    const buf = Buffer.from(JSON.stringify(payload), 'utf-8');
    const gz = zlib.gzipSync(buf);
    await fs.promises.writeFile(gzPath, gz);

    idx.items.push({
      id,
      title: payload.meta.title,
      created_at,
      size_bytes: payload.meta.size_bytes,
      file_path: gzPath,
      preview: String(html || '').slice(0, 240)
    });

    await this._writeIndex(idx);

    const { used, limit } = await this._purgeIfNeeded(idx);
    return {
      meta: payload.meta,
      storage: { used: Number(used), limit: Number(limit) }
    };
  }

  async list({ q = '', limit = 100, page = 1 }) {
    const idx = await this._readIndex();
    let items = idx.items.slice();
    if (q) {
      const qLower = q.toLowerCase();
      items = items.filter(
        (it) =>
          (it.title || '').toLowerCase().includes(qLower) ||
          (it.preview || '').toLowerCase().includes(qLower)
      );
    }
    items.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    const offset = (page - 1) * limit;
    const slice = items.slice(offset, offset + limit).map(
      ({ id, title, created_at, size_bytes, preview }) => ({
        id,
        title,
        created_at,
        size_bytes,
        preview
      })
    );
    return { items: slice, total: items.length, page, limit };
  }

  async get(id) {
    const idx = await this._readIndex();
    const it = idx.items.find((x) => x.id === id);
    if (!it) return null;
    const raw = await fs.promises.readFile(it.file_path);
    const buf = zlib.gunzipSync(raw);
    const data = JSON.parse(buf.toString('utf-8'));
    return data;
  }

  async delete(id) {
    const idx = await this._readIndex();
    const i = idx.items.findIndex((x) => x.id === id);
    if (i === -1) return false;
    const it = idx.items[i];
    idx.items.splice(i, 1);
    try {
      if (it.file_path) await fs.promises.unlink(it.file_path);
    } catch {
      // ignore
    }
    await this._writeIndex(idx);
    return true;
  }

  async rename(id, title) {
    const idx = await this._readIndex();
    const it = idx.items.find((x) => x.id === id);
    if (!it) return false;
    it.title = title;
    await this._writeIndex(idx);

    const full = await this.get(id);
    if (full?.meta) {
      full.meta.title = title;
      const gzPath = path.join(this.dir, `${id}.json.gz`);
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify(full), 'utf-8'));
      await fs.promises.writeFile(gzPath, gz);
    }
    return true;
  }

  async purgeOldest(bytesToFree) {
    const idx = await this._readIndex();
    let used = await this._computeUsedBytes(idx);
    const target = used - BigInt(bytesToFree);
    if (target <= 0) return { used: 0, limit: Number(this.limit) };

    idx.items.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    while (used > target && idx.items.length > 0) {
      const victim = idx.items.shift();
      try {
        if (victim.file_path) await fs.promises.unlink(victim.file_path);
      } catch {
        // ignore
      }
      used = await this._computeUsedBytes(idx);
    }
    await this._writeIndex(idx);
    return { used: Number(used), limit: Number(this.limit) };
  }
}

const historyStore = new HistoryStore(HIST_DIR, HISTORY_LIMIT_BYTES);

// --- Simple in-process Queue + SSE (same behavior as your UI expects) ---
class Queue {
  constructor() {
    this.jobs = new Map();
    this.pending = [];
    this.active = null;
  }

  createTicket() {
    const id = crypto.randomUUID();
    this.jobs.set(id, {
      id,
      state: 'idle',
      position: null,
      progress: { pct: 0, msg: '' },
      error: null,
      listeners: [],
      handler: null,
      resolve: null,
      reject: null
    });
    return id;
  }

  getJob(id) {
    return this.jobs.get(id) || null;
  }

  _emit(job, event, extra = {}) {
    const msg = {
      state: job.state,
      position: job.position,
      progress: job.progress,
      error: job.error,
      ...extra
    };
    for (const l of job.listeners) {
      l.send(event, msg);
    }
  }

  attachSSE(id, res) {
    const job = this.getJob(id);
    if (!job) {
      res.write(
        `event: failed\ndata: ${JSON.stringify({ error: 'Unknown ticket' })}\n\n`
      );
      res.end();
      return;
    }
    const listener = {
      send: (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    };
    job.listeners.push(listener);

    // Initial snapshot
    this._emit(job, 'snapshot', {});

    const remove = () => {
      job.listeners = job.listeners.filter((l) => l !== listener);
    };
    res.on('close', remove);
  }

  _recalcPositions() {
    this.pending.forEach((job, idx) => {
      job.position = idx + 1;
    });
  }

  async run(id, handler) {
    const job = this.getJob(id);
    if (!job) throw new Error('Invalid ticket');
    if (job.state !== 'idle') throw new Error('Ticket already used');

    job.handler = handler;
    job.state = 'queued';
    this.pending.push(job);
    this._recalcPositions();
    this._emit(job, 'queued', { position: job.position });

    return new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
      this._pump();
    });
  }

  async _pump() {
    if (this.active || this.pending.length === 0) return;
    const job = this.pending.shift();
    this.active = job;
    job.state = 'active';
    job.position = 1;
    job.progress = { pct: 5, msg: 'Starting…' };
    this._emit(job, 'started', { progress: job.progress });

    const update = (pct, msg) => {
      job.progress = { pct, msg };
      this._emit(job, 'progress', { progress: job.progress });
    };

    try {
      const result = await job.handler(update);
      job.state = 'done';
      this._emit(job, 'done', {});
      job.resolve(result);
    } catch (err) {
      job.state = 'failed';
      job.error = err?.message || String(err);
      this._emit(job, 'failed', { error: job.error });
      job.reject(err);
    } finally {
      this.active = null;
      this._recalcPositions();
      if (this.pending.length > 0) this._pump();
    }
  }
}

const queue = new Queue();

// --- Queue endpoints (used by your frontend) ---
app.post('/api/queue/ticket', (_req, res) => {
  const id = queue.createTicket();
  res.json({ id });
});

app.get('/api/queue/:id/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  queue.attachSSE(req.params.id, res);
});

// --- /api/upload-video: local file → Gemini Files API via GoogleAIFileManager ---
app.post('/api/upload-video', upload.single('video'), async (req, res) => {
  const ticketId = typeof req.query.qid === 'string' ? req.query.qid : null;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const tmpPath = req.file.path;
  const filename = req.file.filename;
  const displayName = req.file.originalname;
  const mimeType = req.file.mimetype || 'video/mp4';

  const runUpload = async (update) => {
    update(10, 'Uploading video to Gemini Files API…');

    let uploadResult;
    try {
      uploadResult = await fileManager.uploadFile(tmpPath, {
        mimeType,
        displayName
      });
    } catch (err) {
      console.error('[Files API] upload failed:', err);
      throw new Error('Gemini Files API upload failed');
    }
    // Note: We keep the local file in public/uploads for history playback

    let file = uploadResult?.file;
    if (!file || !file.uri || !file.name) {
      throw new Error('Files API did not return a valid file with uri + name');
    }

    update(40, 'Waiting for video to become ACTIVE…');

    try {
      // ⏱️ Poll until the file state is ACTIVE
      file = await waitForFileActive(file.name);
    } catch (err) {
      console.error('[Files API] waitForFileActive failed:', err);
      throw new Error('Uploaded video is not ready for use yet (file not ACTIVE)');
    }

    update(80, 'Video ready. Preparing for generation…');

    return {
      fileUri: file.uri, // ACTIVE file, safe to pass into fileData.fileUri
      fileMime: file.mimeType || mimeType,
      displayName,
      playback: { kind: 'local', url: `/uploads/${filename}` }
    };
  };

  try {
    const result = ticketId
      ? await queue.run(ticketId, runUpload)
      : await runUpload(() => { });
    res.json(result);
  } catch (err) {
    console.error('upload-video error:', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// --- /api/fetch-youtube: no download, just validate URL & return it ---
app.post('/api/fetch-youtube', async (req, res) => {
  const ticketId = typeof req.query.qid === 'string' ? req.query.qid : null;
  const body = req.body || {};
  const url = (body.url || body.videoSource || body.youtubeUrl || '').trim();

  if (!url || !isYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  function extractYoutubeId(u) {
    const m = u.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([\w-]{11})/);
    return m ? m[1] : null;
  }

  const runFetch = async (update) => {
    update(10, 'Validating YouTube URL…');
    update(80, 'YouTube URL accepted. Preparing for generation…');
    const ytId = extractYoutubeId(url);
    return {
      fileUri: null, // we use videoSource as the YouTube URL
      fileMime: 'video/mp4',
      displayName: url,
      videoSource: url,
      playback: { kind: 'youtube', url: url, youtubeId: ytId }
    };
  };

  try {
    const result = ticketId
      ? await queue.run(ticketId, runFetch)
      : await runFetch(() => { });
    res.json(result);
  } catch (err) {
    console.error('fetch-youtube error:', err);
    res.status(500).json({ error: err.message || 'YouTube prepare failed' });
  }
});

// --- /api/generate: main Gemini call ---
app.post('/api/generate', async (req, res) => {
  const ticketId = typeof req.query.qid === 'string' ? req.query.qid : null;
  const body = req.body || {};

  const {
    fileUri,
    fileMime,
    videoSource,
    displayName,
    topic,
    titleHint,
    contextText,
    strategistPrompt,
    playback
  } = body;

  if (!fileUri && !videoSource) {
    return res.status(400).json({ error: 'Missing fileUri or videoSource' });
  }

  const runGenerate = async (update) => {
    update(5, 'Preparing video & Gold Standards…');

    const gsParts = buildGSIngestParts();

    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      systemInstruction:
        'You are an expert YouTube strategist for the true-crime niche. ' +
        'Your expertise comes from deeply analyzing gold standard patterns from top-performing channels. ' +
        'For every title and thumbnail you suggest, you MUST apply proven psychological triggers and keyword formulas from the gold standards. ' +
        'Explain your strategic choices by referencing specific patterns you identified. ' +
        'Follow the requested HTML output format exactly. ' +
        'Never reveal chain-of-thought or raw Gold Standard data in your output.',
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    });

    const generationConfig = {
      temperature: 0.28,
      maxOutputTokens: 8192,
      topP: 0.9,
      topK: 40,
      responseMimeType: 'text/plain'
    };

    const videoParts = buildVideoParts({
      videoSource,
      fileUri,
      fileMime,
      displayName
    });

    update(15, 'Sending Gold Standards to Gemini…');

    const chat = model.startChat({
      generationConfig,
      history: [
        { role: 'user', parts: gsParts },
        { role: 'user', parts: videoParts }
      ]
    });

    update(30, 'Calling Gemini model…');

    const finalInstruction = buildFinalInstruction({
      strategistPrompt,
      videoSource: videoSource || fileUri || '',
      topic,
      titleHint,
      contextText
    });

    let result;
    try {
      result = await chat.sendMessage(finalInstruction);
    } catch (err) {
      console.error('Gemini generateContent error:', err);
      throw new Error('Gemini API generateContent failed');
    }

    update(75, 'Normalizing model output…');

    const text = result?.response?.text() || '';
    const html = normalizeHtmlServer(text);

    update(90, 'Saving to history…');

    const saved = await historyStore.save(html, {
      title: displayName || videoSource || 'Untitled',
      videoSource: videoSource || fileUri || null,
      playback
    });

    update(98, 'Finalizing…');

    return {
      html,
      history: { saved: true, id: saved.meta.id },
      storage: saved.storage
    };
  };

  try {
    const out = ticketId
      ? await queue.run(ticketId, runGenerate)
      : await runGenerate(() => { });
    res.json(out);
  } catch (err) {
    console.error('generate error:', err);
    res.status(500).json({ error: err.message || 'Generate failed' });
  }
});

// --- /api/generate-image: Thumbnail prompt generator (image generation requires Vertex AI) ---
app.post('/api/generate-image', async (req, res) => {
  const { prompt, title } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  try {
    // Clean and prepare the prompt
    const safePrompt = String(prompt)
      .replace(/<[^>]*>/g, '') // Remove HTML tags
      .replace(/[^\w\s,.:;!?-]/g, '') // Remove special chars except basic punctuation
      .trim()
      .slice(0, 500); // Limit length

    // Construct a detailed prompt for image generation
    const enhancedPrompt = `
      Create a high-quality, viral YouTube thumbnail image for a true crime video.
      
      Title context: "${title || ''}"
      Visual Description: ${safePrompt}
      
      Style: Hyper-realistic, cinematic lighting, 4k resolution, high contrast, intense emotion, true crime aesthetic, dramatic atmosphere.
      Focus: Clear focal point, emotive facial expressions (if people are present).
      Composition: Professional, attention-grabbing, suitable for YouTube thumbnail, 16:9 aspect ratio.
      Do NOT include text overlays unless explicitly requested in the description.
    `.trim();

    console.log('[Image Gen] Generated prompt for external use');

    // Return a helpful message with the prompt
    // Image generation via API requires Vertex AI setup, not available with AI Studio API key
    res.json({
      success: false,
      message: 'Image generation requires Vertex AI or ImageFX. Use the prompt below in those tools.',
      enhancedPrompt: enhancedPrompt,
      instructions: {
        option1: 'Use ImageFX at https://aitestkitchen.withgoogle.com/tools/image-fx',
        option2: 'Set up Vertex AI with proper credentials',
        option3: 'Use the enhanced prompt in any AI image generator (Midjourney, DALL-E, etc.)'
      }
    });

  } catch (err) {
    console.error('[Image Gen] Error:', err);
    res.status(500).json({ error: err.message || 'Prompt generation failed' });
  }
});

// --- /api/regenerate-card: regenerate a single title+thumbnail package ---
app.post('/api/regenerate-card', async (req, res) => {
  const ticketId = typeof req.query.qid === 'string' ? req.query.qid : null;
  const body = req.body || {};

  const {
    fileUri,
    fileMime,
    videoSource,
    displayName,
    topic,
    titleHint,
    contextText,
    strategistPrompt,
    packageNum // Extract packageNum
  } = body;

  if (!fileUri && !videoSource) {
    return res.status(400).json({ error: 'Missing fileUri or videoSource' });
  }

  const runRegenerate = async (update) => {
    update(5, 'Preparing to regenerate package…');

    const gsParts = buildGSIngestParts();

    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      systemInstruction:
        'You are an expert YouTube strategist for the true-crime niche. ' +
        'Your expertise comes from deeply analyzing gold standard patterns from top-performing channels. ' +
        'For every title and thumbnail you suggest, you MUST apply proven psychological triggers and keyword formulas from the gold standards. ' +
        'Explain your strategic choices by referencing specific patterns you identified. ' +
        'Follow the requested HTML output format exactly. ' +
        'Never reveal chain-of-thought or raw Gold Standard data in your output.',
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    });

    const generationConfig = {
      temperature: 0.28,
      maxOutputTokens: 8192,
      topP: 0.9,
      topK: 40,
      responseMimeType: 'text/plain'
    };

    const videoParts = buildVideoParts({
      videoSource,
      fileUri,
      fileMime,
      displayName
    });

    update(20, 'Sending Gold Standards to Gemini…');

    const chat = model.startChat({
      generationConfig,
      history: [
        { role: 'user', parts: gsParts },
        { role: 'user', parts: videoParts }
      ]
    });

    update(40, 'Regenerating single package…');

    const finalInstruction = buildFinalInstruction({
      strategistPrompt,
      videoSource: videoSource || fileUri || '',
      topic,
      titleHint,
      contextText,
      packageCount: 1,  // KEY DIFFERENCE: request only 1 package
      packageNum: packageNum || 1 // Pass packageNum to instruction builder
    });

    let result;
    try {
      result = await chat.sendMessage(finalInstruction);
    } catch (err) {
      const msg = `Gemini regenerate error: ${err.message} \nStack: ${err.stack}`;
      console.error(msg);
      fs.appendFileSync(path.join(__dirname, 'server_error.log'), `[${new Date().toISOString()}] ${msg}\n`);
      throw new Error(`Gemini API regenerate failed: ${err.message}`);
    }

    update(85, 'Normalizing output…');

    const text = result?.response?.text() || '';
    const html = normalizeHtmlServer(text);

    update(98, 'Complete.');

    return { html };
  };

  try {
    const out = ticketId
      ? await queue.run(ticketId, runRegenerate)
      : await runRegenerate(() => { });
    res.json(out);
  } catch (err) {
    const msg = `regenerate-card error: ${err.message}\nStack: ${err.stack}`;
    console.error(msg);
    fs.appendFileSync(path.join(__dirname, 'server_error.log'), `[${new Date().toISOString()}] ${msg}\n`);
    res.status(500).json({ error: err.message || 'Regenerate failed' });
  }
});

// --- History endpoints (used by history.js + index.html sidebar) ---
app.get('/api/history-stats', async (_req, res) => {
  try {
    const s = await historyStore.stats();
    res.json(s);
  } catch (err) {
    console.error('history-stats error:', err);
    res.status(500).json({ error: 'History stats failed' });
  }
});

app.get('/api/history', async (req, res) => {
  const q = (req.query.q || '').toString();
  const limit = Number(req.query.limit || 100) || 100;
  const page = Number(req.query.page || 1) || 1;
  try {
    const list = await historyStore.list({ q, limit, page });
    res.json(list);
  } catch (err) {
    console.error('history list error:', err);
    res.status(500).json({ error: 'History list failed' });
  }
});

app.get('/api/history/:id', async (req, res) => {
  try {
    const data = await historyStore.get(req.params.id);
    if (!data) return res.status(404).json({ error: 'Not found' });
    const { html, meta, ts, ...rest } = data;
    res.json({ meta, data: { html }, ts, extra: rest });
  } catch (err) {
    console.error('history get error:', err);
    res.status(500).json({ error: 'History get failed' });
  }
});

app.get('/api/history/:id/html', async (req, res) => {
  try {
    const data = await historyStore.get(req.params.id);
    if (!data) return res.status(404).send('Not found');

    const { html, meta } = data;
    const playback = meta?.playback || {};

    let playerHtml = '';
    if (playback.kind === 'youtube' && (playback.youtubeId || playback.url)) {
      let vid = playback.youtubeId;
      if (!vid && playback.url) {
        const m = playback.url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([\w-]{11})/);
        if (m) vid = m[1];
      }
      if (vid) {
        playerHtml = `
           <div style="margin-bottom:24px; border-radius:12px; overflow:hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
             <iframe id="ytPlayer" src="https://www.youtube.com/embed/${vid}?enablejsapi=1" style="width:100%; aspect-ratio:16/9; border:0; display:block;" allowfullscreen></iframe>
           </div>`;
      }
    } else if (playback.kind === 'local' && playback.url) {
      playerHtml = `
         <div style="margin-bottom:24px; border-radius:12px; overflow:hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
           <video src="${playback.url}" controls style="width:100%; aspect-ratio:16/9; display:block; background:#000;"></video>
         </div>`;
    }

    const css = `
      <style>
        :root { --bg: #0a0c10; --panel: #11141a; --text: #e8ecf4; --muted: #8b96a8; --brand: #6ea8ff; --border: #202633; }
        body { background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; margin: 0; padding: 20px; }
        .wrap { max-width: 800px; margin: 0 auto; }
        a { color: var(--brand); }
        h1, h2, h3 { margin-top: 1.5em; color: #fff; }
        h1 { font-size: 24px; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
        .output { background: var(--panel); padding: 30px; border-radius: 16px; border: 1px solid var(--border); }
        /* Basic card-like look for sections if they exist */
        .out-card { background: #161b22; padding: 16px; border-radius: 8px; margin-bottom: 16px; border: 1px solid var(--border); }
        /* Timestamp links */
        a.ts-link { color: #60a5fa; text-decoration: underline; cursor: pointer; }
        a.ts-link:hover { color: #93c5fd; }
      </style>
    `;

    const cleanHtml = normalizeHtmlServer(html || '');

    // JavaScript for timestamp functionality
    const timestampScript = `
      <script>
        // Parse timestamp string to seconds
        function parseTimestampToSeconds(raw) {
          if (!raw) return 0;
          const s = String(raw).trim().toLowerCase().replace(/[()[\\]]/g, '');
          
          // Format: 1h2m3s or 2m3s or 3s
          const hms = s.match(/^(?:(\\d+)\\s*h)?\\s*(?:(\\d+)\\s*m)?\\s*(?:(\\d+)\\s*s)$/i);
          if (hms) {
            const h = parseInt(hms[1] || '0', 10);
            const m = parseInt(hms[2] || '0', 10);
            const sec = parseInt(hms[3] || '0', 10);
            return h * 3600 + m * 60 + sec;
          }
          
          // Format: H:M:S or M:S
          const parts = s.split(':').map(x => x.trim());
          if (parts.length === 3) {
            const [H, M, S] = parts.map(n => parseInt(n, 10));
            if ([H, M, S].every(n => Number.isFinite(n))) return H * 3600 + M * 60 + S;
          }
          if (parts.length === 2) {
            const [M, S] = parts.map(n => parseInt(n, 10));
            if ([M, S].every(n => Number.isFinite(n))) return M * 60 + S;
          }
          
          // Format: just seconds like "45s"
          const onlyS = s.match(/^(\\d+)\\s*s$/);
          if (onlyS) return parseInt(onlyS[1], 10);
          
          return 0;
        }

        // Linkify timestamps in the output
        function linkifyTimestamps(container) {
          const RX = /\\b(?:\\(?\\[?)?(?:\\d{1,2}:\\d{2}(?::\\d{2})?|\\d+h\\d+m\\d+s|\\d+m\\d+s|\\d+s)(?:\\]?\\)?)\\b/ig;
          const nodes = [...container.querySelectorAll('p, li, h1, h2, h3, h4, div, span, td, th')];
          
          nodes.forEach(node => {
            if (!node.childNodes) return;
            if (node.querySelector('a[data-seconds]')) return; // Already processed
            
            const html = node.innerHTML;
            if (!RX.test(html)) return;
            
            node.innerHTML = html.replace(RX, m => {
              const secs = parseTimestampToSeconds(m);
              if (!secs) return m;
              const label = m.replace(/^[(\\[ ]*|[)\\] ]*$/g, '');
              return \`<a href="#t=\${encodeURIComponent(label)}" data-seconds="\${secs}" class="ts-link">\${label}</a>\`;
            });
          });
        }

        // Seek YouTube player
        function seekYouTube(seconds) {
          const iframe = document.querySelector('iframe[src*="youtube.com/embed"]');
          if (!iframe) return false;
          
          const src = iframe.src;
          const hasParams = src.includes('?');
          const newSrc = src.split('?')[0] + (hasParams ? '&' : '?') + 'start=' + seconds + '&autoplay=1';
          iframe.src = newSrc;
          
          // Scroll to player
          iframe.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return true;
        }

        // Seek local video player
        function seekLocalVideo(seconds) {
          const video = document.querySelector('video');
          if (!video) return false;
          
          video.currentTime = seconds;
          video.pause(); // Pause at the timestamp as requested
          
          // Scroll to player
          video.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return true;
        }

        // Initialize on page load
        document.addEventListener('DOMContentLoaded', () => {
          const output = document.querySelector('.output');
          if (output) {
            linkifyTimestamps(output);
            
            // Add click handler for timestamp links
            output.addEventListener('click', (e) => {
              const link = e.target.closest('a[data-seconds]');
              if (!link) return;
              
              e.preventDefault();
              const seconds = parseInt(link.getAttribute('data-seconds') || '0', 10);
              
              if (seconds > 0) {
                // Try YouTube first, then local video
                if (!seekYouTube(seconds)) {
                  seekLocalVideo(seconds);
                }
              }
            });
          }
        });
      </script>
    `;

    const fullPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${meta.title || 'Shared Result'}</title>
  ${css}
</head>
<body>
  <div class="wrap">
    ${playerHtml}
    <div class="output">
      ${cleanHtml}
    </div>
  </div>
  ${timestampScript}
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(fullPage);
  } catch (err) {
    console.error('history html error:', err);
    res.status(500).send('History html failed');
  }
});

app.patch('/api/history/:id', async (req, res) => {
  try {
    const title = (req.body?.title || '').toString().trim();
    if (!title) return res.status(400).json({ error: 'Missing title' });
    const ok = await historyStore.rename(req.params.id, title);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('history rename error:', err);
    res.status(500).json({ error: 'History rename failed' });
  }
});

app.delete('/api/history/:id', async (req, res) => {
  try {
    const ok = await historyStore.delete(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('history delete error:', err);
    res.status(500).json({ error: 'History delete failed' });
  }
});

app.post('/api/history/purge', async (req, res) => {
  const mode = (req.query.mode || 'oldest').toString();
  const bytes = Number(req.query.bytes || 0);
  if (mode !== 'oldest' || !bytes || bytes <= 0) {
    return res.status(400).json({ error: 'Invalid purge params' });
  }
  try {
    const out = await historyStore.purgeOldest(bytes);
    res.json({ ok: true, storage: out });
  } catch (err) {
    console.error('history purge error:', err);
    res.status(500).json({ error: 'History purge failed' });
  }
});

// --- Start server ---
(async () => {
  await loadGoldStandards();
  await fs.promises.mkdir(HIST_DIR, { recursive: true }).catch(() => { });
  app.listen(PORT, HOST, () => {
    console.log(`TT Generator running at http://${HOST}:${PORT}`);
  });
})();

















