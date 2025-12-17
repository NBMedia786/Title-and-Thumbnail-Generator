
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
import ytDlpRaw from 'yt-dlp-exec';
import ffmpeg from 'fluent-ffmpeg';

// --- Wrapper for yt-dlp with permanent quiet defaults ---
// This prevents terminal overflow by ensuring all calls suppress verbose output
const ytDlp = (url, options = {}) => {
  const defaultOptions = {
    quiet: true,           // Suppress progress and other non-error output
    noWarnings: true,      // Suppress warnings
    noPart: true,          // Don't use .part files
    noProgress: true       // Don't show progress bar
  };

  // Merge user options with defaults (user options take precedence)
  const mergedOptions = { ...defaultOptions, ...options };

  return ytDlpRaw(url, mergedOptions);
};

// Expose the .exec method for streaming support (used in thumbnail proxy)
ytDlp.exec = ytDlpRaw.exec;

// --- ESM helpers ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- GLOBAL ERROR HANDLERS to prevent crash on unhandled 429s or others ---
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Ex:', err);
  // Optional: fs.appendFileSync(...)
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled Rejection:', reason);
});


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

// --- Retry Helper ---
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runWithRetry(fn, retries = 3, baseDelay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status || err.response?.status;
      // Retry on 429 (Too Many Requests) or 503 (Service Unavailable)
      if ((status === 429 || status === 503) && i < retries - 1) {
        const delay = baseDelay * Math.pow(2, i);
        console.warn(`[Retry] Attempt ${i + 1} failed with ${status}. Retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

// --- Express setup ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));

// Static: /public for index.html + history.js (same UI as before)
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// --- Multer for local uploads (no yt-dlp, no ytdl-core) ---
const MAX_FILE_SIZE = Number(process.env.MULTER_MAX_FILE_SIZE || 2_147_483_648); // 2GB
const UPLOADS_DIR = path.join(__dirname, 'public/uploads');

// Ensure uploads directory exists with proper permissions
try {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  // Test write permissions
  const testFile = path.join(UPLOADS_DIR, '.write-test');
  fs.writeFileSync(testFile, 'test');
  fs.unlinkSync(testFile);
  console.log('[UPLOADS] Directory ready:', UPLOADS_DIR);
} catch (err) {
  console.error('[UPLOADS] ERROR: Cannot write to uploads directory:', err.message);
  console.error('[UPLOADS] Path:', UPLOADS_DIR);
  console.error('[UPLOADS] This will cause upload failures on production servers!');
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      // Verify directory exists on each upload
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      cb(null, UPLOADS_DIR);
    },
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
      const filename = `upload_${Date.now()}_${safeName}`;
      console.log('[UPLOADS] Saving file:', filename);
      cb(null, filename);
    }
  }),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  },
  fileFilter: (_req, file, cb) => {
    console.log('[UPLOADS] Receiving file:', file.originalname, 'mime:', file.mimetype);
    // Accept video files
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      console.warn('[UPLOADS] Rejected non-video file:', file.mimetype);
      cb(new Error(`Invalid file type: ${file.mimetype}. Only video files are allowed.`));
    }
  }
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

// === HEALTH CHECK ENDPOINT ===
app.get("/api/health", (_req, res) => {
  const uploadsWritable = (() => {
    try {
      const testFile = path.join(UPLOADS_DIR, '.health-check');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      return true;
    } catch {
      return false;
    }
  })();

  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    goldStandards: {
      json: !!GOLD_STANDARDS.jsonText,
      csv: !!GOLD_STANDARDS.csvText,
      keywords: !!GOLD_STANDARDS.kwText
    },
    uploads: {
      directory: UPLOADS_DIR,
      writable: uploadsWritable,
      maxFileSize: MAX_FILE_SIZE
    },
    config: {
      port: PORT,
      model: MODEL_NAME,
      nodeVersion: process.version
    }
  };

  res.json(health);
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
  // Clean potential "YouTube: " prefix from app.js
  let cleanSource = videoSource;
  if (videoSource && typeof videoSource === 'string') {
    cleanSource = videoSource.replace(/^YouTube:\s*/i, '').trim();
  }

  if (cleanSource && isYouTubeUrl(cleanSource)) {
    parts.push({
      text:
        `Here is the YouTube video to analyze:\n${cleanSource}\n` +
        analysisInstruction
    });
    parts.push({
      fileData: {
        fileUri: cleanSource
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

function buildFinalInstruction({ strategistPrompt, videoSource, topic, titleHint, angleHint, contextText, packageCount = 10, packageNum = 1 }) {
  const base =
    strategistPrompt ||
    'You are a YouTube title & thumbnail strategist for long-form true-crime videos. ' +
    `Given the video and the GOLD STANDARD patterns you analyzed, generate ALL your best ` +
    'Title + Thumbnail idea packages for this video (MAXIMUM 10).';

  const contextInfo =
    '\n\n=== VIDEO CONTEXT ===\n' +
    'VIDEO SOURCE: ' + (videoSource || 'uploaded file / unknown') + '\n' +
    'TOPIC (optional): ' + (topic || '(none)') + '\n' +
    'TITLE/WORKING TITLE HINT (optional): ' + (titleHint || '(none)') + '\n' +
    'ANGLE/PERSONA HINT (optional): ' + (angleHint || '(none)') + '\n' +
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
      '• Then provide YOUR BEST Title + Thumbnail packages (MAXIMUM ' + packageCount + ').\n' +
      '• STOP generating if you run out of high-quality, gold-standard ideas. Do NOT fill space with mediocre ones.\n' +
      '• For each package, include:\n' +
      '  - Package number heading: <h2>Package X</h2>\n' +
      '  - Core Angle classification: <p><strong>Core Angle:</strong> [One of: Shocking Twist/Revelation 😱 | Human Element (Killer Psychology) 🧠 | Procedural Deep-Dive 🕵️‍♂️ | Injustice & Outrage 😠]</p>\n' +
      '  - Title (bold): <p><strong>Title:</strong> Your title here</p>\n' +
      '  - Timestamps (crucial): <p><strong>Timestamps:</strong> [MM:SS], [MM:SS]</p> (Identify 1-2 exact moments in the video that match this thumbnail concept. If no exact match, estimate based on the event.)\n' +
      '  - Thumbnail description (detailed visual strategy): <p><strong>Thumbnail Description:</strong> ...</p>\n' +
      '  - Strategy explanation: <p><strong>Strategy:</strong> Explain which gold standard patterns and triggers you used</p>\n' +
      '  - Gold standard references: <p><strong>Gold Standard References:</strong> Cite 1-2 similar successful examples</p>\n' +
      '\n' +
      'IMPORTANT: Ensure variety across packages - use different core angles and patterns.\n');

  const qualityRules =
    '\n\n=== QUALITY RULES ===\n' +
    '• QUALITY OVER QUANTITY: Provide 5-7 perfect packages rather than 10 mediocre ones. Only go up to 10 if every single one is a perfect match.\n' +
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
    '<p><strong>Timestamps:</strong> [04:21], [12:45]</p>\n' +
    '<p><strong>Thumbnail Description:</strong> Close-up of a woman\'s face in intense distress/shock, captured in police custody. High-contrast lighting emphasizes her panicked expression. Muted color palette (grays, dark blues) creates somber mood. Police presence visible in blurred background. Emotion conveyed: Panic, despair, dawning horror of being caught.</p>\n' +
    '<p><strong>Strategy:</strong> This follows the "[Persona] Realizes [Authority] Discovered [Horrifying Secret]" pattern from gold standards. Applies three key psychological triggers: (1) <em>Curiosity Gap</em> - withholds what the secret is, (2) <em>Negativity Bias</em> - "horrifying" amplifies shock value, (3) <em>Violation of Norms</em> - maternal figure with dark secret creates cognitive dissonance. Uses 5 master keywords: Mom (persona), Realizes (action), Police (authority), Discovered (action), Horrifying (emotion), Secret (object). Title-thumbnail synergy: Title promises revelation → Thumbnail shows emotional impact of that revelation.</p>\n' +
    '<p><strong>Gold Standard References:</strong> Inspired by "Mom Realizes Police Discovered Her Horrifying Secret" (DATASET1.JSON case study) and "Dad Realizes Cops Discovered His Horrifying Secret" (top100_titles_thumbnails.csv). Both use identical pattern with 95%+ effectiveness in crime niche.</p>\n\n' +
    '--- EXAMPLE 2 ---\n' +
    '<h2>Package 2</h2>\n' +
    '<p><strong>Core Angle:</strong> Human Element (Killer Psychology) 🧠</p>\n' +
    '<p><strong>Title:</strong> When Teen Killer Realizes She\'s Been Caught</p>\n' +
    '<p><strong>Timestamps:</strong> [08:15]</p>\n' +
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
    this._initialized = false;
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
    let j = { items: [] };
    try {
      const raw = await fs.promises.readFile(this.indexPath, 'utf-8');
      j = JSON.parse(raw);
      if (!j || !Array.isArray(j.items)) j = { items: [] };
    } catch {
      j = { items: [] };
    }

    // Auto-migration: If items lack 'videoSource' or 'meta_preview', try to populate them
    if (!this._initialized) {
      this._initialized = true;
      let changed = false;
      const items = j.items;
      // Process in chunks to avoid blocking too long on startup
      for (const it of items) {
        if (!it.videoSource && it.file_path && fs.existsSync(it.file_path)) {
          try {
            // Peek at the file
            const rawGz = await fs.promises.readFile(it.file_path);
            const buf = zlib.gunzipSync(rawGz);
            console.log(`[History] Migrated item ${it.id}`);
          } catch (e) {
            console.warn(`[History] Failed to migrate ${it.id}:`, e.message);
          }
        }
      }
      if (changed) {
        await this._writeIndex(j);
        console.log('[History] Index migration complete.');
      }
    }
    return j;
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
        summary: meta.summary || null,
        created_at,
        size_bytes: Buffer.byteLength(html || '', 'utf-8'),
        videoSource: meta.videoSource || null,
        playback: meta.playback || null,
        generationContext: meta.generationContext || null
      },
      ts: created_at
    };

    const buf = Buffer.from(JSON.stringify(payload), 'utf-8');
    const gz = zlib.gzipSync(buf);
    await fs.promises.writeFile(gzPath, gz);

    idx.items.push({
      id,
      title: payload.meta.title,
      summary: payload.meta.summary,
      created_at,
      size_bytes: payload.meta.size_bytes,
      file_path: gzPath,
      videoSource: payload.meta.videoSource,
      playback: payload.meta.playback,
      angle: payload.meta.generationContext?.angleHint,
      prompt: payload.meta.generationContext?.strategistPrompt,
      preview: String(html || '').slice(0, 240)
    });

    await this._writeIndex(idx);

    const { used, limit } = await this._purgeIfNeeded(idx);
    return {
      meta: payload.meta,
      storage: { used: Number(used), limit: Number(limit) }
    };
  }

  async appendHtml(id, htmlToAppend) {
    const idx = await this._readIndex();
    const item = idx.items.find(i => i.id === id);
    if (!item || !item.file_path) return false;

    try {
      const rawGz = await fs.promises.readFile(item.file_path);
      const buf = zlib.gunzipSync(rawGz);
      const data = JSON.parse(buf.toString('utf-8'));

      data.html = (data.html || '') + htmlToAppend;
      data.meta.size_bytes = Buffer.byteLength(data.html, 'utf-8');

      const newBuf = Buffer.from(JSON.stringify(data), 'utf-8');
      const newGz = zlib.gzipSync(newBuf);
      await fs.promises.writeFile(item.file_path, newGz);

      item.size_bytes = newGz.length;
      await this._writeIndex(idx);

      return true;
    } catch (e) {
      console.error("Append failed", e);
      return false;
    }
  }

  async updateHtml(id, newHtml) {
    const idx = await this._readIndex();
    const item = idx.items.find(i => i.id === id);
    if (!item || !item.file_path) return false;

    try {
      const rawGz = await fs.promises.readFile(item.file_path);
      const buf = zlib.gunzipSync(rawGz);
      const data = JSON.parse(buf.toString('utf-8'));

      data.html = newHtml;
      data.meta.size_bytes = Buffer.byteLength(data.html, 'utf-8');

      const newBuf = Buffer.from(JSON.stringify(data), 'utf-8');
      const newGz = zlib.gzipSync(newBuf);
      await fs.promises.writeFile(item.file_path, newGz);

      item.size_bytes = newGz.length;
      await this._writeIndex(idx);

      return true;
    } catch (e) {
      console.error("Update failed", e);
      return false;
    }
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
      (it) => ({
        id: it.id,
        title: it.title,
        summary: it.summary,
        created_at: it.created_at,
        size_bytes: it.size_bytes,
        preview: it.preview,
        videoSource: it.videoSource,
        playback: it.playback,
        angle: it.angle,
        prompt: it.prompt
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
    console.error('[UPLOAD] No file in request');
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const tmpPath = req.file.path;
  const filename = req.file.filename;
  const displayName = req.file.originalname;
  const mimeType = req.file.mimetype || 'video/mp4';
  const fileSize = req.file.size;

  console.log('[UPLOAD] Processing:', displayName, `(${Math.round(fileSize / 1024 / 1024)}MB)`);

  const runUpload = async (update) => {
    update(10, 'Uploading video to Gemini Files API…');

    let uploadResult;
    try {
      console.log('[Files API] Starting upload:', tmpPath);
      uploadResult = await fileManager.uploadFile(tmpPath, {
        mimeType,
        displayName
      });
      console.log('[Files API] Upload successful:', uploadResult?.file?.name);
    } catch (err) {
      console.error('[Files API] upload failed:', err);
      console.error('[Files API] Error details:', {
        message: err.message,
        code: err.code,
        status: err.status
      });
      throw new Error(`Gemini Files API upload failed: ${err.message}`);
    }
    // Note: We keep the local file in public/uploads for history playback

    let file = uploadResult?.file;
    if (!file || !file.uri || !file.name) {
      throw new Error('Files API did not return a valid file with uri + name');
    }

    update(40, 'Waiting for video to become ACTIVE…');

    try {
      // ⏱️ Poll until the file state is ACTIVE
      console.log('[Files API] Waiting for file to become ACTIVE:', file.name);
      file = await waitForFileActive(file.name);
      console.log('[Files API] File is now ACTIVE:', file.name);
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
    console.log('[UPLOAD] Success:', displayName);
    res.json(result);
  } catch (err) {
    console.error('[UPLOAD] Failed:', displayName, err.message);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// Handle multer errors (file too large, wrong type, etc.)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error('[MULTER ERROR]:', err.code, err.message);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `File too large. Maximum size is ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB`
      });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  } else if (err) {
    console.error('[UPLOAD ERROR]:', err.message);
    return res.status(500).json({ error: err.message || 'Upload failed' });
  }
  next();
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

// --- /api/proxy-youtube-frame: Capture static frame from YouTube ---
app.get('/api/proxy-youtube-frame', async (req, res) => {
  const url = req.query.url;
  const time = parseFloat(req.query.time) || 0;

  if (!url) return res.status(400).send('Invalid YouTube URL');

  try {
    console.log(`[Proxy] Fetching info for ${url} at ${time}s via yt-dlp pipe...`);

    // Use yt-dlp to download a small segment (5s) around the timestamp
    // This is much more reliable than ffmpeg seeking on remote URLs
    // Format: *start-end
    const section = `*${time}-${time + 5}`;

    const ytProcess = ytDlp.exec(url, {
      output: '-',
      downloadSections: section,
      format: 'bestvideo[height<=720]+bestaudio/best[height<=720]', // Limit quality for speed
      quiet: true,
      noWarnings: true,
    }, {
      stdio: ['ignore', 'pipe', 'ignore'] // We only want stdout
    });

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000');

    // Hard timeout for the process to prevent hanging
    const timeout = setTimeout(() => {
      if (!ytProcess.killed) {
        console.error('[Proxy] yt-dlp timeout');
        ytProcess.kill();
        if (!res.headersSent) res.status(504).send('Gateway Timeout');
      }
    }, 15000); // 15s timeout

    // Handle yt-dlp stderr manually to catch early failures
    if (ytProcess.stderr) {
      ytProcess.stderr.on('data', (d) => process.stdout.write(`[yt-dlp err] ${d}`));
    }

    // Pipe yt-dlp -> ffmpeg -> response
    if (!ytProcess.stdout) {
      clearTimeout(timeout);
      throw new Error('yt-dlp stdout not available');
    }

    const ff = ffmpeg(ytProcess.stdout)
      .frames(1)
      .format('image2')
      .on('error', (err) => {
        // Suppress expected "pipe:0: End of file" errors when we kill the pipe
        if (err.message.includes('pipe:0')) return;
        console.error('[Proxy] FFmpeg error:', err.message);
        ytProcess.kill();
        if (!res.headersSent) res.status(500).end();
      })
      .on('end', () => clearTimeout(timeout))
      .pipe(res, { end: true });

  } catch (err) {
    console.error('[Proxy] Error:', err.message);
    if (!res.headersSent) res.status(500).send('Generation failed');
  }
});

// --- /api/search-competitors: Search YouTube via yt-dlp ---
// --- /api/search-competitors: Search YouTube via yt-dlp ---
app.get('/api/search-competitors', async (req, res) => {
  let query = req.query.query;
  const limit = parseInt(req.query.limit) || 10;
  const type = req.query.type || 'video'; // 'video' or 'channel'

  if (!query) return res.status(400).send('Missing query');

  console.log(`[Search] Searching for: "${query}" (limit ${limit}, type ${type})`);

  try {
    let command = '';

    // Channel Mode Logic
    if (type === 'channel' || query.trim().startsWith('@')) {
      // Assume input is handle/url. 
      // yt-dlp works best with full URL for channels.
      if (!query.startsWith('http')) {
        // If it's just "@handle", make it "https://www.youtube.com/@handle/videos"
        if (!query.trim().startsWith('@')) query = '@' + query;
        query = `https://www.youtube.com/${query}/videos`;
      } else {
        if (!query.endsWith('/videos') && !query.includes('/watch')) {
          // Append /videos to ensure we get upload feed, not home
          query = query.replace(/\/$/, '') + '/videos';
        }
      }

      // Fetch playlist
      command = query; // Just passing the URL triggers playlist behavior

    } else {
      // Standard Search
      command = `ytsearch${limit}:${query}`;
    }

    // Run yt-dlp
    const results = await ytDlp(command, {
      dumpSingleJson: true,
      flatPlaylist: true, // Always use flat to prevent terminal overflow
      playlistEnd: limit
    });

    const videos = results.entries || [];

    // Channel Metadata attempt (results.uploader, results.channel_url etc might be in root)
    const channelMeta = {
      avatar: null,
      name: results.uploader || results.channel || results.title,
      url: results.webpage_url || results.uploader_url
    };

    // Map to cleaner format with better fallbacks for flat playlist
    const cleanVideos = videos.map(v => {
      // For thumbnails, try multiple sources
      let thumbnail = null;
      if (v.id) {
        thumbnail = `https://i.ytimg.com/vi/${v.id}/maxresdefault.jpg`;
      } else if (v.thumbnail) {
        thumbnail = v.thumbnail;
      } else if (v.thumbnails && v.thumbnails.length > 0) {
        thumbnail = v.thumbnails[v.thumbnails.length - 1]?.url;
      }

      return {
        id: v.id,
        title: v.title,
        channel: v.channel || v.uploader || v.channel_name || channelMeta.name,
        views: v.view_count || v.views || null,
        date: v.upload_date || v.release_date || v.timestamp || null,
        duration: v.duration || null,
        thumbnail: thumbnail,
        url: v.url || v.webpage_url || `https://www.youtube.com/watch?v=${v.id}`,
        channelAvatar: channelMeta.avatar
      };
    });

    res.json({ videos: cleanVideos, meta: channelMeta });

  } catch (err) {
    console.error('[Search] Error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});


// --- /api/enrich-metadata: Batch fetch dates for video IDs ---
app.post('/api/enrich-metadata', async (req, res) => {
  const { videoIds } = req.body;
  if (!videoIds || !Array.isArray(videoIds) || videoIds.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid videoIds array' });
  }

  console.log(`[Enrich] Fetching metadata for ${videoIds.length} videos`);

  try {
    const enrichedData = [];

    // Fetch each video individually with full metadata
    for (const id of videoIds) {
      try {
        const videoUrl = `https://www.youtube.com/watch?v=${id}`;
        const result = await ytDlp(videoUrl, {
          dumpSingleJson: true,
          skipDownload: true,
          ignoreErrors: true  // Continue even if video is members-only
        });

        enrichedData.push({
          id: id,
          date: result.upload_date || result.release_date || null,
          views: result.view_count || result.views || null,
          duration: result.duration || null
        });
      } catch (err) {
        console.warn(`[Enrich] Failed to fetch ${id}:`, err.message);
        // Continue with other videos even if one fails
        enrichedData.push({ id: id, date: null, views: null, duration: null });
      }
    }

    res.json({ enriched: enrichedData });
  } catch (err) {
    console.error('[Enrich] Error:', err);
    res.status(500).json({ error: 'Enrichment failed' });
  }
});

// --- /api/discover-competitors: AI Brainstorming ---
app.post('/api/discover-competitors', async (req, res) => {
  // We treat 'description' as the channel query now
  const { description } = req.body;
  if (!description) return res.status(400).json({ error: 'Missing query' });

  console.log('[Discover] analyzing channel:', description);

  try {
    // STEP 1: Ground Truth Search via yt-dlp
    // We search for 1 result to confirm the channel identity and get context
    console.log('[Discover] Running yt-dlp search...');
    const searchRes = await ytDlp(`ytsearch1:${description}`, {
      dumpSingleJson: true,
      flatPlaylist: true
    });

    const entry = searchRes.entries ? searchRes.entries[0] : null;

    let context = "";
    let targetChannel = null;

    if (entry) {
      targetChannel = {
        name: entry.channel || entry.uploader,
        handle: entry.uploader_url ? ('@' + entry.uploader_id) : null, // Best effort handle
        url: entry.uploader_url || entry.channel_url
      };
      context = `The user searched for "${description}".I found a top result from the channel "${targetChannel.name}" titled "${entry.title}".`;
      console.log('[Discover] Context found:', context);
    } else {
      console.log('[Discover] No yt-dlp result found. Relying on AI pure guess.');
      context = `The user searched for "${description}" but I couldn't find a direct match.`;
      targetChannel = { name: description, handle: '?' };
    }

    // STEP 2: AI Brainstorming with Context & Verification
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });
    const prompt = `
            Act as a YouTube strategist.
            
            User's Search: "${description}"
            Tech Search Result: Found a video by channel "${targetChannel.name}" titled "${entry ? entry.title : 'N/A'}" (Handle: ${targetChannel.handle || 'N/A'}).

            Task:
            1. **VERIFY**: Is "${targetChannel.name}" likely the specific channel the user was looking for? 
               - If YES (e.g. User="MKBHD", Found="Marques Brownlee"), use the Tech Result metadata.
               - If NO (e.g. User="MrBeast", Found="MrBeast Fan Account" or "News about MrBeast"), then **CORRECT IT** using your own knowledge of the official channel.
            
            2. **COMPETITORS**: List 10 DIRECT competitor channels (similar niche, audience, and size) for the *Corrected* Target.
               - **Genre Rule**: If the channel is True Crime/Mystery (e.g. Mysterious7), prioritize True Crime/Mystery suggestions (e.g. EWU, Dr Insanity).

            Return ONLY raw JSON in this format:
            {
                "final_target": {
                    "name": "The Official Channel Name",
                    "handle": "@OfficialHandle",
                    "reason": "Why you chose this (e.g. 'Search result was correct' or 'Corrected reaction channel')"
                },
                "similar_channels": [
                    { "name": "Competitor 1", "handle": "@Handle" },
                    { "name": "Competitor 2", "handle": "@Handle" },
                    ...
                ]
            }
        `;

    const result = await model.generateContent(prompt);
    let responseText = result.response.text();

    console.log('[Discover] Raw AI response:', responseText);

    // Robust JSON extraction
    let finalData = {};
    try {
      responseText = responseText.replace(/```json/g, '').replace(/```/g, '');
      const firstOpen = responseText.indexOf('{');
      const lastClose = responseText.lastIndexOf('}');
      if (firstOpen !== -1 && lastClose !== -1) {
        responseText = responseText.substring(firstOpen, lastClose + 1);
      }
      finalData = JSON.parse(responseText);
    } catch (parseErr) {
      console.error('[Discover] JSON Parse Error:', parseErr);
    }

    // Return refined result
    // Use AI's final_target if valid, else fall back to search result
    const definitiveTarget = (finalData.final_target && finalData.final_target.name)
      ? finalData.final_target
      : targetChannel;

    res.json({
      target_channel: definitiveTarget,
      similar_channels: finalData.similar_channels || []
    });

  } catch (err) {
    console.error('[Discover] Error:', err);
    res.status(500).json({ error: 'Discovery failed: ' + err.message });
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
    angleHint,
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
      angleHint,
      contextText
    });

    let result;
    try {
      // WRAPPED IN RETRY
      result = await runWithRetry(() => chat.sendMessage(finalInstruction), 3, 3000);
    } catch (err) {
      console.error('Gemini generateContent error:', err);
      throw new Error('Gemini API generateContent failed');
    }

    update(75, 'Normalizing model output…');

    const text = result?.response?.text() || '';
    const html = normalizeHtmlServer(text);

    update(90, 'Saving to history…');

    // Extract Summary for history list (More robust: Get everything before first Package)
    let extractedSummary = null;
    try {
      const split = html.split(/<h[1-6][^>]*>Package/i);
      if (split.length > 1) {
        let rawPre = split[0];
        // Remove Headers (e.g. "Video Summary") entirely
        rawPre = rawPre.replace(/<h[1-6][^>]*>.*?<\/h[1-6]>/gi, '');
        // Remove remaining tags
        const cleanText = rawPre.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (cleanText.length > 10) {
          // Take approx 2 sentences or 200 chars
          extractedSummary = cleanText.slice(0, 200).trim();
          if (extractedSummary.length === 200) extractedSummary += '...';
        }
      }
      console.log('[SUMMARY] Extracted:', extractedSummary);
    } catch (e) { console.error('[SUMMARY] Extraction error:', e); }

    const saved = await historyStore.save(html, {
      title: displayName || videoSource || 'Untitled',
      summary: extractedSummary,
      videoSource: videoSource || fileUri || null,
      playback,
      // Store generation context for regeneration
      generationContext: {
        fileUri,
        fileMime,
        videoSource,
        displayName,
        topic,
        titleHint,
        angleHint,
        contextText,
        strategistPrompt,
        playback // Save playback in context for easy restoration
      }
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
    angleHint,
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
      angleHint,
      contextText,
      packageCount: 1,  // KEY DIFFERENCE: request only 1 package
      packageNum: packageNum || 1 // Pass packageNum to instruction builder
    });

    let result;
    try {
      // WRAPPED IN RETRY
      result = await runWithRetry(() => chat.sendMessage(finalInstruction), 3, 3000);
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

    let cleanHtml = normalizeHtmlServer(html || '');

    // Remove interactive buttons for share view
    cleanHtml = cleanHtml.replace(/<button[^>]*class="[^"]*\bregen-btn\b[^"]*"[^>]*>.*?<\/button>/gs, '');
    cleanHtml = cleanHtml.replace(/<button[^>]*class="[^"]*\bdownload-btn\b[^"]*"[^>]*>.*?<\/button>/gs, '');
    cleanHtml = cleanHtml.replace(/<button[^>]*class="[^"]*\bghost\b[^"]*"[^>]*>.*?<\/button>/gs, '');

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
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      // HIDE Strategy and Gold Standard References
      const ps = document.querySelectorAll('.output p');
      ps.forEach(p => {
         const html = p.innerHTML || '';
         if (html.includes('<strong>Strategy:</strong>') || html.includes('<strong>Gold Standard References:</strong>')) {
            p.style.display = 'none';
         }
      });
    });
  </script>
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

app.post('/api/history/:id/append', async (req, res) => {
  try {
    const { html } = req.body;
    if (!html) return res.status(400).json({ error: 'Missing html' });
    const ok = await historyStore.appendHtml(req.params.id, html);
    if (!ok) return res.status(404).json({ error: 'Not found or failed' });
    res.json({ ok: true });
  } catch (err) {
    console.error('history append error:', err);
    res.status(500).json({ error: 'History append failed' });
  }
});

// Create new history item (for Custom Cards)
app.post('/api/history/create', async (req, res) => {
  try {
    const { html, meta } = req.body;
    if (!html || !meta) return res.status(400).json({ error: 'Missing html or meta' });

    // Validate meta
    const safeMeta = {
      ...meta,
      created_at: Date.now()
    };

    const saved = await historyStore.save(html, safeMeta);
    res.json(saved);
  } catch (err) {
    console.error('history create error:', err);
    res.status(500).json({ error: 'History create failed' });
  }
});

// Update history HTML (for regenerated packages)
app.post('/api/history/:id/update-html', async (req, res) => {
  try {
    const { html } = req.body;
    if (!html) return res.status(400).json({ error: 'Missing html' });

    const id = req.params.id;
    const item = await historyStore.get(id);
    if (!item) return res.status(404).json({ error: 'History item not found' });

    // Update HTML while preserving metadata
    const updated = await historyStore.save(html, {
      title: item.meta?.title || 'Untitled',
      videoSource: item.meta?.videoSource || null,
      playback: item.meta?.playback || null,
      generationContext: item.meta?.generationContext || null
    });

    // Delete old item and replace with updated one
    await historyStore.delete(id);

    console.log(`Updated history item ${id} HTML`);
    res.json({ ok: true, newId: updated.meta.id });
  } catch (err) {
    console.error('history update html error:', err);
    res.status(500).json({ error: 'History update failed' });
  }
});

// Update content IN-PLACE (preserves ID)
app.post('/api/history/:id/update-content', async (req, res) => {
  try {
    const { html } = req.body;
    if (!html) return res.status(400).json({ error: 'Missing html' });

    const ok = await historyStore.updateHtml(req.params.id, html);
    if (!ok) return res.status(404).json({ error: 'Not found or failed' });

    res.json({ ok: true });
  } catch (err) {
    console.error('history inplace update error:', err);
    res.status(500).json({ error: 'History update failed' });
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

  const server = app.listen(PORT, HOST, () => {
    console.log(`TT Generator running at http://${HOST}:${PORT}`);
  });

  // Apply timeout configurations from .env for large file uploads
  const REQUEST_TIMEOUT = Number(process.env.SERVER_REQUEST_TIMEOUT_MS || 3600000); // 1 hour default
  const HEADERS_TIMEOUT = Number(process.env.SERVER_HEADERS_TIMEOUT_MS || 1800000); // 30 min default
  const KEEPALIVE_TIMEOUT = Number(process.env.SERVER_KEEPALIVE_TIMEOUT_MS || 65000); // 65s default

  server.requestTimeout = REQUEST_TIMEOUT;
  server.headersTimeout = HEADERS_TIMEOUT;
  server.keepAliveTimeout = KEEPALIVE_TIMEOUT;

  console.log('[SERVER] Timeout configuration:');
  console.log(`  - Request timeout: ${REQUEST_TIMEOUT}ms (${Math.round(REQUEST_TIMEOUT / 60000)} minutes)`);
  console.log(`  - Headers timeout: ${HEADERS_TIMEOUT}ms (${Math.round(HEADERS_TIMEOUT / 60000)} minutes)`);
  console.log(`  - Keep-alive timeout: ${KEEPALIVE_TIMEOUT}ms (${Math.round(KEEPALIVE_TIMEOUT / 1000)} seconds)`);
  console.log(`[SERVER] Max upload size: ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB`);
})();

















