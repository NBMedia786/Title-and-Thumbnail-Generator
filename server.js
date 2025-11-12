

// server.js
import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import express from 'express';
import cors from 'cors';
import multer from 'multer';


// Video fetchers
import ytdl from 'ytdl-core';
import { execFile } from 'child_process';

// Gemini SDK + docx
import { GoogleGenerativeAI } from '@google/generative-ai';
import mammoth from 'mammoth';

// ✅ Streaming multipart for large files (no RAM buffering)
import FormData from 'form-data';

// at top (keep your other imports)
import { FormData as UndiciFormData, File as UndiciFile } from 'undici';
import FormDataFallback from 'form-data';

// === history deps ===
import zlib from 'zlib';
import { randomUUID } from 'crypto';

// Queue / SSE deps
import { EventEmitter } from 'events';

const unlink = promisify(fs.unlink);
const writeFile = promisify(fs.writeFile);
const readFile  = promisify(fs.readFile);

// __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();

// ✅ CORS
app.use(cors({ origin: true, credentials: true }));
app.options('*', cors({ origin: true, credentials: true }));

// ✅ Larger body limit (for large JSON fallbacks etc.)
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// ✅ Never time out long requests (uploads / SSE / model runs)
app.use((req, res, next) => {
  // 0 disables Node’s default timeouts for this socket
  req.setTimeout(0);
  res.setTimeout(0);
  next();
});

// Serve frontend
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

/* =========================================================
   Storage (data/, uploads/, history/)
   ========================================================= */
const DATA_DIR        = path.join(__dirname, 'data');
const UPLOADS_DIR     = path.join(DATA_DIR, 'uploads');  // <— keep a copy for history playback
const HIST_DIR        = process.env.HIST_DIR || path.join(DATA_DIR, 'history');
const INDEX_PATH      = path.join(HIST_DIR, 'index.json');
const HISTORY_LIMIT_BYTES = BigInt(process.env.HISTORY_LIMIT_BYTES || 20 * 1024 * 1024 * 1024); // 20 GB

fs.mkdirSync(DATA_DIR,    { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(HIST_DIR,    { recursive: true });

/* =========================================================
   Multer — DISK storage
   ========================================================= */
const MULTER_MAX_FILE_SIZE = Number(process.env.MULTER_MAX_FILE_SIZE || 5 * 1024 * 1024 * 1024); // default 5GB
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) =>
      cb(null, `${Date.now()}-${(file.originalname || 'upload.mp4').replace(/[^\w.\-]+/g, '_')}`)
  }),
  limits: { fileSize: MULTER_MAX_FILE_SIZE }
});

const API_KEY = process.env.GOOGLE_API_KEY;
// const MODEL   = process.env.MODEL || 'gemini-2.5-pro';
//new
const MODEL            = (process.env.MODEL || 'gemini-2.5-flash').replace(/\r|\n/g, '').trim();
const PORT             = process.env.PORT || 3002;
const CLIENT_API_BASE  = process.env.CLIENT_API_BASE || '';

const GS_JSON_PATH = process.env.GS_JSON_PATH || '';
const GS_CSV_PATH  = process.env.GS_CSV_PATH  || '';
const GS_DOCX_PATH = process.env.GS_DOCX_PATH || '';

const FILES_ACTIVE_TIMEOUT_MS = Number(process.env.FILES_ACTIVE_TIMEOUT_MS || 30 * 60 * 1000);
const FILES_INITIAL_DELAY_MS  = Number(process.env.FILES_INITIAL_DELAY_MS || 1200);
const FILES_MAX_DELAY_MS      = Number(process.env.FILES_MAX_DELAY_MS || 5000);

if (!API_KEY) {
  console.error('❌ Missing GOOGLE_API_KEY in .env');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);

app.get('/env.js', (_req, res) => {
  res.type('application/javascript');
  res.send(`window.env = Object.assign({}, window.env, ${JSON.stringify({
    API_BASE_URL: CLIENT_API_BASE || ''
  })});`);
});

/* =========================================================
   SIMPLE IN-PROCESS CONCURRENCY QUEUE + SSE PROGRESS
   ========================================================= */

const QUEUE_CONCURRENCY = Number(process.env.QUEUE_CONCURRENCY || 3);

// job store
// job = { id, state, position, progress:{pct,msg}, error?, createdAt }
const qJobs = new Map();

// waiting line (FIFO of jobs that haven't started yet)
const qWaiting = [];

// current running
let qActive = 0;

// event bus for SSE pushes
const qBus = new EventEmitter();

// helper: create a job or get existing
function createJob(jobIdOptional) {
  const id = jobIdOptional || randomUUID();
  let job = qJobs.get(id);
  if (!job) {
    job = {
      id,
      state: 'created',         // 'created' -> 'queued' -> 'active' -> 'done'|'failed'
      position: 0,
      progress: { pct: 0, msg: 'created' },
      error: null,
      createdAt: Date.now()
    };
    qJobs.set(id, job);
  }
  return job;
}

// broadcast queue positions to listeners
function updatePositionsAndBroadcast() {
  qWaiting.forEach((slot, idx) => {
    const job = qJobs.get(slot.jobId);
    if (!job) return;
    job.position = idx + 1; // 1-based
    if (job.state !== 'active' && job.state !== 'done' && job.state !== 'failed') {
      job.state = 'queued';
    }
    qBus.emit('queued', { id: job.id, position: job.position });
  });
}

// try to start jobs if we have capacity
function tryStartNext() {
  while (qActive < QUEUE_CONCURRENCY && qWaiting.length > 0) {
    const slot = qWaiting.shift();
    const job = qJobs.get(slot.jobId);
    if (!job) continue;

    qActive++;
    job.state = 'active';
    job.position = 0;
    job.progress = { pct: 5, msg: 'starting' };
    qBus.emit('started', { id: job.id, progress: job.progress });

    // actually run the work
    slot.startFn(job);
  }
  updatePositionsAndBroadcast();
}

// queue a job
function enqueueJob(jobId, startFn) {
  const job = createJob(jobId);

  const alreadyIdx = qWaiting.findIndex(s => s.jobId === jobId);
  if (alreadyIdx === -1 && job.state !== 'active' && job.state !== 'done' && job.state !== 'failed') {
    qWaiting.push({ jobId, startFn });
    if (job.state === 'created') job.state = 'queued';
  }

  updatePositionsAndBroadcast();
  tryStartNext();
}

// middleware/wrapper for heavy routes
function queuedRouteWithSSE(handler) {
  return async (req, res) => {
    const qid = String(req.query.qid || req.body?.qid || randomUUID());
    const job = createJob(qid);

    function runJob() {
      req._queueProgress = (pct, msg) => {
        const j = qJobs.get(qid);
        if (!j) return;
        j.progress = { pct, msg };
        qBus.emit('progress', { id: qid, progress: j.progress });
      };

      (async () => {
        try {
          await handler(req, res);

          const j = qJobs.get(qid);
          if (j) {
            j.progress = { pct: 100, msg: 'completed' };
            j.state = 'done';
            qBus.emit('done', { id: qid });
          }
        } catch (err) {
          const j = qJobs.get(qid);
          if (j) {
            j.state = 'failed';
            j.error = err?.message || 'failed';
            qBus.emit('failed', { id: qid, error: j.error });
          }
          if (!res.headersSent) {
            res.status(500).json({ ok: false, error: err?.message || 'failed' });
          }
        } finally {
          qActive = Math.max(0, qActive - 1);
          tryStartNext();
        }
      })();
    }

    enqueueJob(qid, runJob);
  };
}

// SSE stream (hardened: no buffering + heartbeat)
app.get('/api/queue/:id/stream', (req, res) => {
  const { id } = req.params;
  const job = qJobs.get(id);
  if (!job) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Connection', 'keep-alive');
  // Disable proxy buffering (nginx)
  res.setHeader('X-Accel-Buffering', 'no');

  // immediately flush headers
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // initial snapshot
  send('snapshot', job);

  const onQueued   = (p) => { if (p.id === id) send('queued', p); };
  const onStarted  = (p) => { if (p.id === id) send('started', p); };
  const onProgress = (p) => { if (p.id === id) send('progress', p); };
  const onDone     = (p) => {
    if (p.id === id) {
      send('done', p);
      cleanup();
      res.end();
    }
  };
  const onFailed   = (p) => {
    if (p.id === id) {
      send('failed', p);
      cleanup();
      res.end();
    }
  };

  // heartbeat every 15s so proxies keep the connection open
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 15000);

  function cleanup() {
    clearInterval(heartbeat);
    qBus.off('queued', onQueued);
    qBus.off('started', onStarted);
    qBus.off('progress', onProgress);
    qBus.off('done', onDone);
    qBus.off('failed', onFailed);
  }

  qBus.on('queued', onQueued);
  qBus.on('started', onStarted);
  qBus.on('progress', onProgress);
  qBus.on('done', onDone);
  qBus.on('failed', onFailed);

  req.on('close', cleanup);
});

// Queue ticket
app.post('/api/queue/ticket', (req, res) => {
  const job = createJob();
  res.json({ ok: true, id: job.id });
});

// Queue stats
app.get('/api/queue-stats', (req, res) => {
  res.json({
    ok: true,
    active: qActive,
    waiting: qWaiting.length,
    concurrency: QUEUE_CONCURRENCY
  });
});

// Queue status (polling fallback if SSE unavailable)
app.get('/api/queue/:id/status', (req, res) => {
  const job = qJobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, job });
});

/* =========================================================
   Helpers (unchanged + new timestamp linkifier)
   ========================================================= */
function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }
const GS_CAP = { json: 180000, csv: 120000, kw: 120000 };

function humanizeFileName(name) {
  const base = String(name || '')
    .replace(/[/\\]+/g, ' ')
    .replace(/\.[a-z0-9]+$/i, '');
  const spaced = base.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  const stripped = spaced
    .replace(/\b(vid|mov|img|pxl|dji|gopr|frame|clip)\b/gi, '')
    .replace(/\b(20\d{2}[-_.]?\d{2}[-_.]?\d{2}|\d{8}_\d{6})\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const titled = stripped.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
  return (titled || 'Local Video').slice(0, 80);
}

function stripCodeFences(s) {
  const fence = s.match(/^\s*```(?:html|HTML)?\s*([\s\S]*?)\s*```\s*$/);
  if (fence) return fence[1];
  return s.replace(/^\s*```(?:html|HTML)?\s*/, '').replace(/\s*```\s*$/, '');
}
function extractBodyIfFullHtml(s) {
  const hasHtml = /<html[\s\S]*?>/i.test(s);
  if (!hasHtml) return { isFull: false, body: s };
  const bodyMatch = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) return { isFull: true, body: bodyMatch[1] };
  return { isFull: true, body: s };
}
function sanitizeNoScripts(s) {
  return s.replace(/<script[\s\S]*?<\/script>/gi, '');
}

/* ---------- NEW: Timestamp linkifier ---------- */
function parseToSeconds(raw) {
  if (!raw) return 0;
  const s = String(raw).toLowerCase().replace(/[()[\]]/g, '').trim();

  // h m s tokens: 1h2m3s / 2m30s / 45s
  const t = s.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/i);
  if (t && (t[1] || t[2] || t[3])) {
    const h = +(t[1]||0), m = +(t[2]||0), sec = +(t[3]||0);
    return h*3600 + m*60 + sec;
  }

  // HH:MM:SS or MM:SS
  const parts = s.split(':').map(x => +x);
  if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0]*3600 + parts[1]*60 + parts[2];
  if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0]*60 + parts[1];

  return 0;
}

function linkifyTimestampsHTML(html) {
  if (!html) return html;
  // Matches: 0:02, 12:34, 1:02:03, [00:59], (5m30s), 45s, 2m, 1h03m
  const RX = /\b(?:\(?\[?)?(?:\d{1,2}:\d{2}(?::\d{2})?|\d+h\d*m?\d*s?|\d+m\d*s?|\d+s)(?:\]?\)?)\b/ig;

  return html.replace(RX, (match) => {
    const secs = parseToSeconds(match);
    if (!secs) return match;
    const label = match.replace(/^[([ ]*|[)\] ]*$/g, '');
    return `<a href="#t=${encodeURIComponent(label)}" class="ts-link" data-seconds="${secs}">${label}</a>`;
  });
}
/* ---------- /NEW ---------- */

/* ********************************************************************
   IMPORTANT CHANGE: no player injection into output HTML anymore.
   ******************************************************************** */
function buildPlayerSection(){ return { css:'', html:'', js:'' }; }

function wrapInTemplate(innerHtml /*, inputMeta */) {
  const player = buildPlayerSection();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Video Summary & Core Angles</title>
<style>
  :root{ --bg:#0c1016; --panel:#151a23; --ink:#e9edf4; --muted:#a3acba; --rule:#2b3240; --accent-red:#ef4444; --accent-purple:#7c3aed; }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,"Apple Color Emoji","Segoe UI Emoji"}
  .page{max-width:980px;margin:36px auto;padding:28px;background:var(--panel);border:1px solid var(--rule);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
  h1,h2,h3{line-height:1.25;margin:0 0 14px}
  h1{font-size:2.1rem;font-weight:800;padding-bottom:12px;border-bottom:3px solid var(--accent-red);letter-spacing:.2px}
  h2{font-size:1.35rem;margin-top:28px;padding-bottom:8px;border-bottom:2px solid var(--accent-purple);font-weight:700}
  h3{font-size:1.08rem;margin-top:20px}
  p{margin:0 0 12px}
  ul,ol{margin:8px 0 16px;padding-left:22px}
  li{margin:6px 0}
  .angle,.card{background:#1b2230;border:1px solid var(--rule);border-left:6px solid var(--accent-red);border-radius:12px;padding:14px 16px;margin:14px 0}
  hr{border:0;border-top:1px solid var(--rule);margin:22px 0}
  .muted{color:var(--muted)}
  pre,code{background:#0b0f16;border:1px solid var(--rule);border-radius:8px}
  pre{padding:12px;overflow:auto}
  code{padding:2px 6px}
  a{color:#c4b5fd;text-decoration:none}
  a:hover{text-decoration:underline}
  ${player.css}
</style>
</head>
<body>
  <main class="page">
    ${innerHtml}
  </main>
</body>
</html>`;
}

function normalizeModelHtml(raw, inputMeta) {
  let s = String(raw || '').trim();
  s = stripCodeFences(s);
  s = sanitizeNoScripts(s);
  const { body } = extractBodyIfFullHtml(s);

  // ⬅️ linkify timestamps before wrapping into the template
  const linked = linkifyTimestampsHTML(body);

  return wrapInTemplate(linked, inputMeta || {});
}

// ---- Server-side GS cache
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

function buildGSIngestParts(gsJsonStr, gsCsvStr, keywordsFullText) {
  const parts = [];
  parts.push({ text:
    "TAKE THESE AS GOLD STANDARD TITLES AND THUMBNAILS ALONG WITH ALL THE VIRAL IMPORTANT KEYWORDS ATTACHED.THESE ARE THE TOP PERFORMING VIDEOS AND HAVE BEST TITLES AND THUMBNAILS.ANALYSE THESE AND KEEP THESE IN YOUR MEMORY FIRST "
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

/* =================== Files API helpers (unchanged logic; hardened) =================== */
async function waitForFileActive(
  fileId,
  {
    timeoutMs = FILES_ACTIVE_TIMEOUT_MS,
    initialDelay = FILES_INITIAL_DELAY_MS,
    maxDelay = FILES_MAX_DELAY_MS
  } = {}
) {
  const started = Date.now();
  let delay = initialDelay;
  let lastState = 'UNKNOWN';
  let lastUri = '';

  let checks = 0;
  while (Date.now() - started < timeoutMs) {
    checks++;
    const metaResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileId}?key=${API_KEY}`);
    if (!metaResp.ok) {
      const txt = await metaResp.text().catch(()=> '');
      throw new Error(`Files API GET failed (${metaResp.status}): ${txt}`);
    }
    const meta = await metaResp.json();
    const state = meta?.state || meta?.fileState || 'UNKNOWN';
    const uri = meta?.uri || meta?.file?.uri || '';

    lastState = state;
    lastUri = uri;

    if (state === 'ACTIVE' && uri) {
      console.log(`📦 Files API: ${fileId} ACTIVE after ${checks} checks (${Math.round((Date.now()-started)/1000)}s)`);
      return { uri, state };
    }

    if (checks === 1 || checks % 5 === 0) {
      console.log(`⌛ Files API: ${fileId} state=${state} (waiting ${delay}ms)`);
    }

    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(maxDelay, Math.floor(delay * 1.6));
  }

  throw new Error(`File did not become ACTIVE in time (lastState=${lastState}, uri=${lastUri ? 'present' : 'missing'})`);
}



// replace ONLY this function
async function uploadPathToFilesAPI(filePath, mimeType, displayName) {
  const url  = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${API_KEY}`;
  const name = displayName || path.basename(filePath);

  let type = String(mimeType || 'application/octet-stream').toLowerCase().split(';')[0].trim();
  if (type.includes('mp4') || name.toLowerCase().endsWith('.mp4')) {
    type = 'video/mp4';
  } else if (type.includes('webm') || name.toLowerCase().endsWith('.webm')) {
    type = 'video/webm';
  } else if (type.includes('mov') || name.toLowerCase().endsWith('.mov')) {
    type = 'video/mp4';
  }
  const buf  = await fs.promises.readFile(filePath);

  let resp, text;

  try {
    // Preferred: Undici (preserves filename + MIME)
    const file = new UndiciFile([buf], name, { type });
    const form = new UndiciFormData();
    form.append('file', file);                         // field MUST be 'file'
    resp  = await fetch(url, { method: 'POST', body: form });
    text  = await resp.text();
    if (!resp.ok) throw new Error(`Undici upload failed (${resp.status}): ${text}`);
  } catch (e) {
    console.warn(`⚠️ Undici upload failed (${e?.message}). Falling back to form-data.`);

    const form = new FormDataFallback();
    form.append('file', buf, { filename: name, contentType: type });

    const formHeaders = form.getHeaders?.() || {};

    resp = await fetch(url, {
      method: 'POST',
      body: form,
      headers: {
        'Content-Type': formHeaders['content-type'],
        'Content-Length': buf.byteLength
      },
      signal: AbortSignal.timeout(600000)
    });
    text = await resp.text();
    if (!resp.ok) throw new Error(`Files API upload (fallback) failed (${resp.status}): ${text}`);
  }

  let data; try { data = JSON.parse(text); } catch { throw new Error(`Files API returned non-JSON: ${text}`); }
  const fileId = data?.file?.name;
  if (!fileId) throw new Error(`Files API response missing file.name: ${JSON.stringify(data)}`);

  const { uri } = await waitForFileActive(fileId);    // unchanged polling logic
  return { fileUri: uri, fileId };
}

// ---- Serve uploads for local playback
app.use('/uploads', express.static(UPLOADS_DIR, {
  setHeaders(res) {
    res.setHeader('Accept-Ranges', 'bytes');
  }
}));

// ---- Health
app.get('/health', (req, res) => res.send('ok'));

// ---- GS status & reload
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

/* =========================================================
   1) Upload local MP4 (immediate, not queued)
   ========================================================= */
app.post('/api/upload-video', upload.single('video'), async (req, res) => {
  const filePath = req?.file?.path;
  const mime     = req?.file?.mimetype || 'video/mp4';
  const name     = req?.file?.originalname || 'uploaded-video.mp4';

  if (!filePath) return res.status(400).json({ ok: false, error: 'No video uploaded' });
  console.log(`⬆️  /api/upload-video  path=${filePath} mime=${mime} size=${req.file.size}`);

  // save copy for local playback
  const safeExt = path.extname(name) || '.mp4';
  const uploadId = randomUUID();
  const uploadFile = path.join(UPLOADS_DIR, `${uploadId}${safeExt}`);

  try {
    const { fileUri, fileId } = await uploadPathToFilesAPI(filePath, mime, name);

    // stream copy
    await new Promise((resolve, reject) => {
      const r = fs.createReadStream(filePath);
      const w = fs.createWriteStream(uploadFile);
      r.pipe(w);
      r.on('error', reject);
      w.on('finish', resolve);
      w.on('error', reject);
    });

    console.log(`✅  Uploaded to Files API: ${fileId} (ACTIVE). Local playback copy saved ${uploadFile}`);
    res.json({
      ok: true,
      fileUri,
      fileId,
      mimeType: mime,
      fileMime: mime,
      displayName: name,
      playback: { kind: 'local', url: `/uploads/${path.basename(uploadFile)}` }
    });
  } catch (err) {
    console.error('Upload error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || 'Upload failed' });
  } finally {
    try { await unlink(filePath); } catch {}
  }
});

/* =========================================================
   2) Fetch YouTube (queued with progress)
   ========================================================= */
const BIN_DIR    = path.join(__dirname, 'bin');
const YTDLP_EXE  = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const YTDLP_PATH = path.join(BIN_DIR, YTDLP_EXE);
// Optional cookie file (used only if present)
const COOKIE_FILE_PATH = path.join(__dirname, 'assets', 'deployment_cookies.txt');

async function ensureYtDlp() {
  try { await fs.promises.access(YTDLP_PATH, fs.constants.XOK || fs.constants.X_OK); return YTDLP_PATH; } catch {}
  await fs.promises.mkdir(BIN_DIR, { recursive: true });
  const url = process.platform === 'win32'
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
  console.log(`⬇️  Downloading yt-dlp from ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`yt-dlp download failed: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await fs.promises.writeFile(YTDLP_PATH, buf, { mode: 0o755 });
  console.log('✅  yt-dlp downloaded');
  return YTDLP_PATH;
}

async function downloadWithYtDlpToPath(url) {
  const ytdlp   = await ensureYtDlp();
  const outPath = path.join(os.tmpdir(), `yt_${Date.now()}.mp4`);

  const args = [
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--quiet', '--no-warnings',
    '-o', outPath,
    url
  ];

  // add cookies only if file exists
  try { await fs.promises.access(COOKIE_FILE_PATH, fs.constants.R_OK); args.splice(7, 0, '--cookies', COOKIE_FILE_PATH); }
  catch { /* cookie file absent; proceed without */ }

  console.log('▶️  yt-dlp', args.join(' '));
  await new Promise((resolve, reject) => {
    execFile(ytdlp, args, { windowsHide: true }, (err) => err ? reject(err) : resolve());
  });

  // friendly name
  let displayName = `youtube-video-${Date.now()}.mp4`;
  try {
    await new Promise((resolve) => {
      execFile(ytdlp, ['--get-title', '--no-playlist', url], { windowsHide: true }, (e, stdout) => {
        const t = String(stdout || '').split('\n')[0].trim();
        if (t) displayName = `${t}`.replace(/[^\w.\-]+/g, '_') + '.mp4';
        resolve();
      });
    });
  } catch {}
  return { outPath, displayName, mime: 'video/mp4' };
}

// QUEUED VERSION of /api/fetch-youtube
app.post('/api/fetch-youtube', queuedRouteWithSSE(async (req, res) => {
  try {
    req._queueProgress?.(10, 'validating YouTube URL');

    let { url } = req.body || {};
    if (!url) {
      return res.status(400).json({ ok: false, error: 'Missing YouTube URL' });
    }

    let ytId;
    try {
      ytId = ytdl.getURLVideoID(url);
      url = `https://www.youtube.com/watch?v=${ytId}`;
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid YouTube URL' });
    }

    console.log(`⬇️  /api/fetch-youtube  url=${url}`);

    // Attempt 1: ytdl-core
    try {
      req._queueProgress?.(30, 'downloading with ytdl-core');

      const headers = {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'accept-language': 'en-US,en;q=0.9',
      };

      const info = await ytdl.getInfo(url, { requestOptions: { headers } });

      let fmt =
        ytdl.chooseFormat(info.formats, {
          quality: 'highest',
          filter: (f) =>
            f.hasAudio &&
            f.hasVideo &&
            (f.container === 'mp4' || (f.mimeType || '').includes('mp4')),
        }) ||
        ytdl.chooseFormat(info.formats, {
          quality: 'highest',
          filter: (f) => f.hasAudio && f.hasVideo,
        });

      if (!fmt || !fmt.url) throw new Error('No direct AV format URL');

      const mime =
        fmt.mimeType?.split(';')[0] ||
        (fmt.container === 'mp4' ? 'video/mp4' : 'video/webm');

      const safeTitle = (info.videoDetails?.title || 'youtube-video').replace(/[^\w.\-]+/g, '_');
      const ext = mime === 'video/mp4' ? '.mp4' : '.webm';
      const tempPath = path.join(os.tmpdir(), `${Date.now()}-${safeTitle}${ext}`);

      await new Promise((resolve, reject) => {
        const r = ytdl.downloadFromInfo(info, { format: fmt, requestOptions: { headers } });
        const w = fs.createWriteStream(tempPath);
        r.pipe(w);
        r.on('error', reject);
        w.on('finish', resolve);
        w.on('error', reject);
      });

      try {
        req._queueProgress?.(60, 'uploading to Files API');

        const { fileUri, fileId } = await uploadPathToFilesAPI(tempPath, mime, path.basename(tempPath));
        console.log(`✅  YouTube uploaded via ytdl-core: ${fileId} (ACTIVE)`);

        req._queueProgress?.(95, 'finalizing');

        return res.json({
          ok: true,
          fileUri,
          fileId,
          mimeType: mime,
          fileMime: mime,
          displayName: path.basename(tempPath),
          playback: { kind: 'youtube', url, youtubeId: ytId }
        });
      } finally {
        try { await unlink(tempPath); } catch {}
      }
    } catch (e1) {
      console.warn('⚠️  ytdl-core fetch failed; falling back to yt-dlp:', e1?.message || e1);
    }

    // Attempt 2: yt-dlp
    req._queueProgress?.(40, 'downloading with yt-dlp');

    const { outPath, displayName, mime } = await downloadWithYtDlpToPath(url);
    try {
      req._queueProgress?.(70, 'uploading to Files API');

      const { fileUri, fileId } = await uploadPathToFilesAPI(outPath, mime, displayName);
      console.log(`✅  YouTube uploaded via yt-dlp: ${fileId} (ACTIVE)`);

      req._queueProgress?.(95, 'finalizing');

      return res.json({
        ok: true,
        fileUri,
        fileId,
        mimeType: mime,
        fileMime: mime,
        displayName,
        playback: { kind: 'youtube', url, youtubeId: ytId }
      });
    } finally {
      try { await unlink(outPath); } catch {}
    }
  } catch (err) {
    console.error('YouTube fetch error:', err?.message || err);
    const msg =
      /private|copyright|410|signin|age|forbidden|403/i.test(err?.message || '')
        ? 'Video is restricted (private/age/region). Try another public URL.'
        : err?.message || 'YouTube fetch failed';
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: msg });
    }
  }
}));

/* ===============================
   HistoryStore (filesystem)
   =============================== */
class HistoryStore {
  constructor(dir, indexPath, limitBytes) {
    this.dir = dir;
    this.indexPath = indexPath;
    this.limit = BigInt(limitBytes);
    this._ensureIndex();
  }
  _ensureIndex() {
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, JSON.stringify({ items: [] }), 'utf-8');
    }
  }
  _readIndex() {
    try {
      return JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')) || { items: [] };
    } catch { return { items: [] }; }
  }
  _writeIndex(idx) {
    fs.writeFileSync(this.indexPath, JSON.stringify(idx), 'utf-8');
  }
  _usage(idx) {
    return idx.items.reduce((a, b) => a + BigInt(b.size_bytes || 0), 0n);
  }
  stats() {
    const idx = this._readIndex();
    const used = this._usage(idx);
    return {
      limit: Number(this.limit),
      used : Number(used),
      remaining: Number(used > this.limit ? 0n : (this.limit - used)),
      count: idx.items.length
    };
  }
  search({ q = '', page = 1, limit = 50 }) {
    const idx = this._readIndex();
    const norm = q.trim().toLowerCase();
    let items = idx.items;
    if (norm) {
      items = items.filter(x =>
        String(x.title||'').toLowerCase().includes(norm) ||
        String(x.preview||'').toLowerCase().includes(norm)
      );
    }
    items.sort((a,b)=> b.created_at - a.created_at);
    const offset = (page - 1) * limit;
    const slice = items.slice(offset, offset + limit)
      .map(({ id, title, created_at, size_bytes, preview }) => ({ id, title, created_at, size_bytes, preview }));
    return { items: slice, total: items.length, page, limit };
  }
  async get(id) {
    const idx = this._readIndex();
    const it = idx.items.find(x => x.id === id);
    if (!it) return null;
    const raw = await fs.promises.readFile(it.file_path);
    const buf = zlib.gunzipSync(raw);
    const data = JSON.parse(buf.toString('utf-8'));
    return { meta: it, data };
  }
  async delete(id) {
    const idx = this._readIndex();
    const i = idx.items.findIndex(x => x.id === id);
    if (i === -1) return false;
    try { if (fs.existsSync(idx.items[i].file_path)) await fs.promises.unlink(idx.items[i].file_path); } catch {}
    idx.items.splice(i, 1);
    this._writeIndex(idx);
    return true;
  }
  async purgeOldestUntilFree(bytesNeeded) {
    const needed = BigInt(bytesNeeded || 0);
    const idx = this._readIndex();
    idx.items.sort((a,b)=> a.created_at - b.created_at);
    let used = this._usage(idx);
    const evicted = [];
    let p = 0;
    while (used + needed > this.limit && p < idx.items.length) {
      const it = idx.items[p++];
      try { if (fs.existsSync(it.file_path)) fs.unlinkSync(it.file_path); } catch {}
      used -= BigInt(it.size_bytes || 0);
      evicted.push(it.id);
    }
    idx.items = idx.items.filter(x => !evicted.includes(x.id));
    this._writeIndex(idx);
    return { evicted, used: Number(used), limit: Number(this.limit) };
  }
  _gzip(obj) { return zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf-8'), { level: 9 }); }
  _previewFromHTML(html) {
    const text = String(html||'').replace(/<script[\s\S]*?<\/script>/gi,'')
      .replace(/<style[\s\S]*?<\/style>/gi,'')
      .replace(/<[^>]+>/g,' ')
      .replace(/\s+/g,' ')
      .trim();
    return text.length > 180 ? text.slice(0,180) + '…' : text;
  }
  save({ title, html, extraMeta }) {
    const idx = this._readIndex();
    const used = this._usage(idx);
    const gz = this._gzip({ html, meta: extraMeta || null, ts: Date.now() });
    const newSize = BigInt(gz.byteLength);
    if (used + newSize > this.limit) {
      const needed = Number((used + newSize) - this.limit);
      return { error: 'STORAGE_LIMIT_EXCEEDED', needed, used: Number(used), limit: Number(this.limit) };
    }
    const id = randomUUID();
    const file_path = path.join(this.dir, `${id}.json.gz`);
    fs.writeFileSync(file_path, gz);
    const entry = {
      id,
      title: String(title || 'Generated Package').slice(0, 200),
      created_at: Date.now(),
      size_bytes: Number(newSize),
      file_path,
      preview: this._previewFromHTML(html)
    };
    idx.items.push(entry);
    this._writeIndex(idx);
    return { id, size_bytes: Number(newSize) };
  }
}

const historyStore = new HistoryStore(HIST_DIR, INDEX_PATH, HISTORY_LIMIT_BYTES);

/* ====================== History HTTP Endpoints ====================== */
app.get('/api/history-stats', (req, res) => res.json(historyStore.stats()));

app.get('/api/history', (req, res) => {
  const q = String(req.query.q || '');
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  res.json(historyStore.search({ q, page, limit }));
});

app.get('/api/history/:id', async (req, res) => {
  const item = await historyStore.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(item);
});

app.get('/api/history/:id/html', async (req, res) => {
  const item = await historyStore.get(req.params.id);
  if (!item) return res.status(404).send('Not found');
  const html = String(item.data?.html || '');
  const download = String(req.query.download || '').toLowerCase() === '1';
  if (download) {
    res.setHeader('Content-Disposition', `attachment; filename="${(item.meta?.title || 'Generated_Package').replace(/[^\w.-]/g,'_')}.html"`);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
});

app.delete('/api/history/:id', async (req, res) => {
  const ok = await historyStore.delete(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.post('/api/history/purge', async (req, res) => {
  const mode = String(req.query.mode || 'oldest');
  if (mode !== 'oldest') return res.status(400).json({ error: 'Unsupported mode' });
  const bytes = Number(req.query.bytes || req.body?.bytes || 0);
  const result = await historyStore.purgeOldestUntilFree(bytes);
  res.json(result);
});

/* =========================================================
   3) Generate (queued with progress + history save)
   ========================================================= */
app.post('/api/generate', queuedRouteWithSSE(async (req, res) => {
  try {
    req._queueProgress?.(10, 'validating input');

    const {
      fileUri, fileMime = 'video/mp4', videoSource = 'N/A', displayName,
      strategistPrompt = '', topic = '', titleHint = '', contextText = '',
      gsJson = '', gsCsv = '', gsKeywordsText = '',
      playback = null
    } = req.body || {};
    //new
        // ——— Normalize inputs (protect against CR/LF and stray params on VPS) ———
    const cleanFileUri = String(fileUri || '').replace(/\r|\n/g, '').trim();
    const cleanMime    = String(fileMime || 'video/mp4').split(';')[0].trim();

    // sanity guard: only proceed with a valid Files API URI
    if (!/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\//.test(cleanFileUri)) {
      return res.status(400).json({ ok: false, error: 'fileUri is not a valid Files API URI' });
    }

    console.log('▶️  /api/generate', {
      hasFileUri: !!fileUri,
      mime: fileMime,
      topic: clip(topic, 60),
      hint: clip(titleHint, 60),
      ctxLen: (contextText || '').length,
      gs: { json: (gsJson || '').length, csv: (gsCsv || '').length, kw: (gsKeywordsText || '').length },
      serverGS: { json: !!serverGS.json, csv: !!serverGS.csv, kw: !!serverGS.kw },
      playback
    });

    if (!fileUri)           return res.status(400).json({ ok: false, error: 'fileUri missing' });
    if (!strategistPrompt) return res.status(400).json({ ok: false, error: 'strategistPrompt missing' });

    const model = genAI.getGenerativeModel({
      model: `models/${MODEL}`
    });

    req._queueProgress?.(30, 'Preparing video analysis parts');

    const finalContentParts = [
      {
        role: 'user',
        parts: [
          {
            text: "Analyze the attached video file. Provide a 3-sentence summary and 3 unique title ideas. DO NOT reference any Gold Standard files."
          },
          {
            fileData: { fileUri: cleanFileUri, mimeType: cleanMime }
          }
        ]
      }
    ];

    req._queueProgress?.(55, 'analyzing video and generating');

    const result = await model.generateContent({
      contents: finalContentParts,
      generationConfig: {
        temperature: 0.1,
        topP: 0.9,
        topK: 40,
        maxOutputTokens: 8192
      }
    });

    let raw = "";
    try { raw = result?.response?.text?.() || ""; } catch (e) { console.error("result.response.text() failed:", e); }

    const candidate = result?.response?.candidates?.[0];
    const meta = {
      finishReason: candidate?.finishReason,
      safety: candidate?.safetyRatings,
      usage: result?.response?.usageMetadata
    };

    if (!raw.trim()) {
      console.error("Empty HTML; full API response:", JSON.stringify(result, null, 2));
      return res.status(502).json({
        ok: false,
        error: "Model returned empty response. See server logs for details.",
        meta
      });
    }

    req._queueProgress?.(80, 'formatting HTML');

    const normalizedHtml = normalizeModelHtml(raw, {});
    console.log('✅  Generation OK');

    let title =
      (topic && topic.trim()) ||
      (titleHint && titleHint.trim()) ||
      (displayName && humanizeFileName(displayName)) ||
      'Generated Package';

    if (title === 'Generated Package') {
      const h = normalizedHtml.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/i) || normalizedHtml.match(/^\s*#+\s*([^\n]+)/m);
      if (h && h[1]) title = h[1].trim().slice(0, 80);
    }

    const saved = historyStore.save({
      title,
      html: normalizedHtml,
      extraMeta: {
        meta,
        input: { videoSource, topic, titleHint, contextText, displayName, playback }
      }
    });

    let historyPayload = null;
    let storage = historyStore.stats();
    if (saved?.error === 'STORAGE_LIMIT_EXCEEDED') {
      historyPayload = { saved: false, reason: 'STORAGE_LIMIT_EXCEEDED', needed: saved.needed };
    } else if (saved?.id) {
      historyPayload = { saved: true, id: saved.id, size_bytes: saved.size_bytes };
    }

    req._queueProgress?.(95, 'finalizing');

    return res.json({ ok: true, html: normalizedHtml, meta, history: historyPayload, storage });
  } catch (err) {
    console.error("GENERATION ERROR:");
    console.error(err?.stack || err?.message || String(err));
    try { console.error("Raw error object:", JSON.stringify(err, null, 2)); } catch {}
    if (!res.headersSent) {
      return res.status(500).json({
        ok: false,
        error: err?.message || 'Generation failed (see server logs).'
      });
    }
  }
}));

/* =========================================================
   ⬇️ NEW: Write your History UI script into /public/history.js
   ========================================================= */
try {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  const HISTORY_UI_JS = 
`// Elements
const historyBtn = document.getElementById("historyBtn");
const historyPanel = document.getElementById("historyPanel");
const historyBackdrop = document.getElementById("historyBackdrop");
const closeHistory = document.getElementById("closeHistory");
const historyList = document.getElementById("historyList");

function toggleHistory(open) {
  const isOpen = open ?? !historyPanel.classList.contains("open");
  historyPanel.classList.toggle("open", isOpen);
  historyBackdrop.classList.toggle("open", isOpen);
  document.body.style.overflow = isOpen ? "hidden" : "";
}

historyBtn?.addEventListener("click", () => toggleHistory());
closeHistory?.addEventListener("click", () => toggleHistory(false));
historyBackdrop?.addEventListener("click", () => toggleHistory(false));

// Sample data
const historyData = [
  { id: 1, title: "Woman On Sofa", size: "4.5 KB" },
  { id: 2, title: "Terrilynne Collins Final Render", size: "5.2 KB" },
  { id: 3, title: "Moment After Psychopath Song", size: "6.1 KB" },
];

// Render items
function renderHistory() {
  historyList.innerHTML = "";
  historyData.forEach(item => {
    const div = document.createElement("div");
    div.className = "history-item";
    div.innerHTML = \`
      <div class="history-title">\${item.title}</div>
      <button class="kebab-btn" title="Options">⋯</button>
      <div class="kebab-menu">
        <div class="size">Size: \${item.size}</div>
        <button data-action="rename">Rename</button>
        <button data-action="share">Share</button>
        <button data-action="delete">Delete</button>
      </div>
    \`;
    const kebabBtn = div.querySelector(".kebab-btn");
    const kebabMenu = div.querySelector(".kebab-menu");

    // Floating, viewport-fixed menu like ChatGPT
    kebabBtn.addEventListener("click", (e) => {
      e.stopPropagation();

      // close other open menus
      document.querySelectorAll(".kebab-menu.open").forEach(m => {
        m.classList.remove("open");
        m.style.display = "";
        m.style.visibility = "";
      });

      const openNow = !kebabMenu.classList.contains("open");
      if (!openNow) {
        kebabMenu.classList.remove("open");
        return;
      }

      kebabMenu.classList.add("open");
      kebabMenu.style.position = "fixed";
      kebabMenu.style.display = "block";
      kebabMenu.style.visibility = "hidden";

      const btnRect = kebabBtn.getBoundingClientRect();
      const menuRect = kebabMenu.getBoundingClientRect();
      const margin = 10;
      const top = Math.min(window.innerHeight - menuRect.height - margin, btnRect.bottom + 6);
      const left = Math.min(window.innerWidth - menuRect.width - margin, Math.max(margin, btnRect.right - menuRect.width));

      kebabMenu.style.top = top + "px";
      kebabMenu.style.left = left + "px";
      kebabMenu.style.visibility = "visible";

      const closeAll = (ev) => {
        if (!kebabMenu.contains(ev.target) && ev.target !== kebabBtn) {
          kebabMenu.classList.remove("open");
          kebabMenu.style.display = "";
          kebabMenu.style.visibility = "";
          document.removeEventListener("click", closeAll);
        }
      };
      // defer binding to avoid immediate close from this click
      setTimeout(() => document.addEventListener("click", closeAll), 0);

      // also close on resize/scroll (one-shot)
      const onEnd = () => {
        kebabMenu.classList.remove("open");
        kebabMenu.style.display = "";
        kebabMenu.style.visibility = "";
        window.removeEventListener("resize", onEnd);
        window.removeEventListener("scroll", onEnd, true);
      };
      window.addEventListener("resize", onEnd, { once: true });
      window.addEventListener("scroll", onEnd, { once: true, capture: true });
    });

    // simple outside close if user clicks elsewhere while menu is open
    document.addEventListener("click", (ev) => {
      if (!div.contains(ev.target)) {
        kebabMenu.classList.remove("open");
        kebabMenu.style.display = "";
        kebabMenu.style.visibility = "";
      }
    });

    historyList.appendChild(div);
  });
}
renderHistory();
`;
  const HISTORY_JS_PATH = path.join(PUBLIC_DIR, 'history.js');
  fs.writeFileSync(HISTORY_JS_PATH, HISTORY_UI_JS, 'utf-8');
  console.log(`🧩 History UI script written to ${HISTORY_JS_PATH}`);
} catch (e) {
  console.warn('⚠️ Failed to write history.js:', e?.message || e);
}

// ✅ Long timeouts for big uploads/slow nets
const server = app.listen(PORT, () => console.log(`Server running http://0.0.0.0:${PORT}`));

server.headersTimeout   = Number(process.env.SERVER_HEADERS_TIMEOUT_MS   || 30 * 60 * 1000);// 30 min
server.requestTimeout   = Number(process.env.SERVER_REQUEST_TIMEOUT_MS   || 10 * 60 * 60 * 1000);// 10 hr
server.keepAliveTimeout = Number(process.env.SERVER_KEEPALIVE_TIMEOUT_MS || 2 * 60 * 60 * 1000);// 2 hr


























