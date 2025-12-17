import mammoth from "https://esm.run/mammoth@1.7.2";
import { marked } from "https://esm.run/marked@12.0.2";
import * as docx from "https://esm.run/docx@8.5.0";

const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? 'http://localhost:3002' : window.location.origin;

const $ = (id) => document.getElementById(id);
const els = {
    // Sidebar Inputs
    urlBtn: $("urlBtn"), localBtn: $("localBtn"),
    urlInputContainer: $("urlInputContainer"), localInputContainer: $("localInputContainer"),
    ytUrl: $("ytUrl"), videoFile: $("videoFile"),
    videoPreview: $("videoPreview"), videoPreviewContainer: $("videoPreviewContainer"),
    ytPreview: $("ytPreview"), ytPreviewContainer: $("ytPreviewContainer"),

    // Context
    titleHint: $("titleHint"), angleHint: $("angleHint"),
    runBtn: $("runBtn"),
    runBtn: $("runBtn"),
    runBtn: $("runBtn"),
    competitorToggle: $("competitorToggle"),

    // Market Mode
    competitorModal: $("competitorModal"),
    closeCompetitorModal: $("closeCompetitorModal"),

    // AI Discovery
    aiDiscoveryInput: $("aiDiscoveryInput"),
    btnDiscover: $("btnDiscover"),
    discoveryKeywords: $("discoveryKeywords"), // Now used for Target Channel container
    discoveryChannels: $("discoveryChannels"), // Used for Similar Channels container

    // Legacy support (hidden container now, but logic uses it)
    competitorResults: $("competitorResults"),

    // Output
    output: $("output"),

    // Progress
    status: $("status"), bar: $("bar"),
    progressOverlay: $("progressOverlay"), // Modal container
    modalBar: $("modalBar"), modalStatus: $("modalStatus"), modalLog: $("modalLog"),

    // Settings
    openSettings: $("openSettings"), closeSettings: $("closeSettings"),
    settingsSheet: $("settingsSheet"), settingsBackdrop: $("settingsBackdrop"),
    prompt: $("prompt"), saveSettings: $("saveSettings"), resetSettings: $("resetSettings"),

    // History
    // History
    openHist: $("openHist"),
    historyView: $("historyView"), // New View
    historyDetailView: $("historyDetailView"), // Detail View
    hQuery: $("hQuery"), // Kept if we want search but standard youtube doesn't have it on toggle


    // Data Uploads
    dzJson: $("dzJson"), gsJsonName: $("gsJsonName"), btnPickJson: $("btnPickJson"), gsJson: $("gsJson"),
    dzCsv: $("dzCsv"), gsCsvName: $("gsCsvName"), btnPickCsv: $("btnPickCsv"), gsCsv: $("gsCsv"),
    dzDoc: $("dzDoc"), gsDocName: $("gsDocName"), btnPickDoc: $("btnPickDoc"), gsDoc: $("gsDoc"),
    gsStatus: $("gsStatus"),

    // Extras
    saveDocBtn: $("saveDocBtn"),

    // Theme
    themeBtn: $("themeBtn"),
    themeMenu: $("themeMenu"),
};

const LS_KEY = "tt_generator_v3";
const LS_THEME = "tt_gen_theme"; // New LS Key
const LS_GS_JSON = "tt_gen_gs_dataset_json";
const LS_GS_CSV = "tt_gen_gs_top10_csv";
const LS_GS_DOCX = "tt_gen_gs_keywords_docx_b64";

// Theme Logic
window.setTheme = (mode) => {
    document.documentElement.setAttribute('data-theme', mode);
    localStorage.setItem(LS_THEME, mode);
    if (els.themeMenu) els.themeMenu.style.display = 'none';
};

function initTheme() {
    const saved = localStorage.getItem(LS_THEME) || 'dark';
    window.setTheme(saved);

    if (els.themeBtn) {
        els.themeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const curr = els.themeMenu.style.display;
            els.themeMenu.style.display = curr === 'block' ? 'none' : 'block';
        });

        // Close on outside click
        document.addEventListener('click', (e) => {
            if (els.themeMenu && els.themeMenu.style.display === 'block' && !els.themeBtn.contains(e.target)) {
                els.themeMenu.style.display = 'none';
            }
        });
    }
}

let lastGenerationContext = null;
let currentHistoryItemId = null;
let currentInputMethod = "url";
let serverGSAvailable = false;

// ==========================================
// 1. INPUT HANDLING & RESTORATION
// ==========================================
async function restoreInputState(ctx) {
    if (!ctx) return;

    // Determine Type
    const isYoutube = (ctx.videoSource || '').toLowerCase().includes('youtube');

    if (isYoutube) {
        switchInputMethod('url');
        // Extract URL from "YouTube: https://..." string if needed, or use ctx.fileUri if it holds the link
        const urlMatch = (ctx.videoSource || '').match(/https?:\/\/[^\s]+/);
        const url = urlMatch ? urlMatch[0] : '';
        if (url) {
            els.ytUrl.value = url;
            // Trigger preview
            const ytID = extractYoutubeId(url);
            if (ytID && els.ytPreview) {
                els.ytPreviewContainer.style.display = 'block';
                els.ytPreview.src = `https://www.youtube.com/embed/${ytID}?enablejsapi=1`;
            }
        }
    } else {
        switchInputMethod('local');
        // Restore Local Video
        // Handle playback object or string (legacy)
        let src = null;
        if (ctx.playback) {
            src = typeof ctx.playback === 'string' ? ctx.playback : ctx.playback.url;
        }

        if (src) {
            // Append API_BASE if it's a relative path (starts with /)
            if (src.startsWith('/')) src = `${API_BASE}${src}`;

            els.videoPreview.src = src;
            els.videoPreviewContainer.style.display = 'block';
            // We don't auto-play, just load

            // Trigger auto-thumbnails for any existing cards that are missing previews
            // Wait for metadata
            // Trigger auto-thumbnails for any existing cards that are missing previews
            // Wait for metadata
            els.videoPreview.addEventListener('loadeddata', () => {
                // Fix: Do NOT re-process cards (which destroys DOM). Just update thumbnails.
                document.querySelectorAll('.video-card.user').forEach(card => updateCardThumbnail(card));
            }, { once: true });

        } else {
            console.warn("Cannot restore local video playback: No accessible URL.");
        }
    }
}

function switchInputMethod(method) {
    currentInputMethod = method;
    if (method === 'url') {
        els.urlBtn.classList.add('active'); els.localBtn.classList.remove('active');
        els.urlInputContainer.style.display = 'block'; els.localInputContainer.style.display = 'none';
        els.videoPreviewContainer.style.display = 'none';
    } else {
        els.localBtn.classList.add('active'); els.urlBtn.classList.remove('active');
        els.localInputContainer.style.display = 'block'; els.urlInputContainer.style.display = 'none';
        els.ytPreviewContainer.style.display = 'none';
        els.ytPreview.src = '';
    }
}
// Helper to extract YouTube ID handling both formats
function extractYoutubeId(url) {
    if (!url) return null;
    const match = url.match(/(?:v=|youtu\.be\/|\/v\/|\/embed\/)([^&?]+)/);
    return match ? match[1] : null;
}

if (els.urlBtn) els.urlBtn.addEventListener("click", () => switchInputMethod('url'));
if (els.localBtn) els.localBtn.addEventListener("click", () => switchInputMethod('local'));

// Add listener to YT URL input for immediate preview
if (els.ytUrl) {
    els.ytUrl.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        const id = extractYoutubeId(val);
        if (id) {
            els.ytPreviewContainer.style.display = 'block';
            els.ytPreview.src = `https://www.youtube.com/embed/${id}?enablejsapi=1`;
            // Also update any visible cards if needed? No, user has to click generate.
        } else {
            els.ytPreviewContainer.style.display = 'none';
            els.ytPreview.removeAttribute('src');
        }
    });
}

if (els.videoFile) {
    els.videoFile.addEventListener("change", (e) => {
        const f = e.target.files?.[0];
        if (!f) { els.videoPreviewContainer.style.display = 'none'; els.videoPreview.removeAttribute('src'); return; }
        const url = URL.createObjectURL(f); els.videoPreview.src = url; els.videoPreviewContainer.style.display = 'block';
    });
}

// ==========================================
// 2. VIDEO SEEKING
// ==========================================
function parseTimestampToSeconds(raw) {
    if (!raw) return 0;
    const s = String(raw).trim().toLowerCase().replace(/[()[\]]/g, '');
    const hms = s.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)$/i);
    if (hms) {
        const h = parseInt(hms[1] || '0', 10);
        const m = parseInt(hms[2] || '0', 10);
        const sec = parseInt(hms[3] || '0', 10);
        return h * 3600 + m * 60 + sec;
    }
    const parts = s.split(':').map(x => x.trim());
    if (parts.length === 3) return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
    if (parts.length === 2) return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    const onlyS = s.match(/^(\d+)\s*s$/);
    if (onlyS) return parseInt(onlyS[1], 10);
    return 0;
}

async function seekLocal(seconds, scroll = true) {
    return new Promise(resolve => {
        const v = els.videoPreview;
        if (!v || !v.src) return resolve(false);

        let attempts = 0;
        const checkSeek = () => {
            // Verify we are actually close to target (within 0.5s)
            // Note: currentTime might be slightly off due to keyframes
            if (Math.abs(v.currentTime - seconds) < 1.0) {
                try { v.pause(); } catch { }
                resolve(true);
            } else {
                if (attempts++ > 50) { // 50 * 200ms = 10 seconds patience
                    console.warn(`[Seek] Failed to reach ${seconds}s (at ${v.currentTime}s)`);
                    resolve(true); // Give up and take what we have
                } else {
                    // Retry check in 200ms
                    setTimeout(checkSeek, 200);
                }
            }
        };

        const onSeeked = () => {
            checkSeek();
        };

        v.currentTime = seconds;
        v.addEventListener('seeked', onSeeked, { once: true });
        // Failsafe timeout
        setTimeout(() => {
            v.removeEventListener('seeked', onSeeked);
            checkSeek();
        }, 3000);
    });
}
function seekYouTube(seconds) {
    const yti = els.ytPreview;
    if (!yti || !yti.contentWindow) return;
    yti.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [seconds, true] }), '*');
    yti.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), '*');
}
async function seekTo(seconds) {
    const done = await seekLocal(seconds);
    if (!done) seekYouTube(seconds);
}

// ==========================================
// 3. CAPTURE FRAME & TIMESTAMP LOGIC
// ==========================================
function linkifyTimestamps(container) {
    const RX = /\b(?:(?:\d{1,2}:)?\d{2}:\d{2}|\d+h\d+m\d+s|\d+m\d+s|\d+s)\b/ig;
    // Simplified regex to catch [MM:SS] or MM:SS or 1h2m3s
    // The server regex was complex: /\b(?:\(?\[?)?(?:\d{1,2}:\d{2}(?::\d{2})?|\d+h\d+m\d+s|\d+m\d+s|\d+s)(?:\]?\)?)\b/ig;

    // We only want to linkify text nodes, but safe replacement on innerHTML is easier if careful
    // However, recreating exact server logic is safer:
    const nodes = [...container.querySelectorAll('p, li, h1, h2, h3, h4, span, td, th')];
    nodes.forEach(node => {
        if (!node.childNodes) return;
        if (node.querySelector('a.ts-link')) return; // Already processed
        node.innerHTML = node.innerHTML.replace(RX, m => {
            const secs = parseTimestampToSeconds(m);
            if (!secs) return m;
            // Ensure it's not already in a link (naive check)
            return `<button class="ts-link-btn" onclick="seekTo(${secs})">${m}</button>`;
        });
    });
}
window.seekTo = seekTo; // Global exposure for inline onclicks if needed (though we use class above?)
// Actually better to use event delegation in init() rather than inline strings. 
// But for now, let's use the replacement to creates buttons.

// Queue for serializing captures to allow "seeked" to finish
const captureQueue = [];
let isCapturing = false;

async function processCaptureQueue() {
    if (isCapturing || captureQueue.length === 0) return;
    isCapturing = true;
    while (captureQueue.length > 0) {
        const task = captureQueue.shift();
        try {
            await task();
        } catch (e) {
            console.error("Capture task failed:", e);
        }
        // Small buffer to prevent browser choking
        await new Promise(r => setTimeout(r, 50));
    }
    isCapturing = false;
}

async function captureVideoFrame(seconds) {
    const v = els.videoPreview;
    if (!v || !v.src || v.readyState < 1) { // Allow readyState 1 (Metadata) to attempt seek
        console.warn('captureVideoFrame: Video not ready', v?.readyState);
        return null;
    }
    try {
        await seekLocal(seconds, false);
        // FORCE RENDER DELAY: Wait for frame to actually update in renderer
        await new Promise(r => setTimeout(r, 150));
    } catch (e) {
        console.error('captureVideoFrame: Seek failed', e);
        return null;
    }

    // Safety: ensure reasonable dimensions
    if (v.videoWidth === 0 || v.videoHeight === 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', 0.85);
    console.log(`[Capture] Frame at ${seconds}s captured. size=${url.length}`);
    return url;
}

// ==========================================
// 4. CARD ANATOMY
// ==========================================
function normalizeHtml(raw) {
    if (!raw) return "";
    const parser = new DOMParser();
    const doc = parser.parseFromString(raw.replace(/```html/g, '').replace(/```/g, ''), "text/html");
    return doc.body.innerHTML;
}

function enforceOutputLayout(root = els.output) {
    if (!root) return;

    // Identify Package blocks from raw H2s
    const blocks = [];
    let currentBlock = null;
    const nodes = Array.from(root.childNodes);

    const isHeader = (n) => n.tagName === 'H2' || n.tagName === 'H1';

    nodes.forEach(node => {
        if (node.nodeName === '#text' && !node.textContent.trim()) return;

        // Custom/Saved Cards (already formatted)
        if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('video-card')) {
            blocks.push(node.cloneNode(true));
            currentBlock = null; // Break the current accumulation
            return;
        }

        if (node.nodeType === Node.ELEMENT_NODE && isHeader(node)) {
            currentBlock = document.createElement('div');
            currentBlock.className = 'video-card user';
            if (node.textContent.includes('Package')) {
                currentBlock.dataset.type = 'package';
                currentBlock.dataset.packageNum = node.textContent.replace(/\D/g, '');
            } else {
                currentBlock.className = 'video-card summary';
            }
            blocks.push(currentBlock);
        }
        if (currentBlock) currentBlock.appendChild(node.cloneNode(true));
    });

    if (blocks.length > 0) {
        root.innerHTML = '';
        blocks.forEach(card => {
            processCard(card);
            root.appendChild(card);
        });
    }
}

function processCard(card) {
    const isPackage = card.dataset.type === 'package';
    if (!isPackage) {
        card.style.padding = '20px'; // Simple style for summary
        return;
    }

    // Fix: If card is already processed (has thumb-container), do NOT re-process.
    // This prevents wiping the DOM and losing state if called accidentally.
    if (card.querySelector('.thumb-container')) {
        updateCardThumbnail(card);
        return;
    }

    // Data Extraction
    // Data Extraction
    let titleText = "Untitled";

    // Robust Title Finder
    const pTags = [...card.querySelectorAll('p')];
    // 1. Try explicit "Title:" prefix
    let titleP = pTags.find(p => /title:/i.test(p.textContent));
    if (titleP) {
        titleText = titleP.textContent.replace(/title:/i, '').trim();
    } else {
        // 2. Try identifying the bolded title pattern common in generation
        // Often formatted as <p><strong>Title:</strong> ...</p>
        // Or simply the first paragraph that follows the Core Angle
        // Or using the Gold Standard reference as a bounding box.

        // Let's try to look for lines that look like titles (shorter, no labels)
        // But falling back to "Untitled" is safe if we fail. 
    }

    // Cleanup title clean of any HTML tags if they leaked
    titleText = titleText.replace(/<\/?[^>]+(>|$)/g, "");
    if (titleText.length > 100) titleText = titleText.substring(0, 100) + '...';

    const text = card.textContent;
    const tsRegex = /\[(\d{1,2}:\d{2})\]/g;
    const timestamps = [...text.matchAll(tsRegex)].map(m => m[1]);

    // Fix: Save timestamps to dataset for robust re-use
    card.dataset.timestamps = JSON.stringify(timestamps);

    // Container
    const container = document.createElement('div');
    container.className = 'thumb-container';

    const img = document.createElement('img');
    img.className = 'thumb-img';
    img.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9" fill="%23111"><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%23333">No Preview</text></svg>';

    // Auto-Thumbnail Logic
    // We defer this until we are sure the video source is ready or we have enough info
    const tryCapture = () => {
        if (timestamps.length > 0) {
            const sec = parseTimestampToSeconds(timestamps[0]);
            // DEBUG: Ensure we use the queue to prevent parallel seeks on the single video element
            captureQueue.push(async () => {
                console.log(`[Queue] Auto-capture for card ${card.dataset.packageNum} at ${sec}s`);
                const url = await captureVideoFrame(sec);
                if (url) {
                    img.src = url;
                    card.dataset.thumbUrl = url;
                }
            });
            processCaptureQueue();
        }
    };

    if (currentInputMethod === 'local') {
        const v = els.videoPreview;
        // Debug logs
        console.log(`[ProcessCard] Checking video state for card. ReadyState: ${v?.readyState}`);

        if (v && v.readyState >= 1) {
            // 1 = HAVE_METADATA, usually enough to seek, but 2 (HAVE_CURRENT_DATA) is safer for frame.
            // Let's try if we have at least metadata.
            tryCapture();
        } else if (v) {
            console.log('[ProcessCard] Waiting for loadeddata/canplay...');
            // Listen for BOTH loadeddata and canplay to be safe
            const onReady = () => {
                console.log('[ProcessCard] Video ready event fired. Capturing...');
                tryCapture();
            };
            v.addEventListener('loadeddata', onReady, { once: true });
            v.addEventListener('canplay', onReady, { once: true });

            // Backup timeout
            setTimeout(() => {
                if (v.readyState >= 1) {
                    console.log('[ProcessCard] Timeout fired, video state:', v.readyState);
                    tryCapture();
                }
            }, 2000);
        }
    } else if (currentInputMethod === 'url' && els.ytUrl.value) {
        const ytID = extractYoutubeId(els.ytUrl.value);
        if (ytID) img.src = `https://img.youtube.com/vi/${ytID}/maxresdefault.jpg`;
    }

    // Overlay
    const overlay = document.createElement('div');
    overlay.className = 'thumb-overlay';

    const chipGroup = document.createElement('div');
    chipGroup.className = 'chip-group';
    timestamps.forEach(ts => {
        const chip = document.createElement('button');
        chip.className = 'ts-chip';
        chip.textContent = ts;
        chip.onclick = async () => {
            card.dataset.activeTimestamp = ts; // Persist choice
            if (currentInputMethod === 'local') {
                captureQueue.push(async () => {
                    console.log(`[Queue] Manual click to ${ts}`);
                    const url = await captureVideoFrame(parseTimestampToSeconds(ts));
                    if (url) {
                        img.src = url;
                        card.dataset.thumbUrl = url;
                    }
                });
                processCaptureQueue();
            } else {
                seekTo(parseTimestampToSeconds(ts));
                // Fix: Also update the card thumbnail for YouTube proxy
                updateCardThumbnail(card);
            }
        };
        chipGroup.appendChild(chip);
    });

    const upBtn = document.createElement('button');
    upBtn.className = 'upload-btn-mini';
    upBtn.innerHTML = '⬆️';
    const fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.style.display = 'none';
    fileInput.onchange = (e) => {
        const f = e.target.files[0];
        if (f) { const url = URL.createObjectURL(f); img.src = url; }
    };
    upBtn.onclick = () => fileInput.click();

    overlay.appendChild(chipGroup);
    overlay.appendChild(upBtn);
    container.appendChild(img);
    container.appendChild(overlay);

    // Body Structure matching YouTube
    // [Avatar] [Title / Channel / Views]
    const details = document.createElement('div');
    details.className = 'card-details';

    const avatar = document.createElement('div');
    avatar.className = 'channel-avatar';
    // NB Logo Style
    avatar.textContent = 'NB';
    avatar.style.background = '#3ea6ff';
    avatar.style.color = '#000';
    avatar.style.display = 'grid';
    avatar.style.placeItems = 'center';
    avatar.style.fontWeight = '800';
    avatar.style.fontSize = '12px';
    avatar.style.borderRadius = '50%';

    const metaCol = document.createElement('div');
    metaCol.className = 'meta-col';

    const titleInput = document.createElement('div');
    titleInput.className = 'card-title';
    titleInput.contentEditable = true;
    titleInput.textContent = titleText;

    const angleP = pTags.find(p => p.textContent.includes('Core Angle'));
    const angleText = angleP ? angleP.textContent.replace('Core Angle:', '').replace(/<\/?[^>]+(>|$)/g, "").trim() : 'ClickPilot Strategy';

    const channelName = document.createElement('div');
    channelName.className = 'card-channel-name';
    channelName.textContent = angleText; // Using Angle as "Channel Name" analog

    // Random recent view count for realism
    const views = Math.floor(Math.random() * 900) + 100 + 'K views';
    const time = Math.floor(Math.random() * 11) + 1 + ' days ago';

    const stats = document.createElement('div');
    stats.className = 'card-stats';
    stats.textContent = `${views} • ${time}`;

    metaCol.appendChild(titleInput);
    metaCol.appendChild(channelName);
    metaCol.appendChild(stats);

    details.appendChild(avatar);
    details.appendChild(metaCol);

    // Actions Row (Subtle)
    const actions = document.createElement('div');
    actions.className = 'card-actions-row';

    const btnRegen = document.createElement('button');
    btnRegen.className = 'action-icon regen-btn'; // added class for handler
    btnRegen.innerHTML = '🔄';
    btnRegen.title = "Regenerate Title";
    btnRegen.onclick = () => handleRegenerateCard(card, card.dataset.packageNum);

    // Removed Delete Button as per request

    actions.appendChild(btnRegen);

    // Assembly
    const body = document.createElement('div');
    // We append details then actions
    body.appendChild(details);
    body.appendChild(actions);

    card.innerHTML = '';
    card.appendChild(container);
    card.appendChild(body);

    // Finalize: Trigger Thumbnail Update (Embeds/Local)
    updateCardThumbnail(card);
}

// Custom Card Feature
// Custom Card Feature
function createCustomCard(options = {}) {
    const card = document.createElement('div');
    card.className = 'video-card custom-card'; // Added custom-card class for Market Mode reordering
    card.dataset.customCard = 'true'; // Mark as custom card

    // Thumbnail Area
    const container = document.createElement('div');
    container.className = 'thumb-container';

    // File Input
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';

    // Upload UI
    const uploadArea = document.createElement('div');
    uploadArea.className = 'custom-upload-area';
    uploadArea.innerHTML = `
        <div style="font-size:24px; margin-bottom:8px;">+</div>
        <div style="font-size:12px;">Upload Thumbnail</div>
    `;

    // Image Preview (Hidden initially)
    const imgPreview = document.createElement('img');
    imgPreview.className = 'thumb-img';
    imgPreview.style.display = 'none';

    // Handlers
    container.onclick = (e) => {
        // Prevent triggering if clicking editable text if somehow nested? No.
        fileInput.click();
    };

    fileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                imgPreview.src = ev.target.result;
                imgPreview.style.display = 'block';
                uploadArea.style.display = 'none';

                // Add "Clear" option? For now just re-click to replace?
                // Re-clicking container triggers input again.
            };
            reader.readAsDataURL(file);
        }
    };

    container.appendChild(fileInput);
    container.appendChild(uploadArea);
    container.appendChild(imgPreview);

    // Body Structure
    const details = document.createElement('div');
    details.className = 'card-details';

    const avatar = document.createElement('div');
    avatar.className = 'channel-avatar';
    avatar.textContent = 'NB'; // Standard Logo
    avatar.style.background = 'var(--brand)';
    avatar.style.color = '#000'; // Black text to match standard
    avatar.style.display = 'grid';
    avatar.style.placeItems = 'center';
    avatar.style.fontSize = '12px'; // Match standard
    avatar.style.fontWeight = '800'; // Match standard

    const metaCol = document.createElement('div');
    metaCol.className = 'meta-col';

    // 1. Title (Editable)
    const titleInput = document.createElement('div');
    titleInput.className = 'card-title editable-text';
    titleInput.contentEditable = true;
    titleInput.innerText = 'Click to add your own title...';
    // Clear on first focus
    titleInput.onfocus = function () {
        if (this.innerText === 'Click to add your own title...') this.innerText = '';
    };

    // 2. Channel Name (Editable) - "NBMedia"
    const channelName = document.createElement('div');
    channelName.className = 'card-channel-name editable-text';
    channelName.contentEditable = true;
    channelName.innerText = 'NBMedia';
    // Removed inline fontSize (handled by CSS .card-channel-name)
    channelName.style.color = '#aaa';
    // Removed marginTop, let .meta-col gap (4px) handle it. 
    // If needed specifically: channelName.style.marginTop = '0';

    // 3. Fixed Metadata - "952K views • 3 days ago"
    const metaStats = document.createElement('div');
    metaStats.className = 'card-stats';
    metaStats.innerText = '952K views • 3 days ago';
    // Removed inline fontSize (handled by CSS .card-stats)
    metaStats.style.color = '#aaa';
    metaStats.style.marginTop = '0px';


    metaCol.appendChild(titleInput);
    metaCol.appendChild(channelName);
    metaCol.appendChild(metaStats);

    details.appendChild(avatar);
    details.appendChild(metaCol);

    // Assembly
    const body = document.createElement('div');
    body.appendChild(details);

    card.appendChild(container);
    card.appendChild(body);

    // Save Button (Icon at bottom right)
    if (!options.readOnly) {
        const btn = document.createElement('button');
        btn.className = 'ghost';
        btn.title = 'Save to History';

        // Absolute positioning
        btn.style.position = 'absolute';
        btn.style.bottom = '10px';
        btn.style.right = '10px';
        btn.style.background = 'transparent';
        btn.style.border = 'none';
        btn.style.padding = '0';
        btn.style.cursor = 'pointer';
        btn.style.zIndex = '5';
        btn.style.width = '24px'; // Match Regenerate icon size (approx)
        btn.style.height = '24px';
        btn.style.display = 'grid'; // Center img
        btn.style.placeItems = 'center';

        const icon = document.createElement('img');
        icon.src = 'icon-save-blue.png'; // New blue floppy disk icon
        icon.style.width = '100%';
        icon.style.height = '100%';
        icon.style.objectFit = 'contain';

        btn.appendChild(icon);

        btn.onclick = (e) => {
            e.stopPropagation();
            handleSaveCustomCard(card, btn);
        };

        card.appendChild(btn);
    }


    return card;
}

// Logic to Save Custom Card to History
// Helper to update history content after deletion
async function saveHistoryUpdate(id) {
    if (!els.historyDetailView) return;
    const clone = els.historyDetailView.cloneNode(true);
    // Remove the input template (identified by file input)
    const template = clone.querySelector('input[type="file"]')?.closest('.video-card');
    if (template) template.remove();

    // Remove all Delete Buttons so they don't multiply? 
    // No, we want to keep them.

    const html = clone.innerHTML;
    try {
        const res = await fetch(`${API_BASE}/api/history/${id}/update-content`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ html })
        });
        if (!res.ok) {
            throw new Error(`Server returned ${res.status} ${res.statusText}`);
        }
    } catch (e) {
        console.error(e);
        alert("Failed to save deletion. PLEASE RESTART THE SERVER (npm start) to apply the latest updates.");
    }
}

window.deleteCustomCard = async function (btn) {
    if (!confirm("Delete this card?")) return;
    const card = btn.closest('.video-card');
    if (card) card.remove();

    if (typeof currentHistoryItemId !== 'undefined' && currentHistoryItemId) {
        await saveHistoryUpdate(currentHistoryItemId);
    }
};

async function handleSaveCustomCard(card, btn) {
    const title = card.querySelector('.card-title')?.innerText;
    const channelName = card.querySelector('.card-channel-name')?.innerText;
    // Stats might be fixed but let's grab it or hardcode it for history consistency
    // Actually for custom cards, we want to save exactly what's there? 
    // Or do we save the "NBMedia" and "952K views" as part of the visual look?
    // Let's grab the text content of the stats line
    const statsText = card.querySelector('.card-stats')?.innerText || '952K views • 3 days ago';

    const img = card.querySelector('.thumb-img');
    const imgSrc = (img && img.style.display !== 'none') ? img.src : null;

    // Updated validation
    if (!title || title.includes('Click to add') || !channelName || channelName.includes('Add description')) {
        alert("Please add a title and channel name before saving.");
        return;
    }

    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.style.cursor = 'wait';

    // Construct HTML for storage (Read-Only version of what we see)
    // We create a clone or just string build? String build is safer for "clean" HTML.
    // Normalized HTML structure for history
    const cardHtml = `
    <div class="video-card custom-saved">
        <div class="thumb-container">
            ${imgSrc
            ? `<img src="${imgSrc}" class="thumb-img" style="display:block; width:100%; height:100%; object-fit:cover;">`
            : `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 9' fill='%23111'%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%23333'%3ENo Preview%3C/text%3E%3C/svg%3E" class="thumb-img" style="display:block; width:100%; height:100%; object-fit:cover;">`
        }
        </div>
        <div class="card-details">
            <div class="channel-avatar" style="background:var(--brand); color:#000; display:grid; place-items:center; font-size:12px; font-weight:800;">NB</div>
            <div class="meta-col">
                <div class="card-title">${title}</div>
                <div class="card-channel-name" style="color:#aaa;">${channelName}</div>
                <div class="card-stats" style="color:#aaa; margin-top:0px;">${statsText}</div>
            </div>
        </div>
        <div class="card-actions-row">
            <button class="action-icon" onclick="deleteCustomCard(this)" title="Delete Card">🗑️</button>
        </div>
    </div>
    `;

    try {
        let res;
        // Check if we are viewing a specific history item
        if (typeof currentHistoryItemId !== 'undefined' && currentHistoryItemId) {
            // Append to existing item
            res = await fetch(`${API_BASE}/api/history/${currentHistoryItemId}/append`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ html: cardHtml })
            });
        } else {
            // Create New Item (Fallback or if triggered from Dashboard?)
            // Actually, if triggered from Dashboard output (run results), we might not have a history ID yet unless we saved the run?
            // "Generate packages to see them here" -> Run -> Dashboard populated.
            // Does Run create a history item immediately? 
            // `run` calls `/api/generate`. Does `/api/generate` save history?
            // Let's assume it does (it usually does in these apps).
            // But `currentHistoryItemId` is only set in `loadHistoryItem`.
            // So if user just Ran, `currentHistoryItemId` is null.
            // So they save -> New Item.
            // User requested: "saved... inside the History Detail view page only"
            // If they are in Dashboard, where does it go?
            // If they are in Dashboard, maybe we should CREATE a history item for the current Dashboard content if it doesn't exist?
            // Existing logic creates a NEW item for JUST the card. That's what the user disliked in list.

            // If we are in Dashboard (no history ID), standard behavior (Create) might be the only option unless we "Save Session".
            // But user specifically complained about "on the watch history page... list".
            // So when they are viewing history, it should append.

            res = await fetch(`${API_BASE}/api/history/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    html: cardHtml,
                    meta: {
                        title: title,
                        displayName: 'Custom Card',
                        videoSource: 'custom',
                        generationContext: {
                            angleHint: 'Custom',
                            strategistPrompt: channelName
                        }
                    }
                })
            });
        }

        if (res.ok) {
            btn.style.opacity = '1';
            btn.style.cursor = 'default';
            // Visual feedback - bounce
            btn.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.2)' }, { transform: 'scale(1)' }], { duration: 300 });

            // "One more Customize Your Own Card template got made next to it automatically"
            const newCard = createCustomCard();
            // Insert after current card
            card.parentNode.insertBefore(newCard, card.nextSibling);

        } else {
            throw new Error('Save failed');
        }
    } catch (e) {
        console.error(e);
        btn.style.opacity = '1';
        btn.disabled = false;
        alert("Failed to save card.");
    }
}

// New helper to update thumbnails WITHOUT destroying DOM
async function updateCardThumbnail(card) {
    if (!card.dataset.timestamps) return;
    const timestamps = JSON.parse(card.dataset.timestamps || "[]");
    if (timestamps.length === 0) return;

    const img = card.querySelector('.thumb-img');
    if (!img) return;

    // Only update if it's still the placeholder
    // URL containing SVG data means it's likely the placeholder
    const isPlaceholder = img.src.includes('data:image/svg+xml') || img.src === window.location.href; // sometimes empty src resolves to href

    // Use the capture queue to ensure correct frame
    if (currentInputMethod === 'local') {
        const v = els.videoPreview;
        // Only queue if we have video and metadata
        if (v && v.readyState >= 1) {
            const targetTs = card.dataset.activeTimestamp || timestamps[0];
            const sec = parseTimestampToSeconds(targetTs);
            captureQueue.push(async () => {
                console.log(`[Queue] Update thumb for card to ${sec}s`);
                const url = await captureVideoFrame(sec);
                if (url) {
                    img.src = url;
                    card.dataset.thumbUrl = url;
                }
            });
            processCaptureQueue();
        }
    } else if (currentInputMethod === 'url') {
        const ytID = extractYoutubeId(els.ytUrl.value);
        if (ytID) {
            const targetTs = card.dataset.activeTimestamp || timestamps[0];
            const sec = parseTimestampToSeconds(targetTs);

            // Revert Iframe to Image if needed
            let iframe = card.querySelector('iframe.thumb-img');
            if (iframe) {
                const newImg = document.createElement('img');
                newImg.className = 'thumb-img';
                iframe.replaceWith(newImg);
                img = newImg; // Update reference
            }

            // Use Proxy Endpoint
            // We use the FULL YouTube URL from input (els.ytUrl.value)
            const videoUrl = els.ytUrl.value;
            img.src = `${API_BASE}/api/proxy-youtube-frame?url=${encodeURIComponent(videoUrl)}&time=${sec}`;
            card.dataset.thumbUrl = img.src;
        }
    }
}

// 1. Update handleRegenerateCard signature
async function handleRegenerateCard(card, packageNum, contextOverride = null) {
    const ctx = contextOverride || lastGenerationContext;
    if (!ctx) return alert('No context available.');

    const btn = card.querySelector('.regen-btn');
    if (btn) btn.disabled = true;

    // Show Loading Overlay on Thumbnail
    const thumbContainer = card.querySelector('.thumb-container');
    let loader = null;
    if (thumbContainer) {
        loader = document.createElement('div');
        loader.className = 'thumb-loader'; // Defined in style.css
        thumbContainer.appendChild(loader);
    }

    log(`Regenerating #${packageNum}...`);
    try {
        const tRes = await fetch(`${API_BASE}/api/queue/ticket`, { method: 'POST' });
        const { id: qid } = await tRes.json();
        attachQueueStream(qid, { labelWhileActive: 'Regenerating...' });

        const res = await fetch(`${API_BASE}/api/regenerate-card?qid=${encodeURIComponent(qid)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...ctx, packageNum })
        });
        if (!res.ok) throw new Error('Regen failed');
        const d = await res.json();
        const html = normalizeHtml(d.html || "");

        // Parsing the new HTML into the card
        // We expect exactly ONE package output HTML from server for single regen
        const temp = document.createElement('div');
        temp.innerHTML = html;

        // Populate card with new content
        card.innerHTML = html;

        // Process new content
        processCard(card);

        log(`Regenerated #${packageNum}`, 'ok');
    } catch (e) {
        // Remove loader on error
        if (loader) loader.remove();

        log(`Regen Error: ${e.message}`, 'err');
        if (btn) btn.disabled = false;
    }
}

// ==========================================
// 1.1 AUTHENTICATION LOGIC (Google Identity Services)
// ==========================================
function parseJwt(token) {
    try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(window.atob(base64).split('').map(function (c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        return JSON.parse(jsonPayload);
    } catch (e) {
        return null;
    }
}

function handleCredentialResponse(response) {
    const responsePayload = parseJwt(response.credential);
    console.log("ID: " + responsePayload.sub);
    console.log('Full Name: ' + responsePayload.name);
    console.log('Given Name: ' + responsePayload.given_name);
    console.log('Family Name: ' + responsePayload.family_name);
    console.log("Image URL: " + responsePayload.picture);
    console.log("Email: " + responsePayload.email);

    const email = responsePayload.email;

    if (email && email.endsWith('@nbmediaproductions.com')) {
        localStorage.setItem('tt_user_email', email);
        localStorage.setItem('tt_user_name', responsePayload.name);
        localStorage.setItem('tt_user_pic', responsePayload.picture);

        // Update UI
        checkAuth();
    } else {
        alert("Access Denied: You must use an @nbmediaproductions.com email address.");
        // Clear session if any
        localStorage.removeItem('tt_user_email');
    }
}

function checkAuth() {
    const user = localStorage.getItem('tt_user_email');
    const overlay = document.getElementById('login-overlay');

    // Check if user exists and has valid domain
    if (user && user.endsWith('@nbmediaproductions.com')) {
        if (overlay) overlay.style.display = 'none';
        console.log(`Logged in as ${user}`);

        // Update User Menu Button
        // Force Initial Only as per request
        const name = localStorage.getItem('tt_user_name') || 'User';
        const userBtn = document.getElementById('userMenuBtn');
        const initial = name.charAt(0).toUpperCase();

        if (userBtn) {
            // Always show Initial
            userBtn.innerHTML = `<div class="user-avatar" style="background:var(--brand);">${initial}</div>`;
        }

        // Pre-populate Dropdown (so it's ready when clicked)
        const dropdown = document.getElementById('userDropdown');
        if (dropdown) {
            dropdown.innerHTML = `
                <div class="dropdown-header">
                    <div class="dropdown-avatar-large" style="background:var(--brand); display:grid; place-items:center;">
                        ${initial}
                    </div>
                    <div class="dropdown-name">${name}</div>
                    <div class="dropdown-email">${user}</div>
                </div>
                <button class="dropdown-item" onclick="alert('Settings not implemented yet')">
                     ⚙️ User Settings
                </button>
                <div class="dropdown-divider"></div>
                <button class="dropdown-item" onclick="logout()">
                     🚪 Log Out
                </button>
            `;
        }

    } else {
        if (overlay) overlay.style.display = 'grid'; // Grid for centering

        // Initialize Google Sign-In Button
        if (typeof google !== 'undefined') {
            google.accounts.id.initialize({
                client_id: "859069659723-t48kb1j7195akcmq12ivk4tabrsldlnm.apps.googleusercontent.com",
                callback: handleCredentialResponse
            });
            google.accounts.id.renderButton(
                document.getElementById("google-btn-container"),
                { theme: "outline", size: "large", type: "standard" }  // customization attributes
            );
        } else {
            setTimeout(checkAuth, 100);
        }
    }
}

// Global functions for User Menu
window.toggleUserMenu = function (e) {
    e.stopPropagation();
    const dd = document.getElementById('userDropdown');
    if (dd) {
        dd.style.display = dd.style.display === 'none' ? 'flex' : 'none';
    }
};

window.logout = function () {
    if (confirm('Are you sure you want to log out?')) {
        localStorage.removeItem('tt_user_email');
        localStorage.removeItem('tt_user_name');
        localStorage.removeItem('tt_user_pic');
        location.reload();
    }
};

// Close dropdown on outside click
document.addEventListener('click', (e) => {
    const dd = document.getElementById('userDropdown');
    const btn = document.getElementById('userMenuBtn');
    if (dd && dd.style.display !== 'none') {
        if (!dd.contains(e.target) && !btn.contains(e.target)) {
            dd.style.display = 'none';
        }
    }
});

// Make globally available for Google Callback
window.handleCredentialResponse = handleCredentialResponse;

// ==========================================
// 5. GENERATION FLOW
// ==========================================
function setStatus(msg) { if (els.status) els.status.innerHTML = msg; }
function setProgress(pct, msg) {
    if (els.bar) els.bar.style.width = pct + "%";
    if (els.modalBar) els.modalBar.style.width = pct + "%";
    if (msg) {
        setStatus(msg);
        if (els.modalStatus) els.modalStatus.textContent = msg.replace(/<[^>]+>/g, '');
    }
}
function showProgress(show) {
    els.progressOverlay.style.display = show ? 'flex' : 'none'; // Flex for centering
    if (show) {
        // Reset log on new run
        if (els.modalLog) els.modalLog.innerHTML = '';
        if (els.modalStatus) els.modalStatus.textContent = 'Ready';
        if (els.modalBar) els.modalBar.style.width = '0%';
    }
}

// ==========================================
// MARKET MODE LOGIC
// ==========================================

// 1. Toggle Handler
if (els.competitorToggle) {
    els.competitorToggle.addEventListener('change', (e) => {
        if (e.target.checked) {
            // Open Modal
            els.competitorModal.style.display = 'grid';
            els.competitorSearch.focus();
        } else {
            // Remove competitors from grid? OR just keep them?
            // Usually unchecking market mode hides comparison context.
            // Let's remove them for clarity.
            document.querySelectorAll('.video-card.competitor').forEach(el => el.remove());
        }
    });
}

// 2. Modal Controls
if (els.closeCompetitorModal) {
    els.closeCompetitorModal.addEventListener('click', () => {
        els.competitorModal.style.display = 'none';
        // Uncheck toggle if closed without adding? No, user might just be done searching.
        // We leave toggle checked if they added stuff. If they didn't, maybe uncheck?
        // Let's keep it simple.
    });
}

// 3. Search Handler
async function searchCompetitors() {
    const query = els.competitorSearch.value.trim();
    if (!query) return;

    els.competitorResults.innerHTML = '<div style="grid-column:1/-1; text-align:center;">Searching YouTube...</div>';

    try {
        const res = await fetch(`${API_BASE}/api/search-competitors?query=${encodeURIComponent(query)}&limit=10`);
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        renderCompetitorResults(data.videos || []);
    } catch (e) {
        els.competitorResults.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:red;">Error: ${e.message}</div>`;
    }
}

if (els.btnSearchCompetitors) {
    els.btnSearchCompetitors.addEventListener('click', searchCompetitors);
}
if (els.competitorSearch) {
    els.competitorSearch.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') searchCompetitors();
    });
}

// 4. Render Results
function renderCompetitorResults(videos) {
    els.competitorResults.innerHTML = '';
    if (videos.length === 0) {
        els.competitorResults.innerHTML = '<div style="grid-column:1/-1; text-align:center;">No videos found.</div>';
        return;
    }

    videos.forEach(v => {
        const div = document.createElement('div');
        div.className = 'comp-result-card';
        div.style.cssText = 'background:var(--bg-card); border:1px solid var(--border); border-radius:8px; overflow:hidden; cursor:pointer; transition:border-color 0.2s;';
        div.innerHTML = `
            <div style="position:relative; aspect-ratio:16/9; background:#000;">
                <img src="${v.thumbnail}" style="width:100%; height:100%; object-fit:cover;">
                <div style="position:absolute; bottom:4px; right:4px; background:rgba(0,0,0,0.8); color:#fff; font-size:10px; padding:2px 4px; border-radius:2px;">
                    ${formatDuration(v.duration)}
                </div>
            </div>
            <div style="padding:10px;">
                <div style="font-size:12px; font-weight:600; line-height:1.2; margin-bottom:4px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">${v.title}</div>
                <div style="font-size:10px; color:var(--text-muted);">${v.channel}</div>
                <div style="font-size:10px; color:var(--text-muted);">${v.date}</div>
            </div>
            <button style="width:100%; border:none; background:var(--accent); color:#000; padding:6px; font-weight:600; cursor:pointer;">Add to Board</button>
        `;

        // Click to Add
        div.onclick = () => {
            addCompetitorToGrid(v);
            // Visual feedback
            div.style.border = '2px solid var(--accent)';
            div.querySelector('button').textContent = 'Added';
            setTimeout(() => {
                els.competitorModal.style.display = 'none'; // Close on add? Or let them add multiple?
                // Let them add multiple.
            }, 500);
        };

        els.competitorResults.appendChild(div);
    });
}

function formatDuration(sec) {
    if (!sec) return '';
    // if string "10:00" return as is
    if (typeof sec === 'string' && sec.includes(':')) return sec;

    // if seconds number
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// 5. Add to Grid
function addCompetitorToGrid(v) {
    const card = document.createElement('div');
    card.className = 'video-card competitor'; // specialized class
    // Re-use standard card styling roughly, but distinct
    card.style.border = '1px dashed var(--accent)';

    card.innerHTML = `
        <div class="thumb-container">
            <img class="thumb-img" src="${v.thumbnail}" style="opacity:0.8;">
            <div class="thumb-overlay">
                <div style="position:absolute; top:8px; left:8px; background:var(--accent); color:black; font-size:10px; font-weight:bold; padding:2px 6px; border-radius:4px;">COMPETITOR</div>
            </div>
        </div>
        <div class="card-details">
            <div class="channel-avatar" style="background:#555;">C</div>
            <div class="meta-col">
                <div class="card-title" style="color:var(--text-muted);">${v.title}</div>
                <div class="card-channel-name">${v.channel}</div>
                <div class="card-stats">${v.views || 'N/A'} views • ${v.date}</div>
            </div>
        </div>
    `;

    // Insert at top? Or mix?
    // Let's prepend to output so they are seen first for context.
    els.output.prepend(card);
}
function log(line, kind = 'info') {
    const t = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.innerHTML = `<strong>[${t}]</strong> ${line}`;
    if (kind === 'err') div.style.color = 'var(--danger)';
    if (kind === 'ok') div.style.color = 'var(--success)';
    if (kind === 'ok') div.style.color = 'var(--success)';
    if (els.modalLog) els.modalLog.appendChild(div);
}

// Queue & Upload logic
// (mapProgressLabel removed in favor of raw messages)

// Improved Raw Progress Handler matching Legacy
function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

async function createQueueTicket() {
    const r = await fetch(`${API_BASE}/api/queue/ticket`, { method: 'POST' });
    return (await r.json()).id;
}
function attachQueueStream(id, { labelWhileActive } = {}) {
    // FIX: Match server endpoint /api/queue/:id/stream
    const es = new EventSource(`${API_BASE}/api/queue/${encodeURIComponent(id)}/stream`);
    es.onmessage = (e) => {
        const d = JSON.parse(e.data);
        if (d.progress) {
            // Use RAW message for legacy feel
            const msg = d.progress.msg || labelWhileActive;
            setProgress(d.progress.pct, msg);
        }
        if (d.progress && d.progress.msg) log(d.progress.msg); // Log server messages to console box

        if (d.state === 'done') es.close();
        if (d.error) { log(d.error, 'err'); es.close(); }
    };
    es.onerror = (e) => {
        console.error("EventSource failed:", e);
        es.close();
    };
    return () => es.close();
}

// Helper for nice history dates (ChatGPT style)
function formatHistoryDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';

    const now = new Date();
    const diff = now - d;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function uploadLocalVideoWithProgress(file) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const startTime = Date.now();

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 100);
                const loaded = formatBytes(e.loaded);
                const total = formatBytes(e.total);

                // Calculate Speed
                const elapsed = (Date.now() - startTime) / 1000; // seconds
                const bps = e.loaded / elapsed;
                const speed = formatBytes(bps) + '/s';

                const status = `Uploading... ${loaded} / ${total} (${pct}%) — ${speed}`;
                setProgress(pct, status);
            }
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                log(`Upload complete: ${file.name}`);
                resolve(JSON.parse(xhr.responseText));
            } else reject(new Error(xhr.responseText));
        };
        xhr.open('POST', `${API_BASE}/api/upload-video`);
        const fd = new FormData(); fd.append('video', file);
        xhr.send(fd);
    });
}

// Main Run
async function run() {
    currentHistoryItemId = null;
    els.runBtn.disabled = true;
    // Reset Views
    els.historyDetailView.style.display = 'none';
    els.historyView.style.display = 'none';
    els.output.style.display = 'grid';

    showProgress(true);
    log('Starting...');

    try {
        const promptVal = els.prompt.value || "Default Prompt";
        let fileUri = "", fileMime = "", videoSource = "", playback = null;

        if (currentInputMethod === 'url') {
            const url = els.ytUrl.value.trim();
            if (!url) throw new Error("No URL");
            videoSource = `YouTube: ${url}`;
            log(`Processing YouTube URL: ${url}`);
            setProgress(10, "Fetching YouTube Info...");
            const q = await createQueueTicket();
            attachQueueStream(q, { labelWhileActive: 'Fetching YouTube...' });
            const r = await fetch(`${API_BASE}/api/fetch-youtube?qid=${q}`, {
                method: 'POST', body: JSON.stringify({ url }), headers: { 'Content-Type': 'application/json' }
            });
            const j = await r.json();
            fileUri = j.fileUri; fileMime = j.fileMime || 'video/mp4'; playback = j.playback;
        } else {
            const f = els.videoFile.files[0];
            if (!f) throw new Error("No file");
            videoSource = `Local: ${f.name}`;
            log(`Starting upload: ${f.name} (${formatBytes(f.size)})`);
            // setProgress handled by uploader
            const j = await uploadLocalVideoWithProgress(f);
            fileUri = j.fileUri; fileMime = j.fileMime; playback = j.playback;
        }

        const body = {
            fileUri, fileMime, videoSource, playback,
            strategistPrompt: promptVal,
            titleHint: els.titleHint.value, angleHint: els.angleHint.value,
        };
        lastGenerationContext = { ...body };

        const q2 = await createQueueTicket();
        setProgress(30, "Submitting to Gemini...");
        attachQueueStream(q2, { labelWhileActive: 'Generating...' });

        const genRes = await fetch(`${API_BASE}/api/generate?qid=${q2}`, {
            method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }
        });
        const genData = await genRes.json();

        setProgress(90, "Rendering Output...");
        log('Formatting model output…');

        els.output.innerHTML = normalizeHtml(genData.html);
        linkifyTimestamps(els.output);
        enforceOutputLayout();

        // Append Blank Custom Card (Last Item)
        els.output.appendChild(createCustomCard());

        setProgress(100, "Done!");
        log('Run complete.', 'ok');
        setTimeout(() => showProgress(false), 500); // Short delay to see 100%
    } catch (e) {
        log(e.message, 'err');
        showProgress(false);
    } finally {
        els.runBtn.disabled = false;
        setStatus('Ready'); // Fix persistent status
    }
}

// ==========================================
// 6. HISTORY LOGIC
// ==========================================
// ==========================================
// 6. HISTORY LOGIC
// ==========================================
// ==========================================
// 6. HISTORY LOGIC
// ==========================================
async function handleHistoryRegen(e, id) {
    e.stopPropagation(); // prevent card click
    const card = e.target.closest('.history-card');
    const item = JSON.parse(card.dataset.json || '{}');

    // Reconstruct Context
    const context = {
        fileUri: item.fileUri,
        fileMime: item.fileMime,
        videoSource: item.videoSource,
        playback: item.playback,
        strategistPrompt: item.prompt, // Prompt was saved as 'prompt' or 'strategistPrompt'? Item usually has 'prompt'.
        titleHint: "", // Not saved in history usually?
        angleHint: ""
    };

    // Ensure we have minimal context
    if (!context.videoSource && !context.playback) {
        return alert("Cannot regenerate: Missing video source in history item.");
    }

    // Reuse the main regen logic but pass context
    // We need to support 'packageNum' - History items are single packages?
    // Actually, `regenerate-card` endpoint expects a packageNum. 
    // History items are individual rows (titles). 
    // Is the endpoint designed to regenerate a SPECIFIC card from a batch?
    // Yes. But here we have a saved item.
    // If we want to "regenerate" via AI, we might need to treat it as a fresh generation of 1 item?
    // Or call `regenerate-card`. Let's allow `packageNum=0` effectively.

    await handleRegenerateCard(card, 0, context);
}

// MAKE GLOBAL
window.handleHistoryRegen = handleHistoryRegen;

// Close history and return to dashboard
function closeHistory() {
    currentHistoryItemId = null;
    els.historyView.style.display = 'none';
    els.historyDetailView.style.display = 'none'; // Ensure detail is hidden
    els.output.style.display = 'grid'; // Restore dashboard state
    clearHeaderLeft();
}

async function loadHistory(q = '') {
    try {
        els.output.style.display = 'none';
        els.historyDetailView.style.display = 'none'; // Ensure detail is hidden
        els.historyView.style.display = 'flex';

        // Add Back Button to Header (Back to Dashboard)
        const headerLeft = document.getElementById('headerLeft');
        if (headerLeft) {
            headerLeft.innerHTML = '';
            const backBtn = document.createElement('button');
            backBtn.className = 'action-icon';
            backBtn.style.fontSize = '24px';
            backBtn.style.cursor = 'pointer';
            backBtn.style.background = 'transparent';
            backBtn.style.border = 'none';
            backBtn.style.color = 'var(--text-main)';
            backBtn.style.display = 'flex';
            backBtn.style.alignItems = 'center';
            backBtn.style.gap = '8px';
            backBtn.innerHTML = `
                <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" style="pointer-events: none; display: block; width: 24px; height: 24px; fill: currentColor;"><g><path d="M20,11H7.83l5.59-5.59L12,4l-8,8l8,8l1.41-1.41L7.83,13H20V11z"></path></g></svg>
            `;
            backBtn.title = "Back to Dashboard";
            backBtn.onclick = () => closeHistory();
            headerLeft.appendChild(backBtn);
        }

        // 1. Render Shell if not present
        let listContainer = document.getElementById('history-list-items');
        if (!listContainer) {
            els.historyView.innerHTML = `
                <div class="history-search-container">
                    <div class="history-search-bar">
                        <div class="history-search-input-wrapper">
                            <input type="text" id="histSearchInput" placeholder="Search watch history">
                        </div>
                        <button class="history-search-btn">
                            <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" style="pointer-events: none; display: block; width: 24px; height: 24px; fill: currentColor;"><g><path d="M20.87,20.17l-5.59-5.59C16.35,13.35,17,11.75,17,10c0-3.87-3.13-7-7-7s-7,3.13-7,7s3.13,7,7,7c1.75,0,3.35-0.65,4.58-1.28 l5.59,5.59L20.87,20.17z M10,15c-2.76,0-5-2.24-5-5s2.24-5,5-5s5,2.24,5,5S12.76,15,10,15z"></path></g></svg>
                        </button>
                    </div>
                </div>

                <div class="history-page-header-col">
                    <div class="history-page-title">Watch history</div>
                    <div class="history-filters">
                        <div id="chip-all" class="history-chip active">All</div>
                        <div id="chip-podcasts" class="history-chip">Podcasts</div>
                    </div>
                </div>

                <div id="history-list-items">
                    <div style="padding:20px; color:var(--text-dim);">Loading...</div>
                </div>
            `;
            listContainer = document.getElementById('history-list-items');

            // Bind Chips
            const chipAll = document.getElementById('chip-all');
            const chipPod = document.getElementById('chip-podcasts');

            const toggleChip = (activeChip) => {
                [chipAll, chipPod].forEach(c => c.classList.remove('active'));
                activeChip.classList.add('active');
            };

            chipAll.onclick = () => { toggleChip(chipAll); loadHistory(); };
            chipPod.onclick = () => { toggleChip(chipPod); };

            // Bind Search
            const searchInput = document.getElementById('histSearchInput');
            let debounceTimer;
            searchInput.addEventListener('input', (e) => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    loadHistory(e.target.value);
                }, 400);
            });
        }

        const r = await fetch(`${API_BASE}/api/history?limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}`);
        const j = await r.json();
        const items = j.items || [];

        if (items.length === 0) {
            listContainer.innerHTML = '<div style="padding:40px; text-align:center; color:var(--text-muted);">No watch history found.</div>';
            return;
        }

        let html = '';
        let currentLabel = null;

        items.forEach(item => {
            // Server returns `created_at` (timestamp)
            const dateStr = item.created_at ? new Date(item.created_at).toISOString() : new Date().toISOString();
            const label = formatHistoryDate(dateStr);

            if (label !== currentLabel) {
                html += `<div class="history-section-title">${label}</div>`;
                currentLabel = label;
            }

            // Item Metadata
            const title = item.title || 'Untitled';
            const channel = item.angle || 'NBMedia';
            // Mock View count
            const viewCount = Math.floor(Math.random() * 900 + 100) + 'K views';

            // Generate description with hashtags
            let rawStrategy = item.summary || item.prompt || 'No description available';
            // Extract some hashtags from strategy if not present, or mock them
            let hashtags = '#truecrime #documentary';

            let description = rawStrategy;
            if (description.length > 120) description = description.substring(0, 120) + '...';
            // Combine for UI
            const descHtml = `
                ${description} <span style="color:var(--brand);">${hashtags}</span>
            `;

            // Thumbnail / Video Preview
            let thumbHTML = '';
            const isYoutube = (item.videoSource || '').toLowerCase().includes('youtube');

            if (isYoutube) {
                let ytID = extractYoutubeId(item.videoSource);
                if (!ytID && item.title.includes('youtube.com')) {
                    ytID = extractYoutubeId(item.title);
                }
                const imgUrl = ytID
                    ? `https://img.youtube.com/vi/${ytID}/mqdefault.jpg`
                    : 'https://placehold.co/320x180/202020/666?text=No+YT+Preview';
                thumbHTML = `<img src="${imgUrl}" alt="">`;
            } else {
                let videoUrl = item.playback ? (typeof item.playback === 'string' ? item.playback : item.playback.url) : null;
                if (videoUrl) {
                    if (videoUrl.startsWith('/')) videoUrl = API_BASE + videoUrl;
                    thumbHTML = `
                        <video 
                            src="${videoUrl}#t=0.5" 
                            muted 
                            preload="metadata"
                            onmouseover="this.play()" 
                            onmouseout="this.pause();"
                            class="history-video-preview"
                        ></video>
                     `;
                } else {
                    thumbHTML = `<img src="https://placehold.co/320x180/202020/666?text=No+Local+File" alt="">`;
                }
            }

            html += `
                <div class="history-card" data-id="${item.id}" data-json='${JSON.stringify(item).replace(/'/g, "&apos;")}'>
                    <div class="history-thumb">
                        ${thumbHTML}
                        <div class="history-progress"></div>
                    </div>
                    <div class="history-meta">
                        <div class="history-title">${title}</div>
                        <div class="history-channel">${channel} • ${viewCount}</div>
                        <div class="history-desc">
                            ${descHtml}
                        </div>
                    </div>
                    <button class="history-menu-btn" onclick="openHistoryMenu(event, '${item.id}')">⋮</button>
                </div>
            `;
        });

        listContainer.innerHTML = html;

        // Bind main clicks
        listContainer.querySelectorAll('.history-card').forEach(card => {
            card.addEventListener('click', (e) => {
                // Don't trigger if clicked button
                if (e.target.tagName !== 'BUTTON') loadHistoryItem(card.dataset.id);
            });
        });

    } catch (e) {
        console.error("History load error", e);
        const listContainer = document.getElementById('history-list-items');
        if (listContainer) listContainer.innerHTML = `<div style="padding:20px; color:var(--danger);">Error loading history: ${e.message}</div>`;
    }
}

async function loadHistoryItem(id) {
    try {
        const r = await fetch(`${API_BASE}/api/history/${id}`);
        currentHistoryItemId = id;
        const j = await r.json();
        if (j?.data?.html) {
            // Manage Views
            els.historyView.style.display = 'none';
            els.output.style.display = 'none';
            els.historyDetailView.style.display = 'grid'; // Grid container for detail

            // 1. Restore Inputs First
            if (j.meta?.generationContext || j.data.meta?.generationContext) {
                const ctx = j.meta.generationContext || j.data.meta.generationContext;
                if (!ctx.playback && (j.meta?.playback || j.data?.meta?.playback)) {
                    ctx.playback = j.meta?.playback || j.data?.meta?.playback;
                }
                lastGenerationContext = ctx;
                await restoreInputState(ctx);
            }

            // 2. Render Output
            els.historyDetailView.innerHTML = normalizeHtml(j.data.html);

            // 3. Linkify
            linkifyTimestamps(els.historyDetailView);

            // 4. Process Cards
            enforceOutputLayout(els.historyDetailView);

            // 5. Append "Customize Your Own Card" template
            // User requested this feature to be available in history outputs too
            els.historyDetailView.appendChild(createCustomCard());

            // 6. Header Back Button (Moved to Top Header)
            const headerLeft = document.getElementById('headerLeft');
            if (headerLeft) {
                headerLeft.innerHTML = ''; // Clear previous
                const backBtn = document.createElement('button');
                backBtn.className = 'action-icon';
                backBtn.style.fontSize = '24px';
                backBtn.style.cursor = 'pointer';
                backBtn.style.background = 'transparent';
                backBtn.style.border = 'none';
                backBtn.style.color = 'var(--text-main)';
                backBtn.style.display = 'flex';
                backBtn.style.alignItems = 'center';
                backBtn.style.gap = '8px';
                backBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" style="pointer-events: none; display: block; width: 24px; height: 24px; fill: currentColor;"><g><path d="M20,11H7.83l5.59-5.59L12,4l-8,8l8,8l1.41-1.41L7.83,13H20V11z"></path></g></svg>
                `;
                backBtn.title = "Back to Watch History";
                backBtn.onclick = () => loadHistory();
                headerLeft.appendChild(backBtn);
            }

            setStatus(`Loaded: ${j.meta?.title || id}`);
        }
    } catch (e) {
        console.error(e);
        alert(`Failed to load item: ${e.message}`);
    }
}

// ==========================================
// 8. INIT
// ==========================================

// Ensure header is cleared when navigating away
function clearHeaderLeft() {
    const h = document.getElementById('headerLeft');
    if (h) h.innerHTML = '';
}

(async function init() {
    // History Toggle
    // History Toggle
    if (els.openHist) els.openHist.onclick = () => { clearHeaderLeft(); loadHistory(); };
    // if (els.closeHist) els.closeHist.onclick = () => toggleHist(false); // Removed

    // Bind Run
    els.runBtn.addEventListener('click', () => { clearHeaderLeft(); run(); });

    // Bind Export Button (need to add to DOM first)
    // We will check for it dynamically or user can add it in HTML step
    const exportBtn = $("exportBtn");
    if (exportBtn) exportBtn.addEventListener('click', handleDownloadSelected);

    // Toggle Competitors
    // Toggle Competitors
    // ==========================================
    // MARKET MODE LOGIC
    // ==========================================

    let activeGridTarget = els.output; // Default

    // 1. Toggle Handler (Context Aware)
    if (els.competitorToggle) {
        els.competitorToggle.addEventListener('change', (e) => {
            if (e.target.checked) {
                // Check which view is active
                if (els.historyDetailView && window.getComputedStyle(els.historyDetailView).display !== 'none') {
                    activeGridTarget = els.historyDetailView;
                    console.log('Market Mode: Targeting History View');
                } else {
                    activeGridTarget = els.output;
                    console.log('Market Mode: Targeting Main Output');
                }

                els.competitorModal.style.display = 'grid';
                if (els.aiDiscoveryInput) els.aiDiscoveryInput.focus();
            } else {
                document.querySelectorAll('.video-card.competitor').forEach(el => el.remove());
            }
        });
    }

    // 2. Modal Controls
    if (els.closeCompetitorModal) {
        els.closeCompetitorModal.addEventListener('click', () => {
            els.competitorModal.style.display = 'none';
        });
    }

    // ==========================================
    // AI DISCOVERY LOGIC
    // ==========================================

    async function runDiscovery() {
        const desc = els.aiDiscoveryInput.value.trim();
        if (!desc) return;

        const btn = els.btnDiscover;
        const originalText = btn.innerHTML;
        btn.innerHTML = 'Thinking...';
        btn.disabled = true;

        try {
            const res = await fetch(`${API_BASE}/api/discover-competitors`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description: desc })
            });
            const data = await res.json();

            renderDiscoveryLists(data);
        } catch (e) {
            console.error(e);
            alert('Discovery failed');
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    }

    function renderDiscoveryLists(data) {
        // 1. Target Channel (Put in left column, reusing discoveryKeywords container)
        els.discoveryKeywords.innerHTML = '';
        if (data.target_channel) {
            const ch = data.target_channel;
            const el = document.createElement('div');
            el.style.cssText = `
                display:flex; align-items:center; justify-content:space-between;
                background:var(--bg-card); border:1px solid var(--accent); padding:12px; border-radius:12px;
            `;
            const initial = ch.name ? ch.name[0] : 'T';
            el.innerHTML = `
                <div style="display:flex; align-items:center; gap:10px;">
                     <div style="width:32px; height:32px; background:var(--accent); border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:14px; color:#000; font-weight:bold;">${initial}</div>
                     <div style="display:flex; flex-direction:column;">
                        <span style="font-size:14px; font-weight:bold;">${ch.name}</span>
                        <span style="font-size:11px; opacity:0.7;">${ch.handle}</span>
                     </div>
                </div>
                <button class="add-btn" style="background:var(--accent); border:none; color:#000; padding:6px 12px; border-radius:20px; cursor:pointer; font-weight:bold; font-size:11px;">
                   + Add
                </button>
            `;
            el.querySelector('.add-btn').onclick = async function () {
                this.innerHTML = 'Adding...';
                await importByQuery(ch.handle || ch.name, 'channel');
                this.innerHTML = 'Added';
            };
            els.discoveryKeywords.appendChild(el);
        } else {
            els.discoveryKeywords.innerHTML = '<div style="opacity:0.5; padding:10px;">No exact match found.</div>';
        }

        // 2. Similar Channels (Right column)
        els.discoveryChannels.innerHTML = '';
        (data.similar_channels || []).forEach(ch => {
            const el = document.createElement('div');
            el.style.cssText = `
                display:flex; align-items:center; justify-content:space-between;
                background:var(--bg-card); border:1px solid var(--border); padding:8px 12px; border-radius:20px;
            `;
            const initial = ch.name ? ch.name[0] : 'C';
            el.innerHTML = `
                <div style="display:flex; align-items:center; gap:10px;">
                    <div style="width:24px; height:24px; background:#444; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:10px; color:#fff;">${initial}</div>
                    <div style="display:flex; flex-direction:column; line-height:1.1;">
                        <span style="font-size:12px; font-weight:bold;">${ch.name}</span>
                        <span style="font-size:10px; opacity:0.6;">${ch.handle}</span>
                    </div>
                </div>
                <button class="add-btn" style="background:var(--bg-input); border:none; color:var(--text); width:24px; height:24px; border-radius:50%; cursor:pointer; display:flex; align-items:center; justify-content:center;">
                   +
                </button>
            `;
            el.querySelector('.add-btn').onclick = async function () {
                this.innerHTML = '⏳';
                await importByQuery(ch.handle || ch.name, 'channel');
                this.innerHTML = '✅';
                this.style.background = 'var(--accent)';
                this.style.color = '#000';
            };
            els.discoveryChannels.appendChild(el);
        });
    }

    // Reuse the search logic but purely for importing content
    async function importByQuery(query, type) {
        try {
            const res = await fetch(`${API_BASE}/api/search-competitors?query=${encodeURIComponent(query)}&limit=10&type=${type}`);
            const data = await res.json();
            if (data.videos) {
                // Determine channel avatar if we just fetched a channel
                const metaAvatar = data.meta?.avatar;
                const videoIds = [];

                data.videos.forEach(v => {
                    // Inject avatar if we have one from metadata
                    if (metaAvatar) v.channelAvatar = metaAvatar;
                    addCompetitorToGrid(v);
                    // Collect IDs for enrichment
                    if (v.id) videoIds.push(v.id);
                });

                // Progressive enhancement: fetch dates in background
                if (videoIds.length > 0) {
                    enrichCardsWithDates(videoIds);
                }
            }
        } catch (e) {
            console.error(e);
            alert('Import failed: ' + e.message);
        }
    }

    // Progressive enhancement: fetch and update dates
    async function enrichCardsWithDates(videoIds) {
        try {
            console.log('[Enrich] Fetching dates for', videoIds.length, 'videos');
            const res = await fetch(`${API_BASE}/api/enrich-metadata`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ videoIds })
            });
            const data = await res.json();

            if (data.enriched) {
                data.enriched.forEach(item => {
                    // Find the card with this specific video ID
                    const card = document.querySelector(`.video-card.competitor[data-video-id="${item.id}"]`);

                    if (card && item.date) {
                        const statsDiv = card.querySelector('.card-stats');
                        if (statsDiv) {
                            const currentText = statsDiv.textContent;
                            const dateText = formatDate(item.date);

                            // Update the stats div intelligently
                            if (dateText && !currentText.includes('ago')) {
                                // If there's existing text (views) but no date, append date
                                if (currentText.trim()) {
                                    statsDiv.textContent = `${currentText} • ${dateText}`;
                                } else {
                                    statsDiv.textContent = dateText;
                                }
                            }
                        }
                    }
                });
                console.log('[Enrich] Updated dates for', data.enriched.length, 'videos');
            }
        } catch (e) {
            console.warn('[Enrich] Failed to fetch dates:', e.message);
            // Silently fail - dates are nice-to-have
        }
    }

    if (els.btnDiscover) els.btnDiscover.addEventListener('click', runDiscovery);

    function formatDuration(sec) {
        if (!sec) return '';
        if (typeof sec === 'string' && sec.includes(':')) return sec;
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function formatViews(n) {
        if (!n && n !== 0) return '';  // Return empty string for missing data
        if (n > 1000000) return (n / 1000000).toFixed(1) + 'M views';
        if (n > 1000) return (n / 1000).toFixed(1) + 'K views';
        return n + ' views';
    }

    function formatDate(str) {
        if (!str) return '';
        // If it's already a relative string or non-standard, return as is
        if (str.includes('ago')) return str;

        // Parse YYYYMMDD (Standard yt-dlp format)
        if (str.length === 8 && !isNaN(str)) {
            const y = parseInt(str.substr(0, 4), 10);
            const m = parseInt(str.substr(4, 2), 10) - 1;
            const d = parseInt(str.substr(6, 2), 10);

            const date = new Date(y, m, d);
            const now = new Date();
            const diff = now - date;

            const seconds = Math.floor(diff / 1000);
            const minutes = Math.floor(seconds / 60);
            const hours = Math.floor(minutes / 60);
            const days = Math.floor(hours / 24);
            const months = Math.floor(days / 30);
            const years = Math.floor(days / 365);

            if (years > 0) return years + (years === 1 ? ' year ago' : ' years ago');
            if (months > 0) return months + (months === 1 ? ' month ago' : ' months ago');
            if (days > 0) return days + (days === 1 ? ' day ago' : ' days ago');
            return 'Recently';
        }
        return str;
    }

    // 5. Add to Grid
    function addCompetitorToGrid(v) {
        const card = document.createElement('div');
        card.className = 'video-card competitor';
        card.style.border = '1px solid var(--accent)';
        card.dataset.videoId = v.id; // Store video ID for progressive enrichment

        // Construct YouTube channel avatar URL
        // YouTube provides channel avatars via: https://www.youtube.com/[channel_handle]/avatar
        let avatar;
        if (v.channelAvatar) {
            avatar = v.channelAvatar;
        } else if (v.channel) {
            // Use YouTube's oembed API to get channel avatar
            avatar = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${v.id}&format=json`;
            // Fallback to ui-avatars if needed
            avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(v.channel)}&background=555&color=fff&size=48&rounded=true`;
        } else {
            avatar = `https://ui-avatars.com/api/?name=C&background=555&color=fff&size=48&rounded=true`;
        }

        card.innerHTML = `
            <div class="thumb-container">
                <img class="thumb-img" src="${v.thumbnail}" style="opacity:1;" onerror="if(!this.dataset.retry){this.dataset.retry=true; this.src=this.src.replace('maxresdefault.jpg','hqdefault.jpg');}">
                <div class="thumb-overlay">
                    <div style="position:absolute; top:6px; left:6px; background:var(--accent); color:black; font-size:9px; font-weight:bold; padding:2px 6px; border-radius:4px;">COMPETITOR</div>
                    <div style="position:absolute; bottom:6px; right:6px; background:rgba(0,0,0,0.8); color:white; font-size:10px; padding:2px 4px; border-radius:2px;">${formatDuration(v.duration)}</div>
                </div>
            </div>
            <div class="card-details">
                <div class="channel-avatar" style="background-image:url('${avatar}'); background-size:cover; background-position:center; background-color:#333;"></div>
                <div class="meta-col">
                    <div class="card-title" style="color:var(--text); font-weight:600; font-size:13px; line-height:1.2; margin-bottom:4px;">${v.title}</div>
                    <div class="card-channel-name" style="margin-bottom:2px;">${v.channel}</div>
                    <div class="card-stats">${(() => {
                const views = formatViews(v.views);
                const date = formatDate(v.date);
                if (views && date) return `${views} • ${date}`;
                if (views) return views;
                if (date) return date;
                return '';
            })()}</div>
                </div>
            </div>
        `;

        // Use active target
        const targetEl = activeGridTarget || els.output;

        // Interleave competitor cards with generated cards
        // Strategy: Insert after every generated card (alternating pattern)
        const existingCards = Array.from(targetEl.children);
        const competitorCards = existingCards.filter(c => c.classList.contains('competitor'));

        // Calculate insertion position for interleaving
        // Pattern: Gen, Comp, Gen, Comp, Gen, Comp...
        // Insert at position: (number of competitors * 2) to maintain alternating pattern
        const insertIndex = competitorCards.length * 2;

        if (insertIndex < existingCards.length) {
            // Insert at calculated position to maintain alternating pattern
            targetEl.insertBefore(card, existingCards[insertIndex]);
        } else {
            // Append at end if we've run out of generated cards
            targetEl.appendChild(card);
        }
    }

    initTheme();
    checkAuth();

    log('App Ready');
})();

// History Menu Utilities
window.addEventListener('click', (e) => {
    document.querySelectorAll('.history-menu-dropdown').forEach(el => el.remove());
});

window.openHistoryMenu = (e, id) => {
    e.stopPropagation();
    document.querySelectorAll('.history-menu-dropdown').forEach(el => el.remove());

    const btn = e.currentTarget;
    const card = btn.closest('.history-card');

    const menu = document.createElement('div');
    menu.className = 'history-menu-dropdown';
    menu.innerHTML = `
        <div class="history-menu-item" onclick="historyAction(event, 'download', '${id}')">
            <span class="history-menu-icon">⬇️</span> Download
        </div>
        <div class="history-menu-item" onclick="historyAction(event, 'share', '${id}')">
            <span class="history-menu-icon">🔗</span> Share
        </div>
        <div class="history-menu-item" onclick="historyAction(event, 'delete', '${id}')">
            <span class="history-menu-icon">🗑️</span> Remove from history
        </div>
    `;

    if (getComputedStyle(card).position === 'static') {
        card.style.position = 'relative';
    }

    card.appendChild(menu);
};

window.historyAction = async (e, action, id) => {
    e.stopPropagation();
    const menu = e.target.closest('.history-menu-dropdown');
    const card = menu.closest('.history-card');

    const removeMenu = () => menu.remove();

    if (action === 'delete') {
        if (!confirm('Remove from watch history?')) return;
        try {
            await fetch(`${API_BASE}/api/history/${id}`, { method: 'DELETE' });
            card.style.opacity = '0';
            setTimeout(() => card.remove(), 200);
        } catch (e) { alert('Failed'); }
    } else if (action === 'share') {
        const item = JSON.parse(card.dataset.json || '{}');
        const text = `${item.title}`;
        try {
            await navigator.clipboard.writeText(text);
            alert('Copied title to clipboard!');
        } catch { alert('Clipboard error'); }
        removeMenu();
    } else if (action === 'download') {
        const item = JSON.parse(card.dataset.json || '{}');
        const blob = new Blob([JSON.stringify(item, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `history-${id}.json`;
        a.click();
        removeMenu();
    }
};
