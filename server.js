// // server.js
// import 'dotenv/config';
// import fs from 'fs';
// import os from 'os';
// import path from 'path';
// import { fileURLToPath } from 'url';            // NEW for __dirname in ESM
// import { promisify } from 'util';
// import express from 'express';
// import cors from 'cors';
// import multer from 'multer';
// //OLD
// import ytdl from 'ytdl-core';
// // // NEW
// // import ytdl from '@distube/ytdl-core';
// import { GoogleGenerativeAI } from '@google/generative-ai';
// import mammoth from 'mammoth'; // NEW: DOCX -> text

// const unlink = promisify(fs.unlink);
// const writeFile = promisify(fs.writeFile);
// const readFile = promisify(fs.readFile);

// // Resolve __dirname for ESM
// const __filename = fileURLToPath(import.meta.url);
// const __dirname  = path.dirname(__filename);

// const app = express();

// // ✅ CORS hardened so any Chrome profile/device/origin works
// app.use(cors({ origin: true, credentials: true }));
// app.options('*', cors({ origin: true, credentials: true }));

// // ✅ Larger body limit to avoid aborted requests when client GS fallback sends big payloads
// app.use(express.json({ limit: '200mb' }));
// app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// // Serve frontend (static) from /public on the SAME PORT as the API
// const PUBLIC_DIR = path.join(__dirname, 'public');
// app.use(express.static(PUBLIC_DIR));

// // ---- Multer (in-memory) ----
// // (kept intact: memory storage + 1GB limit)
// const upload = multer({
//   storage: multer.memoryStorage(),
//   limits: { fileSize: 1024 * 1024 * 1024 } // up to ~1GB
// });

// const API_KEY = process.env.GOOGLE_API_KEY;
// const MODEL   = process.env.MODEL || 'gemini-2.5-pro';
// const PORT    = process.env.PORT || 3002;     // CHANGED default from 3001 to 3002

// const GS_JSON_PATH = process.env.GS_JSON_PATH || '';
// const GS_CSV_PATH  = process.env.GS_CSV_PATH  || '';
// const GS_DOCX_PATH = process.env.GS_DOCX_PATH || '';

// if (!API_KEY) {
//   console.error('❌ Missing GOOGLE_API_KEY in .env');
//   process.exit(1);
// }

// const genAI = new GoogleGenerativeAI(API_KEY);

// // ---- Helpers (kept) ----
// function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }
// const GS_CAP = { json: 180000, csv: 120000, kw: 120000 };

// // ---- Server-side GS cache (kept) ----
// let serverGS = { json: '', csv: '', kw: '' };

// async function fileExists(p) {
//   try { await fs.promises.access(p, fs.constants.R_OK); return true; }
//   catch { return false; }
// }

// async function loadDocxToText(filePath) {
//   const buf = await readFile(filePath);
//   const { value } = await mammoth.extractRawText({ buffer: buf });
//   return String(value || '').trim();
// }

// async function loadServerGS() {
//   const loaded = { json:false, csv:false, kw:false };
//   try {
//     if (GS_JSON_PATH && await fileExists(GS_JSON_PATH)) {
//       const txt = await readFile(GS_JSON_PATH, 'utf-8');
//       try { JSON.parse(txt); serverGS.json = clip(txt, GS_CAP.json); loaded.json = true; }
//       catch { console.warn('⚠️  DATASET.json is not valid JSON — skipping'); }
//     }
//     if (GS_CSV_PATH && await fileExists(GS_CSV_PATH)) {
//       const txt = await readFile(GS_CSV_PATH, 'utf-8');
//       serverGS.csv = clip(txt, GS_CAP.csv);
//       loaded.csv = true;
//     }
//     if (GS_DOCX_PATH && await fileExists(GS_DOCX_PATH)) {
//       const kw = await loadDocxToText(GS_DOCX_PATH);
//       serverGS.kw = clip(kw, GS_CAP.kw);
//       loaded.kw = true;
//     }
//   } catch (e) {
//     console.error('❌ Failed loading server GS:', e?.message || e);
//   }
//   const all = loaded.json && loaded.csv && loaded.kw;
//   console.log(`GS loaded: json=${loaded.json} csv=${loaded.csv} kw=${loaded.kw} (all=${all})`);
//   return loaded;
// }

// // Load GS at boot
// await loadServerGS();

// // ---- Build model message parts (unchanged core logic) ----
// function buildGSIngestParts(gsJsonStr, gsCsvStr, keywordsFullText) {
//   const parts = [];
//   parts.push({
//     text:
//       "TAKE THESE AS GOLD STANDARD TITLES AND THUMBNAILS ALONG WITH ALL THE VIRAL IMPORTANT KEYWORDS ATTACHED. THESE ARE THE TOP PERFORMING VIDEOS. KEEP THESE IN YOUR MEMORY."
//   });

//   const append = (label, raw, size = 24000) => {
//     parts.push({ text: `\n\n---\n${label}\n---\n` });
//     const s = String(raw || '');
//     for (let i = 0; i < s.length; i += size) parts.push({ text: s.slice(i, i + size) });
//   };

//   append("GOLD STANDARD: DATASET.json (RAW)", gsJsonStr || '');
//   append("GOLD STANDARD: Top10_Viral_Titles_Thumbnails_AllChannels.csv (RAW)", gsCsvStr || '');
//   append("GOLD STANDARD: Viral_Crime_Niche_Master_Keywords.docx (PLAIN TEXT)", keywordsFullText || '');
//   return parts;
// }

// function buildFinalInstructionParts({ videoSource, topic, titleHint, strategistPrompt, contextText }) {
//   const runContext = `
// VIDEO INPUT (authoritative; do not invent facts). Use the attached video fully:
// ${(contextText || "").trim()}

// Video Source: ${videoSource}
// Optional Topic: ${topic || "(none)"} | Optional Angle Hint: ${titleHint || "(none)"}

// MANDATORY:
// - Use ONLY the attached video + VIDEO INPUT + learned gold-standard patterns.
// - Do not assume/fabricate details not present.
// - Output CLEAN HTML only (no preface).
// - Start with "Video Summary & Core Angles" (video-specific), then 10 Title & Thumbnail Packages.
// `.trim();

//   return [
//     { text: String(strategistPrompt || '').trim() },
//     { text: runContext }
//   ];
// }

// // ---- Files API upload + ACTIVE polling (unchanged) ----
// async function waitForFileActive(fileId, { timeoutMs = 120000, initialDelay = 1200, maxDelay = 5000 } = {}) {
//   const started = Date.now();
//   let delay = initialDelay;
//   let lastState = 'UNKNOWN';
//   let lastUri = '';

//   while (Date.now() - started < timeoutMs) {
//     const metaResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileId}?key=${API_KEY}`);
//     if (!metaResp.ok) {
//       const txt = await metaResp.text().catch(()=> '');
//       throw new Error(`Files API GET failed (${metaResp.status}): ${txt}`);
//     }
//     const meta = await metaResp.json();
//     const state = meta?.state || meta?.fileState || 'UNKNOWN';
//     const uri = meta?.uri || meta?.file?.uri || '';

//     lastState = state;
//     lastUri = uri;

//     if (state === 'ACTIVE' && uri) return { uri, state };

//     await new Promise(r => setTimeout(r, delay));
//     delay = Math.min(maxDelay, Math.floor(delay * 1.6));
//   }

//   throw new Error(`File did not become ACTIVE in time (lastState=${lastState}, uri=${lastUri ? 'present' : 'missing'})`);
// }

// async function uploadBufferToFilesAPI(buffer, mimeType, displayName) {
//   const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${displayName}`);
//   await writeFile(tmpPath, buffer);

//   try {
//     const form = new FormData();
//     form.append('file', new Blob([buffer], { type: mimeType }), displayName);

//     const url = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${API_KEY}`;
//     const resp = await fetch(url, { method: 'POST', body: form });

//     if (!resp.ok) {
//       const txt = await resp.text().catch(() => '');
//       throw new Error(`Files API upload failed (${resp.status}): ${txt}`);
//     }

//     const data = await resp.json();
//     const fileId = data?.file?.name; // e.g. "files/abc123"
//     if (!fileId) throw new Error('Files API upload returned no file name');

//     const { uri } = await waitForFileActive(fileId);
//     return { fileUri: uri, fileId };
//   } finally {
//     try { await unlink(tmpPath); } catch {}
//   }
// }

// // ---- Health ----
// app.get('/health', (req, res) => res.send('ok'));

// // ---- GS status & reload (kept) ----
// app.get('/api/gs-status', (req, res) => {
//   res.json({
//     ok: true,
//     serverGS: {
//       json: !!serverGS.json,
//       csv:  !!serverGS.csv,
//       kw:   !!serverGS.kw,
//       all:  !!(serverGS.json && serverGS.csv && serverGS.kw)
//     },
//     paths: {
//       json: GS_JSON_PATH || null,
//       csv:  GS_CSV_PATH  || null,
//       kw:   GS_DOCX_PATH || null
//     }
//   });
// });

// app.post('/api/gs-reload', async (req, res) => {
//   const loaded = await loadServerGS();
//   res.json({ ok: true, loaded });
// });

// // ---- 1) Upload local MP4 -> Files API (kept) ----
// app.post('/api/upload-video', upload.single('video'), async (req, res) => {
//   try {
//     if (!req.file) return res.status(400).json({ ok: false, error: 'No video uploaded' });
//     const mime = req.file.mimetype || 'video/mp4';
//     const name = req.file.originalname || 'uploaded-video.mp4';
//     console.log(`⬆️  /api/upload-video  name=${name} mime=${mime} size=${req.file.size}`);

//     const { fileUri, fileId } = await uploadBufferToFilesAPI(req.file.buffer, mime, name);
//     console.log(`✅  Uploaded to Files API: ${fileId} (ACTIVE)`);

//     // Include both keys for compatibility with any frontend variant
//     res.json({ ok: true, fileUri, fileId, mimeType: mime, fileMime: mime, displayName: name });
//   } catch (err) {
//     console.error('Upload error:', err?.message || err);
//     res.status(500).json({ ok: false, error: err?.message || 'Upload failed' });
//   }
// });

// // ---- 2) Fetch YouTube -> download -> Files API (kept) ----
// app.post('/api/fetch-youtube', async (req, res) => {
//   try {
//     const { url } = req.body || {};
//     if (!url || !ytdl.validateURL(url)) return res.status(400).json({ ok: false, error: 'Invalid YouTube URL' });

//     console.log(`⬇️  /api/fetch-youtube  url=${url}`);
//     const info = await ytdl.getInfo(url);
//     const fmt = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: f => f.container === 'mp4' && f.hasAudio });
//     if (!fmt || !fmt.url) return res.status(500).json({ ok: false, error: 'Could not resolve downloadable MP4' });

//     const chunks = [];
//     await new Promise((resolve, reject) => {
//       ytdl.downloadFromInfo(info, { format: fmt })
//         .on('data', d => chunks.push(d))
//         .on('end', resolve)
//         .on('error', reject);
//     });
//     const buffer = Buffer.concat(chunks);
//     const titleSafe = (info.videoDetails?.title || 'youtube-video').replace(/[^\w.\-]+/g, '_') + '.mp4';

//     const { fileUri, fileId } = await uploadBufferToFilesAPI(buffer, 'video/mp4', titleSafe);
//     console.log(`✅  YouTube uploaded to Files API: ${fileId} (ACTIVE)`);

//     res.json({ ok: true, fileUri, fileId, mimeType: 'video/mp4', fileMime: 'video/mp4', displayName: titleSafe });
//   } catch (err) {
//     console.error('YouTube fetch error:', err?.message || err);
//     res.status(500).json({ ok: false, error: err?.message || 'YouTube fetch failed' });
//   }
// });


// //NEW

// // app.post('/api/fetch-youtube', async (req, res) => {
// //   try {
// //     let { url } = req.body || {};
// //     if (!url) return res.status(400).json({ ok: false, error: 'Missing YouTube URL' });

// //     // Normalize youtu.be and strip tracking params (?si=...)
// //     try {
// //       const id = ytdl.getURLVideoID(url);
// //       url = `https://www.youtube.com/watch?v=${id}`;
// //     } catch {
// //       return res.status(400).json({ ok: false, error: 'Invalid YouTube URL' });
// //     }

// //     console.log(`⬇️  /api/fetch-youtube  url=${url}`);

// //     const headers = {
// //       // Helps avoid throttling/cipher issues
// //       'user-agent':
// //         'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
// //       'accept-language': 'en-US,en;q=0.9',
// //     };

// //     // Get info with request headers
// //     const info = await ytdl.getInfo(url, { requestOptions: { headers } });

// //     // Prefer MP4 with audio+video
// //     let fmt =
// //       ytdl.chooseFormat(info.formats, {
// //         quality: 'highest',
// //         filter: (f) =>
// //           f.hasAudio &&
// //           f.hasVideo &&
// //           (f.container === 'mp4' || (f.mimeType || '').includes('mp4')),
// //       }) ||
// //       // Fallback: any container (often webm) with audio+video
// //       ytdl.chooseFormat(info.formats, {
// //         quality: 'highest',
// //         filter: (f) => f.hasAudio && f.hasVideo,
// //       });

// //     if (!fmt || !fmt.url) {
// //       return res
// //         .status(500)
// //         .json({ ok: false, error: 'Could not resolve a downloadable AV format' });
// //     }

// //     // Derive mime/container
// //     const mime =
// //       fmt.mimeType?.split(';')[0] ||
// //       (fmt.container === 'mp4' ? 'video/mp4' : 'video/webm');

// //     // Stream → Buffer
// //     const chunks = [];
// //     await new Promise((resolve, reject) => {
// //       ytdl
// //         .downloadFromInfo(info, { format: fmt, requestOptions: { headers } })
// //         .on('data', (d) => chunks.push(d))
// //         .on('end', resolve)
// //         .on('error', reject);
// //     });
// //     const buffer = Buffer.concat(chunks);

// //     // Safe filename
// //     const titleSafe =
// //       (info.videoDetails?.title || 'youtube-video').replace(/[^\w.\-]+/g, '_') +
// //       (mime === 'video/mp4' ? '.mp4' : '.webm');

// //     // Upload to Gemini Files API
// //     const { fileUri, fileId } = await uploadBufferToFilesAPI(buffer, mime, titleSafe);
// //     console.log(`✅  YouTube uploaded to Files API: ${fileId} (ACTIVE)`);

// //     res.json({
// //       ok: true,
// //       fileUri,
// //       fileId,
// //       mimeType: mime,
// //       fileMime: mime,
// //       displayName: titleSafe,
// //     });
// //   } catch (err) {
// //     console.error('YouTube fetch error:', err?.message || err);
// //     // Surface clearer messages
// //     const msg =
// //       /decipher|signature|extract functions/i.test(err?.message || '')
// //         ? 'YouTube changed decipher; retried with distube fork but failed'
// //         : err?.message || 'YouTube fetch failed';
// //     res.status(500).json({ ok: false, error: msg });
// //   }
// // });

// // ---- 3) Generate (two-turn; video attached) (kept) ----
// app.post('/api/generate', async (req, res) => {
//   try {
//     const {
//       fileUri, fileMime = 'video/mp4', videoSource = 'N/A',
//       strategistPrompt = '', topic = '', titleHint = '', contextText = '',
//       gsJson = '', gsCsv = '', gsKeywordsText = ''
//     } = req.body || {};

//     console.log('▶️  /api/generate', {
//       hasFileUri: !!fileUri,
//       mime: fileMime,
//       topic: clip(topic, 60),
//       hint: clip(titleHint, 60),
//       ctxLen: (contextText || '').length,
//       gs: { json: (gsJson || '').length, csv: (gsCsv || '').length, kw: (gsKeywordsText || '').length },
//       serverGS: { json: !!serverGS.json, csv: !!serverGS.csv, kw: !!serverGS.kw }
//     });

//     if (!fileUri)          return res.status(400).json({ ok: false, error: 'fileUri missing' });
//     if (!strategistPrompt) return res.status(400).json({ ok: false, error: 'strategistPrompt missing' });

//     // Prefer server GS; fallback to client-provided GS to preserve old behavior
//     const useJson = serverGS.json || clip(gsJson, 150000);
//     const useCsv  = serverGS.csv  || clip(gsCsv, 100000);
//     const useKw   = serverGS.kw   || clip(gsKeywordsText, 100000);

//     const model = genAI.getGenerativeModel({
//       model: MODEL,
//       systemInstruction: "Follow output format exactly; store gold-standard patterns internally; do not leak chain-of-thought."
//     });

//     const history = [
//       { role: 'user', parts: buildGSIngestParts(useJson, useCsv, useKw) },
//       {
//         role: 'user',
//         parts: [
//           { text: "\n\n---\nATTACHED VIDEO (analyze full visuals + audio)\n---\n" },
//           { fileData: { fileUri, mimeType: fileMime } }
//         ]
//       }
//     ];

//     const chat = model.startChat({
//       history,
//       generationConfig: {
//         temperature: 0.35,
//         topP: 0.9,
//         topK: 40,
//         candidateCount: 1,
//         maxOutputTokens: 8192,
//         responseMimeType: "text/plain"
//       }
//     });

//     // Acknowledge context (stability)
//     await chat.sendMessage([{ text: "Acknowledge gold standard + attached video in one short sentence." }]);

//     const parts = buildFinalInstructionParts({ videoSource, topic, titleHint, strategistPrompt, contextText });
//     const result = await chat.sendMessage(parts);

//     let html = "";
//     try { html = result?.response?.text?.() || ""; } catch (e) { console.error("result.response.text() failed:", e); }

//     const candidate = result?.response?.candidates?.[0];
//     const meta = {
//       finishReason: candidate?.finishReason,
//       safety: candidate?.safetyRatings,
//       usage: result?.response?.usageMetadata
//     };

//     if (!html.trim()) {
//       console.error("Empty HTML; full API response:", JSON.stringify(result, null, 2));
//       return res.status(502).json({
//         ok: false,
//         error: "Model returned empty response. See server logs for details.",
//         meta
//       });
//     }

//     console.log('✅  Generation OK');
//     return res.json({ ok: true, html, meta });
//   } catch (err) {
//     console.error("GENERATION ERROR:");
//     console.error(err?.stack || err?.message || String(err));
//     try { console.error("Raw error object:", JSON.stringify(err, null, 2)); } catch {}
//     return res.status(500).json({
//       ok: false,
//       error: err?.message || 'Generation failed (see server logs).'
//     });
//   }
// });

// // ✅ Longer timeouts help slow networks/big uploads avoid abrupt "Failed to fetch"
// const server = app.listen(PORT, () => console.log(`Server running http://0.0.0.0:${PORT}`));
// server.headersTimeout = 300000;   // 5 minutes
// server.requestTimeout = 300000;   // 5 minutes







//////////////////////////////////////////////////////



// // server.js
// import 'dotenv/config';
// import fs from 'fs';
// import os from 'os';
// import path from 'path';
// import { fileURLToPath } from 'url';
// import { promisify } from 'util';
// import express from 'express';
// import cors from 'cors';
// import multer from 'multer';

// // Video fetchers
// import ytdl from 'ytdl-core';
// import { execFile } from 'child_process';

// // Gemini SDK + docx
// import { GoogleGenerativeAI } from '@google/generative-ai';
// import mammoth from 'mammoth';

// // ✅ Undici for multipart upload (native File/Blob)
// import { FormData, File } from 'undici';

// const unlink = promisify(fs.unlink);
// const writeFile = promisify(fs.writeFile);
// const readFile  = promisify(fs.readFile);

// // __dirname for ESM
// const __filename = fileURLToPath(import.meta.url);
// const __dirname  = path.dirname(__filename);

// const app = express();

// // ✅ CORS hardened so any Chrome profile/device/origin works
// app.use(cors({ origin: true, credentials: true }));
// app.options('*', cors({ origin: true, credentials: true }));

// // ✅ Larger body limit to avoid aborted requests when client GS fallback sends big payloads
// app.use(express.json({ limit: '200mb' }));
// app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// // Serve frontend (static) from /public on the SAME PORT as the API
// const PUBLIC_DIR = path.join(__dirname, 'public');
// app.use(express.static(PUBLIC_DIR));

// /* =========================================================
//    Multer — DISK storage (NO big buffers in RAM)
//    Files are written straight to OS temp, then uploaded to
//    Gemini and deleted in a finally{} block.
//    ========================================================= */
// const upload = multer({
//   storage: multer.diskStorage({
//     destination: (req, file, cb) => cb(null, os.tmpdir()),
//     filename: (req, file, cb) =>
//       cb(null, `${Date.now()}-${(file.originalname || 'upload.mp4').replace(/[^\w.\-]+/g, '_')}`)
//   }),
//   limits: { fileSize: 1024 * 1024 * 1024 } // up to ~1GB
// });

// const API_KEY = process.env.GOOGLE_API_KEY;
// const MODEL   = process.env.MODEL || 'gemini-2.5-pro';
// const PORT    = process.env.PORT || 3002;     // default 3002

// const GS_JSON_PATH = process.env.GS_JSON_PATH || '';
// const GS_CSV_PATH  = process.env.GS_CSV_PATH  || '';
// const GS_DOCX_PATH = process.env.GS_DOCX_PATH || '';

// if (!API_KEY) {
//   console.error('❌ Missing GOOGLE_API_KEY in .env');
//   process.exit(1);
// }

// const genAI = new GoogleGenerativeAI(API_KEY);

// // ---- Helpers (kept) ----
// function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }
// const GS_CAP = { json: 180000, csv: 120000, kw: 120000 };

// // ---- Server-side GS cache (kept) ----
// let serverGS = { json: '', csv: '', kw: '' };

// async function fileExists(p) {
//   try { await fs.promises.access(p, fs.constants.R_OK); return true; }
//   catch { return false; }
// }

// async function loadDocxToText(filePath) {
//   const buf = await readFile(filePath);
//   const { value } = await mammoth.extractRawText({ buffer: buf });
//   return String(value || '').trim();
// }

// async function loadServerGS() {
//   const loaded = { json:false, csv:false, kw:false };
//   try {
//     if (GS_JSON_PATH && await fileExists(GS_JSON_PATH)) {
//       const txt = await readFile(GS_JSON_PATH, 'utf-8');
//       try { JSON.parse(txt); serverGS.json = clip(txt, GS_CAP.json); loaded.json = true; }
//       catch { console.warn('⚠️  DATASET.json is not valid JSON — skipping'); }
//     }
//     if (GS_CSV_PATH && await fileExists(GS_CSV_PATH)) {
//       const txt = await readFile(GS_CSV_PATH, 'utf-8');
//       serverGS.csv = clip(txt, GS_CAP.csv);
//       loaded.csv = true;
//     }
//     if (GS_DOCX_PATH && await fileExists(GS_DOCX_PATH)) {
//       const kw = await loadDocxToText(GS_DOCX_PATH);
//       serverGS.kw = clip(kw, GS_CAP.kw);
//       loaded.kw = true;
//     }
//   } catch (e) {
//     console.error('❌ Failed loading server GS:', e?.message || e);
//   }
//   const all = loaded.json && loaded.csv && loaded.kw;
//   console.log(`GS loaded: json=${loaded.json} csv=${loaded.csv} kw=${loaded.kw} (all=${all})`);
//   return loaded;
// }

// // Load GS at boot
// await loadServerGS();

// // ---- Build model message parts (unchanged core logic) ----
// function buildGSIngestParts(gsJsonStr, gsCsvStr, keywordsFullText) {
//   const parts = [];
//   parts.push({
//     text:
//       "TAKE THESE AS GOLD STANDARD TITLES AND THUMBNAILS ALONG WITH ALL THE VIRAL IMPORTANT KEYWORDS ATTACHED. THESE ARE THE TOP PERFORMING VIDEOS. KEEP THESE IN YOUR MEMORY."
//   });

//   const append = (label, raw, size = 24000) => {
//     parts.push({ text: `\n\n---\n${label}\n---\n` });
//     const s = String(raw || '');
//     for (let i = 0; i < s.length; i += size) parts.push({ text: s.slice(i, i + size) });
//   };

//   append("GOLD STANDARD: DATASET.json (RAW)", gsJsonStr || '');
//   append("GOLD STANDARD: Top10_Viral_Titles_Thumbnails_AllChannels.csv (RAW)", gsCsvStr || '');
//   append("GOLD STANDARD: Viral_Crime_Niche_Master_Keywords.docx (PLAIN TEXT)", keywordsFullText || '');
//   return parts;
// }

// function buildFinalInstructionParts({ videoSource, topic, titleHint, strategistPrompt, contextText }) {
//   const runContext = `
// VIDEO INPUT (authoritative; do not invent facts). Use the attached video fully:
// ${(contextText || "").trim()}

// Video Source: ${videoSource}
// Optional Topic: ${topic || "(none)"} | Optional Angle Hint: ${titleHint || "(none)"}

// MANDATORY:
// - Use ONLY the attached video + VIDEO INPUT + learned gold-standard patterns.
// - Do not assume/fabricate details not present.
// - Output CLEAN HTML only (no preface).
// - Start with "Video Summary & Core Angles" (video-specific), then 10 Title & Thumbnail Packages.
// `.trim();

//   return [
//     { text: String(strategistPrompt || '').trim() },
//     { text: runContext }
//   ];
// }

// // ---- Files API upload + ACTIVE polling (kept) ----
// async function waitForFileActive(fileId, { timeoutMs = 120000, initialDelay = 1200, maxDelay = 5000 } = {}) {
//   const started = Date.now();
//   let delay = initialDelay;
//   let lastState = 'UNKNOWN';
//   let lastUri = '';

//   while (Date.now() - started < timeoutMs) {
//     const metaResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileId}?key=${API_KEY}`);
//     if (!metaResp.ok) {
//       const txt = await metaResp.text().catch(()=> '');
//       throw new Error(`Files API GET failed (${metaResp.status}): ${txt}`);
//     }
//     const meta = await metaResp.json();
//     const state = meta?.state || meta?.fileState || 'UNKNOWN';
//     const uri = meta?.uri || meta?.file?.uri || '';

//     lastState = state;
//     lastUri = uri;

//     if (state === 'ACTIVE' && uri) return { uri, state };

//     await new Promise(r => setTimeout(r, delay));
//     delay = Math.min(maxDelay, Math.floor(delay * 1.6));
//   }

//   throw new Error(`File did not become ACTIVE in time (lastState=${lastState}, uri=${lastUri ? 'present' : 'missing'})`);
// }

// //OLD
// /* =========================================================
//    DISK uploader to Gemini Files API (no big buffers in RAM)
//    ========================================================= */
// // async function uploadPathToFilesAPI(filePath, mimeType, displayName) {
// //   const url = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${API_KEY}`;
// //   const form = new FormData();
// //   form.append('file', fs.createReadStream(filePath), { filename: displayName, contentType: mimeType });

// //   const resp = await fetch(url, { method: 'POST', body: form, headers: form.getHeaders() });
// //   if (!resp.ok) {
// //     const txt = await resp.text().catch(() => '');
// //     throw new Error(`Files API upload failed (${resp.status}): ${txt}`);
// //   }
// //   const data = await resp.json();
// //   const fileId = data?.file?.name; // e.g. "files/abc123"
// //   if (!fileId) throw new Error('Files API upload returned no file name');

// //   const { uri } = await waitForFileActive(fileId);
// //   return { fileUri: uri, fileId };
// // }

// //NEW

// // async function uploadPathToFilesAPI(filePath, mimeType, displayName) {
// //   const url = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${API_KEY}`;

// //   // Read once from disk (keeps your disk-first flow; buffer exists only during the POST)
// //   const buf = await fs.promises.readFile(filePath);

// //   const form = new FormData();
// //   // IMPORTANT: use File so the part has filename + content-type
// //   const file = new File([buf], displayName || path.basename(filePath), {
// //     type: mimeType || 'application/octet-stream'
// //   });
// //   form.append('file', file); // field name must be exactly 'file'

// //   const resp = await fetch(url, { method: 'POST', body: form }); // no manual headers
// //   if (!resp.ok) {
// //     const txt = await resp.text().catch(() => '');
// //     throw new Error(`Files API upload failed (${resp.status}): ${txt}`);
// //   }

// //   const data = await resp.json();
// //   const fileId = data?.file?.name; // "files/abc123"
// //   if (!fileId) throw new Error('Files API upload returned no file name');

// //   const { uri } = await waitForFileActive(fileId);
// //   return { fileUri: uri, fileId };
// // }

// async function uploadPathToFilesAPI(filePath, mimeType, displayName) {
//   const url = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${API_KEY}`;

//   // Read once from disk and wrap as a File (Fetch/Undici-compatible)
//   const buf = await fs.promises.readFile(filePath);
//   const file = new File([buf], displayName || path.basename(filePath), {
//     type: mimeType || 'application/octet-stream'
//   });

//   const form = new FormData();
//   form.append('file', file); // field name must be exactly 'file'

//   const resp = await fetch(url, { method: 'POST', body: form });
//   const text = await resp.text();
//   if (!resp.ok) throw new Error(`Files API upload failed (${resp.status}): ${text}`);

//   let data; try { data = JSON.parse(text); }
//   catch { throw new Error(`Files API returned non-JSON: ${text}`); }

//   const fileId = data?.file?.name;
//   if (!fileId) throw new Error(`Files API response missing file.name: ${JSON.stringify(data)}`);

//   const { uri } = await waitForFileActive(fileId);
//   return { fileUri: uri, fileId };
// }


// // ---- Health ----
// app.get('/health', (req, res) => res.send('ok'));

// // ---- GS status & reload (kept) ----
// app.get('/api/gs-status', (req, res) => {
//   res.json({
//     ok: true,
//     serverGS: {
//       json: !!serverGS.json,
//       csv:  !!serverGS.csv,
//       kw:   !!serverGS.kw,
//       all:  !!(serverGS.json && serverGS.csv && serverGS.kw)
//     },
//     paths: {
//       json: GS_JSON_PATH || null,
//       csv:  GS_CSV_PATH  || null,
//       kw:   GS_DOCX_PATH || null
//     }
//   });
// });

// app.post('/api/gs-reload', async (req, res) => {
//   const loaded = await loadServerGS();
//   res.json({ ok: true, loaded });
// });

// /* =========================================================
//    1) Upload local MP4 -> DISK temp -> Files API -> delete
//    ========================================================= */
// app.post('/api/upload-video', upload.single('video'), async (req, res) => {
//   const filePath = req?.file?.path;
//   const mime     = req?.file?.mimetype || 'video/mp4';
//   const name     = req?.file?.originalname || 'uploaded-video.mp4';

//   if (!filePath) return res.status(400).json({ ok: false, error: 'No video uploaded' });
//   console.log(`⬆️  /api/upload-video  path=${filePath} mime=${mime} size=${req.file.size}`);

//   try {
//     const { fileUri, fileId } = await uploadPathToFilesAPI(filePath, mime, name);
//     console.log(`✅  Uploaded to Files API: ${fileId} (ACTIVE)`);
//     res.json({ ok: true, fileUri, fileId, mimeType: mime, fileMime: mime, displayName: name });
//   } catch (err) {
//     console.error('Upload error:', err?.message || err);
//     res.status(500).json({ ok: false, error: err?.message || 'Upload failed' });
//   } finally {
//     // Always clean temp file
//     try { await unlink(filePath); } catch {}
//   }
// });

// /* =========================================================
//    2) Fetch YouTube -> write to DISK temp -> Files API -> delete
//       - ytdl-core fast path
//       - yt-dlp fallback (handles 403/decipher changes)
//    ========================================================= */

// // yt-dlp one-time download to ./bin
// const BIN_DIR    = path.join(__dirname, 'bin');
// const YTDLP_EXE  = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
// const YTDLP_PATH = path.join(BIN_DIR, YTDLP_EXE);

// async function ensureYtDlp() {
//   try { await fs.promises.access(YTDLP_PATH, fs.constants.X_OK); return YTDLP_PATH; } catch {}
//   await fs.promises.mkdir(BIN_DIR, { recursive: true });
//   const url = process.platform === 'win32'
//     ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
//     : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
//   console.log(`⬇️  Downloading yt-dlp from ${url}`);
//   const r = await fetch(url);
//   if (!r.ok) throw new Error(`yt-dlp download failed: ${r.status}`);
//   const buf = Buffer.from(await r.arrayBuffer());
//   await fs.promises.writeFile(YTDLP_PATH, buf, { mode: 0o755 });
//   console.log('✅  yt-dlp downloaded');
//   return YTDLP_PATH;
// }

// async function downloadWithYtDlpToPath(url) {
//   const ytdlp   = await ensureYtDlp();
//   const outPath = path.join(os.tmpdir(), `yt_${Date.now()}.mp4`);
//   const args = [
//     '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
//     '--merge-output-format', 'mp4',
//     '--no-playlist',
//     '--quiet', '--no-warnings',
//     '-o', outPath,
//     url
//   ];
//   console.log('▶️  yt-dlp', args.join(' '));
//   await new Promise((resolve, reject) => {
//     execFile(ytdlp, args, { windowsHide: true }, (err) => err ? reject(err) : resolve());
//   });

//   // friendly name
//   let displayName = `youtube-video-${Date.now()}.mp4`;
//   try {
//     await new Promise((resolve) => {
//       execFile(ytdlp, ['--get-title', '--no-playlist', url], { windowsHide: true }, (e, stdout) => {
//         const t = String(stdout || '').split('\n')[0].trim();
//         if (t) displayName = `${t}`.replace(/[^\w.\-]+/g, '_') + '.mp4';
//         resolve();
//       });
//     });
//   } catch {}
//   return { outPath, displayName, mime: 'video/mp4' };
// }

// app.post('/api/fetch-youtube', async (req, res) => {
//   try {
//     let { url } = req.body || {};
//     if (!url) return res.status(400).json({ ok: false, error: 'Missing YouTube URL' });

//     // Normalize youtu.be and strip tracking params
//     try {
//       const id = ytdl.getURLVideoID(url);
//       url = `https://www.youtube.com/watch?v=${id}`;
//     } catch {
//       return res.status(400).json({ ok: false, error: 'Invalid YouTube URL' });
//     }

//     console.log(`⬇️  /api/fetch-youtube  url=${url}`);

//     // Attempt 1: ytdl-core → DISK temp
//     try {
//       const headers = {
//         'user-agent':
//           'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
//         'accept-language': 'en-US,en;q=0.9',
//       };

//       const info = await ytdl.getInfo(url, { requestOptions: { headers } });

//       let fmt =
//         ytdl.chooseFormat(info.formats, {
//           quality: 'highest',
//           filter: (f) =>
//             f.hasAudio &&
//             f.hasVideo &&
//             (f.container === 'mp4' || (f.mimeType || '').includes('mp4')),
//         }) ||
//         ytdl.chooseFormat(info.formats, {
//           quality: 'highest',
//           filter: (f) => f.hasAudio && f.hasVideo,
//         });

//       if (!fmt || !fmt.url) throw new Error('No direct AV format URL');

//       const mime =
//         fmt.mimeType?.split(';')[0] ||
//         (fmt.container === 'mp4' ? 'video/mp4' : 'video/webm');

//       const safeTitle = (info.videoDetails?.title || 'youtube-video').replace(/[^\w.\-]+/g, '_');
//       const ext = mime === 'video/mp4' ? '.mp4' : '.webm';
//       const tempPath = path.join(os.tmpdir(), `${Date.now()}-${safeTitle}${ext}`);

//       // Stream to DISK
//       await new Promise((resolve, reject) => {
//         const r = ytdl.downloadFromInfo(info, { format: fmt, requestOptions: { headers } });
//         const w = fs.createWriteStream(tempPath);
//         r.pipe(w);
//         r.on('error', reject);
//         w.on('finish', resolve);
//         w.on('error', reject);
//       });

//       // Upload from DISK → Gemini
//       try {
//         const { fileUri, fileId } = await uploadPathToFilesAPI(tempPath, mime, path.basename(tempPath));
//         console.log(`✅  YouTube uploaded via ytdl-core: ${fileId} (ACTIVE)`);
//         return res.json({ ok: true, fileUri, fileId, mimeType: mime, fileMime: mime, displayName: path.basename(tempPath) });
//       } finally {
//         try { await unlink(tempPath); } catch {}
//       }
//     } catch (e1) {
//       console.warn('⚠️  ytdl-core fetch failed; falling back to yt-dlp:', e1?.message || e1);
//     }

//     // Attempt 2: yt-dlp → DISK temp → Gemini
//     const { outPath, displayName, mime } = await downloadWithYtDlpToPath(url);
//     try {
//       const { fileUri, fileId } = await uploadPathToFilesAPI(outPath, mime, displayName);
//       console.log(`✅  YouTube uploaded via yt-dlp: ${fileId} (ACTIVE)`);
//       return res.json({ ok: true, fileUri, fileId, mimeType: mime, fileMime: mime, displayName });
//     } finally {
//       try { await unlink(outPath); } catch {}
//     }
//   } catch (err) {
//     console.error('YouTube fetch error:', err?.message || err);
//     const msg =
//       /private|copyright|410|signin|age|forbidden|403/i.test(err?.message || '')
//         ? 'Video is restricted (private/age/region). Try another public URL.'
//         : err?.message || 'YouTube fetch failed';
//     res.status(500).json({ ok: false, error: msg });
//   }
// });

// /* =========================================================
//    3) Generate (two-turn; video attached) (kept)
//    ========================================================= */
// app.post('/api/generate', async (req, res) => {
//   try {
//     const {
//       fileUri, fileMime = 'video/mp4', videoSource = 'N/A',
//       strategistPrompt = '', topic = '', titleHint = '', contextText = '',
//       gsJson = '', gsCsv = '', gsKeywordsText = ''
//     } = req.body || {};

//     console.log('▶️  /api/generate', {
//       hasFileUri: !!fileUri,
//       mime: fileMime,
//       topic: clip(topic, 60),
//       hint: clip(titleHint, 60),
//       ctxLen: (contextText || '').length,
//       gs: { json: (gsJson || '').length, csv: (gsCsv || '').length, kw: (gsKeywordsText || '').length },
//       serverGS: { json: !!serverGS.json, csv: !!serverGS.csv, kw: !!serverGS.kw }
//     });

//     if (!fileUri)          return res.status(400).json({ ok: false, error: 'fileUri missing' });
//     if (!strategistPrompt) return res.status(400).json({ ok: false, error: 'strategistPrompt missing' });

//     // Prefer server GS; fallback to client-provided GS to preserve old behavior
//     const useJson = serverGS.json || clip(gsJson, 150000);
//     const useCsv  = serverGS.csv  || clip(gsCsv, 100000);
//     const useKw   = serverGS.kw   || clip(gsKeywordsText, 100000);

//     const model = genAI.getGenerativeModel({
//       model: MODEL,
//       systemInstruction: "Follow output format exactly; store gold-standard patterns internally; do not leak chain-of-thought."
//     });

//     const history = [
//       { role: 'user', parts: buildGSIngestParts(useJson, useCsv, useKw) },
//       {
//         role: 'user',
//         parts: [
//           { text: "\n\n---\nATTACHED VIDEO (analyze full visuals + audio)\n---\n" },
//           { fileData: { fileUri, mimeType: fileMime } }
//         ]
//       }
//     ];

//     const chat = model.startChat({
//       history,
//       generationConfig: {
//         temperature: 0.35,
//         topP: 0.9,
//         topK: 40,
//         candidateCount: 1,
//         maxOutputTokens: 8192,
//         responseMimeType: "text/plain"
//       }
//     });

//     // Acknowledge context (stability)
//     await chat.sendMessage([{ text: "Acknowledge gold standard + attached video in one short sentence." }]);

//     const parts = buildFinalInstructionParts({ videoSource, topic, titleHint, strategistPrompt, contextText });
//     const result = await chat.sendMessage(parts);

//     let html = "";
//     try { html = result?.response?.text?.() || ""; } catch (e) { console.error("result.response.text() failed:", e); }

//     const candidate = result?.response?.candidates?.[0];
//     const meta = {
//       finishReason: candidate?.finishReason,
//       safety: candidate?.safetyRatings,
//       usage: result?.response?.usageMetadata
//     };

//     if (!html.trim()) {
//       console.error("Empty HTML; full API response:", JSON.stringify(result, null, 2));
//       return res.status(502).json({
//         ok: false,
//         error: "Model returned empty response. See server logs for details.",
//         meta
//       });
//     }

//     console.log('✅  Generation OK');
//     return res.json({ ok: true, html, meta });
//   } catch (err) {
//     console.error("GENERATION ERROR:");
//     console.error(err?.stack || err?.message || String(err));
//     try { console.error("Raw error object:", JSON.stringify(err, null, 2)); } catch {}
//     return res.status(500).json({
//       ok: false,
//       error: err?.message || 'Generation failed (see server logs).'
//     });
//   }
// });

// // ✅ Longer timeouts help slow networks/big uploads avoid abrupt "Failed to fetch"
// const server = app.listen(PORT, () => console.log(`Server running http://0.0.0.0:${PORT}`));
// server.headersTimeout = 300000;   // 5 minutes
// server.requestTimeout = 300000;   // 5 minutes







///////////////////////////////////

//CURRENT WORKING VERSION WITH DIFFERENT FORMATTED OUTPUTS 

// // server.js
// import 'dotenv/config';
// import fs from 'fs';
// import os from 'os';
// import path from 'path';
// import { fileURLToPath } from 'url';
// import { promisify } from 'util';
// import express from 'express';
// import cors from 'cors';
// import multer from 'multer';

// // Video fetchers
// import ytdl from 'ytdl-core';
// import { execFile } from 'child_process';

// // Gemini SDK + docx
// import { GoogleGenerativeAI } from '@google/generative-ai';
// import mammoth from 'mammoth';

// // ✅ Undici for multipart upload (native File/Blob)
// import { FormData, File } from 'undici';

// // === NEW: history deps ===
// import zlib from 'zlib';
// import { randomUUID } from 'crypto';

// const unlink = promisify(fs.unlink);
// const writeFile = promisify(fs.writeFile);
// const readFile  = promisify(fs.readFile);

// // __dirname for ESM
// const __filename = fileURLToPath(import.meta.url);
// const __dirname  = path.dirname(__filename);

// const app = express();

// // ✅ CORS hardened so any Chrome profile/device/origin works
// app.use(cors({ origin: true, credentials: true }));
// app.options('*', cors({ origin: true, credentials: true }));

// // ✅ Larger body limit to avoid aborted requests when client GS fallback sends big payloads
// app.use(express.json({ limit: '200mb' }));
// app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// // Serve frontend (static) from /public on the SAME PORT as the API
// const PUBLIC_DIR = path.join(__dirname, 'public');
// app.use(express.static(PUBLIC_DIR));

// /* =========================================================
//    Multer — DISK storage (NO big buffers in RAM)
//    Files are written straight to OS temp, then uploaded to
//    Gemini and deleted in a finally{} block.
//    ========================================================= */
// const upload = multer({
//   storage: multer.diskStorage({
//     destination: (req, file, cb) => cb(null, os.tmpdir()),
//     filename: (req, file, cb) =>
//       cb(null, `${Date.now()}-${(file.originalname || 'upload.mp4').replace(/[^\w.\-]+/g, '_')}`)
//   }),
//   limits: { fileSize: 1024 * 1024 * 1024 } // up to ~1GB
// });

// const API_KEY = process.env.GOOGLE_API_KEY;
// const MODEL   = process.env.MODEL || 'gemini-2.5-pro';
// const PORT    = process.env.PORT || 3002;     // default 3002

// const GS_JSON_PATH = process.env.GS_JSON_PATH || '';
// const GS_CSV_PATH  = process.env.GS_CSV_PATH  || '';
// const GS_DOCX_PATH = process.env.GS_DOCX_PATH || '';

// // === NEW: configurable wait for Files API to become ACTIVE (default 5 min)
// const FILES_ACTIVE_TIMEOUT_MS = Number(process.env.FILES_ACTIVE_TIMEOUT_MS || 300000); // 5 minutes
// const FILES_INITIAL_DELAY_MS  = Number(process.env.FILES_INITIAL_DELAY_MS || 1200);
// const FILES_MAX_DELAY_MS      = Number(process.env.FILES_MAX_DELAY_MS || 5000);

// if (!API_KEY) {
//   console.error('❌ Missing GOOGLE_API_KEY in .env');
//   process.exit(1);
// }

// const genAI = new GoogleGenerativeAI(API_KEY);

// // ---- Helpers (kept) ----
// function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }
// const GS_CAP = { json: 180000, csv: 120000, kw: 120000 };

// // === NEW: nice title from a local filename
// function humanizeFileName(name) {
//   const base = String(name || '')
//     .replace(/[/\\]+/g, ' ')
//     .replace(/\.[a-z0-9]+$/i, ''); // drop extension

//   const spaced = base.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();

//   const stripped = spaced
//     .replace(/\b(vid|mov|img|pxl|dji|gopr|frame|clip)\b/gi, '')
//     .replace(/\b(20\d{2}[-_.]?\d{2}[-_.]?\d{2}|\d{8}_\d{6})\b/g, '')
//     .replace(/\s{2,}/g, ' ')
//     .trim();

//   const titled = stripped.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
//   return (titled || 'Local Video').slice(0, 80);
// }

// // ---- Server-side GS cache (kept) ----
// let serverGS = { json: '', csv: '', kw: '' };

// async function fileExists(p) {
//   try { await fs.promises.access(p, fs.constants.R_OK); return true; }
//   catch { return false; }
// }

// async function loadDocxToText(filePath) {
//   const buf = await readFile(filePath);
//   const { value } = await mammoth.extractRawText({ buffer: buf });
//   return String(value || '').trim();
// }

// async function loadServerGS() {
//   const loaded = { json:false, csv:false, kw:false };
//   try {
//     if (GS_JSON_PATH && await fileExists(GS_JSON_PATH)) {
//       const txt = await readFile(GS_JSON_PATH, 'utf-8');
//       try { JSON.parse(txt); serverGS.json = clip(txt, GS_CAP.json); loaded.json = true; }
//       catch { console.warn('⚠️  DATASET.json is not valid JSON — skipping'); }
//     }
//     if (GS_CSV_PATH && await fileExists(GS_CSV_PATH)) {
//       const txt = await readFile(GS_CSV_PATH, 'utf-8');
//       serverGS.csv = clip(txt, GS_CAP.csv);
//       loaded.csv = true;
//     }
//     if (GS_DOCX_PATH && await fileExists(GS_DOCX_PATH)) {
//       const kw = await loadDocxToText(GS_DOCX_PATH);
//       serverGS.kw = clip(kw, GS_CAP.kw);
//       loaded.kw = true;
//     }
//   } catch (e) {
//     console.error('❌ Failed loading server GS:', e?.message || e);
//   }
//   const all = loaded.json && loaded.csv && loaded.kw;
//   console.log(`GS loaded: json=${loaded.json} csv=${loaded.csv} kw=${loaded.kw} (all=${all})`);
//   return loaded;
// }

// // Load GS at boot
// await loadServerGS();

// // ---- Build model message parts (unchanged core logic) ----
// function buildGSIngestParts(gsJsonStr, gsCsvStr, keywordsFullText) {
//   const parts = [];
//   parts.push({
//     text:
//       "TAKE THESE AS GOLD STANDARD TITLES AND THUMBNAILS ALONG WITH ALL THE VIRAL IMPORTANT KEYWORDS ATTACHED. THESE ARE THE TOP PERFORMING VIDEOS. KEEP THESE IN YOUR MEMORY."
//   });

//   const append = (label, raw, size = 24000) => {
//     parts.push({ text: `\n\n---\n${label}\n---\n` });
//     const s = String(raw || '');
//     for (let i = 0; i < s.length; i += size) parts.push({ text: s.slice(i, i + size) });
//   };

//   append("GOLD STANDARD: DATASET.json (RAW)", gsJsonStr || '');
//   append("GOLD STANDARD: Top10_Viral_Titles_Thumbnails_AllChannels.csv (RAW)", gsCsvStr || '');
//   append("GOLD STANDARD: Viral_Crime_Niche_Master_Keywords.docx (PLAIN TEXT)", keywordsFullText || '');
//   return parts;
// }

// function buildFinalInstructionParts({ videoSource, topic, titleHint, strategistPrompt, contextText }) {
//   const runContext = `
// VIDEO INPUT (authoritative; do not invent facts). Use the attached video fully:
// ${(contextText || "").trim()}

// Video Source: ${videoSource}
// Optional Topic: ${topic || "(none)"} | Optional Angle Hint: ${titleHint || "(none)"}

// MANDATORY:
// - Use ONLY the attached video + VIDEO INPUT + learned gold-standard patterns.
// - Do not assume/fabricate details not present.
// - Output CLEAN HTML only (no preface).
// - Start with "Video Summary & Core Angles" (video-specific), then 10 Title & Thumbnail Packages.
// `.trim();

//   return [
//     { text: String(strategistPrompt || '').trim() },
//     { text: runContext }
//   ];
// }

// // ---- Files API upload + ACTIVE polling (UPDATED timeout/backoff & logs) ----
// async function waitForFileActive(
//   fileId,
//   {
//     timeoutMs = FILES_ACTIVE_TIMEOUT_MS,
//     initialDelay = FILES_INITIAL_DELAY_MS,
//     maxDelay = FILES_MAX_DELAY_MS
//   } = {}
// ) {
//   const started = Date.now();
//   let delay = initialDelay;
//   let lastState = 'UNKNOWN';
//   let lastUri = '';

//   let checks = 0;
//   while (Date.now() - started < timeoutMs) {
//     checks++;
//     const metaResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileId}?key=${API_KEY}`);
//     if (!metaResp.ok) {
//       const txt = await metaResp.text().catch(()=> '');
//       throw new Error(`Files API GET failed (${metaResp.status}): ${txt}`);
//     }
//     const meta = await metaResp.json();
//     const state = meta?.state || meta?.fileState || 'UNKNOWN';
//     const uri = meta?.uri || meta?.file?.uri || '';

//     lastState = state;
//     lastUri = uri;

//     if (state === 'ACTIVE' && uri) {
//       console.log(`📦 Files API: ${fileId} ACTIVE after ${checks} checks (${Math.round((Date.now()-started)/1000)}s)`);
//       return { uri, state };
//     }

//     // log occasionally to see progress
//     if (checks === 1 || checks % 5 === 0) {
//       console.log(`⌛ Files API: ${fileId} state=${state} (waiting ${delay}ms)`);
//     }

//     await new Promise(r => setTimeout(r, delay));
//     delay = Math.min(maxDelay, Math.floor(delay * 1.6));
//   }

//   throw new Error(`File did not become ACTIVE in time (lastState=${lastState}, uri=${lastUri ? 'present' : 'missing'})`);
// }

// async function uploadPathToFilesAPI(filePath, mimeType, displayName) {
//   const url = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${API_KEY}`;

//   // Read once from disk and wrap as a File (Fetch/Undici-compatible)
//   const buf = await fs.promises.readFile(filePath);
//   const file = new File([buf], displayName || path.basename(filePath), {
//     type: mimeType || 'application/octet-stream'
//   });

//   const form = new FormData();
//   form.append('file', file); // field name must be exactly 'file'

//   const resp = await fetch(url, { method: 'POST', body: form });
//   const text = await resp.text();
//   if (!resp.ok) throw new Error(`Files API upload failed (${resp.status}): ${text}`);

//   let data; try { data = JSON.parse(text); }
//   catch { throw new Error(`Files API returned non-JSON: ${text}`); }

//   const fileId = data?.file?.name;
//   if (!fileId) throw new Error(`Files API response missing file.name: ${JSON.stringify(data)}`);

//   const { uri } = await waitForFileActive(fileId);
//   return { fileUri: uri, fileId };
// }


// // ---- Health ----
// app.get('/health', (req, res) => res.send('ok'));

// // ---- GS status & reload (kept) ----
// app.get('/api/gs-status', (req, res) => {
//   res.json({
//     ok: true,
//     serverGS: {
//       json: !!serverGS.json,
//       csv:  !!serverGS.csv,
//       kw:   !!serverGS.kw,
//       all:  !!(serverGS.json && serverGS.csv && serverGS.kw)
//     },
//     paths: {
//       json: GS_JSON_PATH || null,
//       csv:  GS_CSV_PATH  || null,
//       kw:   GS_DOCX_PATH || null
//     }
//   });
// });

// app.post('/api/gs-reload', async (req, res) => {
//   const loaded = await loadServerGS();
//   res.json({ ok: true, loaded });
// });

// /* =========================================================
//    1) Upload local MP4 -> DISK temp -> Files API -> delete
//    ========================================================= */
// app.post('/api/upload-video', upload.single('video'), async (req, res) => {
//   const filePath = req?.file?.path;
//   const mime     = req?.file?.mimetype || 'video/mp4';
//   const name     = req?.file?.originalname || 'uploaded-video.mp4';

//   if (!filePath) return res.status(400).json({ ok: false, error: 'No video uploaded' });
//   console.log(`⬆️  /api/upload-video  path=${filePath} mime=${mime} size=${req.file.size}`);

//   try {
//     const { fileUri, fileId } = await uploadPathToFilesAPI(filePath, mime, name);
//     console.log(`✅  Uploaded to Files API: ${fileId} (ACTIVE)`);
//     res.json({ ok: true, fileUri, fileId, mimeType: mime, fileMime: mime, displayName: name });
//   } catch (err) {
//     console.error('Upload error:', err?.message || err);
//     res.status(500).json({ ok: false, error: err?.message || 'Upload failed' });
//   } finally {
//     // Always clean temp file
//     try { await unlink(filePath); } catch {}
//   }
// });

// /* =========================================================
//    2) Fetch YouTube -> write to DISK temp -> Files API -> delete
//       - ytdl-core fast path
//       - yt-dlp fallback (handles 403/decipher changes)
//    ========================================================= */

// // yt-dlp one-time download to ./bin
// const BIN_DIR    = path.join(__dirname, 'bin');
// const YTDLP_EXE  = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
// const YTDLP_PATH = path.join(BIN_DIR, YTDLP_EXE);

// async function ensureYtDlp() {
//   try { await fs.promises.access(YTDLP_PATH, fs.constants.X_OK); return YTDLP_PATH; } catch {}
//   await fs.promises.mkdir(BIN_DIR, { recursive: true });
//   const url = process.platform === 'win32'
//     ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
//     : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
//   console.log(`⬇️  Downloading yt-dlp from ${url}`);
//   const r = await fetch(url);
//   if (!r.ok) throw new Error(`yt-dlp download failed: ${r.status}`);
//   const buf = Buffer.from(await r.arrayBuffer());
//   await fs.promises.writeFile(YTDLP_PATH, buf, { mode: 0o755 });
//   console.log('✅  yt-dlp downloaded');
//   return YTDLP_PATH;
// }

// async function downloadWithYtDlpToPath(url) {
//   const ytdlp   = await ensureYtDlp();
//   const outPath = path.join(os.tmpdir(), `yt_${Date.now()}.mp4`);
//   const args = [
//     '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
//     '--merge-output-format', 'mp4',
//     '--no-playlist',
//     '--quiet', '--no-warnings',
//     '-o', outPath,
//     url
//   ];
//   console.log('▶️  yt-dlp', args.join(' '));
//   await new Promise((resolve, reject) => {
//     execFile(ytdlp, args, { windowsHide: true }, (err) => err ? reject(err) : resolve());
//   });

//   // friendly name
//   let displayName = `youtube-video-${Date.now()}.mp4`;
//   try {
//     await new Promise((resolve) => {
//       execFile(ytdlp, ['--get-title', '--no-playlist', url], { windowsHide: true }, (e, stdout) => {
//         const t = String(stdout || '').split('\n')[0].trim();
//         if (t) displayName = `${t}`.replace(/[^\w.\-]+/g, '_') + '.mp4';
//         resolve();
//       });
//     });
//   } catch {}
//   return { outPath, displayName, mime: 'video/mp4' };
// }

// app.post('/api/fetch-youtube', async (req, res) => {
//   try {
//     let { url } = req.body || {};
//     if (!url) return res.status(400).json({ ok: false, error: 'Missing YouTube URL' });

//     // Normalize youtu.be and strip tracking params
//     try {
//       const id = ytdl.getURLVideoID(url);
//       url = `https://www.youtube.com/watch?v=${id}`;
//     } catch {
//       return res.status(400).json({ ok: false, error: 'Invalid YouTube URL' });
//     }

//     console.log(`⬇️  /api/fetch-youtube  url=${url}`);

//     // Attempt 1: ytdl-core → DISK temp
//     try {
//       const headers = {
//         'user-agent':
//           'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
//         'accept-language': 'en-US,en;q=0.9',
//       };

//       const info = await ytdl.getInfo(url, { requestOptions: { headers } });

//       let fmt =
//         ytdl.chooseFormat(info.formats, {
//           quality: 'highest',
//           filter: (f) =>
//             f.hasAudio &&
//             f.hasVideo &&
//             (f.container === 'mp4' || (f.mimeType || '').includes('mp4')),
//         }) ||
//         ytdl.chooseFormat(info.formats, {
//           quality: 'highest',
//           filter: (f) => f.hasAudio && f.hasVideo,
//         });

//       if (!fmt || !fmt.url) throw new Error('No direct AV format URL');

//       const mime =
//         fmt.mimeType?.split(';')[0] ||
//         (fmt.container === 'mp4' ? 'video/mp4' : 'video/webm');

//       const safeTitle = (info.videoDetails?.title || 'youtube-video').replace(/[^\w.\-]+/g, '_');
//       const ext = mime === 'video/mp4' ? '.mp4' : '.webm';
//       const tempPath = path.join(os.tmpdir(), `${Date.now()}-${safeTitle}${ext}`);

//       // Stream to DISK
//       await new Promise((resolve, reject) => {
//         const r = ytdl.downloadFromInfo(info, { format: fmt, requestOptions: { headers } });
//         const w = fs.createWriteStream(tempPath);
//         r.pipe(w);
//         r.on('error', reject);
//         w.on('finish', resolve);
//         w.on('error', reject);
//       });

//       // Upload from DISK → Gemini
//       try {
//         const { fileUri, fileId } = await uploadPathToFilesAPI(tempPath, mime, path.basename(tempPath));
//         console.log(`✅  YouTube uploaded via ytdl-core: ${fileId} (ACTIVE)`);
//         return res.json({ ok: true, fileUri, fileId, mimeType: mime, fileMime: mime, displayName: path.basename(tempPath) });
//       } finally {
//         try { await unlink(tempPath); } catch {}
//       }
//     } catch (e1) {
//       console.warn('⚠️  ytdl-core fetch failed; falling back to yt-dlp:', e1?.message || e1);
//     }

//     // Attempt 2: yt-dlp → DISK temp → Gemini
//     const { outPath, displayName, mime } = await downloadWithYtDlpToPath(url);
//     try {
//       const { fileUri, fileId } = await uploadPathToFilesAPI(outPath, mime, displayName);
//       console.log(`✅  YouTube uploaded via yt-dlp: ${fileId} (ACTIVE)`);
//       return res.json({ ok: true, fileUri, fileId, mimeType: mime, fileMime: mime, displayName });
//     } finally {
//       try { await unlink(outPath); } catch {}
//     }
//   } catch (err) {
//     console.error('YouTube fetch error:', err?.message || err);
//     const msg =
//       /private|copyright|410|signin|age|forbidden|403/i.test(err?.message || '')
//         ? 'Video is restricted (private/age/region). Try another public URL.'
//         : err?.message || 'YouTube fetch failed';
//     res.status(500).json({ ok: false, error: msg });
//   }
// });

// /* ===============================
//    HistoryStore (20 GB filesystem)
//    =============================== */
// const DATA_DIR  = path.join(__dirname, 'data');
// const HIST_DIR  = process.env.HIST_DIR || path.join(DATA_DIR, 'history');
// const INDEX_PATH = path.join(HIST_DIR, 'index.json');
// const HISTORY_LIMIT_BYTES = BigInt(process.env.HISTORY_LIMIT_BYTES || 20 * 1024 * 1024 * 1024); // 20 GB

// fs.mkdirSync(HIST_DIR, { recursive: true });

// class HistoryStore {
//   constructor(dir, indexPath, limitBytes) {
//     this.dir = dir;
//     this.indexPath = indexPath;
//     this.limit = BigInt(limitBytes);
//     this._ensureIndex();
//   }
//   _ensureIndex() {
//     if (!fs.existsSync(this.indexPath)) {
//       fs.writeFileSync(this.indexPath, JSON.stringify({ items: [] }), 'utf-8');
//     }
//   }
//   _readIndex() {
//     try {
//       return JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')) || { items: [] };
//     } catch { return { items: [] }; }
//   }
//   _writeIndex(idx) {
//     fs.writeFileSync(this.indexPath, JSON.stringify(idx), 'utf-8');
//   }
//   _usage(idx) {
//     return idx.items.reduce((a, b) => a + BigInt(b.size_bytes || 0), 0n);
//   }
//   stats() {
//     const idx = this._readIndex();
//     const used = this._usage(idx);
//     return {
//       limit: Number(this.limit),
//       used : Number(used),
//       remaining: Number(used > this.limit ? 0n : (this.limit - used)),
//       count: idx.items.length
//     };
//   }
//   search({ q = '', page = 1, limit = 50 }) {
//     const idx = this._readIndex();
//     const norm = q.trim().toLowerCase();
//     let items = idx.items;
//     if (norm) {
//       items = items.filter(x =>
//         String(x.title||'').toLowerCase().includes(norm) ||
//         String(x.preview||'').toLowerCase().includes(norm)
//       );
//     }
//     items.sort((a,b)=> b.created_at - a.created_at);
//     const offset = (page - 1) * limit;
//     const slice = items.slice(offset, offset + limit)
//       .map(({ id, title, created_at, size_bytes, preview }) => ({ id, title, created_at, size_bytes, preview }));
//     return { items: slice, total: items.length, page, limit };
//   }
//   async get(id) {
//     const idx = this._readIndex();
//     const it = idx.items.find(x => x.id === id);
//     if (!it) return null;
//     const raw = await fs.promises.readFile(it.file_path);
//     const buf = zlib.gunzipSync(raw);
//     const data = JSON.parse(buf.toString('utf-8'));
//     return { meta: it, data };
//   }
//   async delete(id) {
//     const idx = this._readIndex();
//     const i = idx.items.findIndex(x => x.id === id);
//     if (i === -1) return false;
//     try { if (fs.existsSync(idx.items[i].file_path)) await fs.promises.unlink(idx.items[i].file_path); } catch {}
//     idx.items.splice(i, 1);
//     this._writeIndex(idx);
//     return true;
//   }
//   async purgeOldestUntilFree(bytesNeeded) {
//     const needed = BigInt(bytesNeeded || 0);
//     const idx = this._readIndex();
//     idx.items.sort((a,b)=> a.created_at - b.created_at);
//     let used = this._usage(idx);
//     const evicted = [];
//     let p = 0;
//     while (used + needed > this.limit && p < idx.items.length) {
//       const it = idx.items[p++];
//       try { if (fs.existsSync(it.file_path)) fs.unlinkSync(it.file_path); } catch {}
//       evicted.push(it.id);
//       used -= BigInt(it.size_bytes || 0);
//     }
//     idx.items = idx.items.filter(x => !evicted.includes(x.id));
//     this._writeIndex(idx);
//     return { evicted, used: Number(used), limit: Number(this.limit) };
//   }
//   _gzip(obj) { return zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf-8'), { level: 9 }); }
//   _previewFromHTML(html) {
//     const text = String(html||'').replace(/<script[\s\S]*?<\/script>/gi,'')
//       .replace(/<style[\s\S]*?<\/style>/gi,'')
//       .replace(/<[^>]+>/g,' ')
//       .replace(/\s+/g,' ')
//       .trim();
//     return text.length > 180 ? text.slice(0,180) + '…' : text;
//   }
//   save({ title, html, extraMeta }) {
//     const idx = this._readIndex();
//     const used = this._usage(idx);
//     const gz = this._gzip({ html, meta: extraMeta || null, ts: Date.now() });
//     const newSize = BigInt(gz.byteLength);
//     if (used + newSize > this.limit) {
//       const needed = Number((used + newSize) - this.limit);
//       return { error: 'STORAGE_LIMIT_EXCEEDED', needed, used: Number(used), limit: Number(this.limit) };
//     }
//     const id = randomUUID();
//     const file_path = path.join(this.dir, `${id}.json.gz`);
//     fs.writeFileSync(file_path, gz);
//     const entry = {
//       id,
//       title: String(title || 'Generated Package').slice(0, 200),
//       created_at: Date.now(),
//       size_bytes: Number(newSize),
//       file_path,
//       preview: this._previewFromHTML(html)
//     };
//     idx.items.push(entry);
//     this._writeIndex(idx);
//     return { id, size_bytes: Number(newSize) };
//   }
// }

// const historyStore = new HistoryStore(HIST_DIR, INDEX_PATH, HISTORY_LIMIT_BYTES);

// /* ======================
//    History HTTP Endpoints
//    ====================== */

// // Stats
// app.get('/api/history-stats', (req, res) => res.json(historyStore.stats()));

// // List/search
// app.get('/api/history', (req, res) => {
//   const q = String(req.query.q || '');
//   const page = Math.max(parseInt(req.query.page || '1', 10), 1);
//   const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
//   res.json(historyStore.search({ q, page, limit }));
// });

// // Read one
// app.get('/api/history/:id', async (req, res) => {
//   const item = await historyStore.get(req.params.id);
//   if (!item) return res.status(404).json({ error: 'Not found' });
//   res.json(item);
// });

// // Delete one
// app.delete('/api/history/:id', async (req, res) => {
//   const ok = await historyStore.delete(req.params.id);
//   if (!ok) return res.status(404).json({ error: 'Not found' });
//   res.json({ ok: true });
// });

// // Purge (oldest)
// app.post('/api/history/purge', async (req, res) => {
//   const mode = String(req.query.mode || 'oldest');
//   if (mode !== 'oldest') return res.status(400).json({ error: 'Unsupported mode' });
//   const bytes = Number(req.query.bytes || req.body?.bytes || 0);
//   const result = await historyStore.purgeOldestUntilFree(bytes);
//   res.json(result);
// });

// /* =========================================================
//    3) Generate (two-turn; video attached) (kept, now saves history)
//    ========================================================= */
// app.post('/api/generate', async (req, res) => {
//   try {
//     const {
//       fileUri, fileMime = 'video/mp4', videoSource = 'N/A', displayName,
//       strategistPrompt = '', topic = '', titleHint = '', contextText = '',
//       gsJson = '', gsCsv = '', gsKeywordsText = ''
//     } = req.body || {};

//     console.log('▶️  /api/generate', {
//       hasFileUri: !!fileUri,
//       mime: fileMime,
//       topic: clip(topic, 60),
//       hint: clip(titleHint, 60),
//       ctxLen: (contextText || '').length,
//       gs: { json: (gsJson || '').length, csv: (gsCsv || '').length, kw: (gsKeywordsText || '').length },
//       serverGS: { json: !!serverGS.json, csv: !!serverGS.csv, kw: !!serverGS.kw }
//     });

//     if (!fileUri)          return res.status(400).json({ ok: false, error: 'fileUri missing' });
//     if (!strategistPrompt) return res.status(400).json({ ok: false, error: 'strategistPrompt missing' });

//     // Prefer server GS; fallback to client-provided GS to preserve old behavior
//     const useJson = serverGS.json || clip(gsJson, 150000);
//     const useCsv  = serverGS.csv  || clip(gsCsv, 100000);
//     const useKw   = serverGS.kw   || clip(gsKeywordsText, 100000);

//     const model = genAI.getGenerativeModel({
//       model: MODEL,
//       systemInstruction: "Follow output format exactly; store gold-standard patterns internally; do not leak chain-of-thought."
//     });

//     const history = [
//       { role: 'user', parts: buildGSIngestParts(useJson, useCsv, useKw) },
//       {
//         role: 'user',
//         parts: [
//           { text: "\n\n---\nATTACHED VIDEO (analyze full visuals + audio)\n---\n" },
//           { fileData: { fileUri, mimeType: fileMime } }
//         ]
//       }
//     ];

//     const chat = model.startChat({
//       history,
//       generationConfig: {
//         temperature: 0.35,
//         topP: 0.9,
//         topK: 40,
//         candidateCount: 1,
//         maxOutputTokens: 8192,
//         responseMimeType: "text/plain" // ✅ allowed; still returns HTML-as-text per prompt
//       }
//     });

//     // Acknowledge context (stability)
//     await chat.sendMessage([{ text: "Acknowledge gold standard + attached video in one short sentence." }]);

//     const parts = buildFinalInstructionParts({ videoSource, topic, titleHint, strategistPrompt, contextText });
//     const result = await chat.sendMessage(parts);

//     let html = "";
//     try { html = result?.response?.text?.() || ""; } catch (e) { console.error("result.response.text() failed:", e); }

//     const candidate = result?.response?.candidates?.[0];
//     const meta = {
//       finishReason: candidate?.finishReason,
//       safety: candidate?.safetyRatings,
//       usage: result?.response?.usageMetadata
//     };

//     if (!html.trim()) {
//       console.error("Empty HTML; full API response:", JSON.stringify(result, null, 2));
//       return res.status(502).json({
//         ok: false,
//         error: "Model returned empty response. See server logs for details.",
//         meta
//       });
//     }

//     console.log('✅  Generation OK');

//     // === UPDATED: smarter title for history (topic → hint → local filename → first heading → fallback)
//     let title =
//       (topic && topic.trim()) ||
//       (titleHint && titleHint.trim()) ||
//       (displayName && humanizeFileName(displayName)) ||
//       'Generated Package';

//     if (title === 'Generated Package') {
//       const h = html.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/i) || html.match(/^\s*#+\s*([^\n]+)/m);
//       if (h && h[1]) title = h[1].trim().slice(0, 80);
//     }

//     // Save to history
//     const saved = historyStore.save({
//       title,
//       html,
//       extraMeta: {
//         meta,
//         input: { videoSource, topic, titleHint, contextText, displayName }
//       }
//     });

//     // collect stats and optional save info
//     let historyPayload = null;
//     let storage = historyStore.stats();
//     if (saved?.error === 'STORAGE_LIMIT_EXCEEDED') {
//       historyPayload = { saved: false, reason: 'STORAGE_LIMIT_EXCEEDED', needed: saved.needed };
//     } else if (saved?.id) {
//       historyPayload = { saved: true, id: saved.id, size_bytes: saved.size_bytes };
//     }

//     return res.json({ ok: true, html, meta, history: historyPayload, storage });
//   } catch (err) {
//     console.error("GENERATION ERROR:");
//     console.error(err?.stack || err?.message || String(err));
//     try { console.error("Raw error object:", JSON.stringify(err, null, 2)); } catch {}
//     return res.status(500).json({
//       ok: false,
//       error: err?.message || 'Generation failed (see server logs).'
//     });
//   }
// });

// // ✅ Longer timeouts help slow networks/big uploads avoid abrupt "Failed to fetch"
// const server = app.listen(PORT, () => console.log(`Server running http://0.0.0.0:${PORT}`));
// server.headersTimeout = 300000;   // 5 minutes
// server.requestTimeout = 300000;   // 5 minutes






///////////////////////////



///BLACK AND WHITE FORMAT


// // server.js
// import 'dotenv/config';
// import fs from 'fs';
// import os from 'os';
// import path from 'path';
// import { fileURLToPath } from 'url';
// import { promisify } from 'util';
// import express from 'express';
// import cors from 'cors';
// import multer from 'multer';

// // Video fetchers
// import ytdl from 'ytdl-core';
// import { execFile } from 'child_process';

// // Gemini SDK + docx
// import { GoogleGenerativeAI } from '@google/generative-ai';
// import mammoth from 'mammoth';

// // ✅ Undici for multipart upload (native File/Blob)
// import { FormData, File } from 'undici';

// // === NEW: history deps ===
// import zlib from 'zlib';
// import { randomUUID } from 'crypto';

// const unlink = promisify(fs.unlink);
// const writeFile = promisify(fs.writeFile);
// const readFile  = promisify(fs.readFile);

// // __dirname for ESM
// const __filename = fileURLToPath(import.meta.url);
// const __dirname  = path.dirname(__filename);

// const app = express();

// // ✅ CORS hardened so any Chrome profile/device/origin works
// app.use(cors({ origin: true, credentials: true }));
// app.options('*', cors({ origin: true, credentials: true }));

// // ✅ Larger body limit to avoid aborted requests when client GS fallback sends big payloads
// app.use(express.json({ limit: '200mb' }));
// app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// // Serve frontend (static) from /public on the SAME PORT as the API
// const PUBLIC_DIR = path.join(__dirname, 'public');
// app.use(express.static(PUBLIC_DIR));

// /* =========================================================
//    Multer — DISK storage (NO big buffers in RAM)
//    Files are written straight to OS temp, then uploaded to
//    Gemini and deleted in a finally{} block.
//    ========================================================= */
// const upload = multer({
//   storage: multer.diskStorage({
//     destination: (req, file, cb) => cb(null, os.tmpdir()),
//     filename: (req, file, cb) =>
//       cb(null, `${Date.now()}-${(file.originalname || 'upload.mp4').replace(/[^\w.\-]+/g, '_')}`)
//   }),
//   limits: { fileSize: 1024 * 1024 * 1024 } // up to ~1GB
// });

// const API_KEY = process.env.GOOGLE_API_KEY;
// const MODEL   = process.env.MODEL || 'gemini-2.5-pro';
// const PORT    = process.env.PORT || 3002;     // default 3002

// const GS_JSON_PATH = process.env.GS_JSON_PATH || '';
// const GS_CSV_PATH  = process.env.GS_CSV_PATH  || '';
// const GS_DOCX_PATH = process.env.GS_DOCX_PATH || '';

// // === NEW: configurable wait for Files API to become ACTIVE (default 5 min)
// const FILES_ACTIVE_TIMEOUT_MS = Number(process.env.FILES_ACTIVE_TIMEOUT_MS || 300000); // 5 minutes
// const FILES_INITIAL_DELAY_MS  = Number(process.env.FILES_INITIAL_DELAY_MS || 1200);
// const FILES_MAX_DELAY_MS      = Number(process.env.FILES_MAX_DELAY_MS || 5000);

// if (!API_KEY) {
//   console.error('❌ Missing GOOGLE_API_KEY in .env');
//   process.exit(1);
// }

// const genAI = new GoogleGenerativeAI(API_KEY);

// // ---- Helpers (kept) ----
// function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }
// const GS_CAP = { json: 180000, csv: 120000, kw: 120000 };

// // === NEW: nice title from a local filename
// function humanizeFileName(name) {
//   const base = String(name || '')
//     .replace(/[/\\]+/g, ' ')
//     .replace(/\.[a-z0-9]+$/i, ''); // drop extension

//   const spaced = base.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();

//   const stripped = spaced
//     .replace(/\b(vid|mov|img|pxl|dji|gopr|frame|clip)\b/gi, '')
//     .replace(/\b(20\d{2}[-_.]?\d{2}[-_.]?\d{2}|\d{8}_\d{6})\b/g, '')
//     .replace(/\s{2,}/g, ' ')
//     .trim();

//   const titled = stripped.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
//   return (titled || 'Local Video').slice(0, 80);
// }

// // ---- NEW: Output normalization helpers (consistent HTML every time) ----
// function stripCodeFences(s) {
//   const fence = s.match(/^\s*```(?:html|HTML)?\s*([\s\S]*?)\s*```\s*$/);
//   if (fence) return fence[1];
//   return s.replace(/^\s*```(?:html|HTML)?\s*/, '').replace(/\s*```\s*$/, '');
// }
// function extractBodyIfFullHtml(s) {
//   const hasHtml = /<html[\s\S]*?>/i.test(s);
//   if (!hasHtml) return { isFull: false, body: s };
//   const bodyMatch = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
//   if (bodyMatch) return { isFull: true, body: bodyMatch[1] };
//   return { isFull: true, body: s };
// }
// function sanitizeNoScripts(s) {
//   return s.replace(/<script[\s\S]*?<\/script>/gi, '');
// }
// function wrapInTemplate(innerHtml) {
//   return `<!doctype html>
// <html lang="en">
// <head>
// <meta charset="utf-8">
// <meta name="viewport" content="width=device-width,initial-scale=1">
// <title>Video Summary & Core Angles</title>
// <style>
//   :root { --bg:#0f1115; --panel:#171a21; --ink:#e8eaed; --muted:#9aa0a6; --accent:#a78bfa; --accent-2:#ef4444; --border:#2a2f3a; }
//   *{box-sizing:border-box}
//   html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,"Apple Color Emoji","Segoe UI Emoji"}
//   .page{max-width:960px;margin:32px auto;padding:28px;background:var(--panel);border:1px solid var(--border);border-radius:14px}
//   h1,h2,h3{line-height:1.25;margin:0 0 14px}
//   h1{font-size:2rem;border-bottom:2px solid var(--accent-2);padding-bottom:12px}
//   h2{font-size:1.35rem;border-bottom:2px solid var(--accent);padding-bottom:6px;margin-top:28px}
//   h3{font-size:1.1rem;margin-top:20px}
//   p{margin:0 0 12px}
//   ul,ol{padding-left:22px;margin:8px 0 16px}
//   li{margin:6px 0}
//   .card{background:#1c212b;border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:12px 0}
//   .muted{color:var(--muted)}
//   code,pre{background:#0b0e13;border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:block;overflow:auto}
//   a{color:#c4b5fd}
// </style>
// </head>
// <body>
//   <main class="page">
//   ${innerHtml}
//   </main>
// </body>
// </html>`;
// }
// function normalizeModelHtml(raw) {
//   let s = String(raw || '').trim();
//   s = stripCodeFences(s);
//   s = sanitizeNoScripts(s);
//   const { isFull, body } = extractBodyIfFullHtml(s);
//   return wrapInTemplate(body);
// }

// // ---- Server-side GS cache (kept) ----
// let serverGS = { json: '', csv: '', kw: '' };

// async function fileExists(p) {
//   try { await fs.promises.access(p, fs.constants.R_OK); return true; }
//   catch { return false; }
// }

// async function loadDocxToText(filePath) {
//   const buf = await readFile(filePath);
//   const { value } = await mammoth.extractRawText({ buffer: buf });
//   return String(value || '').trim();
// }

// async function loadServerGS() {
//   const loaded = { json:false, csv:false, kw:false };
//   try {
//     if (GS_JSON_PATH && await fileExists(GS_JSON_PATH)) {
//       const txt = await readFile(GS_JSON_PATH, 'utf-8');
//       try { JSON.parse(txt); serverGS.json = clip(txt, GS_CAP.json); loaded.json = true; }
//       catch { console.warn('⚠️  DATASET.json is not valid JSON — skipping'); }
//     }
//     if (GS_CSV_PATH && await fileExists(GS_CSV_PATH)) {
//       const txt = await readFile(GS_CSV_PATH, 'utf-8');
//       serverGS.csv = clip(txt, GS_CAP.csv);
//       loaded.csv = true;
//     }
//     if (GS_DOCX_PATH && await fileExists(GS_DOCX_PATH)) {
//       const kw = await loadDocxToText(GS_DOCX_PATH);
//       serverGS.kw = clip(kw, GS_CAP.kw);
//       loaded.kw = true;
//     }
//   } catch (e) {
//     console.error('❌ Failed loading server GS:', e?.message || e);
//   }
//   const all = loaded.json && loaded.csv && loaded.kw;
//   console.log(`GS loaded: json=${loaded.json} csv=${loaded.csv} kw=${loaded.kw} (all=${all})`);
//   return loaded;
// }

// // Load GS at boot
// await loadServerGS();

// // ---- Build model message parts (unchanged core logic) ----
// function buildGSIngestParts(gsJsonStr, gsCsvStr, keywordsFullText) {
//   const parts = [];
//   parts.push({
//     text:
//       "TAKE THESE AS GOLD STANDARD TITLES AND THUMBNAILS ALONG WITH ALL THE VIRAL IMPORTANT KEYWORDS ATTACHED. THESE ARE THE TOP PERFORMING VIDEOS. KEEP THESE IN YOUR MEMORY."
//   });

//   const append = (label, raw, size = 24000) => {
//     parts.push({ text: `\n\n---\n${label}\n---\n` });
//     const s = String(raw || '');
//     for (let i = 0; i < s.length; i += size) parts.push({ text: s.slice(i, i + size) });
//   };

//   append("GOLD STANDARD: DATASET.json (RAW)", gsJsonStr || '');
//   append("GOLD STANDARD: Top10_Viral_Titles_Thumbnails_AllChannels.csv (RAW)", gsCsvStr || '');
//   append("GOLD STANDARD: Viral_Crime_Niche_Master_Keywords.docx (PLAIN TEXT)", keywordsFullText || '');
//   return parts;
// }

// function buildFinalInstructionParts({ videoSource, topic, titleHint, strategistPrompt, contextText }) {
//   const runContext = `
// VIDEO INPUT (authoritative; do not invent facts). Use the attached video fully:
// ${(contextText || "").trim()}

// Video Source: ${videoSource}
// Optional Topic: ${topic || "(none)"} | Optional Angle Hint: ${titleHint || "(none)"}

// MANDATORY:
// - Use ONLY the attached video + VIDEO INPUT + learned gold-standard patterns.
// - Do not assume/fabricate details not present.
// - Output CLEAN HTML only (no preface).
// - Start with "Video Summary & Core Angles" (video-specific), then 10 Title & Thumbnail Packages.
// `.trim();

//   return [
//     { text: String(strategistPrompt || '').trim() },
//     { text: runContext }
//   ];
// }

// // ---- Files API upload + ACTIVE polling (UPDATED timeout/backoff & logs) ----
// async function waitForFileActive(
//   fileId,
//   {
//     timeoutMs = FILES_ACTIVE_TIMEOUT_MS,
//     initialDelay = FILES_INITIAL_DELAY_MS,
//     maxDelay = FILES_MAX_DELAY_MS
//   } = {}
// ) {
//   const started = Date.now();
//   let delay = initialDelay;
//   let lastState = 'UNKNOWN';
//   let lastUri = '';

//   let checks = 0;
//   while (Date.now() - started < timeoutMs) {
//     checks++;
//     const metaResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileId}?key=${API_KEY}`);
//     if (!metaResp.ok) {
//       const txt = await metaResp.text().catch(()=> '');
//       throw new Error(`Files API GET failed (${metaResp.status}): ${txt}`);
//     }
//     const meta = await metaResp.json();
//     const state = meta?.state || meta?.fileState || 'UNKNOWN';
//     const uri = meta?.uri || meta?.file?.uri || '';

//     lastState = state;
//     lastUri = uri;

//     if (state === 'ACTIVE' && uri) {
//       console.log(`📦 Files API: ${fileId} ACTIVE after ${checks} checks (${Math.round((Date.now()-started)/1000)}s)`);
//       return { uri, state };
//     }

//     // log occasionally to see progress
//     if (checks === 1 || checks % 5 === 0) {
//       console.log(`⌛ Files API: ${fileId} state=${state} (waiting ${delay}ms)`);
//     }

//     await new Promise(r => setTimeout(r, delay));
//     delay = Math.min(maxDelay, Math.floor(delay * 1.6));
//   }

//   throw new Error(`File did not become ACTIVE in time (lastState=${lastState}, uri=${lastUri ? 'present' : 'missing'})`);
// }

// async function uploadPathToFilesAPI(filePath, mimeType, displayName) {
//   const url = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${API_KEY}`;

//   // Read once from disk and wrap as a File (Fetch/Undici-compatible)
//   const buf = await fs.promises.readFile(filePath);
//   const file = new File([buf], displayName || path.basename(filePath), {
//     type: mimeType || 'application/octet-stream'
//   });

//   const form = new FormData();
//   form.append('file', file); // field name must be exactly 'file'

//   const resp = await fetch(url, { method: 'POST', body: form });
//   const text = await resp.text();
//   if (!resp.ok) throw new Error(`Files API upload failed (${resp.status}): ${text}`);

//   let data; try { data = JSON.parse(text); }
//   catch { throw new Error(`Files API returned non-JSON: ${text}`); }

//   const fileId = data?.file?.name;
//   if (!fileId) throw new Error(`Files API response missing file.name: ${JSON.stringify(data)}`);

//   const { uri } = await waitForFileActive(fileId);
//   return { fileUri: uri, fileId };
// }


// // ---- Health ----
// app.get('/health', (req, res) => res.send('ok'));

// // ---- GS status & reload (kept) ----
// app.get('/api/gs-status', (req, res) => {
//   res.json({
//     ok: true,
//     serverGS: {
//       json: !!serverGS.json,
//       csv:  !!serverGS.csv,
//       kw:   !!serverGS.kw,
//       all:  !!(serverGS.json && serverGS.csv && serverGS.kw)
//     },
//     paths: {
//       json: GS_JSON_PATH || null,
//       csv:  GS_CSV_PATH  || null,
//       kw:   GS_DOCX_PATH || null
//     }
//   });
// });

// app.post('/api/gs-reload', async (req, res) => {
//   const loaded = await loadServerGS();
//   res.json({ ok: true, loaded });
// });

// /* =========================================================
//    1) Upload local MP4 -> DISK temp -> Files API -> delete
//    ========================================================= */
// app.post('/api/upload-video', upload.single('video'), async (req, res) => {
//   const filePath = req?.file?.path;
//   const mime     = req?.file?.mimetype || 'video/mp4';
//   const name     = req?.file?.originalname || 'uploaded-video.mp4';

//   if (!filePath) return res.status(400).json({ ok: false, error: 'No video uploaded' });
//   console.log(`⬆️  /api/upload-video  path=${filePath} mime=${mime} size=${req.file.size}`);

//   try {
//     const { fileUri, fileId } = await uploadPathToFilesAPI(filePath, mime, name);
//     console.log(`✅  Uploaded to Files API: ${fileId} (ACTIVE)`);
//     res.json({ ok: true, fileUri, fileId, mimeType: mime, fileMime: mime, displayName: name });
//   } catch (err) {
//     console.error('Upload error:', err?.message || err);
//     res.status(500).json({ ok: false, error: err?.message || 'Upload failed' });
//   } finally {
//     // Always clean temp file
//     try { await unlink(filePath); } catch {}
//   }
// });

// /* =========================================================
//    2) Fetch YouTube -> write to DISK temp -> Files API -> delete
//       - ytdl-core fast path
//       - yt-dlp fallback (handles 403/decipher changes)
//    ========================================================= */

// // yt-dlp one-time download to ./bin
// const BIN_DIR    = path.join(__dirname, 'bin');
// const YTDLP_EXE  = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
// const YTDLP_PATH = path.join(BIN_DIR, YTDLP_EXE);

// async function ensureYtDlp() {
//   try { await fs.promises.access(YTDLP_PATH, fs.constants.X_OK); return YTDLP_PATH; } catch {}
//   await fs.promises.mkdir(BIN_DIR, { recursive: true });
//   const url = process.platform === 'win32'
//     ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
//     : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
//   console.log(`⬇️  Downloading yt-dlp from ${url}`);
//   const r = await fetch(url);
//   if (!r.ok) throw new Error(`yt-dlp download failed: ${r.status}`);
//   const buf = Buffer.from(await r.arrayBuffer());
//   await fs.promises.writeFile(YTDLP_PATH, buf, { mode: 0o755 });
//   console.log('✅  yt-dlp downloaded');
//   return YTDLP_PATH;
// }

// async function downloadWithYtDlpToPath(url) {
//   const ytdlp   = await ensureYtDlp();
//   const outPath = path.join(os.tmpdir(), `yt_${Date.now()}.mp4`);
//   const args = [
//     '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
//     '--merge-output-format', 'mp4',
//     '--no-playlist',
//     '--quiet', '--no-warnings',
//     '-o', outPath,
//     url
//   ];
//   console.log('▶️  yt-dlp', args.join(' '));
//   await new Promise((resolve, reject) => {
//     execFile(ytdlp, args, { windowsHide: true }, (err) => err ? reject(err) : resolve());
//   });

//   // friendly name
//   let displayName = `youtube-video-${Date.now()}.mp4`;
//   try {
//     await new Promise((resolve) => {
//       execFile(ytdlp, ['--get-title', '--no-playlist', url], { windowsHide: true }, (e, stdout) => {
//         const t = String(stdout || '').split('\n')[0].trim();
//         if (t) displayName = `${t}`.replace(/[^\w.\-]+/g, '_') + '.mp4';
//         resolve();
//       });
//     });
//   } catch {}
//   return { outPath, displayName, mime: 'video/mp4' };
// }

// app.post('/api/fetch-youtube', async (req, res) => {
//   try {
//     let { url } = req.body || {};
//     if (!url) return res.status(400).json({ ok: false, error: 'Missing YouTube URL' });

//     // Normalize youtu.be and strip tracking params
//     try {
//       const id = ytdl.getURLVideoID(url);
//       url = `https://www.youtube.com/watch?v=${id}`;
//     } catch {
//       return res.status(400).json({ ok: false, error: 'Invalid YouTube URL' });
//     }

//     console.log(`⬇️  /api/fetch-youtube  url=${url}`);

//     // Attempt 1: ytdl-core → DISK temp
//     try {
//       const headers = {
//         'user-agent':
//           'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
//         'accept-language': 'en-US,en;q=0.9',
//       };

//       const info = await ytdl.getInfo(url, { requestOptions: { headers } });

//       let fmt =
//         ytdl.chooseFormat(info.formats, {
//           quality: 'highest',
//           filter: (f) =>
//             f.hasAudio &&
//             f.hasVideo &&
//             (f.container === 'mp4' || (f.mimeType || '').includes('mp4')),
//         }) ||
//         ytdl.chooseFormat(info.formats, {
//           quality: 'highest',
//           filter: (f) => f.hasAudio && f.hasVideo,
//         });

//       if (!fmt || !fmt.url) throw new Error('No direct AV format URL');

//       const mime =
//         fmt.mimeType?.split(';')[0] ||
//         (fmt.container === 'mp4' ? 'video/mp4' : 'video/webm');

//       const safeTitle = (info.videoDetails?.title || 'youtube-video').replace(/[^\w.\-]+/g, '_');
//       const ext = mime === 'video/mp4' ? '.mp4' : '.webm';
//       const tempPath = path.join(os.tmpdir(), `${Date.now()}-${safeTitle}${ext}`);

//       // Stream to DISK
//       await new Promise((resolve, reject) => {
//         const r = ytdl.downloadFromInfo(info, { format: fmt, requestOptions: { headers } });
//         const w = fs.createWriteStream(tempPath);
//         r.pipe(w);
//         r.on('error', reject);
//         w.on('finish', resolve);
//         w.on('error', reject);
//       });

//       // Upload from DISK → Gemini
//       try {
//         const { fileUri, fileId } = await uploadPathToFilesAPI(tempPath, mime, path.basename(tempPath));
//         console.log(`✅  YouTube uploaded via ytdl-core: ${fileId} (ACTIVE)`);
//         return res.json({ ok: true, fileUri, fileId, mimeType: mime, fileMime: mime, displayName: path.basename(tempPath) });
//       } finally {
//         try { await unlink(tempPath); } catch {}
//       }
//     } catch (e1) {
//       console.warn('⚠️  ytdl-core fetch failed; falling back to yt-dlp:', e1?.message || e1);
//     }

//     // Attempt 2: yt-dlp → DISK temp → Gemini
//     const { outPath, displayName, mime } = await downloadWithYtDlpToPath(url);
//     try {
//       const { fileUri, fileId } = await uploadPathToFilesAPI(outPath, mime, displayName);
//       console.log(`✅  YouTube uploaded via yt-dlp: ${fileId} (ACTIVE)`);
//       return res.json({ ok: true, fileUri, fileId, mimeType: mime, fileMime: mime, displayName });
//     } finally {
//       try { await unlink(outPath); } catch {}
//     }
//   } catch (err) {
//     console.error('YouTube fetch error:', err?.message || err);
//     const msg =
//       /private|copyright|410|signin|age|forbidden|403/i.test(err?.message || '')
//         ? 'Video is restricted (private/age/region). Try another public URL.'
//         : err?.message || 'YouTube fetch failed';
//     res.status(500).json({ ok: false, error: msg });
//   }
// });

// /* ===============================
//    HistoryStore (20 GB filesystem)
//    =============================== */
// const DATA_DIR  = path.join(__dirname, 'data');
// const HIST_DIR  = process.env.HIST_DIR || path.join(DATA_DIR, 'history');
// const INDEX_PATH = path.join(HIST_DIR, 'index.json');
// const HISTORY_LIMIT_BYTES = BigInt(process.env.HISTORY_LIMIT_BYTES || 20 * 1024 * 1024 * 1024); // 20 GB

// fs.mkdirSync(HIST_DIR, { recursive: true });

// class HistoryStore {
//   constructor(dir, indexPath, limitBytes) {
//     this.dir = dir;
//     this.indexPath = indexPath;
//     this.limit = BigInt(limitBytes);
//     this._ensureIndex();
//   }
//   _ensureIndex() {
//     if (!fs.existsSync(this.indexPath)) {
//       fs.writeFileSync(this.indexPath, JSON.stringify({ items: [] }), 'utf-8');
//     }
//   }
//   _readIndex() {
//     try {
//       return JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')) || { items: [] };
//     } catch { return { items: [] }; }
//   }
//   _writeIndex(idx) {
//     fs.writeFileSync(this.indexPath, JSON.stringify(idx), 'utf-8');
//   }
//   _usage(idx) {
//     return idx.items.reduce((a, b) => a + BigInt(b.size_bytes || 0), 0n);
//   }
//   stats() {
//     const idx = this._readIndex();
//     const used = this._usage(idx);
//     return {
//       limit: Number(this.limit),
//       used : Number(used),
//       remaining: Number(used > this.limit ? 0n : (this.limit - used)),
//       count: idx.items.length
//     };
//   }
//   search({ q = '', page = 1, limit = 50 }) {
//     const idx = this._readIndex();
//     const norm = q.trim().toLowerCase();
//     let items = idx.items;
//     if (norm) {
//       items = items.filter(x =>
//         String(x.title||'').toLowerCase().includes(norm) ||
//         String(x.preview||'').toLowerCase().includes(norm)
//       );
//     }
//     items.sort((a,b)=> b.created_at - a.created_at);
//     const offset = (page - 1) * limit;
//     const slice = items.slice(offset, offset + limit)
//       .map(({ id, title, created_at, size_bytes, preview }) => ({ id, title, created_at, size_bytes, preview }));
//     return { items: slice, total: items.length, page, limit };
//   }
//   async get(id) {
//     const idx = this._readIndex();
//     const it = idx.items.find(x => x.id === id);
//     if (!it) return null;
//     const raw = await fs.promises.readFile(it.file_path);
//     const buf = zlib.gunzipSync(raw);
//     const data = JSON.parse(buf.toString('utf-8'));
//     return { meta: it, data };
//   }
//   async delete(id) {
//     const idx = this._readIndex();
//     const i = idx.items.findIndex(x => x.id === id);
//     if (i === -1) return false;
//     try { if (fs.existsSync(idx.items[i].file_path)) await fs.promises.unlink(idx.items[i].file_path); } catch {}
//     idx.items.splice(i, 1);
//     this._writeIndex(idx);
//     return true;
//   }
//   async purgeOldestUntilFree(bytesNeeded) {
//     const needed = BigInt(bytesNeeded || 0);
//     const idx = this._readIndex();
//     idx.items.sort((a,b)=> a.created_at - b.created_at);
//     let used = this._usage(idx);
//     const evicted = [];
//     let p = 0;
//     while (used + needed > this.limit && p < idx.items.length) {
//       const it = idx.items[p++];
//       try { if (fs.existsSync(it.file_path)) fs.unlinkSync(it.file_path); } catch {}
//       used -= BigInt(it.size_bytes || 0);
//       evicted.push(it.id);
//     }
//     idx.items = idx.items.filter(x => !evicted.includes(x.id));
//     this._writeIndex(idx);
//     return { evicted, used: Number(used), limit: Number(this.limit) };
//   }
//   _gzip(obj) { return zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf-8'), { level: 9 }); }
//   _previewFromHTML(html) {
//     const text = String(html||'').replace(/<script[\s\S]*?<\/script>/gi,'')
//       .replace(/<style[\s\S]*?<\/style>/gi,'')
//       .replace(/<[^>]+>/g,' ')
//       .replace(/\s+/g,' ')
//       .trim();
//     return text.length > 180 ? text.slice(0,180) + '…' : text;
//   }
//   save({ title, html, extraMeta }) {
//     const idx = this._readIndex();
//     const used = this._usage(idx);
//     const gz = this._gzip({ html, meta: extraMeta || null, ts: Date.now() });
//     const newSize = BigInt(gz.byteLength);
//     if (used + newSize > this.limit) {
//       const needed = Number((used + newSize) - this.limit);
//       return { error: 'STORAGE_LIMIT_EXCEEDED', needed, used: Number(used), limit: Number(this.limit) };
//     }
//     const id = randomUUID();
//     const file_path = path.join(this.dir, `${id}.json.gz`);
//     fs.writeFileSync(file_path, gz);
//     const entry = {
//       id,
//       title: String(title || 'Generated Package').slice(0, 200),
//       created_at: Date.now(),
//       size_bytes: Number(newSize),
//       file_path,
//       preview: this._previewFromHTML(html)
//     };
//     idx.items.push(entry);
//     this._writeIndex(idx);
//     return { id, size_bytes: Number(newSize) };
//   }
// }

// const historyStore = new HistoryStore(HIST_DIR, INDEX_PATH, HISTORY_LIMIT_BYTES);

// /* ======================
//    History HTTP Endpoints
//    ====================== */

// // Stats
// app.get('/api/history-stats', (req, res) => res.json(historyStore.stats()));

// // List/search
// app.get('/api/history', (req, res) => {
//   const q = String(req.query.q || '');
//   const page = Math.max(parseInt(req.query.page || '1', 10), 1);
//   const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
//   res.json(historyStore.search({ q, page, limit }));
// });

// // Read one (JSON)
// app.get('/api/history/:id', async (req, res) => {
//   const item = await historyStore.get(req.params.id);
//   if (!item) return res.status(404).json({ error: 'Not found' });
//   res.json(item);
// });

// // NEW: Serve the saved HTML directly (for Open/Open in new tab/Download)
// app.get('/api/history/:id/html', async (req, res) => {
//   const item = await historyStore.get(req.params.id);
//   if (!item) return res.status(404).send('Not found');
//   const html = String(item.data?.html || '');
//   const download = String(req.query.download || '').toLowerCase() === '1';
//   if (download) {
//     res.setHeader('Content-Disposition', `attachment; filename="${(item.meta?.title || 'Generated_Package').replace(/[^\w.-]/g,'_')}.html"`);
//   }
//   res.setHeader('Content-Type', 'text/html; charset=utf-8');
//   res.send(html);
// });

// // Delete one
// app.delete('/api/history/:id', async (req, res) => {
//   const ok = await historyStore.delete(req.params.id);
//   if (!ok) return res.status(404).json({ error: 'Not found' });
//   res.json({ ok: true });
// });

// // Purge (oldest)
// app.post('/api/history/purge', async (req, res) => {
//   const mode = String(req.query.mode || 'oldest');
//   if (mode !== 'oldest') return res.status(400).json({ error: 'Unsupported mode' });
//   const bytes = Number(req.query.bytes || req.body?.bytes || 0);
//   const result = await historyStore.purgeOldestUntilFree(bytes);
//   res.json(result);
// });

// /* =========================================================
//    3) Generate (two-turn; video attached) — now normalizes HTML
//    ========================================================= */
// app.post('/api/generate', async (req, res) => {
//   try {
//     const {
//       fileUri, fileMime = 'video/mp4', videoSource = 'N/A', displayName,
//       strategistPrompt = '', topic = '', titleHint = '', contextText = '',
//       gsJson = '', gsCsv = '', gsKeywordsText = ''
//     } = req.body || {};

//     console.log('▶️  /api/generate', {
//       hasFileUri: !!fileUri,
//       mime: fileMime,
//       topic: clip(topic, 60),
//       hint: clip(titleHint, 60),
//       ctxLen: (contextText || '').length,
//       gs: { json: (gsJson || '').length, csv: (gsCsv || '').length, kw: (gsKeywordsText || '').length },
//       serverGS: { json: !!serverGS.json, csv: !!serverGS.csv, kw: !!serverGS.kw }
//     });

//     if (!fileUri)          return res.status(400).json({ ok: false, error: 'fileUri missing' });
//     if (!strategistPrompt) return res.status(400).json({ ok: false, error: 'strategistPrompt missing' });

//     // Prefer server GS; fallback to client-provided GS to preserve old behavior
//     const useJson = serverGS.json || clip(gsJson, 150000);
//     const useCsv  = serverGS.csv  || clip(gsCsv, 100000);
//     const useKw   = serverGS.kw   || clip(gsKeywordsText, 100000);

//     const model = genAI.getGenerativeModel({
//       model: MODEL,
//       systemInstruction: "Follow output format exactly; store gold-standard patterns internally; do not leak chain-of-thought."
//     });

//     const history = [
//       { role: 'user', parts: buildGSIngestParts(useJson, useCsv, useKw) },
//       {
//         role: 'user',
//         parts: [
//           { text: "\n\n---\nATTACHED VIDEO (analyze full visuals + audio)\n---\n" },
//           { fileData: { fileUri, mimeType: fileMime } }
//         ]
//       }
//     ];

//     const chat = model.startChat({
//       history,
//       generationConfig: {
//         temperature: 0.35,
//         topP: 0.9,
//         topK: 40,
//         candidateCount: 1,
//         maxOutputTokens: 8192,
//         responseMimeType: "text/plain" // allowed; model still returns HTML text
//       }
//     });

//     // Acknowledge context (stability)
//     await chat.sendMessage([{ text: "Acknowledge gold standard + attached video in one short sentence." }]);

//     const parts = buildFinalInstructionParts({ videoSource, topic, titleHint, strategistPrompt, contextText });
//     const result = await chat.sendMessage(parts);

//     let raw = "";
//     try { raw = result?.response?.text?.() || ""; } catch (e) { console.error("result.response.text() failed:", e); }

//     const candidate = result?.response?.candidates?.[0];
//     const meta = {
//       finishReason: candidate?.finishReason,
//       safety: candidate?.safetyRatings,
//       usage: result?.response?.usageMetadata
//     };

//     if (!raw.trim()) {
//       console.error("Empty HTML; full API response:", JSON.stringify(result, null, 2));
//       return res.status(502).json({
//         ok: false,
//         error: "Model returned empty response. See server logs for details.",
//         meta
//       });
//     }

//     // ✅ Normalize into one consistent, styled HTML page
//     const normalizedHtml = normalizeModelHtml(raw);

//     console.log('✅  Generation OK');

//     // === UPDATED: smarter title for history
//     let title =
//       (topic && topic.trim()) ||
//       (titleHint && titleHint.trim()) ||
//       (displayName && humanizeFileName(displayName)) ||
//       'Generated Package';

//     if (title === 'Generated Package') {
//       const h = normalizedHtml.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/i) || normalizedHtml.match(/^\s*#+\s*([^\n]+)/m);
//       if (h && h[1]) title = h[1].trim().slice(0, 80);
//     }

//     // Save to history (store normalized HTML)
//     const saved = historyStore.save({
//       title,
//       html: normalizedHtml,
//       extraMeta: {
//         meta,
//         input: { videoSource, topic, titleHint, contextText, displayName }
//       }
//     });

//     // collect stats and optional save info
//     let historyPayload = null;
//     let storage = historyStore.stats();
//     if (saved?.error === 'STORAGE_LIMIT_EXCEEDED') {
//       historyPayload = { saved: false, reason: 'STORAGE_LIMIT_EXCEEDED', needed: saved.needed };
//     } else if (saved?.id) {
//       historyPayload = { saved: true, id: saved.id, size_bytes: saved.size_bytes };
//     }

//     // Return normalized HTML to client → your Preview tab will render the exact same page
//     return res.json({ ok: true, html: normalizedHtml, meta, history: historyPayload, storage });
//   } catch (err) {
//     console.error("GENERATION ERROR:");
//     console.error(err?.stack || err?.message || String(err));
//     try { console.error("Raw error object:", JSON.stringify(err, null, 2)); } catch {}
//     return res.status(500).json({
//       ok: false,
//       error: err?.message || 'Generation failed (see server logs).'
//     });
//   }
// });

// // ✅ Longer timeouts help slow networks/big uploads avoid abrupt "Failed to fetch"
// const server = app.listen(PORT, () => console.log(`Server running http://0.0.0.0:${PORT}`));
// server.headersTimeout = 300000;   // 5 minutes
// server.requestTimeout = 300000;   // 5 minutes








////////////////////////////////////////






// // server.js
// import 'dotenv/config';
// import fs from 'fs';
// import os from 'os';
// import path from 'path';
// import { fileURLToPath } from 'url';
// import { promisify } from 'util';
// import express from 'express';
// import cors from 'cors';
// import multer from 'multer';

// // Video fetchers
// import ytdl from 'ytdl-core';
// import { execFile } from 'child_process';

// // Gemini SDK + docx
// import { GoogleGenerativeAI } from '@google/generative-ai';
// import mammoth from 'mammoth';

// // ✅ Undici for multipart upload (native File/Blob)
// import { FormData, File } from 'undici';

// // === NEW: history deps ===
// import zlib from 'zlib';
// import { randomUUID } from 'crypto';

// const unlink = promisify(fs.unlink);
// const writeFile = promisify(fs.writeFile);
// const readFile  = promisify(fs.readFile);

// // __dirname for ESM
// const __filename = fileURLToPath(import.meta.url);
// const __dirname  = path.dirname(__filename);

// const app = express();

// // ✅ CORS hardened so any Chrome profile/device/origin works
// app.use(cors({ origin: true, credentials: true }));
// app.options('*', cors({ origin: true, credentials: true }));

// // ✅ Larger body limit to avoid aborted requests when client GS fallback sends big payloads
// app.use(express.json({ limit: '200mb' }));
// app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// // Serve frontend (static) from /public on the SAME PORT as the API
// const PUBLIC_DIR = path.join(__dirname, 'public');
// app.use(express.static(PUBLIC_DIR));

// /* =========================================================
//    Multer — DISK storage (NO big buffers in RAM)
//    Files are written straight to OS temp, then uploaded to
//    Gemini and deleted in a finally{} block.
//    ========================================================= */
// const upload = multer({
//   storage: multer.diskStorage({
//     destination: (req, file, cb) => cb(null, os.tmpdir()),
//     filename: (req, file, cb) =>
//       cb(null, `${Date.now()}-${(file.originalname || 'upload.mp4').replace(/[^\w.\-]+/g, '_')}`)
//   }),
//   limits: { fileSize: 1024 * 1024 * 1024 } // up to ~1GB
// });

// const API_KEY = process.env.GOOGLE_API_KEY;
// const MODEL   = process.env.MODEL || 'gemini-2.5-pro';
// const PORT    = process.env.PORT || 3002;     // default 3002

// const GS_JSON_PATH = process.env.GS_JSON_PATH || '';
// const GS_CSV_PATH  = process.env.GS_CSV_PATH  || '';
// const GS_DOCX_PATH = process.env.GS_DOCX_PATH || '';

// // === NEW: configurable wait for Files API to become ACTIVE (default 5 min)
// const FILES_ACTIVE_TIMEOUT_MS = Number(process.env.FILES_ACTIVE_TIMEOUT_MS || 300000); // 5 minutes
// const FILES_INITIAL_DELAY_MS  = Number(process.env.FILES_INITIAL_DELAY_MS || 1200);
// const FILES_MAX_DELAY_MS      = Number(process.env.FILES_MAX_DELAY_MS || 5000);

// if (!API_KEY) {
//   console.error('❌ Missing GOOGLE_API_KEY in .env');
//   process.exit(1);
// }

// const genAI = new GoogleGenerativeAI(API_KEY);

// // ---- Helpers (kept) ----
// function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }
// const GS_CAP = { json: 180000, csv: 120000, kw: 120000 };

// // === NEW: nice title from a local filename
// function humanizeFileName(name) {
//   const base = String(name || '')
//     .replace(/[/\\]+/g, ' ')
//     .replace(/\.[a-z0-9]+$/i, ''); // drop extension

//   const spaced = base.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();

//   const stripped = spaced
//     .replace(/\b(vid|mov|img|pxl|dji|gopr|frame|clip)\b/gi, '')
//     .replace(/\b(20\d{2}[-_.]?\d{2}[-_.]?\d{2}|\d{8}_\d{6})\b/g, '')
//     .replace(/\s{2,}/g, ' ')
//     .trim();

//   const titled = stripped.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
//   return (titled || 'Local Video').slice(0, 80);
// }

// // ---- NEW: Output normalization helpers (consistent HTML every time) ----
// function stripCodeFences(s) {
//   const fence = s.match(/^\s*```(?:html|HTML)?\s*([\s\S]*?)\s*```\s*$/);
//   if (fence) return fence[1];
//   return s.replace(/^\s*```(?:html|HTML)?\s*/, '').replace(/\s*```\s*$/, '');
// }
// function extractBodyIfFullHtml(s) {
//   const hasHtml = /<html[\s\S]*?>/i.test(s);
//   if (!hasHtml) return { isFull: false, body: s };
//   const bodyMatch = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
//   if (bodyMatch) return { isFull: true, body: bodyMatch[1] };
//   return { isFull: true, body: s };
// }
// function sanitizeNoScripts(s) {
//   return s.replace(/<script[\s\S]*?<\/script>/gi, '');
// }
// function wrapInTemplate(innerHtml) {
//   // Theme tuned to match the “third screenshot” (red underline H1, purple rules, red pill cards).
//   return `<!doctype html>
// <html lang="en">
// <head>
// <meta charset="utf-8">
// <meta name="viewport" content="width=device-width,initial-scale=1">
// <title>Video Summary & Core Angles</title>
// <style>
//   /* ======= Layout & Colors ======= */
//   :root{
//     --bg:#0c1016;            /* page background */
//     --panel:#151a23;         /* content card */
//     --ink:#e9edf4;           /* base text */
//     --muted:#a3acba;         /* secondary text */
//     --rule:#2b3240;          /* thin dividers */
//     --accent-red:#ef4444;    /* red underline & card edge */
//     --accent-purple:#7c3aed; /* purple section rules */
//   }

//   *{box-sizing:border-box}
//   html,body{
//     margin:0;padding:0;background:var(--bg);color:var(--ink);
//     font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,"Apple Color Emoji","Segoe UI Emoji";
//     -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale
//   }

//   .page{
//     max-width:980px;margin:36px auto;padding:28px;
//     background:var(--panel);border:1px solid var(--rule);border-radius:14px;
//     box-shadow:0 10px 30px rgba(0,0,0,.25)
//   }

//   h1,h2,h3{line-height:1.25;margin:0 0 14px}
//   h1{
//     font-size:2.1rem;font-weight:800;padding-bottom:12px;
//     border-bottom:3px solid var(--accent-red);letter-spacing:.2px
//   }
//   h2{
//     font-size:1.35rem;margin-top:28px;padding-bottom:8px;
//     border-bottom:2px solid var(--accent-purple);font-weight:700
//   }
//   h3{font-size:1.08rem;margin-top:20px}

//   p{margin:0 0 12px}
//   ul,ol{margin:8px 0 16px;padding-left:22px}
//   li{margin:6px 0}

//   /* “pill” angle cards (red bar at left) */
//   .angle,.card{
//     background:#1b2230;border:1px solid var(--rule);border-left:6px solid var(--accent-red);
//     border-radius:12px;padding:14px 16px;margin:14px 0
//   }

//   /* subtle horizontal rules between packages */
//   hr{border:0;border-top:1px solid var(--rule);margin:22px 0}

//   /* Details text styles */
//   .muted{color:var(--muted)}
//   strong{font-weight:700}
//   em{opacity:.95}

//   /* Code/fallback blocks (rare) */
//   pre,code{background:#0b0f16;border:1px solid var(--rule);border-radius:8px}
//   pre{padding:12px;overflow:auto}
//   code{padding:2px 6px}

//   /* Links inside doc (if any) */
//   a{color:#c4b5fd;text-decoration:none}
//   a:hover{text-decoration:underline}

//   /* Make any top-level UL right under h1 look spaced nicely */
//   h1 + p, h1 + ul, h1 + div{margin-top:10px}
// </style>
// </head>
// <body>
//   <main class="page">
//     ${innerHtml}
//   </main>

//   <script>
//     /* Post-process: if the model emitted “angle” lines as plain paragraphs,
//        heuristically wrap lines that start with certain keywords into .angle cards. */
//     (function(){
//       try{
//         const container=document.querySelector('.page');
//         if(!container) return;
//         const triggers=['Shocking','Shock','Human','Empathy','Police','Procedural','Twist','Revelation','The '];
//         const ps=[...container.querySelectorAll('p')];
//         ps.forEach(p=>{
//           const t=(p.textContent||'').trim();
//           if(t && triggers.some(k=>t.startsWith(k))){
//             const wrap=document.createElement('div');
//             wrap.className='angle';
//             p.replaceWith(wrap);
//             wrap.appendChild(p);
//           }
//         });
//       }catch(_e){}
//     })();
//   </script>
// </body>
// </html>`;
// }
// function normalizeModelHtml(raw) {
//   let s = String(raw || '').trim();
//   s = stripCodeFences(s);
//   s = sanitizeNoScripts(s);
//   const { isFull, body } = extractBodyIfFullHtml(s);
//   return wrapInTemplate(body);
// }

// // ---- Server-side GS cache (kept) ----
// let serverGS = { json: '', csv: '', kw: '' };

// async function fileExists(p) {
//   try { await fs.promises.access(p, fs.constants.R_OK); return true; }
//   catch { return false; }
// }

// async function loadDocxToText(filePath) {
//   const buf = await readFile(filePath);
//   const { value } = await mammoth.extractRawText({ buffer: buf });
//   return String(value || '').trim();
// }

// async function loadServerGS() {
//   const loaded = { json:false, csv:false, kw:false };
//   try {
//     if (GS_JSON_PATH && await fileExists(GS_JSON_PATH)) {
//       const txt = await readFile(GS_JSON_PATH, 'utf-8');
//       try { JSON.parse(txt); serverGS.json = clip(txt, GS_CAP.json); loaded.json = true; }
//       catch { console.warn('⚠️  DATASET.json is not valid JSON — skipping'); }
//     }
//     if (GS_CSV_PATH && await fileExists(GS_CSV_PATH)) {
//       const txt = await readFile(GS_CSV_PATH, 'utf-8');
//       serverGS.csv = clip(txt, GS_CAP.csv);
//       loaded.csv = true;
//     }
//     if (GS_DOCX_PATH && await fileExists(GS_DOCX_PATH)) {
//       const kw = await loadDocxToText(GS_DOCX_PATH);
//       serverGS.kw = clip(kw, GS_CAP.kw);
//       loaded.kw = true;
//     }
//   } catch (e) {
//     console.error('❌ Failed loading server GS:', e?.message || e);
//   }
//   const all = loaded.json && loaded.csv && loaded.kw;
//   console.log(`GS loaded: json=${loaded.json} csv=${loaded.csv} kw=${loaded.kw} (all=${all})`);
//   return loaded;
// }

// // Load GS at boot
// await loadServerGS();

// // ---- Build model message parts (unchanged core logic) ----
// function buildGSIngestParts(gsJsonStr, gsCsvStr, keywordsFullText) {
//   const parts = [];
//   parts.push({
//     text:
//       "TAKE THESE AS GOLD STANDARD TITLES AND THUMBNAILS ALONG WITH ALL THE VIRAL IMPORTANT KEYWORDS ATTACHED. THESE ARE THE TOP PERFORMING VIDEOS. KEEP THESE IN YOUR MEMORY."
//   });

//   const append = (label, raw, size = 24000) => {
//     parts.push({ text: `\n\n---\n${label}\n---\n` });
//     const s = String(raw || '');
//     for (let i = 0; i < s.length; i += size) parts.push({ text: s.slice(i, i + size) });
//   };

//   append("GOLD STANDARD: DATASET.json (RAW)", gsJsonStr || '');
//   append("GOLD STANDARD: Top10_Viral_Titles_Thumbnails_AllChannels.csv (RAW)", gsCsvStr || '');
//   append("GOLD STANDARD: Viral_Crime_Niche_Master_Keywords.docx (PLAIN TEXT)", keywordsFullText || '');
//   return parts;
// }

// function buildFinalInstructionParts({ videoSource, topic, titleHint, strategistPrompt, contextText }) {
//   const runContext = `
// VIDEO INPUT (authoritative; do not invent facts). Use the attached video fully:
// ${(contextText || "").trim()}

// Video Source: ${videoSource}
// Optional Topic: ${topic || "(none)"} | Optional Angle Hint: ${titleHint || "(none)"}

// MANDATORY:
// - Use ONLY the attached video + VIDEO INPUT + learned gold-standard patterns.
// - Do not assume/fabricate details not present.
// - Output CLEAN HTML only (no preface).
// - Start with "Video Summary & Core Angles" (video-specific), then 10 Title & Thumbnail Packages.
// `.trim();

//   return [
//     { text: String(strategistPrompt || '').trim() },
//     { text: runContext }
//   ];
// }

// // ---- Files API upload + ACTIVE polling (UPDATED timeout/backoff & logs) ----
// async function waitForFileActive(
//   fileId,
//   {
//     timeoutMs = FILES_ACTIVE_TIMEOUT_MS,
//     initialDelay = FILES_INITIAL_DELAY_MS,
//     maxDelay = FILES_MAX_DELAY_MS
//   } = {}
// ) {
//   const started = Date.now();
//   let delay = initialDelay;
//   let lastState = 'UNKNOWN';
//   let lastUri = '';

//   let checks = 0;
//   while (Date.now() - started < timeoutMs) {
//     checks++;
//     const metaResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileId}?key=${API_KEY}`);
//     if (!metaResp.ok) {
//       const txt = await metaResp.text().catch(()=> '');
//       throw new Error(`Files API GET failed (${metaResp.status}): ${txt}`);
//     }
//     const meta = await metaResp.json();
//     const state = meta?.state || meta?.fileState || 'UNKNOWN';
//     const uri = meta?.uri || meta?.file?.uri || '';

//     lastState = state;
//     lastUri = uri;

//     if (state === 'ACTIVE' && uri) {
//       console.log(`📦 Files API: ${fileId} ACTIVE after ${checks} checks (${Math.round((Date.now()-started)/1000)}s)`);
//       return { uri, state };
//     }

//     // log occasionally to see progress
//     if (checks === 1 || checks % 5 === 0) {
//       console.log(`⌛ Files API: ${fileId} state=${state} (waiting ${delay}ms)`);
//     }

//     await new Promise(r => setTimeout(r, delay));
//     delay = Math.min(maxDelay, Math.floor(delay * 1.6));
//   }

//   throw new Error(`File did not become ACTIVE in time (lastState=${lastState}, uri=${lastUri ? 'present' : 'missing'})`);
// }

// async function uploadPathToFilesAPI(filePath, mimeType, displayName) {
//   const url = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${API_KEY}`;

//   // Read once from disk and wrap as a File (Fetch/Undici-compatible)
//   const buf = await fs.promises.readFile(filePath);
//   const file = new File([buf], displayName || path.basename(filePath), {
//     type: mimeType || 'application/octet-stream'
//   });

//   const form = new FormData();
//   form.append('file', file); // field name must be exactly 'file'

//   const resp = await fetch(url, { method: 'POST', body: form });
//   const text = await resp.text();
//   if (!resp.ok) throw new Error(`Files API upload failed (${resp.status}): ${text}`);

//   let data; try { data = JSON.parse(text); }
//   catch { throw new Error(`Files API returned non-JSON: ${text}`); }

//   const fileId = data?.file?.name;
//   if (!fileId) throw new Error(`Files API response missing file.name: ${JSON.stringify(data)}`);

//   const { uri } = await waitForFileActive(fileId);
//   return { fileUri: uri, fileId };
// }


// // ---- Health ----
// app.get('/health', (req, res) => res.send('ok'));

// // ---- GS status & reload (kept) ----
// app.get('/api/gs-status', (req, res) => {
//   res.json({
//     ok: true,
//     serverGS: {
//       json: !!serverGS.json,
//       csv:  !!serverGS.csv,
//       kw:   !!serverGS.kw,
//       all:  !!(serverGS.json && serverGS.csv && serverGS.kw)
//     },
//     paths: {
//       json: GS_JSON_PATH || null,
//       csv:  GS_CSV_PATH  || null,
//       kw:   GS_DOCX_PATH || null
//     }
//   });
// });

// app.post('/api/gs-reload', async (req, res) => {
//   const loaded = await loadServerGS();
//   res.json({ ok: true, loaded });
// });

// /* =========================================================
//    1) Upload local MP4 -> DISK temp -> Files API -> delete
//    ========================================================= */
// app.post('/api/upload-video', upload.single('video'), async (req, res) => {
//   const filePath = req?.file?.path;
//   const mime     = req?.file?.mimetype || 'video/mp4';
//   const name     = req?.file?.originalname || 'uploaded-video.mp4';

//   if (!filePath) return res.status(400).json({ ok: false, error: 'No video uploaded' });
//   console.log(`⬆️  /api/upload-video  path=${filePath} mime=${mime} size=${req.file.size}`);

//   try {
//     const { fileUri, fileId } = await uploadPathToFilesAPI(filePath, mime, name);
//     console.log(`✅  Uploaded to Files API: ${fileId} (ACTIVE)`);
//     res.json({ ok: true, fileUri, fileId, mimeType: mime, fileMime: mime, displayName: name });
//   } catch (err) {
//     console.error('Upload error:', err?.message || err);
//     res.status(500).json({ ok: false, error: err?.message || 'Upload failed' });
//   } finally {
//     // Always clean temp file
//     try { await unlink(filePath); } catch {}
//   }
// });

// /* =========================================================
//    2) Fetch YouTube -> write to DISK temp -> Files API -> delete
//       - ytdl-core fast path
//       - yt-dlp fallback (handles 403/decipher changes)
//    ========================================================= */

// // yt-dlp one-time download to ./bin
// const BIN_DIR    = path.join(__dirname, 'bin');
// const YTDLP_EXE  = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
// const YTDLP_PATH = path.join(BIN_DIR, YTDLP_EXE);

// async function ensureYtDlp() {
//   try { await fs.promises.access(YTDLP_PATH, fs.constants.XOK); return YTDLP_PATH; } catch {}
//   await fs.promises.mkdir(BIN_DIR, { recursive: true });
//   const url = process.platform === 'win32'
//     ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
//     : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
//   console.log(`⬇️  Downloading yt-dlp from ${url}`);
//   const r = await fetch(url);
//   if (!r.ok) throw new Error(`yt-dlp download failed: ${r.status}`);
//   const buf = Buffer.from(await r.arrayBuffer());
//   await fs.promises.writeFile(YTDLP_PATH, buf, { mode: 0o755 });
//   console.log('✅  yt-dlp downloaded');
//   return YTDLP_PATH;
// }

// async function downloadWithYtDlpToPath(url) {
//   const ytdlp   = await ensureYtDlp();
//   const outPath = path.join(os.tmpdir(), `yt_${Date.now()}.mp4`);
//   const args = [
//     '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
//     '--merge-output-format', 'mp4',
//     '--no-playlist',
//     '--quiet', '--no-warnings',
//     '-o', outPath,
//     url
//   ];
//   console.log('▶️  yt-dlp', args.join(' '));
//   await new Promise((resolve, reject) => {
//     execFile(ytdlp, args, { windowsHide: true }, (err) => err ? reject(err) : resolve());
//   });

//   // friendly name
//   let displayName = `youtube-video-${Date.now()}.mp4`;
//   try {
//     await new Promise((resolve) => {
//       execFile(ytdlp, ['--get-title', '--no-playlist', url], { windowsHide: true }, (e, stdout) => {
//         const t = String(stdout || '').split('\n')[0].trim();
//         if (t) displayName = `${t}`.replace(/[^\w.\-]+/g, '_') + '.mp4';
//         resolve();
//       });
//     });
//   } catch {}
//   return { outPath, displayName, mime: 'video/mp4' };
// }

// app.post('/api/fetch-youtube', async (req, res) => {
//   try {
//     let { url } = req.body || {};
//     if (!url) return res.status(400).json({ ok: false, error: 'Missing YouTube URL' });

//     // Normalize youtu.be and strip tracking params
//     try {
//       const id = ytdl.getURLVideoID(url);
//       url = `https://www.youtube.com/watch?v=${id}`;
//     } catch {
//       return res.status(400).json({ ok: false, error: 'Invalid YouTube URL' });
//     }

//     console.log(`⬇️  /api/fetch-youtube  url=${url}`);

//     // Attempt 1: ytdl-core → DISK temp
//     try {
//       const headers = {
//         'user-agent':
//           'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
//         'accept-language': 'en-US,en;q=0.9',
//       };

//       const info = await ytdl.getInfo(url, { requestOptions: { headers } });

//       let fmt =
//         ytdl.chooseFormat(info.formats, {
//           quality: 'highest',
//           filter: (f) =>
//             f.hasAudio &&
//             f.hasVideo &&
//             (f.container === 'mp4' || (f.mimeType || '').includes('mp4')),
//         }) ||
//         ytdl.chooseFormat(info.formats, {
//           quality: 'highest',
//           filter: (f) => f.hasAudio && f.hasVideo,
//         });

//       if (!fmt || !fmt.url) throw new Error('No direct AV format URL');

//       const mime =
//         fmt.mimeType?.split(';')[0] ||
//         (fmt.container === 'mp4' ? 'video/mp4' : 'video/webm');

//       const safeTitle = (info.videoDetails?.title || 'youtube-video').replace(/[^\w.\-]+/g, '_');
//       const ext = mime === 'video/mp4' ? '.mp4' : '.webm';
//       const tempPath = path.join(os.tmpdir(), `${Date.now()}-${safeTitle}${ext}`);

//       // Stream to DISK
//       await new Promise((resolve, reject) => {
//         const r = ytdl.downloadFromInfo(info, { format: fmt, requestOptions: { headers } });
//         const w = fs.createWriteStream(tempPath);
//         r.pipe(w);
//         r.on('error', reject);
//         w.on('finish', resolve);
//         w.on('error', reject);
//       });

//       // Upload from DISK → Gemini
//       try {
//         const { fileUri, fileId } = await uploadPathToFilesAPI(tempPath, mime, path.basename(tempPath));
//         console.log(`✅  YouTube uploaded via ytdl-core: ${fileId} (ACTIVE)`);
//         return res.json({ ok: true, fileUri, fileId, mimeType: mime, fileMime: mime, displayName: path.basename(tempPath) });
//       } finally {
//         try { await unlink(tempPath); } catch {}
//       }
//     } catch (e1) {
//       console.warn('⚠️  ytdl-core fetch failed; falling back to yt-dlp:', e1?.message || e1);
//     }

//     // Attempt 2: yt-dlp → DISK temp → Gemini
//     const { outPath, displayName, mime } = await downloadWithYtDlpToPath(url);
//     try {
//       const { fileUri, fileId } = await uploadPathToFilesAPI(outPath, mime, displayName);
//       console.log(`✅  YouTube uploaded via yt-dlp: ${fileId} (ACTIVE)`);
//       return res.json({ ok: true, fileUri, fileId, mimeType: mime, fileMime: mime, displayName });
//     } finally {
//       try { await unlink(outPath); } catch {}
//     }
//   } catch (err) {
//     console.error('YouTube fetch error:', err?.message || err);
//     const msg =
//       /private|copyright|410|signin|age|forbidden|403/i.test(err?.message || '')
//         ? 'Video is restricted (private/age/region). Try another public URL.'
//         : err?.message || 'YouTube fetch failed';
//     res.status(500).json({ ok: false, error: msg });
//   }
// });

// /* ===============================
//    HistoryStore (20 GB filesystem)
//    =============================== */
// const DATA_DIR  = path.join(__dirname, 'data');
// const HIST_DIR  = process.env.HIST_DIR || path.join(DATA_DIR, 'history');
// const INDEX_PATH = path.join(HIST_DIR, 'index.json');
// const HISTORY_LIMIT_BYTES = BigInt(process.env.HISTORY_LIMIT_BYTES || 20 * 1024 * 1024 * 1024); // 20 GB

// fs.mkdirSync(HIST_DIR, { recursive: true });

// class HistoryStore {
//   constructor(dir, indexPath, limitBytes) {
//     this.dir = dir;
//     this.indexPath = indexPath;
//     this.limit = BigInt(limitBytes);
//     this._ensureIndex();
//   }
//   _ensureIndex() {
//     if (!fs.existsSync(this.indexPath)) {
//       fs.writeFileSync(this.indexPath, JSON.stringify({ items: [] }), 'utf-8');
//     }
//   }
//   _readIndex() {
//     try {
//       return JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')) || { items: [] };
//     } catch { return { items: [] }; }
//   }
//   _writeIndex(idx) {
//     fs.writeFileSync(this.indexPath, JSON.stringify(idx), 'utf-8');
//   }
//   _usage(idx) {
//     return idx.items.reduce((a, b) => a + BigInt(b.size_bytes || 0), 0n);
//   }
//   stats() {
//     const idx = this._readIndex();
//     const used = this._usage(idx);
//     return {
//       limit: Number(this.limit),
//       used : Number(used),
//       remaining: Number(used > this.limit ? 0n : (this.limit - used)),
//       count: idx.items.length
//     };
//   }
//   search({ q = '', page = 1, limit = 50 }) {
//     const idx = this._readIndex();
//     const norm = q.trim().toLowerCase();
//     let items = idx.items;
//     if (norm) {
//       items = items.filter(x =>
//         String(x.title||'').toLowerCase().includes(norm) ||
//         String(x.preview||'').toLowerCase().includes(norm)
//       );
//     }
//     items.sort((a,b)=> b.created_at - a.created_at);
//     const offset = (page - 1) * limit;
//     const slice = items.slice(offset, offset + limit)
//       .map(({ id, title, created_at, size_bytes, preview }) => ({ id, title, created_at, size_bytes, preview }));
//     return { items: slice, total: items.length, page, limit };
//   }
//   async get(id) {
//     const idx = this._readIndex();
//     const it = idx.items.find(x => x.id === id);
//     if (!it) return null;
//     const raw = await fs.promises.readFile(it.file_path);
//     const buf = zlib.gunzipSync(raw);
//     const data = JSON.parse(buf.toString('utf-8'));
//     return { meta: it, data };
//   }
//   async delete(id) {
//     const idx = this._readIndex();
//     const i = idx.items.findIndex(x => x.id === id);
//     if (i === -1) return false;
//     try { if (fs.existsSync(idx.items[i].file_path)) await fs.promises.unlink(idx.items[i].file_path); } catch {}
//     idx.items.splice(i, 1);
//     this._writeIndex(idx);
//     return true;
//   }
//   async purgeOldestUntilFree(bytesNeeded) {
//     const needed = BigInt(bytesNeeded || 0);
//     const idx = this._readIndex();
//     idx.items.sort((a,b)=> a.created_at - b.created_at);
//     let used = this._usage(idx);
//     const evicted = [];
//     let p = 0;
//     while (used + needed > this.limit && p < idx.items.length) {
//       const it = idx.items[p++];
//       try { if (fs.existsSync(it.file_path)) fs.unlinkSync(it.file_path); } catch {}
//       used -= BigInt(it.size_bytes || 0);
//       evicted.push(it.id);
//     }
//     idx.items = idx.items.filter(x => !evicted.includes(x.id));
//     this._writeIndex(idx);
//     return { evicted, used: Number(used), limit: Number(this.limit) };
//   }
//   _gzip(obj) { return zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf-8'), { level: 9 }); }
//   _previewFromHTML(html) {
//     const text = String(html||'').replace(/<script[\s\S]*?<\/script>/gi,'')
//       .replace(/<style[\s\S]*?<\/style>/gi,'')
//       .replace(/<[^>]+>/g,' ')
//       .replace(/\s+/g,' ')
//       .trim();
//     return text.length > 180 ? text.slice(0,180) + '…' : text;
//   }
//   save({ title, html, extraMeta }) {
//     const idx = this._readIndex();
//     const used = this._usage(idx);
//     const gz = this._gzip({ html, meta: extraMeta || null, ts: Date.now() });
//     const newSize = BigInt(gz.byteLength);
//     if (used + newSize > this.limit) {
//       const needed = Number((used + newSize) - this.limit);
//       return { error: 'STORAGE_LIMIT_EXCEEDED', needed, used: Number(used), limit: Number(this.limit) };
//     }
//     const id = randomUUID();
//     const file_path = path.join(this.dir, `${id}.json.gz`);
//     fs.writeFileSync(file_path, gz);
//     const entry = {
//       id,
//       title: String(title || 'Generated Package').slice(0, 200),
//       created_at: Date.now(),
//       size_bytes: Number(newSize),
//       file_path,
//       preview: this._previewFromHTML(html)
//     };
//     idx.items.push(entry);
//     this._writeIndex(idx);
//     return { id, size_bytes: Number(newSize) };
//   }
// }

// const historyStore = new HistoryStore(HIST_DIR, INDEX_PATH, HISTORY_LIMIT_BYTES);

// /* ======================
//    History HTTP Endpoints
//    ====================== */

// // Stats
// app.get('/api/history-stats', (req, res) => res.json(historyStore.stats()));

// // List/search
// app.get('/api/history', (req, res) => {
//   const q = String(req.query.q || '');
//   const page = Math.max(parseInt(req.query.page || '1', 10), 1);
//   const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
//   res.json(historyStore.search({ q, page, limit }));
// });

// // Read one (JSON)
// app.get('/api/history/:id', async (req, res) => {
//   const item = await historyStore.get(req.params.id);
//   if (!item) return res.status(404).json({ error: 'Not found' });
//   res.json(item);
// });

// // NEW: Serve the saved HTML directly (for Open/Open in new tab/Download)
// app.get('/api/history/:id/html', async (req, res) => {
//   const item = await historyStore.get(req.params.id);
//   if (!item) return res.status(404).send('Not found');
//   const html = String(item.data?.html || '');
//   const download = String(req.query.download || '').toLowerCase() === '1';
//   if (download) {
//     res.setHeader('Content-Disposition', `attachment; filename="${(item.meta?.title || 'Generated_Package').replace(/[^\w.-]/g,'_')}.html"`);
//   }
//   res.setHeader('Content-Type', 'text/html; charset=utf-8');
//   res.send(html);
// });

// // Delete one
// app.delete('/api/history/:id', async (req, res) => {
//   const ok = await historyStore.delete(req.params.id);
//   if (!ok) return res.status(404).json({ error: 'Not found' });
//   res.json({ ok: true });
// });

// // Purge (oldest)
// app.post('/api/history/purge', async (req, res) => {
//   const mode = String(req.query.mode || 'oldest');
//   if (mode !== 'oldest') return res.status(400).json({ error: 'Unsupported mode' });
//   const bytes = Number(req.query.bytes || req.body?.bytes || 0);
//   const result = await historyStore.purgeOldestUntilFree(bytes);
//   res.json(result);
// });

// /* =========================================================
//    3) Generate (two-turn; video attached) — now normalizes HTML
//    ========================================================= */
// app.post('/api/generate', async (req, res) => {
//   try {
//     const {
//       fileUri, fileMime = 'video/mp4', videoSource = 'N/A', displayName,
//       strategistPrompt = '', topic = '', titleHint = '', contextText = '',
//       gsJson = '', gsCsv = '', gsKeywordsText = ''
//     } = req.body || {};

//     console.log('▶️  /api/generate', {
//       hasFileUri: !!fileUri,
//       mime: fileMime,
//       topic: clip(topic, 60),
//       hint: clip(titleHint, 60),
//       ctxLen: (contextText || '').length,
//       gs: { json: (gsJson || '').length, csv: (gsCsv || '').length, kw: (gsKeywordsText || '').length },
//       serverGS: { json: !!serverGS.json, csv: !!serverGS.csv, kw: !!serverGS.kw }
//     });

//     if (!fileUri)          return res.status(400).json({ ok: false, error: 'fileUri missing' });
//     if (!strategistPrompt) return res.status(400).json({ ok: false, error: 'strategistPrompt missing' });

//     // Prefer server GS; fallback to client-provided GS to preserve old behavior
//     const useJson = serverGS.json || clip(gsJson, 150000);
//     const useCsv  = serverGS.csv  || clip(gsCsv, 100000);
//     const useKw   = serverGS.kw   || clip(gsKeywordsText, 100000);

//     const model = genAI.getGenerativeModel({
//       model: MODEL,
//       systemInstruction: "Follow output format exactly; store gold-standard patterns internally; do not leak chain-of-thought."
//     });

//     const history = [
//       { role: 'user', parts: buildGSIngestParts(useJson, useCsv, useKw) },
//       {
//         role: 'user',
//         parts: [
//           { text: "\n\n---\nATTACHED VIDEO (analyze full visuals + audio)\n---\n" },
//           { fileData: { fileUri, mimeType: fileMime } }
//         ]
//       }
//     ];

//     const chat = model.startChat({
//       history,
//       generationConfig: {
//         temperature: 0.35,
//         topP: 0.9,
//         topK: 40,
//         candidateCount: 1,
//         maxOutputTokens: 8192,
//         responseMimeType: "text/plain" // allowed; model still returns HTML text
//       }
//     });

//     // Acknowledge context (stability)
//     await chat.sendMessage([{ text: "Acknowledge gold standard + attached video in one short sentence." }]);

//     const parts = buildFinalInstructionParts({ videoSource, topic, titleHint, strategistPrompt, contextText });
//     const result = await chat.sendMessage(parts);

//     let raw = "";
//     try { raw = result?.response?.text?.() || ""; } catch (e) { console.error("result.response.text() failed:", e); }

//     const candidate = result?.response?.candidates?.[0];
//     const meta = {
//       finishReason: candidate?.finishReason,
//       safety: candidate?.safetyRatings,
//       usage: result?.response?.usageMetadata
//     };

//     if (!raw.trim()) {
//       console.error("Empty HTML; full API response:", JSON.stringify(result, null, 2));
//       return res.status(502).json({
//         ok: false,
//         error: "Model returned empty response. See server logs for details.",
//         meta
//       });
//     }

//     // ✅ Normalize into one consistent, styled HTML page
//     const normalizedHtml = normalizeModelHtml(raw);

//     console.log('✅  Generation OK');

//     // === UPDATED: smarter title for history
//     let title =
//       (topic && topic.trim()) ||
//       (titleHint && titleHint.trim()) ||
//       (displayName && humanizeFileName(displayName)) ||
//       'Generated Package';

//     if (title === 'Generated Package') {
//       const h = normalizedHtml.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/i) || normalizedHtml.match(/^\s*#+\s*([^\n]+)/m);
//       if (h && h[1]) title = h[1].trim().slice(0, 80);
//     }

//     // Save to history (store normalized HTML)
//     const saved = historyStore.save({
//       title,
//       html: normalizedHtml,
//       extraMeta: {
//         meta,
//         input: { videoSource, topic, titleHint, contextText, displayName }
//       }
//     });

//     // collect stats and optional save info
//     let historyPayload = null;
//     let storage = historyStore.stats();
//     if (saved?.error === 'STORAGE_LIMIT_EXCEEDED') {
//       historyPayload = { saved: false, reason: 'STORAGE_LIMIT_EXCEEDED', needed: saved.needed };
//     } else if (saved?.id) {
//       historyPayload = { saved: true, id: saved.id, size_bytes: saved.size_bytes };
//     }

//     // Return normalized HTML to client → your Preview tab will render the exact same page
//     return res.json({ ok: true, html: normalizedHtml, meta, history: historyPayload, storage });
//   } catch (err) {
//     console.error("GENERATION ERROR:");
//     console.error(err?.stack || err?.message || String(err));
//     try { console.error("Raw error object:", JSON.stringify(err, null, 2)); } catch {}
//     return res.status(500).json({
//       ok: false,
//       error: err?.message || 'Generation failed (see server logs).'
//     });
//   }
// });

// // ✅ Longer timeouts help slow networks/big uploads avoid abrupt "Failed to fetch"
// const server = app.listen(PORT, () => console.log(`Server running http://0.0.0.0:${PORT}`));
// server.headersTimeout = 300000;   // 5 minutes
// server.requestTimeout = 300000;   // 5 minutes








///////////////////////////////



// // server.js
// import 'dotenv/config';
// import fs from 'fs';
// import os from 'os';
// import path from 'path';
// import { fileURLToPath } from 'url';
// import { promisify } from 'util';
// import express from 'express';
// import cors from 'cors';
// import multer from 'multer';

// // Video fetchers
// import ytdl from 'ytdl-core';
// import { execFile } from 'child_process';

// // Gemini SDK + docx
// import { GoogleGenerativeAI } from '@google/generative-ai';
// import mammoth from 'mammoth';

// // ✅ Streaming multipart for large files (no RAM buffering)
// import FormData from 'form-data';

// // === history deps ===
// import zlib from 'zlib';
// import { randomUUID } from 'crypto';

// const unlink = promisify(fs.unlink);
// const writeFile = promisify(fs.writeFile);
// const readFile  = promisify(fs.readFile);

// // __dirname for ESM
// const __filename = fileURLToPath(import.meta.url);
// const __dirname  = path.dirname(__filename);

// const app = express();

// // ✅ CORS hardened so any Chrome profile/device/origin works
// app.use(cors({ origin: true, credentials: true }));
// app.options('*', cors({ origin: true, credentials: true }));

// // ✅ Larger body limit to avoid aborted requests when client GS fallback sends big payloads
// app.use(express.json({ limit: '200mb' }));
// app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// // Serve frontend (static) from /public on the SAME PORT as the API
// const PUBLIC_DIR = path.join(__dirname, 'public');
// app.use(express.static(PUBLIC_DIR));

// /* =========================================================
//    Multer — DISK storage (NO big buffers in RAM)
//    Files are written straight to OS temp, then uploaded to
//    Gemini and deleted in a finally{} block.
//    ========================================================= */
// const MULTER_MAX_FILE_SIZE = Number(process.env.MULTER_MAX_FILE_SIZE || 5 * 1024 * 1024 * 1024); // default 5GB
// const upload = multer({
//   storage: multer.diskStorage({
//     destination: (req, file, cb) => cb(null, os.tmpdir()),
//     filename: (req, file, cb) =>
//       cb(null, `${Date.now()}-${(file.originalname || 'upload.mp4').replace(/[^\w.\-]+/g, '_')}`)
//   }),
//   limits: { fileSize: MULTER_MAX_FILE_SIZE }
// });

// const API_KEY = process.env.GOOGLE_API_KEY;
// const MODEL   = process.env.MODEL || 'gemini-2.5-pro';
// const PORT    = process.env.PORT || 3002;     // default 3002

// const GS_JSON_PATH = process.env.GS_JSON_PATH || '';
// const GS_CSV_PATH  = process.env.GS_CSV_PATH  || '';
// const GS_DOCX_PATH = process.env.GS_DOCX_PATH || '';

// // === Configurable wait for Files API to become ACTIVE (generous defaults)
// const FILES_ACTIVE_TIMEOUT_MS = Number(process.env.FILES_ACTIVE_TIMEOUT_MS || 30 * 60 * 1000); // 30 minutes
// const FILES_INITIAL_DELAY_MS  = Number(process.env.FILES_INITIAL_DELAY_MS || 1200);
// const FILES_MAX_DELAY_MS      = Number(process.env.FILES_MAX_DELAY_MS || 5000);

// if (!API_KEY) {
//   console.error('❌ Missing GOOGLE_API_KEY in .env');
//   process.exit(1);
// }

// const genAI = new GoogleGenerativeAI(API_KEY);

// // ---- Helpers (kept) ----
// function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }
// const GS_CAP = { json: 180000, csv: 120000, kw: 120000 };

// // === NEW: nice title from a local filename
// function humanizeFileName(name) {
//   const base = String(name || '')
//     .replace(/[/\\]+/g, ' ')
//     .replace(/\.[a-z0-9]+$/i, ''); // drop extension

//   const spaced = base.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();

//   const stripped = spaced
//     .replace(/\b(vid|mov|img|pxl|dji|gopr|frame|clip)\b/gi, '')
//     .replace(/\b(20\d{2}[-_.]?\d{2}[-_.]?\d{2}|\d{8}_\d{6})\b/g, '')
//     .replace(/\s{2,}/g, ' ')
//     .trim();

//   const titled = stripped.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
//   return (titled || 'Local Video').slice(0, 80);
// }

// // ---- NEW: Output normalization helpers (consistent HTML every time) ----
// function stripCodeFences(s) {
//   const fence = s.match(/^\s*```(?:html|HTML)?\s*([\s\S]*?)\s*```\s*$/);
//   if (fence) return fence[1];
//   return s.replace(/^\s*```(?:html|HTML)?\s*/, '').replace(/\s*```\s*$/, '');
// }
// function extractBodyIfFullHtml(s) {
//   const hasHtml = /<html[\s\S]*?>/i.test(s);
//   if (!hasHtml) return { isFull: false, body: s };
//   const bodyMatch = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
//   if (bodyMatch) return { isFull: true, body: bodyMatch[1] };
//   return { isFull: true, body: s };
// }
// function sanitizeNoScripts(s) {
//   return s.replace(/<script[\s\S]*?<\/script>/gi, '');
// }
// function wrapInTemplate(innerHtml) {
//   // Theme tuned to match the “third screenshot” (red underline H1, purple rules, red pill cards).
//   return `<!doctype html>
// <html lang="en">
// <head>
// <meta charset="utf-8">
// <meta name="viewport" content="width=device-width,initial-scale=1">
// <title>Video Summary & Core Angles</title>
// <style>
//   /* ======= Layout & Colors ======= */
//   :root{
//     --bg:#0c1016;            /* page background */
//     --panel:#151a23;         /* content card */
//     --ink:#e9edf4;           /* base text */
//     --muted:#a3acba;         /* secondary text */
//     --rule:#2b3240;          /* thin dividers */
//     --accent-red:#ef4444;    /* red underline & card edge */
//     --accent-purple:#7c3aed; /* purple section rules */
//   }

//   *{box-sizing:border-box}
//   html,body{
//     margin:0;padding:0;background:var(--bg);color:var(--ink);
//     font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,"Apple Color Emoji","Segoe UI Emoji";
//     -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale
//   }

//   .page{
//     max-width:980px;margin:36px auto;padding:28px;
//     background:var(--panel);border:1px solid var(--rule);border-radius:14px;
//     box-shadow:0 10px 30px rgba(0,0,0,.25)
//   }

//   h1,h2,h3{line-height:1.25;margin:0 0 14px}
//   h1{
//     font-size:2.1rem;font-weight:800;padding-bottom:12px;
//     border-bottom:3px solid var(--accent-red);letter-spacing:.2px
//   }
//   h2{
//     font-size:1.35rem;margin-top:28px;padding-bottom:8px;
//     border-bottom:2px solid var(--accent-purple);font-weight:700
//   }
//   h3{font-size:1.08rem;margin-top:20px}

//   p{margin:0 0 12px}
//   ul,ol{margin:8px 0 16px;padding-left:22px}
//   li{margin:6px 0}

//   /* “pill” angle cards (red bar at left) */
//   .angle,.card{
//     background:#1b2230;border:1px solid var(--rule);border-left:6px solid var(--accent-red);
//     border-radius:12px;padding:14px 16px;margin:14px 0
//   }

//   /* subtle horizontal rules between packages */
//   hr{border:0;border-top:1px solid var(--rule);margin:22px 0}

//   /* Details text styles */
//   .muted{color:var(--muted)}
//   strong{font-weight:700}
//   em{opacity:.95}

//   /* Code/fallback blocks (rare) */
//   pre,code{background:#0b0f16;border:1px solid var(--rule);border-radius:8px}
//   pre{padding:12px;overflow:auto}
//   code{padding:2px 6px}

//   /* Links inside doc (if any) */
//   a{color:#c4b5fd;text-decoration:none}
//   a:hover{text-decoration:underline}

//   /* Make any top-level UL right under h1 look spaced nicely */
//   h1 + p, h1 + ul, h1 + div{margin-top:10px}
// </style>
// </head>
// <body>
//   <main class="page">
//     ${innerHtml}
//   </main>

//   <script>
//     /* Post-process: if the model emitted “angle” lines as plain paragraphs,
//        heuristically wrap lines that start with certain keywords into .angle cards. */
//     (function(){
//       try{
//         const container=document.querySelector('.page');
//         if(!container) return;
//         const triggers=['Shocking','Shock','Human','Empathy','Police','Procedural','Twist','Revelation','The '];
//         const ps=[...container.querySelectorAll('p')];
//         ps.forEach(p=>{
//           const t=(p.textContent||'').trim();
//           if(t && triggers.some(k=>t.startsWith(k))){
//             const wrap=document.createElement('div');
//             wrap.className='angle';
//             p.replaceWith(wrap);
//             wrap.appendChild(p);
//           }
//         });
//       }catch(_e){}
//     })();
//   </script>
// </body>
// </html>`;
// }
// function normalizeModelHtml(raw) {
//   let s = String(raw || '').trim();
//   s = stripCodeFences(s);
//   s = sanitizeNoScripts(s);
//   const { isFull, body } = extractBodyIfFullHtml(s);
//   return wrapInTemplate(body);
// }

// // ---- Server-side GS cache (kept) ----
// let serverGS = { json: '', csv: '', kw: '' };

// async function fileExists(p) {
//   try { await fs.promises.access(p, fs.constants.R_OK); return true; }
//   catch { return false; }
// }

// async function loadDocxToText(filePath) {
//   const buf = await readFile(filePath);
//   const { value } = await mammoth.extractRawText({ buffer: buf });
//   return String(value || '').trim();
// }

// async function loadServerGS() {
//   const loaded = { json:false, csv:false, kw:false };
//   try {
//     if (GS_JSON_PATH && await fileExists(GS_JSON_PATH)) {
//       const txt = await readFile(GS_JSON_PATH, 'utf-8');
//       try { JSON.parse(txt); serverGS.json = clip(txt, GS_CAP.json); loaded.json = true; }
//       catch { console.warn('⚠️  DATASET.json is not valid JSON — skipping'); }
//     }
//     if (GS_CSV_PATH && await fileExists(GS_CSV_PATH)) {
//       const txt = await readFile(GS_CSV_PATH, 'utf-8');
//       serverGS.csv = clip(txt, GS_CAP.csv);
//       loaded.csv = true;
//     }
//     if (GS_DOCX_PATH && await fileExists(GS_DOCX_PATH)) {
//       const kw = await loadDocxToText(GS_DOCX_PATH);
//       serverGS.kw = clip(kw, GS_CAP.kw);
//       loaded.kw = true;
//     }
//   } catch (e) {
//     console.error('❌ Failed loading server GS:', e?.message || e);
//   }
//   const all = loaded.json && loaded.csv && loaded.kw;
//   console.log(`GS loaded: json=${loaded.json} csv=${loaded.csv} kw=${loaded.kw} (all=${all})`);
//   return loaded;
// }

// // Load GS at boot
// await loadServerGS();

// // ---- Build model message parts (unchanged core logic) ----
// function buildGSIngestParts(gsJsonStr, gsCsvStr, keywordsFullText) {
//   const parts = [];
//   parts.push({
//     text:
//       "TAKE THESE AS GOLD STANDARD TITLES AND THUMBNAILS ALONG WITH ALL THE VIRAL IMPORTANT KEYWORDS ATTACHED. THESE ARE THE TOP PERFORMING VIDEOS. KEEP THESE IN YOUR MEMORY."
//   });

//   const append = (label, raw, size = 24000) => {
//     parts.push({ text: `\n\n---\n${label}\n---\n` });
//     const s = String(raw || '');
//     for (let i = 0; i < s.length; i += size) parts.push({ text: s.slice(i, i + size) });
//   };

//   append("GOLD STANDARD: DATASET.json (RAW)", gsJsonStr || '');
//   append("GOLD STANDARD: Top10_Viral_Titles_Thumbnails_AllChannels.csv (RAW)", gsCsvStr || '');
//   append("GOLD STANDARD: Viral_Crime_Niche_Master_Keywords.docx (PLAIN TEXT)", keywordsFullText || '');
//   return parts;
// }

// function buildFinalInstructionParts({ videoSource, topic, titleHint, strategistPrompt, contextText }) {
//   const runContext = `
// VIDEO INPUT (authoritative; do not invent facts). Use the attached video fully:
// ${(contextText || "").trim()}

// Video Source: ${videoSource}
// Optional Topic: ${topic || "(none)"} | Optional Angle Hint: ${titleHint || "(none)"}

// MANDATORY:
// - Use ONLY the attached video + VIDEO INPUT + learned gold-standard patterns.
// - Do not assume/fabricate details not present.
// - Output CLEAN HTML only (no preface).
// - Start with "Video Summary & Core Angles" (video-specific), then 10 Title & Thumbnail Packages.
// `.trim();

//   return [
//     { text: String(strategistPrompt || '').trim() },
//     { text: runContext }
//   ];
// }

// // ---- Files API upload + ACTIVE polling (UPDATED timeout/backoff & logs) ----
// async function waitForFileActive(
//   fileId,
//   {
//     timeoutMs = FILES_ACTIVE_TIMEOUT_MS,
//     initialDelay = FILES_INITIAL_DELAY_MS,
//     maxDelay = FILES_MAX_DELAY_MS
//   } = {}
// ) {
//   const started = Date.now();
//   let delay = initialDelay;
//   let lastState = 'UNKNOWN';
//   let lastUri = '';

//   let checks = 0;
//   while (Date.now() - started < timeoutMs) {
//     checks++;
//     const metaResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileId}?key=${API_KEY}`);
//     if (!metaResp.ok) {
//       const txt = await metaResp.text().catch(()=> '');
//       throw new Error(`Files API GET failed (${metaResp.status}): ${txt}`);
//     }
//     const meta = await metaResp.json();
//     const state = meta?.state || meta?.fileState || 'UNKNOWN';
//     const uri = meta?.uri || meta?.file?.uri || '';

//     lastState = state;
//     lastUri = uri;

//     if (state === 'ACTIVE' && uri) {
//       console.log(`📦 Files API: ${fileId} ACTIVE after ${checks} checks (${Math.round((Date.now()-started)/1000)}s)`);
//       return { uri, state };
//     }

//     // log occasionally to see progress
//     if (checks === 1 || checks % 5 === 0) {
//       console.log(`⌛ Files API: ${fileId} state=${state} (waiting ${delay}ms)`);
//     }

//     await new Promise(r => setTimeout(r, delay));
//     delay = Math.min(maxDelay, Math.floor(delay * 1.6));
//   }

//   throw new Error(`File did not become ACTIVE in time (lastState=${lastState}, uri=${lastUri ? 'present' : 'missing'})`);
// }

// /** STREAMING upload (no fs.readFile buffer) */
// /** STREAMING upload (no fs.readFile buffer) with duplex fix + safe fallback */
// async function uploadPathToFilesAPI(filePath, mimeType, displayName) {
//   const url = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${API_KEY}`;

//   // ---------- Attempt A: pure streaming with `form-data` ----------
//   try {
//     const form = new (await import('form-data')).default();
//     form.append('file', fs.createReadStream(filePath), {
//       filename: displayName || path.basename(filePath),
//       contentType: mimeType || 'application/octet-stream'
//     });

//     const headers = form.getHeaders();
//     // Optional: set Content-Length (helps some proxies)
//     const length = await new Promise((resolve) =>
//       form.getLength((err, len) => resolve(err ? undefined : len))
//     );
//     if (typeof length === 'number') headers['Content-Length'] = String(length);

//     const resp = await fetch(url, {
//       method: 'POST',
//       headers,
//       body: form,
//       // 👇 REQUIRED by Node.js fetch when the request body is a stream
//       duplex: 'half'
//     });

//     const text = await resp.text();
//     if (!resp.ok) {
//       throw new Error(`Files API upload failed (${resp.status}): ${text}`);
//     }

//     let data; try { data = JSON.parse(text); }
//     catch { throw new Error(`Files API returned non-JSON: ${text}`); }

//     const fileId = data?.file?.name;
//     if (!fileId) throw new Error(`Files API response missing file.name: ${JSON.stringify(data)}`);

//     const { uri } = await waitForFileActive(fileId);
//     return { fileUri: uri, fileId };
//   } catch (err) {
//     console.warn('⚠️ Streaming upload failed, will retry once with buffer fallback:', err?.message || err);
//   }

//   // ---------- Attempt B (fallback): buffer → undici File ----------
//   try {
//     const { File } = await import('undici'); // already a dependency in your project
//     const buf = await fs.promises.readFile(filePath);
//     const file = new File([buf], displayName || path.basename(filePath), {
//       type: mimeType || 'application/octet-stream'
//     });

//     const { FormData } = await import('undici');
//     const form = new FormData();
//     form.append('file', file);

//     const resp = await fetch(url, { method: 'POST', body: form });
//     const text = await resp.text();
//     if (!resp.ok) throw new Error(`Files API upload (fallback) failed (${resp.status}): ${text}`);

//     let data; try { data = JSON.parse(text); }
//     catch { throw new Error(`Files API returned non-JSON (fallback): ${text}`); }

//     const fileId = data?.file?.name;
//     if (!fileId) throw new Error(`Files API response missing file.name (fallback): ${JSON.stringify(data)}`);

//     const { uri } = await waitForFileActive(fileId);
//     return { fileUri: uri, fileId };
//   } catch (err) {
//     // Bubble up the original reason so the client sees a useful message
//     console.error('❌ Upload error (fallback path):', err?.stack || err?.message || err);
//     throw err;
//   }
// }



// // ---- Health ----
// app.get('/health', (req, res) => res.send('ok'));

// // ---- GS status & reload (kept) ----
// app.get('/api/gs-status', (req, res) => {
//   res.json({
//     ok: true,
//     serverGS: {
//       json: !!serverGS.json,
//       csv:  !!serverGS.csv,
//       kw:   !!serverGS.kw,
//       all:  !!(serverGS.json && serverGS.csv && serverGS.kw)
//     },
//     paths: {
//       json: GS_JSON_PATH || null,
//       csv:  GS_CSV_PATH  || null,
//       kw:   GS_DOCX_PATH || null
//     }
//   });
// });

// app.post('/api/gs-reload', async (req, res) => {
//   const loaded = await loadServerGS();
//   res.json({ ok: true, loaded });
// });

// /* =========================================================
//    1) Upload local MP4 -> DISK temp -> Files API -> delete
//    ========================================================= */
// app.post('/api/upload-video', upload.single('video'), async (req, res) => {
//   const filePath = req?.file?.path;
//   const mime     = req?.file?.mimetype || 'video/mp4';
//   const name     = req?.file?.originalname || 'uploaded-video.mp4';

//   if (!filePath) return res.status(400).json({ ok: false, error: 'No video uploaded' });
//   console.log(`⬆️  /api/upload-video  path=${filePath} mime=${mime} size=${req.file.size}`);

//   try {
//     const { fileUri, fileId } = await uploadPathToFilesAPI(filePath, mime, name);
//     console.log(`✅  Uploaded to Files API: ${fileId} (ACTIVE)`);
//     res.json({ ok: true, fileUri, fileId, mimeType: mime, fileMime: mime, displayName: name });
//   } catch (err) {
//     console.error('Upload error:', err?.message || err);
//     res.status(500).json({ ok: false, error: err?.message || 'Upload failed' });
//   } finally {
//     // Always clean temp file
//     try { await unlink(filePath); } catch {}
//   }
// });

// /* =========================================================
//    2) Fetch YouTube -> write to DISK temp -> Files API -> delete
//       - ytdl-core fast path
//       - yt-dlp fallback (handles 403/decipher changes)
//    ========================================================= */

// // yt-dlp one-time download to ./bin
// const BIN_DIR    = path.join(__dirname, 'bin');
// const YTDLP_EXE  = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
// const YTDLP_PATH = path.join(BIN_DIR, YTDLP_EXE);

// async function ensureYtDlp() {
//   try { await fs.promises.access(YTDLP_PATH, fs.constants.X_OK); return YTDLP_PATH; } catch {}
//   await fs.promises.mkdir(BIN_DIR, { recursive: true });
//   const url = process.platform === 'win32'
//     ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
//     : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
//   console.log(`⬇️  Downloading yt-dlp from ${url}`);
//   const r = await fetch(url);
//   if (!r.ok) throw new Error(`yt-dlp download failed: ${r.status}`);
//   const buf = Buffer.from(await r.arrayBuffer());
//   await fs.promises.writeFile(YTDLP_PATH, buf, { mode: 0o755 });
//   console.log('✅  yt-dlp downloaded');
//   return YTDLP_PATH;
// }

// async function downloadWithYtDlpToPath(url) {
//   const ytdlp   = await ensureYtDlp();
//   const outPath = path.join(os.tmpdir(), `yt_${Date.now()}.mp4`);
//   const args = [
//     '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
//     '--merge-output-format', 'mp4',
//     '--no-playlist',
//     '--quiet', '--no-warnings',
//     '-o', outPath,
//     url
//   ];
//   console.log('▶️  yt-dlp', args.join(' '));
//   await new Promise((resolve, reject) => {
//     execFile(ytdlp, args, { windowsHide: true }, (err) => err ? reject(err) : resolve());
//   });

//   // friendly name
//   let displayName = `youtube-video-${Date.now()}.mp4`;
//   try {
//     await new Promise((resolve) => {
//       execFile(ytdlp, ['--get-title', '--no-playlist', url], { windowsHide: true }, (e, stdout) => {
//         const t = String(stdout || '').split('\n')[0].trim();
//         if (t) displayName = `${t}`.replace(/[^\w.\-]+/g, '_') + '.mp4';
//         resolve();
//       });
//     });
//   } catch {}
//   return { outPath, displayName, mime: 'video/mp4' };
// }

// app.post('/api/fetch-youtube', async (req, res) => {
//   try {
//     let { url } = req.body || {};
//     if (!url) return res.status(400).json({ ok: false, error: 'Missing YouTube URL' });

//     // Normalize youtu.be and strip tracking params
//     try {
//       const id = ytdl.getURLVideoID(url);
//       url = `https://www.youtube.com/watch?v=${id}`;
//     } catch {
//       return res.status(400).json({ ok: false, error: 'Invalid YouTube URL' });
//     }

//     console.log(`⬇️  /api/fetch-youtube  url=${url}`);

//     // Attempt 1: ytdl-core → DISK temp
//     try {
//       const headers = {
//         'user-agent':
//           'Mozilla/5.0 (Windows NT 10.0; Win32; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
//         'accept-language': 'en-US,en;q=0.9',
//       };

//       const info = await ytdl.getInfo(url, { requestOptions: { headers } });

//       let fmt =
//         ytdl.chooseFormat(info.formats, {
//           quality: 'highest',
//           filter: (f) =>
//             f.hasAudio &&
//             f.hasVideo &&
//             (f.container === 'mp4' || (f.mimeType || '').includes('mp4')),
//         }) ||
//         ytdl.chooseFormat(info.formats, {
//           quality: 'highest',
//           filter: (f) => f.hasAudio && f.hasVideo,
//         });

//       if (!fmt || !fmt.url) throw new Error('No direct AV format URL');

//       const mime =
//         fmt.mimeType?.split(';')[0] ||
//         (fmt.container === 'mp4' ? 'video/mp4' : 'video/webm');

//       const safeTitle = (info.videoDetails?.title || 'youtube-video').replace(/[^\w.\-]+/g, '_');
//       const ext = mime === 'video/mp4' ? '.mp4' : '.webm';
//       const tempPath = path.join(os.tmpdir(), `${Date.now()}-${safeTitle}${ext}`);

//       // Stream to DISK
//       await new Promise((resolve, reject) => {
//         const r = ytdl.downloadFromInfo(info, { format: fmt, requestOptions: { headers } });
//         const w = fs.createWriteStream(tempPath);
//         r.pipe(w);
//         r.on('error', reject);
//         w.on('finish', resolve);
//         w.on('error', reject);
//       });

//       // Upload from DISK → Gemini
//       try {
//         const { fileUri, fileId } = await uploadPathToFilesAPI(tempPath, mime, path.basename(tempPath));
//         console.log(`✅  YouTube uploaded via ytdl-core: ${fileId} (ACTIVE)`);
//         return res.json({ ok: true, fileUri, fileId, mimeType: mime, fileMime: mime, displayName: path.basename(tempPath) });
//       } finally {
//         try { await unlink(tempPath); } catch {}
//       }
//     } catch (e1) {
//       console.warn('⚠️  ytdl-core fetch failed; falling back to yt-dlp:', e1?.message || e1);
//     }

//     // Attempt 2: yt-dlp → DISK temp → Gemini
//     const { outPath, displayName, mime } = await downloadWithYtDlpToPath(url);
//     try {
//       const { fileUri, fileId } = await uploadPathToFilesAPI(outPath, mime, displayName);
//       console.log(`✅  YouTube uploaded via yt-dlp: ${fileId} (ACTIVE)`);
//       return res.json({ ok: true, fileUri, fileId, mimeType: mime, fileMime: mime, displayName });
//     } finally {
//       try { await unlink(outPath); } catch {}
//     }
//   } catch (err) {
//     console.error('YouTube fetch error:', err?.message || err);
//     const msg =
//       /private|copyright|410|signin|age|forbidden|403/i.test(err?.message || '')
//         ? 'Video is restricted (private/age/region). Try another public URL.'
//         : err?.message || 'YouTube fetch failed';
//     res.status(500).json({ ok: false, error: msg });
//   }
// });

// /* ===============================
//    HistoryStore (20 GB filesystem)
//    =============================== */
// const DATA_DIR  = path.join(__dirname, 'data');
// const HIST_DIR  = process.env.HIST_DIR || path.join(DATA_DIR, 'history');
// const INDEX_PATH = path.join(HIST_DIR, 'index.json');
// const HISTORY_LIMIT_BYTES = BigInt(process.env.HISTORY_LIMIT_BYTES || 20 * 1024 * 1024 * 1024); // 20 GB

// fs.mkdirSync(HIST_DIR, { recursive: true });

// class HistoryStore {
//   constructor(dir, indexPath, limitBytes) {
//     this.dir = dir;
//     this.indexPath = indexPath;
//     this.limit = BigInt(limitBytes);
//     this._ensureIndex();
//   }
//   _ensureIndex() {
//     if (!fs.existsSync(this.indexPath)) {
//       fs.writeFileSync(this.indexPath, JSON.stringify({ items: [] }), 'utf-8');
//     }
//   }
//   _readIndex() {
//     try {
//       return JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')) || { items: [] };
//     } catch { return { items: [] }; }
//   }
//   _writeIndex(idx) {
//     fs.writeFileSync(this.indexPath, JSON.stringify(idx), 'utf-8');
//   }
//   _usage(idx) {
//     return idx.items.reduce((a, b) => a + BigInt(b.size_bytes || 0), 0n);
//   }
//   stats() {
//     const idx = this._readIndex();
//     return {
//       limit: Number(this.limit),
//       used : Number(this._usage(idx)),
//       remaining: Number(this._usage(idx) > this.limit ? 0n : (this.limit - this._usage(idx))),
//       count: idx.items.length
//     };
//   }
//   search({ q = '', page = 1, limit = 50 }) {
//     const idx = this._readIndex();
//     const norm = q.trim().toLowerCase();
//     let items = idx.items;
//     if (norm) {
//       items = items.filter(x =>
//         String(x.title||'').toLowerCase().includes(norm) ||
//         String(x.preview||'').toLowerCase().includes(norm)
//       );
//     }
//     items.sort((a,b)=> b.created_at - a.created_at);
//     const offset = (page - 1) * limit;
//     const slice = items.slice(offset, offset + limit)
//       .map(({ id, title, created_at, size_bytes, preview }) => ({ id, title, created_at, size_bytes, preview }));
//     return { items: slice, total: items.length, page, limit };
//   }
//   async get(id) {
//     const idx = this._readIndex();
//     const it = idx.items.find(x => x.id === id);
//     if (!it) return null;
//     const raw = await fs.promises.readFile(it.file_path);
//     const buf = zlib.gunzipSync(raw);
//     const data = JSON.parse(buf.toString('utf-8'));
//     return { meta: it, data };
//   }
//   async delete(id) {
//     const idx = this._readIndex();
//     const i = idx.items.findIndex(x => x.id === id);
//     if (i === -1) return false;
//     try { if (fs.existsSync(idx.items[i].file_path)) await fs.promises.unlink(idx.items[i].file_path); } catch {}
//     idx.items.splice(i, 1);
//     this._writeIndex(idx);
//     return true;
//   }
//   async purgeOldestUntilFree(bytesNeeded) {
//     const needed = BigInt(bytesNeeded || 0);
//     const idx = this._readIndex();
//     idx.items.sort((a,b)=> a.created_at - b.created_at);
//     let used = this._usage(idx);
//     const evicted = [];
//     let p = 0;
//     while (used + needed > this.limit && p < idx.items.length) {
//       const it = idx.items[p++];
//       try { if (fs.existsSync(it.file_path)) fs.unlinkSync(it.file_path); } catch {}
//       used -= BigInt(it.size_bytes || 0);
//       evicted.push(it.id);
//     }
//     idx.items = idx.items.filter(x => !evicted.includes(x.id));
//     this._writeIndex(idx);
//     return { evicted, used: Number(used), limit: Number(this.limit) };
//   }
//   _gzip(obj) { return zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf-8'), { level: 9 }); }
//   _previewFromHTML(html) {
//     const text = String(html||'').replace(/<script[\s\S]*?<\/script>/gi,'')
//       .replace(/<style[\s\S]*?<\/style>/gi,'')
//       .replace(/<[^>]+>/g,' ')
//       .replace(/\s+/g,' ')
//       .trim();
//     return text.length > 180 ? text.slice(0,180) + '…' : text;
//   }
//   save({ title, html, extraMeta }) {
//     const idx = this._readIndex();
//     const used = this._usage(idx);
//     const gz = this._gzip({ html, meta: extraMeta || null, ts: Date.now() });
//     const newSize = BigInt(gz.byteLength);
//     if (used + newSize > this.limit) {
//       const needed = Number((used + newSize) - this.limit);
//       return { error: 'STORAGE_LIMIT_EXCEEDED', needed, used: Number(used), limit: Number(this.limit) };
//     }
//     const id = randomUUID();
//     const file_path = path.join(this.dir, `${id}.json.gz`);
//     fs.writeFileSync(file_path, gz);
//     const entry = {
//       id,
//       title: String(title || 'Generated Package').slice(0, 200),
//       created_at: Date.now(),
//       size_bytes: Number(newSize),
//       file_path,
//       preview: this._previewFromHTML(html)
//     };
//     idx.items.push(entry);
//     this._writeIndex(idx);
//     return { id, size_bytes: Number(newSize) };
//   }
// }

// const historyStore = new HistoryStore(HIST_DIR, INDEX_PATH, HISTORY_LIMIT_BYTES);

// /* ======================
//    History HTTP Endpoints
//    ====================== */

// // Stats
// app.get('/api/history-stats', (req, res) => res.json(historyStore.stats()));

// // List/search
// app.get('/api/history', (req, res) => {
//   const q = String(req.query.q || '');
//   const page = Math.max(parseInt(req.query.page || '1', 10), 1);
//   const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
//   res.json(historyStore.search({ q, page, limit }));
// });

// // Read one (JSON)
// app.get('/api/history/:id', async (req, res) => {
//   const item = await historyStore.get(req.params.id);
//   if (!item) return res.status(404).json({ error: 'Not found' });
//   res.json(item);
// });

// // NEW: Serve the saved HTML directly (for Open/Open in new tab/Download)
// app.get('/api/history/:id/html', async (req, res) => {
//   const item = await historyStore.get(req.params.id);
//   if (!item) return res.status(404).send('Not found');
//   const html = String(item.data?.html || '');
//   const download = String(req.query.download || '').toLowerCase() === '1';
//   if (download) {
//     res.setHeader('Content-Disposition', `attachment; filename="${(item.meta?.title || 'Generated_Package').replace(/[^\w.-]/g,'_')}.html"`);
//   }
//   res.setHeader('Content-Type', 'text/html; charset=utf-8');
//   res.send(html);
// });

// // Delete one
// app.delete('/api/history/:id', async (req, res) => {
//   const ok = await historyStore.delete(req.params.id);
//   if (!ok) return res.status(404).json({ error: 'Not found' });
//   res.json({ ok: true });
// });

// // Purge (oldest)
// app.post('/api/history/purge', async (req, res) => {
//   const mode = String(req.query.mode || 'oldest');
//   if (mode !== 'oldest') return res.status(400).json({ error: 'Unsupported mode' });
//   const bytes = Number(req.query.bytes || req.body?.bytes || 0);
//   const result = await historyStore.purgeOldestUntilFree(bytes);
//   res.json(result);
// });

// /* =========================================================
//    3) Generate (two-turn; video attached) — now normalizes HTML
//    ========================================================= */
// app.post('/api/generate', async (req, res) => {
//   try {
//     const {
//       fileUri, fileMime = 'video/mp4', videoSource = 'N/A', displayName,
//       strategistPrompt = '', topic = '', titleHint = '', contextText = '',
//       gsJson = '', gsCsv = '', gsKeywordsText = ''
//     } = req.body || {};

//     console.log('▶️  /api/generate', {
//       hasFileUri: !!fileUri,
//       mime: fileMime,
//       topic: clip(topic, 60),
//       hint: clip(titleHint, 60),
//       ctxLen: (contextText || '').length,
//       gs: { json: (gsJson || '').length, csv: (gsCsv || '').length, kw: (gsKeywordsText || '').length },
//       serverGS: { json: !!serverGS.json, csv: !!serverGS.csv, kw: !!serverGS.kw }
//     });

//     if (!fileUri)          return res.status(400).json({ ok: false, error: 'fileUri missing' });
//     if (!strategistPrompt) return res.status(400).json({ ok: false, error: 'strategistPrompt missing' });

//     // Prefer server GS; fallback to client-provided GS to preserve old behavior
//     const useJson = serverGS.json || clip(gsJson, 150000);
//     const useCsv  = serverGS.csv  || clip(gsCsv, 100000);
//     const useKw   = serverGS.kw   || clip(gsKeywordsText, 100000);

//     const model = genAI.getGenerativeModel({
//       model: MODEL,
//       systemInstruction: "Follow output format exactly; store gold-standard patterns internally; do not leak chain-of-thought."
//     });

//     const history = [
//       { role: 'user', parts: buildGSIngestParts(useJson, useCsv, useKw) },
//       {
//         role: 'user',
//         parts: [
//           { text: "\n\n---\nATTACHED VIDEO (analyze full visuals + audio)\n---\n" },
//           { fileData: { fileUri, mimeType: fileMime } }
//         ]
//       }
//     ];

//     const chat = model.startChat({
//       history,
//       generationConfig: {
//         temperature: 0.35,
//         topP: 0.9,
//         topK: 40,
//         candidateCount: 1,
//         maxOutputTokens: 8192,
//         responseMimeType: "text/plain" // allowed; model still returns HTML text
//       }
//     });

//     // Acknowledge context (stability)
//     await chat.sendMessage([{ text: "Acknowledge gold standard + attached video in one short sentence." }]);

//     const parts = buildFinalInstructionParts({ videoSource, topic, titleHint, strategistPrompt, contextText });
//     const result = await chat.sendMessage(parts);

//     let raw = "";
//     try { raw = result?.response?.text?.() || ""; } catch (e) { console.error("result.response.text() failed:", e); }

//     const candidate = result?.response?.candidates?.[0];
//     const meta = {
//       finishReason: candidate?.finishReason,
//       safety: candidate?.safetyRatings,
//       usage: result?.response?.usageMetadata
//     };

//     if (!raw.trim()) {
//       console.error("Empty HTML; full API response:", JSON.stringify(result, null, 2));
//       return res.status(502).json({
//         ok: false,
//         error: "Model returned empty response. See server logs for details.",
//         meta
//       });
//     }

//     // ✅ Normalize into one consistent, styled HTML page
//     const normalizedHtml = normalizeModelHtml(raw);

//     console.log('✅  Generation OK');

//     // === UPDATED: smarter title for history
//     let title =
//       (topic && topic.trim()) ||
//       (titleHint && titleHint.trim()) ||
//       (displayName && humanizeFileName(displayName)) ||
//       'Generated Package';

//     if (title === 'Generated Package') {
//       const h = normalizedHtml.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/i) || normalizedHtml.match(/^\s*#+\s*([^\n]+)/m);
//       if (h && h[1]) title = h[1].trim().slice(0, 80);
//     }

//     // Save to history (store normalized HTML)
//     const saved = historyStore.save({
//       title,
//       html: normalizedHtml,
//       extraMeta: {
//         meta,
//         input: { videoSource, topic, titleHint, contextText, displayName }
//       }
//     });

//     // collect stats and optional save info
//     let historyPayload = null;
//     let storage = historyStore.stats();
//     if (saved?.error === 'STORAGE_LIMIT_EXCEEDED') {
//       historyPayload = { saved: false, reason: 'STORAGE_LIMIT_EXCEEDED', needed: saved.needed };
//     } else if (saved?.id) {
//       historyPayload = { saved: true, id: saved.id, size_bytes: saved.size_bytes };
//     }

//     // Return normalized HTML to client → your Preview tab will render the exact same page
//     return res.json({ ok: true, html: normalizedHtml, meta, history: historyPayload, storage });
//   } catch (err) {
//     console.error("GENERATION ERROR:");
//     console.error(err?.stack || err?.message || String(err));
//     try { console.error("Raw error object:", JSON.stringify(err, null, 2)); } catch {}
//     return res.status(500).json({
//       ok: false,
//       error: err?.message || 'Generation failed (see server logs).'
//     });
//   }
// });

// // ✅ Longer timeouts help slow networks/big uploads avoid abrupt "Failed to fetch"
// const server = app.listen(PORT, () => console.log(`Server running http://0.0.0.0:${PORT}`));

// // Use env-driven timeouts; provide generous defaults for long uploads
// server.headersTimeout   = Number(process.env.SERVER_HEADERS_TIMEOUT_MS  || 2  * 60 * 1000);  // 2 minutes
// server.requestTimeout   = Number(process.env.SERVER_REQUEST_TIMEOUT_MS  || 60 * 60 * 1000);  // 60 minutes
// server.keepAliveTimeout = Number(process.env.SERVER_KEEPALIVE_TIMEOUT_MS|| 10 * 60 * 1000);  // 10 minutes






//////////////////////////////////////





///////NEW FEATURES ADDED




// // server.js
// import 'dotenv/config';
// import fs from 'fs';
// import os from 'os';
// import path from 'path';
// import { fileURLToPath } from 'url';
// import { promisify } from 'util';
// import express from 'express';
// import cors from 'cors';
// import multer from 'multer';

// // Video fetchers
// import ytdl from 'ytdl-core';
// import { execFile } from 'child_process';

// // Gemini SDK + docx
// import { GoogleGenerativeAI } from '@google/generative-ai';
// import mammoth from 'mammoth';

// // ✅ Streaming multipart for large files (no RAM buffering)
// import FormData from 'form-data';

// // === history deps ===
// import zlib from 'zlib';
// import { randomUUID } from 'crypto';

// const unlink = promisify(fs.unlink);
// const writeFile = promisify(fs.writeFile);
// const readFile  = promisify(fs.readFile);

// // __dirname for ESM
// const __filename = fileURLToPath(import.meta.url);
// const __dirname  = path.dirname(__filename);

// const app = express();

// // ✅ CORS
// app.use(cors({ origin: true, credentials: true }));
// app.options('*', cors({ origin: true, credentials: true }));

// // ✅ Larger body limit (for large JSON fallbacks etc.)
// app.use(express.json({ limit: '200mb' }));
// app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// // Serve frontend
// const PUBLIC_DIR = path.join(__dirname, 'public');
// app.use(express.static(PUBLIC_DIR));

// /* =========================================================
//    Storage (data/, uploads/, history/)
//    ========================================================= */
// const DATA_DIR       = path.join(__dirname, 'data');
// const UPLOADS_DIR    = path.join(DATA_DIR, 'uploads');  // <— keep a copy for history playback
// const HIST_DIR       = process.env.HIST_DIR || path.join(DATA_DIR, 'history');
// const INDEX_PATH     = path.join(HIST_DIR, 'index.json');
// const HISTORY_LIMIT_BYTES = BigInt(process.env.HISTORY_LIMIT_BYTES || 20 * 1024 * 1024 * 1024); // 20 GB

// fs.mkdirSync(DATA_DIR,   { recursive: true });
// fs.mkdirSync(UPLOADS_DIR,{ recursive: true });
// fs.mkdirSync(HIST_DIR,   { recursive: true });

// /* =========================================================
//    Multer — DISK storage
//    ========================================================= */
// const MULTER_MAX_FILE_SIZE = Number(process.env.MULTER_MAX_FILE_SIZE || 5 * 1024 * 1024 * 1024); // default 5GB
// const upload = multer({
//   storage: multer.diskStorage({
//     destination: (req, file, cb) => cb(null, os.tmpdir()),
//     filename: (req, file, cb) =>
//       cb(null, `${Date.now()}-${(file.originalname || 'upload.mp4').replace(/[^\w.\-]+/g, '_')}`)
//   }),
//   limits: { fileSize: MULTER_MAX_FILE_SIZE }
// });

// const API_KEY = process.env.GOOGLE_API_KEY;
// const MODEL   = process.env.MODEL || 'gemini-2.5-pro';
// const PORT    = process.env.PORT || 3002;

// const GS_JSON_PATH = process.env.GS_JSON_PATH || '';
// const GS_CSV_PATH  = process.env.GS_CSV_PATH  || '';
// const GS_DOCX_PATH = process.env.GS_DOCX_PATH || '';

// const FILES_ACTIVE_TIMEOUT_MS = Number(process.env.FILES_ACTIVE_TIMEOUT_MS || 30 * 60 * 1000);
// const FILES_INITIAL_DELAY_MS  = Number(process.env.FILES_INITIAL_DELAY_MS || 1200);
// const FILES_MAX_DELAY_MS      = Number(process.env.FILES_MAX_DELAY_MS || 5000);

// if (!API_KEY) {
//   console.error('❌ Missing GOOGLE_API_KEY in .env');
//   process.exit(1);
// }

// const genAI = new GoogleGenerativeAI(API_KEY);

// // ---- Helpers
// function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }
// const GS_CAP = { json: 180000, csv: 120000, kw: 120000 };

// function humanizeFileName(name) {
//   const base = String(name || '')
//     .replace(/[/\\]+/g, ' ')
//     .replace(/\.[a-z0-9]+$/i, '');
//   const spaced = base.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
//   const stripped = spaced
//     .replace(/\b(vid|mov|img|pxl|dji|gopr|frame|clip)\b/gi, '')
//     .replace(/\b(20\d{2}[-_.]?\d{2}[-_.]?\d{2}|\d{8}_\d{6})\b/g, '')
//     .replace(/\s{2,}/g, ' ')
//     .trim();
//   const titled = stripped.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
//   return (titled || 'Local Video').slice(0, 80);
// }

// function stripCodeFences(s) {
//   const fence = s.match(/^\s*```(?:html|HTML)?\s*([\s\S]*?)\s*```\s*$/);
//   if (fence) return fence[1];
//   return s.replace(/^\s*```(?:html|HTML)?\s*/, '').replace(/\s*```\s*$/, '');
// }
// function extractBodyIfFullHtml(s) {
//   const hasHtml = /<html[\s\S]*?>/i.test(s);
//   if (!hasHtml) return { isFull: false, body: s };
//   const bodyMatch = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
//   if (bodyMatch) return { isFull: true, body: bodyMatch[1] };
//   return { isFull: true, body: s };
// }
// function sanitizeNoScripts(s) {
//   return s.replace(/<script[\s\S]*?<\/script>/gi, '');
// }

// /* ********************************************************************
//    IMPORTANT CHANGE: no player injection into output HTML anymore.
//    ******************************************************************** */
// function buildPlayerSection(){ return { css:'', html:'', js:'' }; }

// function wrapInTemplate(innerHtml /*, inputMeta */) {
//   const player = buildPlayerSection();
//   return `<!doctype html>
// <html lang="en">
// <head>
// <meta charset="utf-8">
// <meta name="viewport" content="width=device-width,initial-scale=1">
// <title>Video Summary & Core Angles</title>
// <style>
//   :root{ --bg:#0c1016; --panel:#151a23; --ink:#e9edf4; --muted:#a3acba; --rule:#2b3240; --accent-red:#ef4444; --accent-purple:#7c3aed; }
//   *{box-sizing:border-box}
//   html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,"Apple Color Emoji","Segoe UI Emoji"}
//   .page{max-width:980px;margin:36px auto;padding:28px;background:var(--panel);border:1px solid var(--rule);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
//   h1,h2,h3{line-height:1.25;margin:0 0 14px}
//   h1{font-size:2.1rem;font-weight:800;padding-bottom:12px;border-bottom:3px solid var(--accent-red);letter-spacing:.2px}
//   h2{font-size:1.35rem;margin-top:28px;padding-bottom:8px;border-bottom:2px solid var(--accent-purple);font-weight:700}
//   h3{font-size:1.08rem;margin-top:20px}
//   p{margin:0 0 12px}
//   ul,ol{margin:8px 0 16px;padding-left:22px}
//   li{margin:6px 0}
//   .angle,.card{background:#1b2230;border:1px solid var(--rule);border-left:6px solid var(--accent-red);border-radius:12px;padding:14px 16px;margin:14px 0}
//   hr{border:0;border-top:1px solid var(--rule);margin:22px 0}
//   .muted{color:var(--muted)}
//   pre,code{background:#0b0f16;border:1px solid var(--rule);border-radius:8px}
//   pre{padding:12px;overflow:auto}
//   code{padding:2px 6px}
//   a{color:#c4b5fd;text-decoration:none}
//   a:hover{text-decoration:underline}
//   ${player.css}
// </style>
// </head>
// <body>
//   <main class="page">
//     ${innerHtml}
//   </main>
// </body>
// </html>`;
// }

// function normalizeModelHtml(raw, inputMeta) {
//   let s = String(raw || '').trim();
//   s = stripCodeFences(s);
//   s = sanitizeNoScripts(s);
//   const { body } = extractBodyIfFullHtml(s);
//   return wrapInTemplate(body, inputMeta || {});
// }

// // ---- Server-side GS cache
// let serverGS = { json: '', csv: '', kw: '' };

// async function fileExists(p) {
//   try { await fs.promises.access(p, fs.constants.R_OK); return true; }
//   catch { return false; }
// }

// async function loadDocxToText(filePath) {
//   const buf = await readFile(filePath);
//   const { value } = await mammoth.extractRawText({ buffer: buf });
//   return String(value || '').trim();
// }

// async function loadServerGS() {
//   const loaded = { json:false, csv:false, kw:false };
//   try {
//     if (GS_JSON_PATH && await fileExists(GS_JSON_PATH)) {
//       const txt = await readFile(GS_JSON_PATH, 'utf-8');
//       try { JSON.parse(txt); serverGS.json = clip(txt, GS_CAP.json); loaded.json = true; }
//       catch { console.warn('⚠️  DATASET.json is not valid JSON — skipping'); }
//     }
//     if (GS_CSV_PATH && await fileExists(GS_CSV_PATH)) {
//       const txt = await readFile(GS_CSV_PATH, 'utf-8');
//       serverGS.csv = clip(txt, GS_CAP.csv);
//       loaded.csv = true;
//     }
//     if (GS_DOCX_PATH && await fileExists(GS_DOCX_PATH)) {
//       const kw = await loadDocxToText(GS_DOCX_PATH);
//       serverGS.kw = clip(kw, GS_CAP.kw);
//       loaded.kw = true;
//     }
//   } catch (e) {
//     console.error('❌ Failed loading server GS:', e?.message || e);
//   }
//   const all = loaded.json && loaded.csv && loaded.kw;
//   console.log(`GS loaded: json=${loaded.json} csv=${loaded.csv} kw=${loaded.kw} (all=${all})`);
//   return loaded;
// }

// // Load GS at boot
// await loadServerGS();

// function buildGSIngestParts(gsJsonStr, gsCsvStr, keywordsFullText) {
//   const parts = [];
//   parts.push({ text:
//     "TAKE THESE AS GOLD STANDARD TITLES AND THUMBNAILS ALONG WITH ALL THE VIRAL IMPORTANT KEYWORDS ATTACHED. THESE ARE THE TOP PERFORMING VIDEOS. KEEP THESE IN YOUR MEMORY."
//   });

//   const append = (label, raw, size = 24000) => {
//     parts.push({ text: `\n\n---\n${label}\n---\n` });
//     const s = String(raw || '');
//     for (let i = 0; i < s.length; i += size) parts.push({ text: s.slice(i, i + size) });
//   };

//   append("GOLD STANDARD: DATASET.json (RAW)", gsJsonStr || '');
//   append("GOLD STANDARD: Top10_Viral_Titles_Thumbnails_AllChannels.csv (RAW)", gsCsvStr || '');
//   append("GOLD STANDARD: Viral_Crime_Niche_Master_Keywords.docx (PLAIN TEXT)", keywordsFullText || '');
//   return parts;
// }

// function buildFinalInstructionParts({ videoSource, topic, titleHint, strategistPrompt, contextText }) {
//   const runContext = `
// VIDEO INPUT (authoritative; do not invent facts). Use the attached video fully:
// ${(contextText || "").trim()}

// Video Source: ${videoSource}
// Optional Topic: ${topic || "(none)"} | Optional Angle Hint: ${titleHint || "(none)"}

// MANDATORY:
// - Use ONLY the attached video + VIDEO INPUT + learned gold-standard patterns.
// - Do not assume/fabricate details not present.
// - Output CLEAN HTML only (no preface).
// - Start with "Video Summary & Core Angles" (video-specific), then 10 Title & Thumbnail Packages.
// `.trim();

//   return [
//     { text: String(strategistPrompt || '').trim() },
//     { text: runContext }
//   ];
// }

// /* =================== Files API helpers (unchanged) =================== */
// async function waitForFileActive(
//   fileId,
//   {
//     timeoutMs = FILES_ACTIVE_TIMEOUT_MS,
//     initialDelay = FILES_INITIAL_DELAY_MS,
//     maxDelay = FILES_MAX_DELAY_MS
//   } = {}
// ) {
//   const started = Date.now();
//   let delay = initialDelay;
//   let lastState = 'UNKNOWN';
//   let lastUri = '';

//   let checks = 0;
//   while (Date.now() - started < timeoutMs) {
//     checks++;
//     const metaResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileId}?key=${API_KEY}`);
//     if (!metaResp.ok) {
//       const txt = await metaResp.text().catch(()=> '');
//       throw new Error(`Files API GET failed (${metaResp.status}): ${txt}`);
//     }
//     const meta = await metaResp.json();
//     const state = meta?.state || meta?.fileState || 'UNKNOWN';
//     const uri = meta?.uri || meta?.file?.uri || '';

//     lastState = state;
//     lastUri = uri;

//     if (state === 'ACTIVE' && uri) {
//       console.log(`📦 Files API: ${fileId} ACTIVE after ${checks} checks (${Math.round((Date.now()-started)/1000)}s)`);
//       return { uri, state };
//     }

//     if (checks === 1 || checks % 5 === 0) {
//       console.log(`⌛ Files API: ${fileId} state=${state} (waiting ${delay}ms)`);
//     }

//     await new Promise(r => setTimeout(r, delay));
//     delay = Math.min(maxDelay, Math.floor(delay * 1.6));
//   }

//   throw new Error(`File did not become ACTIVE in time (lastState=${lastState}, uri=${lastUri ? 'present' : 'missing'})`);
// }

// /** STREAMING upload (no fs.readFile buffer) with duplex fix + safe fallback */
// async function uploadPathToFilesAPI(filePath, mimeType, displayName) {
//   const url = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${API_KEY}`;

//   // Attempt A: streaming form-data
//   try {
//     const form = new (await import('form-data')).default();
//     form.append('file', fs.createReadStream(filePath), {
//       filename: displayName || path.basename(filePath),
//       contentType: mimeType || 'application/octet-stream'
//     });

//     const headers = form.getHeaders();
//     const length = await new Promise((resolve) =>
//       form.getLength((err, len) => resolve(err ? undefined : len))
//     );
//     if (typeof length === 'number') headers['Content-Length'] = String(length);

//     const resp = await fetch(url, {
//       method: 'POST',
//       headers,
//       body: form,
//       duplex: 'half'
//     });

//     const text = await resp.text();
//     if (!resp.ok) throw new Error(`Files API upload failed (${resp.status}): ${text}`);

//     let data; try { data = JSON.parse(text); }
//     catch { throw new Error(`Files API returned non-JSON: ${text}`); }

//     const fileId = data?.file?.name;
//     if (!fileId) throw new Error(`Files API response missing file.name: ${JSON.stringify(data)}`);

//     const { uri } = await waitForFileActive(fileId);
//     return { fileUri: uri, fileId };
//   } catch (err) {
//     console.warn('⚠️ Streaming upload failed, will retry once with buffer fallback:', err?.message || err);
//   }

//   // Attempt B: buffer fallback
//   try {
//     const { File, FormData: UForm } = await import('undici');
//     const buf = await fs.promises.readFile(filePath);
//     const file = new File([buf], displayName || path.basename(filePath), {
//       type: mimeType || 'application/octet-stream'
//     });
//     const form = new UForm();
//     form.append('file', file);

//     const resp = await fetch(url, { method: 'POST', body: form });
//     const text = await resp.text();
//     if (!resp.ok) throw new Error(`Files API upload (fallback) failed (${resp.status}): ${text}`);

//     let data; try { data = JSON.parse(text); }
//     catch { throw new Error(`Files API returned non-JSON (fallback): ${text}`); }

//     const fileId = data?.file?.name;
//     if (!fileId) throw new Error(`Files API response missing file.name (fallback): ${JSON.stringify(data)}`);

//     const { uri } = await waitForFileActive(fileId);
//     return { fileUri: uri, fileId };
//   } catch (err) {
//     console.error('❌ Upload error (fallback path):', err?.stack || err?.message || err);
//     throw err;
//   }
// }

// // ---- Serve uploads folder for local playback from history
// app.use('/uploads', express.static(UPLOADS_DIR, {
//   setHeaders(res) {
//     // allow range requests for video scrubbing
//     res.setHeader('Accept-Ranges', 'bytes');
//   }
// }));

// // ---- Health
// app.get('/health', (req, res) => res.send('ok'));

// // ---- GS status & reload
// app.get('/api/gs-status', (req, res) => {
//   res.json({
//     ok: true,
//     serverGS: {
//       json: !!serverGS.json,
//       csv:  !!serverGS.csv,
//       kw:   !!serverGS.kw,
//       all:  !!(serverGS.json && serverGS.csv && serverGS.kw)
//     },
//     paths: {
//       json: GS_JSON_PATH || null,
//       csv:  GS_CSV_PATH  || null,
//       kw:   GS_DOCX_PATH || null
//     }
//   });
// });

// app.post('/api/gs-reload', async (req, res) => {
//   const loaded = await loadServerGS();
//   res.json({ ok: true, loaded });
// });

// /* =========================================================
//    1) Upload local MP4 -> DISK temp -> Files API -> save copy -> delete temp
//    ========================================================= */
// app.post('/api/upload-video', upload.single('video'), async (req, res) => {
//   const filePath = req?.file?.path;
//   const mime     = req?.file?.mimetype || 'video/mp4';
//   const name     = req?.file?.originalname || 'uploaded-video.mp4';

//   if (!filePath) return res.status(400).json({ ok: false, error: 'No video uploaded' });
//   console.log(`⬆️  /api/upload-video  path=${filePath} mime=${mime} size=${req.file.size}`);

//   // generate a persistent copy for history playback
//   const safeExt = path.extname(name) || '.mp4';
//   const uploadId = randomUUID();
//   const uploadFile = path.join(UPLOADS_DIR, `${uploadId}${safeExt}`);

//   try {
//     const { fileUri, fileId } = await uploadPathToFilesAPI(filePath, mime, name);

//     // Copy to uploads/ (stream copy to avoid mem)
//     await new Promise((resolve, reject) => {
//       const r = fs.createReadStream(filePath);
//       const w = fs.createWriteStream(uploadFile);
//       r.pipe(w);
//       r.on('error', reject);
//       w.on('finish', resolve);
//       w.on('error', reject);
//     });

//     console.log(`✅  Uploaded to Files API: ${fileId} (ACTIVE). Local playback copy saved ${uploadFile}`);
//     res.json({
//       ok: true,
//       fileUri,
//       fileId,
//       mimeType: mime,
//       fileMime: mime,
//       displayName: name,
//       // playback info for history embedding (input area only)
//       playback: { kind: 'local', url: `/uploads/${path.basename(uploadFile)}` }
//     });
//   } catch (err) {
//     console.error('Upload error:', err?.message || err);
//     res.status(500).json({ ok: false, error: err?.message || 'Upload failed' });
//   } finally {
//     try { await unlink(filePath); } catch {}
//   }
// });

// /* =========================================================
//    2) Fetch YouTube -> DISK temp -> Files API -> delete temp
//    ========================================================= */
// const BIN_DIR    = path.join(__dirname, 'bin');
// const YTDLP_EXE  = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
// const YTDLP_PATH = path.join(BIN_DIR, YTDLP_EXE);

// async function ensureYtDlp() {
//   try { await fs.promises.access(YTDLP_PATH, fs.constants.X_OK); return YTDLP_PATH; } catch {}
//   await fs.promises.mkdir(BIN_DIR, { recursive: true });
//   const url = process.platform === 'win32'
//     ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
//     : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
//   console.log(`⬇️  Downloading yt-dlp from ${url}`);
//   const r = await fetch(url);
//   if (!r.ok) throw new Error(`yt-dlp download failed: ${r.status}`);
//   const buf = Buffer.from(await r.arrayBuffer());
//   await fs.promises.writeFile(YTDLP_PATH, buf, { mode: 0o755 });
//   console.log('✅  yt-dlp downloaded');
//   return YTDLP_PATH;
// }

// async function downloadWithYtDlpToPath(url) {
//   const ytdlp   = await ensureYtDlp();
//   const outPath = path.join(os.tmpdir(), `yt_${Date.now()}.mp4`);
//   const args = [
//     '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
//     '--merge-output-format', 'mp4',
//     '--no-playlist',
//     '--quiet', '--no-warnings',
//     '-o', outPath,
//     url
//   ];
//   console.log('▶️  yt-dlp', args.join(' '));
//   await new Promise((resolve, reject) => {
//     execFile(ytdlp, args, { windowsHide: true }, (err) => err ? reject(err) : resolve());
//   });

//   // friendly name
//   let displayName = `youtube-video-${Date.now()}.mp4`;
//   try {
//     await new Promise((resolve) => {
//       execFile(ytdlp, ['--get-title', '--no-playlist', url], { windowsHide: true }, (e, stdout) => {
//         const t = String(stdout || '').split('\n')[0].trim();
//         if (t) displayName = `${t}`.replace(/[^\w.\-]+/g, '_') + '.mp4';
//         resolve();
//       });
//     });
//   } catch {}
//   return { outPath, displayName, mime: 'video/mp4' };
// }

// app.post('/api/fetch-youtube', async (req, res) => {
//   try {
//     let { url } = req.body || {};
//     if (!url) return res.status(400).json({ ok: false, error: 'Missing YouTube URL' });

//     let ytId;
//     try {
//       ytId = ytdl.getURLVideoID(url);
//       url = `https://www.youtube.com/watch?v=${ytId}`;
//     } catch {
//       return res.status(400).json({ ok: false, error: 'Invalid YouTube URL' });
//     }

//     console.log(`⬇️  /api/fetch-youtube  url=${url}`);

//     // Attempt 1: ytdl-core
//     try {
//       const headers = {
//         'user-agent':
//           'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
//         'accept-language': 'en-US,en;q=0.9',
//       };

//       const info = await ytdl.getInfo(url, { requestOptions: { headers } });

//       let fmt =
//         ytdl.chooseFormat(info.formats, {
//           quality: 'highest',
//           filter: (f) =>
//             f.hasAudio &&
//             f.hasVideo &&
//             (f.container === 'mp4' || (f.mimeType || '').includes('mp4')),
//         }) ||
//         ytdl.chooseFormat(info.formats, {
//           quality: 'highest',
//           filter: (f) => f.hasAudio && f.hasVideo,
//         });

//       if (!fmt || !fmt.url) throw new Error('No direct AV format URL');

//       const mime =
//         fmt.mimeType?.split(';')[0] ||
//         (fmt.container === 'mp4' ? 'video/mp4' : 'video/webm');

//       const safeTitle = (info.videoDetails?.title || 'youtube-video').replace(/[^\w.\-]+/g, '_');
//       const ext = mime === 'video/mp4' ? '.mp4' : '.webm';
//       const tempPath = path.join(os.tmpdir(), `${Date.now()}-${safeTitle}${ext}`);

//       await new Promise((resolve, reject) => {
//         const r = ytdl.downloadFromInfo(info, { format: fmt, requestOptions: { headers } });
//         const w = fs.createWriteStream(tempPath);
//         r.pipe(w);
//         r.on('error', reject);
//         w.on('finish', resolve);
//         w.on('error', reject);
//       });

//       try {
//         const { fileUri, fileId } = await uploadPathToFilesAPI(tempPath, mime, path.basename(tempPath));
//         console.log(`✅  YouTube uploaded via ytdl-core: ${fileId} (ACTIVE)`);
//         return res.json({
//           ok: true,
//           fileUri,
//           fileId,
//           mimeType: mime,
//           fileMime: mime,
//           displayName: path.basename(tempPath),
//           playback: { kind: 'youtube', url, youtubeId: ytId }
//         });
//       } finally {
//         try { await unlink(tempPath); } catch {}
//       }
//     } catch (e1) {
//       console.warn('⚠️  ytdl-core fetch failed; falling back to yt-dlp:', e1?.message || e1);
//     }

//     // Attempt 2: yt-dlp
//     const { outPath, displayName, mime } = await downloadWithYtDlpToPath(url);
//     try {
//       const { fileUri, fileId } = await uploadPathToFilesAPI(outPath, mime, displayName);
//       console.log(`✅  YouTube uploaded via yt-dlp: ${fileId} (ACTIVE)`);
//       return res.json({
//         ok: true,
//         fileUri,
//         fileId,
//         mimeType: mime,
//         fileMime: mime,
//         displayName,
//         playback: { kind: 'youtube', url, youtubeId: ytId }
//       });
//     } finally {
//       try { await unlink(outPath); } catch {}
//     }
//   } catch (err) {
//     console.error('YouTube fetch error:', err?.message || err);
//     const msg =
//       /private|copyright|410|signin|age|forbidden|403/i.test(err?.message || '')
//         ? 'Video is restricted (private/age/region). Try another public URL.'
//         : err?.message || 'YouTube fetch failed';
//     res.status(500).json({ ok: false, error: msg });
//   }
// });

// /* ===============================
//    HistoryStore (filesystem)
//    =============================== */
// class HistoryStore {
//   constructor(dir, indexPath, limitBytes) {
//     this.dir = dir;
//     this.indexPath = indexPath;
//     this.limit = BigInt(limitBytes);
//     this._ensureIndex();
//   }
//   _ensureIndex() {
//     if (!fs.existsSync(this.indexPath)) {
//       fs.writeFileSync(this.indexPath, JSON.stringify({ items: [] }), 'utf-8');
//     }
//   }
//   _readIndex() {
//     try {
//       return JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')) || { items: [] };
//     } catch { return { items: [] }; }
//   }
//   _writeIndex(idx) {
//     fs.writeFileSync(this.indexPath, JSON.stringify(idx), 'utf-8');
//   }
//   _usage(idx) {
//     return idx.items.reduce((a, b) => a + BigInt(b.size_bytes || 0), 0n);
//   }
//   stats() {
//     const idx = this._readIndex();
//     const used = this._usage(idx);
//     return {
//       limit: Number(this.limit),
//       used : Number(used),
//       remaining: Number(used > this.limit ? 0n : (this.limit - used)),
//       count: idx.items.length
//     };
//   }
//   search({ q = '', page = 1, limit = 50 }) {
//     const idx = this._readIndex();
//     const norm = q.trim().toLowerCase();
//     let items = idx.items;
//     if (norm) {
//       items = items.filter(x =>
//         String(x.title||'').toLowerCase().includes(norm) ||
//         String(x.preview||'').toLowerCase().includes(norm)
//       );
//     }
//     items.sort((a,b)=> b.created_at - a.created_at);
//     const offset = (page - 1) * limit;
//     const slice = items.slice(offset, offset + limit)
//       .map(({ id, title, created_at, size_bytes, preview }) => ({ id, title, created_at, size_bytes, preview }));
//     return { items: slice, total: items.length, page, limit };
//   }
//   async get(id) {
//     const idx = this._readIndex();
//     const it = idx.items.find(x => x.id === id);
//     if (!it) return null;
//     const raw = await fs.promises.readFile(it.file_path);
//     const buf = zlib.gunzipSync(raw);
//     const data = JSON.parse(buf.toString('utf-8'));
//     return { meta: it, data };
//   }
//   async delete(id) {
//     const idx = this._readIndex();
//     const i = idx.items.findIndex(x => x.id === id);
//     if (i === -1) return false;
//     try { if (fs.existsSync(idx.items[i].file_path)) await fs.promises.unlink(idx.items[i].file_path); } catch {}
//     idx.items.splice(i, 1);
//     this._writeIndex(idx);
//     return true;
//   }
//   async purgeOldestUntilFree(bytesNeeded) {
//     const needed = BigInt(bytesNeeded || 0);
//     const idx = this._readIndex();
//     idx.items.sort((a,b)=> a.created_at - b.created_at);
//     let used = this._usage(idx);
//     const evicted = [];
//     let p = 0;
//     while (used + needed > this.limit && p < idx.items.length) {
//       const it = idx.items[p++];
//       try { if (fs.existsSync(it.file_path)) fs.unlinkSync(it.file_path); } catch {}
//       used -= BigInt(it.size_bytes || 0);
//       evicted.push(it.id);
//     }
//     idx.items = idx.items.filter(x => !evicted.includes(x.id));
//     this._writeIndex(idx);
//     return { evicted, used: Number(used), limit: Number(this.limit) };
//   }
//   _gzip(obj) { return zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf-8'), { level: 9 }); }
//   _previewFromHTML(html) {
//     const text = String(html||'').replace(/<script[\s\S]*?<\/script>/gi,'')
//       .replace(/<style[\s\S]*?<\/style>/gi,'')
//       .replace(/<[^>]+>/g,' ')
//       .replace(/\s+/g,' ')
//       .trim();
//     return text.length > 180 ? text.slice(0,180) + '…' : text;
//   }
//   save({ title, html, extraMeta }) {
//     const idx = this._readIndex();
//     const used = this._usage(idx);
//     const gz = this._gzip({ html, meta: extraMeta || null, ts: Date.now() });
//     const newSize = BigInt(gz.byteLength);
//     if (used + newSize > this.limit) {
//       const needed = Number((used + newSize) - this.limit);
//       return { error: 'STORAGE_LIMIT_EXCEEDED', needed, used: Number(used), limit: Number(this.limit) };
//     }
//     const id = randomUUID();
//     const file_path = path.join(this.dir, `${id}.json.gz`);
//     fs.writeFileSync(file_path, gz);
//     const entry = {
//       id,
//       title: String(title || 'Generated Package').slice(0, 200),
//       created_at: Date.now(),
//       size_bytes: Number(newSize),
//       file_path,
//       preview: this._previewFromHTML(html)
//     };
//     idx.items.push(entry);
//     this._writeIndex(idx);
//     return { id, size_bytes: Number(newSize) };
//   }
// }

// const historyStore = new HistoryStore(HIST_DIR, INDEX_PATH, HISTORY_LIMIT_BYTES);

// /* ====================== History HTTP Endpoints ====================== */
// app.get('/api/history-stats', (req, res) => res.json(historyStore.stats()));

// app.get('/api/history', (req, res) => {
//   const q = String(req.query.q || '');
//   const page = Math.max(parseInt(req.query.page || '1', 10), 1);
//   const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
//   res.json(historyStore.search({ q, page, limit }));
// });

// app.get('/api/history/:id', async (req, res) => {
//   const item = await historyStore.get(req.params.id);
//   if (!item) return res.status(404).json({ error: 'Not found' });
//   res.json(item);
// });

// app.get('/api/history/:id/html', async (req, res) => {
//   const item = await historyStore.get(req.params.id);
//   if (!item) return res.status(404).send('Not found');
//   const html = String(item.data?.html || '');
//   const download = String(req.query.download || '').toLowerCase() === '1';
//   if (download) {
//     res.setHeader('Content-Disposition', `attachment; filename="${(item.meta?.title || 'Generated_Package').replace(/[^\w.-]/g,'_')}.html"`);
//   }
//   res.setHeader('Content-Type', 'text/html; charset=utf-8');
//   res.send(html);
// });

// app.delete('/api/history/:id', async (req, res) => {
//   const ok = await historyStore.delete(req.params.id);
//   if (!ok) return res.status(404).json({ error: 'Not found' });
//   res.json({ ok: true });
// });

// app.post('/api/history/purge', async (req, res) => {
//   const mode = String(req.query.mode || 'oldest');
//   if (mode !== 'oldest') return res.status(400).json({ error: 'Unsupported mode' });
//   const bytes = Number(req.query.bytes || req.body?.bytes || 0);
//   const result = await historyStore.purgeOldestUntilFree(bytes);
//   res.json(result);
// });

// /* =========================================================
//    3) Generate (two-turn; video attached) — normalize HTML (no player)
//    ========================================================= */
// app.post('/api/generate', async (req, res) => {
//   try {
//     const {
//       fileUri, fileMime = 'video/mp4', videoSource = 'N/A', displayName,
//       strategistPrompt = '', topic = '', titleHint = '', contextText = '',
//       gsJson = '', gsCsv = '', gsKeywordsText = '',
//       // playback meta forwarded from client
//       playback = null
//     } = req.body || {};

//     console.log('▶️  /api/generate', {
//       hasFileUri: !!fileUri,
//       mime: fileMime,
//       topic: clip(topic, 60),
//       hint: clip(titleHint, 60),
//       ctxLen: (contextText || '').length,
//       gs: { json: (gsJson || '').length, csv: (gsCsv || '').length, kw: (gsKeywordsText || '').length },
//       serverGS: { json: !!serverGS.json, csv: !!serverGS.csv, kw: !!serverGS.kw },
//       playback
//     });

//     if (!fileUri)          return res.status(400).json({ ok: false, error: 'fileUri missing' });
//     if (!strategistPrompt) return res.status(400).json({ ok: false, error: 'strategistPrompt missing' });

//     const useJson = serverGS.json || clip(gsJson, 150000);
//     const useCsv  = serverGS.csv  || clip(gsCsv, 100000);
//     const useKw   = serverGS.kw   || clip(gsKeywordsText, 100000);

//     const model = genAI.getGenerativeModel({
//       model: MODEL,
//       systemInstruction: "Follow output format exactly; store gold-standard patterns internally; do not leak chain-of-thought."
//     });

//     const history = [
//       { role: 'user', parts: buildGSIngestParts(useJson, useCsv, useKw) },
//       {
//         role: 'user',
//         parts: [
//           { text: "\n\n---\nATTACHED VIDEO (analyze full visuals + audio)\n---\n" },
//           { fileData: { fileUri, mimeType: fileMime } }
//         ]
//       }
//     ];

//     const chat = model.startChat({
//       history,
//       generationConfig: {
//         temperature: 0.35,
//         topP: 0.9,
//         topK: 40,
//         candidateCount: 1,
//         maxOutputTokens: 8192,
//         responseMimeType: "text/plain"
//       }
//     });

//     await chat.sendMessage([{ text: "Acknowledge gold standard + attached video in one short sentence." }]);

//     const parts = buildFinalInstructionParts({ videoSource, topic, titleHint, strategistPrompt, contextText });
//     const result = await chat.sendMessage(parts);

//     let raw = "";
//     try { raw = result?.response?.text?.() || ""; } catch (e) { console.error("result.response.text() failed:", e); }

//     const candidate = result?.response?.candidates?.[0];
//     const meta = {
//       finishReason: candidate?.finishReason,
//       safety: candidate?.safetyRatings,
//       usage: result?.response?.usageMetadata
//     };

//     if (!raw.trim()) {
//       console.error("Empty HTML; full API response:", JSON.stringify(result, null, 2));
//       return res.status(502).json({
//         ok: false,
//         error: "Model returned empty response. See server logs for details.",
//         meta
//       });
//     }

//     // No player injection — output HTML is analysis only
//     const normalizedHtml = normalizeModelHtml(raw, {});

//     console.log('✅  Generation OK');

//     // Title for history
//     let title =
//       (topic && topic.trim()) ||
//       (titleHint && titleHint.trim()) ||
//       (displayName && humanizeFileName(displayName)) ||
//       'Generated Package';

//     if (title === 'Generated Package') {
//       const h = normalizedHtml.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/i) || normalizedHtml.match(/^\s*#+\s*([^\n]+)/m);
//       if (h && h[1]) title = h[1].trim().slice(0, 80);
//     }

//     // Save to history (store input meta incl. playback)
//     const saved = historyStore.save({
//       title,
//       html: normalizedHtml,
//       extraMeta: {
//         meta,
//         input: { videoSource, topic, titleHint, contextText, displayName, playback }
//       }
//     });

//     let historyPayload = null;
//     let storage = historyStore.stats();
//     if (saved?.error === 'STORAGE_LIMIT_EXCEEDED') {
//       historyPayload = { saved: false, reason: 'STORAGE_LIMIT_EXCEEDED', needed: saved.needed };
//     } else if (saved?.id) {
//       historyPayload = { saved: true, id: saved.id, size_bytes: saved.size_bytes };
//     }

//     return res.json({ ok: true, html: normalizedHtml, meta, history: historyPayload, storage });
//   } catch (err) {
//     console.error("GENERATION ERROR:");
//     console.error(err?.stack || err?.message || String(err));
//     try { console.error("Raw error object:", JSON.stringify(err, null, 2)); } catch {}
//     return res.status(500).json({
//       ok: false,
//       error: err?.message || 'Generation failed (see server logs).'
//     });
//   }
// });

// // ✅ Long timeouts for big uploads/slow nets
// const server = app.listen(PORT, () => console.log(`Server running http://0.0.0.0:${PORT}`));

// server.headersTimeout   = Number(process.env.SERVER_HEADERS_TIMEOUT_MS  || 2  * 60 * 1000);
// server.requestTimeout   = Number(process.env.SERVER_REQUEST_TIMEOUT_MS  || 60 * 60 * 1000);
// server.keepAliveTimeout = Number(process.env.SERVER_KEEPALIVE_TIMEOUT_MS|| 10 * 60 * 1000);








////////////////////////////////////////////




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

// Serve frontend
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

/* =========================================================
   Storage (data/, uploads/, history/)
   ========================================================= */
const DATA_DIR       = path.join(__dirname, 'data');
const UPLOADS_DIR    = path.join(DATA_DIR, 'uploads');  // <— keep a copy for history playback
const HIST_DIR       = process.env.HIST_DIR || path.join(DATA_DIR, 'history');
const INDEX_PATH     = path.join(HIST_DIR, 'index.json');
const HISTORY_LIMIT_BYTES = BigInt(process.env.HISTORY_LIMIT_BYTES || 20 * 1024 * 1024 * 1024); // 20 GB

fs.mkdirSync(DATA_DIR,   { recursive: true });
fs.mkdirSync(UPLOADS_DIR,{ recursive: true });
fs.mkdirSync(HIST_DIR,   { recursive: true });

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
const MODEL   = process.env.MODEL || 'gemini-2.5-pro';
const PORT    = process.env.PORT || 3002;

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
      state: 'created',        // 'created' -> 'queued' -> 'active' -> 'done'|'failed'
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

// SSE stream
app.get('/api/queue/:id/stream', (req, res) => {
  const { id } = req.params;
  const job = qJobs.get(id);
  if (!job) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // initial snapshot
  send('snapshot', job);

  const onQueued = (p) => { if (p.id === id) send('queued', p); };
  const onStarted = (p) => { if (p.id === id) send('started', p); };
  const onProgress = (p) => { if (p.id === id) send('progress', p); };
  const onDone = (p) => {
    if (p.id === id) {
      send('done', p);
      cleanup();
      res.end();
    }
  };
  const onFailed = (p) => {
    if (p.id === id) {
      send('failed', p);
      cleanup();
      res.end();
    }
  };

  function cleanup() {
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

/* =========================================================
   Helpers (unchanged)
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
  return wrapInTemplate(body, inputMeta || {});
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

/* =================== Files API helpers (unchanged) =================== */
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

/** STREAMING upload (no fs.readFile buffer) with duplex fix + safe fallback */
async function uploadPathToFilesAPI(filePath, mimeType, displayName) {
  const url = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${API_KEY}`;

  // Attempt A: streaming form-data
  try {
    const form = new (await import('form-data')).default();
    form.append('file', fs.createReadStream(filePath), {
      filename: displayName || path.basename(filePath),
      contentType: mimeType || 'application/octet-stream'
    });

    const headers = form.getHeaders();
    const length = await new Promise((resolve) =>
      form.getLength((err, len) => resolve(err ? undefined : len))
    );
    if (typeof length === 'number') headers['Content-Length'] = String(length);

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: form,
      duplex: 'half'
    });

    const text = await resp.text();
    if (!resp.ok) throw new Error(`Files API upload failed (${resp.status}): ${text}`);

    let data; try { data = JSON.parse(text); }
    catch { throw new Error(`Files API returned non-JSON: ${text}`); }

    const fileId = data?.file?.name;
    if (!fileId) throw new Error(`Files API response missing file.name: ${JSON.stringify(data)}`);

    const { uri } = await waitForFileActive(fileId);
    return { fileUri: uri, fileId };
  } catch (err) {
    console.warn('⚠️ Streaming upload failed, will retry once with buffer fallback:', err?.message || err);
  }

  // Attempt B: buffer fallback
  try {
    const { File, FormData: UForm } = await import('undici');
    const buf = await fs.promises.readFile(filePath);
    const file = new File([buf], displayName || path.basename(filePath), {
      type: mimeType || 'application/octet-stream'
    });
    const form = new UForm();
    form.append('file', file);

    const resp = await fetch(url, { method: 'POST', body: form });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`Files API upload (fallback) failed (${resp.status}): ${text}`);

    let data; try { data = JSON.parse(text); }
    catch { throw new Error(`Files API returned non-JSON (fallback): ${text}`); }

    const fileId = data?.file?.name;
    if (!fileId) throw new Error(`Files API response missing file.name (fallback): ${JSON.stringify(data)}`);

    const { uri } = await waitForFileActive(fileId);
    return { fileUri: uri, fileId };
  } catch (err) {
    console.error('❌ Upload error (fallback path):', err?.stack || err?.message || err);
    throw err;
  }
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

async function ensureYtDlp() {
  try { await fs.promises.access(YTDLP_PATH, fs.constants.X_OK); return YTDLP_PATH; } catch {}
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

    if (!fileUri)          return res.status(400).json({ ok: false, error: 'fileUri missing' });
    if (!strategistPrompt) return res.status(400).json({ ok: false, error: 'strategistPrompt missing' });

    const useJson = serverGS.json || clip(gsJson, 150000);
    const useCsv  = serverGS.csv  || clip(gsCsv, 100000);
    const useKw   = serverGS.kw   || clip(gsKeywordsText, 100000);

    const model = genAI.getGenerativeModel({
      model: MODEL,
      systemInstruction: "Follow output format exactly; store gold-standard patterns internally; do not leak chain-of-thought."
    });

    const historyMsgs = [
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
      history: historyMsgs,
      generationConfig: {
        temperature: 0.35,
        topP: 0.9,
        topK: 40,
        candidateCount: 1,
        maxOutputTokens: 8192,
        responseMimeType: "text/plain"
      }
    });

    req._queueProgress?.(30, 'model warmup');

    await chat.sendMessage([{ text: "Acknowledge gold standard + attached video in one short sentence." }]);

    req._queueProgress?.(55, 'analyzing video');

    const parts = buildFinalInstructionParts({ videoSource, topic, titleHint, strategistPrompt, contextText });
    const result = await chat.sendMessage(parts);

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

server.headersTimeout   = Number(process.env.SERVER_HEADERS_TIMEOUT_MS  || 2  * 60 * 1000);
server.requestTimeout   = Number(process.env.SERVER_REQUEST_TIMEOUT_MS  || 60 * 60 * 1000);
server.keepAliveTimeout = Number(process.env.SERVER_KEEPALIVE_TIMEOUT_MS|| 10 * 60 * 1000);

