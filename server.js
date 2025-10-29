// server.js
import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import ytdl from 'ytdl-core';
import { GoogleGenerativeAI } from '@google/generative-ai';
import mammoth from 'mammoth'; // NEW: DOCX -> text

const unlink = promisify(fs.unlink);
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' })); // GS text can be large

// ---- Multer (in-memory) ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 } // up to ~1GB
});

const API_KEY = process.env.GOOGLE_API_KEY;
const MODEL   = process.env.MODEL || 'gemini-2.5-pro';
const PORT    = process.env.PORT || 3001;

const GS_JSON_PATH = process.env.GS_JSON_PATH || '';
const GS_CSV_PATH  = process.env.GS_CSV_PATH  || '';
const GS_DOCX_PATH = process.env.GS_DOCX_PATH || '';

if (!API_KEY) {
  console.error('❌ Missing GOOGLE_API_KEY in .env');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);

// ---- Helpers ----
function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }
const GS_CAP = { json: 180000, csv: 120000, kw: 120000 };

// ---- Server-side GS cache ----
let serverGS = { json: '', csv: '', kw: '' };

async function fileExists(p) {
  try { await fs.promises.access(p, fs.constants.R_OK); return true; }
  catch { return false; }
}

async function loadDocxToText(filePath) {
  const buf = await readFile(filePath);
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return String(value || '').trim();
}

async function loadServerGS() {
  const loaded = { json:false, csv:false, kw:false };
  try {
    if (GS_JSON_PATH && await fileExists(GS_JSON_PATH)) {
      const txt = await readFile(GS_JSON_PATH, 'utf-8');
      try { JSON.parse(txt); serverGS.json = clip(txt, GS_CAP.json); loaded.json = true; }
      catch { console.warn('⚠️  DATASET.json is not valid JSON — skipping'); }
    }
    if (GS_CSV_PATH && await fileExists(GS_CSV_PATH)) {
      const txt = await readFile(GS_CSV_PATH, 'utf-8');
      serverGS.csv = clip(txt, GS_CAP.csv);
      loaded.csv = true;
    }
    if (GS_DOCX_PATH && await fileExists(GS_DOCX_PATH)) {
      const kw = await loadDocxToText(GS_DOCX_PATH);
      serverGS.kw = clip(kw, GS_CAP.kw);
      loaded.kw = true;
    }
  } catch (e) {
    console.error('❌ Failed loading server GS:', e?.message || e);
  }
  const all = loaded.json && loaded.csv && loaded.kw;
  console.log(`GS loaded: json=${loaded.json} csv=${loaded.csv} kw=${loaded.kw} (all=${all})`);
  return loaded;
}

// Load GS at boot
await loadServerGS();

// ---- Build model message parts (unchanged core logic) ----
function buildGSIngestParts(gsJsonStr, gsCsvStr, keywordsFullText) {
  const parts = [];
  parts.push({
    text:
      "TAKE THESE AS GOLD STANDARD TITLES AND THUMBNAILS ALONG WITH ALL THE VIRAL IMPORTANT KEYWORDS ATTACHED. THESE ARE THE TOP PERFORMING VIDEOS. KEEP THESE IN YOUR MEMORY."
  });

  const append = (label, raw, size = 24000) => {
    parts.push({ text: `\n\n---\n${label}\n---\n` });
    const s = String(raw || '');
    for (let i = 0; i < s.length; i += size) parts.push({ text: s.slice(i, i + size) });
  };

  append("GOLD STANDARD: DATASET.json (RAW)", gsJsonStr || '');
  append("GOLD STANDARD: Top10_Viral_Titles_Thumbnails_AllChannels.csv (RAW)", gsCsvStr || '');
  append("GOLD STANDARD: Viral_Crime_Niche_Master_Keywords.docx (PLAIN TEXT)", keywordsFullText || '');
  return parts;
}

function buildFinalInstructionParts({ videoSource, topic, titleHint, strategistPrompt, contextText }) {
  const runContext = `
VIDEO INPUT (authoritative; do not invent facts). Use the attached video fully:
${(contextText || "").trim()}

Video Source: ${videoSource}
Optional Topic: ${topic || "(none)"} | Optional Angle Hint: ${titleHint || "(none)"}

MANDATORY:
- Use ONLY the attached video + VIDEO INPUT + learned gold-standard patterns.
- Do not assume/fabricate details not present.
- Output CLEAN HTML only (no preface).
- Start with "Video Summary & Core Angles" (video-specific), then 10 Title & Thumbnail Packages.
`.trim();

  return [
    { text: String(strategistPrompt || '').trim() },
    { text: runContext }
  ];
}

// ---- Files API upload + ACTIVE polling (unchanged) ----
async function waitForFileActive(fileId, { timeoutMs = 120000, initialDelay = 1200, maxDelay = 5000 } = {}) {
  const started = Date.now();
  let delay = initialDelay;
  let lastState = 'UNKNOWN';
  let lastUri = '';

  while (Date.now() - started < timeoutMs) {
    const metaResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileId}?key=${API_KEY}`);
    if (!metaResp.ok) {
      const txt = await metaResp.text().catch(()=>'');
      throw new Error(`Files API GET failed (${metaResp.status}): ${txt}`);
    }
    const meta = await metaResp.json();
    const state = meta?.state || meta?.fileState || 'UNKNOWN';
    const uri = meta?.uri || meta?.file?.uri || '';

    lastState = state;
    lastUri = uri;

    if (state === 'ACTIVE' && uri) return { uri, state };

    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(maxDelay, Math.floor(delay * 1.6));
  }

  throw new Error(`File did not become ACTIVE in time (lastState=${lastState}, uri=${lastUri ? 'present' : 'missing'})`);
}

async function uploadBufferToFilesAPI(buffer, mimeType, displayName) {
  const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${displayName}`);
  await writeFile(tmpPath, buffer);

  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), displayName);

    const url = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${API_KEY}`;
    const resp = await fetch(url, { method: 'POST', body: form });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`Files API upload failed (${resp.status}): ${txt}`);
    }

    const data = await resp.json();
    const fileId = data?.file?.name; // e.g. "files/abc123"
    if (!fileId) throw new Error('Files API upload returned no file name');

    const { uri } = await waitForFileActive(fileId);
    return { fileUri: uri, fileId };
  } finally {
    try { await unlink(tmpPath); } catch {}
  }
}

// ---- Health ----
app.get('/health', (req, res) => res.send('ok'));

// ---- GS status & reload (new endpoints; non-breaking) ----
app.get('/api/gs-status', (req, res) => {
  res.json({
    ok: true,
    serverGS: {
      json: !!serverGS.json,
      csv:  !!serverGS.csv,
      kw:   !!serverGS.kw,
      all:  !!(serverGS.json && serverGS.csv && serverGS.kw)
    },
    paths: {
      json: GS_JSON_PATH || null,
      csv:  GS_CSV_PATH  || null,
      kw:   GS_DOCX_PATH || null
    }
  });
});

app.post('/api/gs-reload', async (req, res) => {
  const loaded = await loadServerGS();
  res.json({ ok: true, loaded });
});

// ---- 1) Upload local MP4 -> Files API ----
app.post('/api/upload-video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No video uploaded' });
    const mime = req.file.mimetype || 'video/mp4';
    const name = req.file.originalname || 'uploaded-video.mp4';
    console.log(`⬆️  /api/upload-video  name=${name} mime=${mime} size=${req.file.size}`);

    const { fileUri, fileId } = await uploadBufferToFilesAPI(req.file.buffer, mime, name);
    console.log(`✅  Uploaded to Files API: ${fileId} (ACTIVE)`);

    res.json({ ok: true, fileUri, fileId, mimeType: mime, displayName: name });
  } catch (err) {
    console.error('Upload error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || 'Upload failed' });
  }
});

// ---- 2) Fetch YouTube -> download -> Files API ----
app.post('/api/fetch-youtube', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || !ytdl.validateURL(url)) return res.status(400).json({ ok: false, error: 'Invalid YouTube URL' });

    console.log(`⬇️  /api/fetch-youtube  url=${url}`);
    const info = await ytdl.getInfo(url);
    const fmt = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: f => f.container === 'mp4' && f.hasAudio });
    if (!fmt || !fmt.url) return res.status(500).json({ ok: false, error: 'Could not resolve downloadable MP4' });

    const chunks = [];
    await new Promise((resolve, reject) => {
      ytdl.downloadFromInfo(info, { format: fmt })
        .on('data', d => chunks.push(d))
        .on('end', resolve)
        .on('error', reject);
    });
    const buffer = Buffer.concat(chunks);
    const titleSafe = (info.videoDetails?.title || 'youtube-video').replace(/[^\w.\-]+/g, '_') + '.mp4';

    const { fileUri, fileId } = await uploadBufferToFilesAPI(buffer, 'video/mp4', titleSafe);
    console.log(`✅  YouTube uploaded to Files API: ${fileId} (ACTIVE)`);

    res.json({ ok: true, fileUri, fileId, mimeType: 'video/mp4', displayName: titleSafe });
  } catch (err) {
    console.error('YouTube fetch error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || 'YouTube fetch failed' });
  }
});

// ---- 3) Generate (two-turn; video attached) ----
app.post('/api/generate', async (req, res) => {
  try {
    const {
      fileUri, fileMime = 'video/mp4', videoSource = 'N/A',
      strategistPrompt = '', topic = '', titleHint = '', contextText = '',
      gsJson = '', gsCsv = '', gsKeywordsText = ''
    } = req.body || {};

    console.log('▶️  /api/generate', {
      hasFileUri: !!fileUri,
      mime: fileMime,
      topic: clip(topic, 60),
      hint: clip(titleHint, 60),
      ctxLen: (contextText || '').length,
      gs: { json: (gsJson || '').length, csv: (gsCsv || '').length, kw: (gsKeywordsText || '').length },
      serverGS: { json: !!serverGS.json, csv: !!serverGS.csv, kw: !!serverGS.kw }
    });

    if (!fileUri)          return res.status(400).json({ ok: false, error: 'fileUri missing' });
    if (!strategistPrompt) return res.status(400).json({ ok: false, error: 'strategistPrompt missing' });

    // Prefer server GS; fallback to client-provided GS to preserve old behavior
    const useJson = serverGS.json || clip(gsJson, 150000);
    const useCsv  = serverGS.csv  || clip(gsCsv, 100000);
    const useKw   = serverGS.kw   || clip(gsKeywordsText, 100000);

    const model = genAI.getGenerativeModel({
      model: MODEL,
      systemInstruction: "Follow output format exactly; store gold-standard patterns internally; do not leak chain-of-thought."
    });

    const history = [
      { role: 'user', parts: buildGSIngestParts(useJson, useCsv, useKw) },
      {
        role: 'user',
        parts: [
          { text: "\n\n---\nATTACHED VIDEO (analyze full visuals + audio)\n---\n" },
          { fileData: { fileUri, mimeType: fileMime } }
        ]
      }
    ];

    const chat = model.startChat({
      history,
      generationConfig: {
        temperature: 0.35,
        topP: 0.9,
        topK: 40,
        candidateCount: 1,
        maxOutputTokens: 8192,
        responseMimeType: "text/plain"
      }
    });

    // Acknowledge context (stability)
    await chat.sendMessage([{ text: "Acknowledge gold standard + attached video in one short sentence." }]);

    const parts = buildFinalInstructionParts({ videoSource, topic, titleHint, strategistPrompt, contextText });
    const result = await chat.sendMessage(parts);

    let html = "";
    try { html = result?.response?.text?.() || ""; } catch (e) { console.error("result.response.text() failed:", e); }

    const candidate = result?.response?.candidates?.[0];
    const meta = {
      finishReason: candidate?.finishReason,
      safety: candidate?.safetyRatings,
      usage: result?.response?.usageMetadata
    };

    if (!html.trim()) {
      console.error("Empty HTML; full API response:", JSON.stringify(result, null, 2));
      return res.status(502).json({
        ok: false,
        error: "Model returned empty response. See server logs for details.",
        meta
      });
    }

    console.log('✅  Generation OK');
    return res.json({ ok: true, html, meta });
  } catch (err) {
    console.error("GENERATION ERROR:");
    console.error(err?.stack || err?.message || String(err));
    try { console.error("Raw error object:", JSON.stringify(err, null, 2)); } catch {}
    return res.status(500).json({
      ok: false,
      error: err?.message || 'Generation failed (see server logs).'
    });
  }
});

app.listen(PORT, () => console.log(`Server running http://localhost:${PORT}`));
