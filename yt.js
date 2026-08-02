const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { URL } = require('url');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'urls.json');
const URL_TTL_MS = 4 * 60 * 1000; // 4 minutes — URLs valid ~5-6 min, refresh with margin

/**
 * Stream Token Registry
 * Instead of storing raw CDN URLs (which expire fast and cause 403),
 * we now store metadata: { videoUrl, quality, type }
 * and re-scrape a fresh download URL on every stream request.
 */
let streamRegistry = {};

function loadRegistry() {
  try {
    if (fs.existsSync(DB_FILE)) {
      streamRegistry = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    streamRegistry = {};
  }
}

function saveRegistry() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(streamRegistry, null, 2), 'utf8');
  } catch (e) {}
}

loadRegistry();

/**
 * In-Memory URL TTL Cache
 * Stores resolved download URLs with timestamps.
 * If a cached URL is < 4 minutes old, use it instantly (no re-scrape).
 * If expired or fails with 403, re-scrape a fresh one.
 */
const urlTTLCache = new Map();

function getCachedUrl(hash) {
  const entry = urlTTLCache.get(hash);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > URL_TTL_MS) {
    urlTTLCache.delete(hash);
    return null; // Expired
  }
  return entry.url;
}

function setCachedUrl(hash, url) {
  urlTTLCache.set(hash, { url, timestamp: Date.now() });
}

function invalidateCachedUrl(hash) {
  urlTTLCache.delete(hash);
}

/**
 * Generate 8-character stream URL token and store metadata (not raw URL)
 */
function createStreamToken(videoUrl, quality, type, hostHeader = `localhost:${PORT}`) {
  const raw = `${videoUrl}::${type}::${quality}`;
  const hash = crypto.createHash('md5').update(raw).digest('hex').substring(0, 8);
  streamRegistry[hash] = { videoUrl, quality, type };
  saveRegistry();
  return { hash, streamUrl: `http://${hostHeader}/stream/${hash}` };
}

/**
 * Fetch format URL from savetube CDN Pool with Automatic Failover
 */
async function fetchFormatUrl(headers, key, type, quality) {
  const cdnPool = [
    'cdn400.savetube.vip',
    'cdn401.savetube.vip',
    'cdn402.savetube.vip',
    'cdn403.savetube.vip',
    'cdn405.savetube.vip',
    'cdn406.savetube.vip'
  ];
  // Shuffle CDN pool to distribute load evenly
  const shuffledCdns = [...cdnPool].sort(() => 0.5 - Math.random());

  for (const cdn of shuffledCdns) {
    try {
      const downloadRes = await fetch(`https://${cdn}/download`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          downloadType: type,
          quality: String(quality),
          key: key
        })
      });
      if (!downloadRes.ok) continue; // If 429 Rate limited, try next CDN
      const downloadData = await downloadRes.json();
      if (downloadData.data?.downloadUrl) {
        return downloadData.data.downloadUrl;
      }
    } catch {}
  }
  return null;
}

/**
 * Low-level scrape: get video info + key from savetube
 */
async function getVideoInfo(youtubeUrl) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Origin': 'https://ytmp4.co.za',
    'Referer': 'https://ytmp4.co.za/',
    'Content-Type': 'application/json'
  };

  const cdnRes = await fetch('https://media.savetube.vip/api/random-cdn', { headers });
  if (!cdnRes.ok) throw new Error('Gagal terhubung ke server CDN');
  const { cdn } = await cdnRes.json();

  const infoRes = await fetch(`https://${cdn}/v2/info`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: youtubeUrl })
  });
  if (!infoRes.ok) throw new Error('Gagal mengambil info video');
  const { data: b64Data, status, message } = await infoRes.json();

  if (!status || !b64Data) throw new Error(message || 'Video tidak ditemukan atau privat');

  const rawBuf = Buffer.from(b64Data.trim(), 'base64');
  const iv = rawBuf.subarray(0, 16);
  const ciphertext = rawBuf.subarray(16);
  const keyBuf = Buffer.from('C5D58EF67A7584E4A29F6C35BBC4EB12', 'hex');

  const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, iv);
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  const videoInfo = JSON.parse(decrypted.toString('utf8'));

  return { videoInfo, headers };
}

/**
 * Resolve a single fresh download URL for a specific quality+type
 */
async function resolveFreshUrl(youtubeUrl, quality, type) {
  const { videoInfo, headers } = await getVideoInfo(youtubeUrl);

  // First check if the format has a direct URL in the info response
  const formats = type === 'audio' ? (videoInfo.audio_formats || []) : (videoInfo.video_formats || []);
  const qualityNum = String(quality).replace(/[^0-9]/g, '');

  for (const f of formats) {
    const fq = String(f.height || f.quality || '');
    if (fq === qualityNum && f.url) {
      return f.url;
    }
  }

  // If no direct URL, use CDN download endpoint with the key
  if (videoInfo.key) {
    const url = await fetchFormatUrl(headers, videoInfo.key, type, qualityNum);
    if (url) return url;
  }

  throw new Error(`Format ${type} ${quality} tidak tersedia`);
}

/**
 * Core YouTube Scraper & Downloader Engine
 */
async function scrapeYoutube(youtubeUrl, hostHeader = `localhost:${PORT}`) {
  const { videoInfo, headers } = await getVideoInfo(youtubeUrl);

  const videoId = videoInfo.id || (youtubeUrl.match(/(?:v=|\/live\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/) || [])[1];

  const rawVideoFormats = videoInfo.video_formats || [];
  const rawAudioFormats = videoInfo.audio_formats || [];

  const seenHeights = new Set();
  const uniqueVideoFormats = rawVideoFormats.filter(f => {
    const h = f.height || f.quality;
    if (seenHeights.has(h)) return false;
    seenHeights.add(h);
    return true;
  });

  const videoResolutions = (await Promise.all(uniqueVideoFormats.map(async f => {
    const q = f.height || f.quality;
    let url = f.url || null;
    if (!url && videoInfo.key) {
      url = await fetchFormatUrl(headers, videoInfo.key, 'video', q);
    }
    if (!url) return null;
    const { hash, streamUrl } = createStreamToken(youtubeUrl, q, 'video', hostHeader);
    // Pre-warm TTL cache — this URL is fresh right now!
    setCachedUrl(hash, url);
    return {
      quality: `${q}p`,
      stream_url: streamUrl,
      direct_url: url
    };
  }))).filter(Boolean);

  const seenAudio = new Set();
  const uniqueAudioFormats = rawAudioFormats.filter(f => {
    const q = f.quality || '128';
    if (seenAudio.has(q)) return false;
    seenAudio.add(q);
    return true;
  });

  const audioResolutions = (await Promise.all(uniqueAudioFormats.map(async f => {
    const q = f.quality || '128';
    let url = f.url || null;
    if (!url && videoInfo.key) {
      url = await fetchFormatUrl(headers, videoInfo.key, 'audio', q);
    }
    if (!url) return null;
    const { hash, streamUrl } = createStreamToken(youtubeUrl, q, 'audio', hostHeader);
    // Pre-warm TTL cache — this URL is fresh right now!
    setCachedUrl(hash, url);
    return {
      quality: `${q}kbps`,
      stream_url: streamUrl,
      direct_url: url
    };
  }))).filter(Boolean);

  return {
    id: videoId,
    title: videoInfo.title,
    duration: videoInfo.durationLabel || null,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    resolutions: {
      video: videoResolutions,
      audio: audioResolutions
    }
  };
}

/**
 * Fast YouTube Scraper — NO download URL resolution (Lazy Mode)
 * Only fetches video info and lists available formats with stream tokens.
 * Download URLs are resolved on-demand when /stream/:id is accessed.
 * This is ~10x faster than full scrape because it skips all CDN /download calls.
 */
async function scrapeYoutubeFast(youtubeUrl, hostHeader = `localhost:${PORT}`) {
  const { videoInfo } = await getVideoInfo(youtubeUrl);

  const videoId = videoInfo.id || (youtubeUrl.match(/(?:v=|\/live\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/) || [])[1];

  const rawVideoFormats = videoInfo.video_formats || [];
  const rawAudioFormats = videoInfo.audio_formats || [];

  const seenHeights = new Set();
  const videoResolutions = rawVideoFormats
    .filter(f => {
      const h = f.height || f.quality;
      if (seenHeights.has(h)) return false;
      seenHeights.add(h);
      return true;
    })
    .map(f => {
      const q = f.height || f.quality;
      const { hash, streamUrl } = createStreamToken(youtubeUrl, q, 'video', hostHeader);
      // If format already has a direct URL, pre-warm cache
      if (f.url) setCachedUrl(hash, f.url);
      return {
        quality: `${q}p`,
        stream_url: streamUrl
      };
    });

  const seenAudio = new Set();
  const audioResolutions = rawAudioFormats
    .filter(f => {
      const q = f.quality || '128';
      if (seenAudio.has(q)) return false;
      seenAudio.add(q);
      return true;
    })
    .map(f => {
      const q = f.quality || '128';
      const { hash, streamUrl } = createStreamToken(youtubeUrl, q, 'audio', hostHeader);
      if (f.url) setCachedUrl(hash, f.url);
      return {
        quality: `${q}kbps`,
        stream_url: streamUrl
      };
    });

  return {
    id: videoId,
    title: videoInfo.title,
    duration: videoInfo.durationLabel || null,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    resolutions: {
      video: videoResolutions,
      audio: audioResolutions
    }
  };
}

/**
 * Combined YouTube Search + Auto Stream Links + Pagination Engine
 * Uses scrapeYoutubeFast for blazing speed (~2-5s vs ~25s)
 */
async function searchAndScrapeYoutube(query, hostHeader = `localhost:${PORT}`, page = 1, limit = 5) {
  const searchHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
  };

  const res = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(query), { headers: searchHeaders });
  if (!res.ok) throw new Error('Gagal terhubung ke server pencarian YouTube');
  const html = await res.text();

  const match = html.match(/ytInitialData\s*=\s*({.*?});<\/script>/s);
  if (!match) throw new Error('Gagal mem-parsing data pencarian YouTube');

  const data = JSON.parse(match[1]);
  const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

  const searchItems = [];
  for (const item of contents) {
    if (item.videoRenderer) {
      const v = item.videoRenderer;
      const id = v.videoId;
      if (!id) continue;
      searchItems.push({
        id: id,
        title: v.title?.runs?.[0]?.text || 'Untitled',
        channel: v.ownerText?.runs?.[0]?.text || 'Unknown',
        duration: v.lengthText?.simpleText || null,
        views: v.viewCountText?.simpleText || null,
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${id}`
      });
    }
  }

  // Calculate Pagination Slices
  const totalItems = searchItems.length;
  const totalPages = Math.ceil(totalItems / limit) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (currentPage - 1) * limit;
  const pageItems = searchItems.slice(startIndex, startIndex + limit);

  // Use FAST scrape — only list formats, resolve URLs on-demand via stream proxy
  const resultsWithDownload = await Promise.all(pageItems.map(async item => {
    try {
      const mediaData = await scrapeYoutubeFast(item.url, hostHeader);
      return {
        ...item,
        resolutions: mediaData.resolutions
      };
    } catch {
      return {
        ...item,
        resolutions: { video: [], audio: [] }
      };
    }
  }));

  const hasNext = currentPage < totalPages;
  const hasPrev = currentPage > 1;

  const paginationObj = {
    page: currentPage,
    limit: limit,
    total_items: totalItems,
    total_pages: totalPages,
    has_next: hasNext,
    has_prev: hasPrev
  };

  if (hasNext) {
    paginationObj.next_page_url = `http://${hostHeader}/api/v1/search?q=${encodeURIComponent(query)}&page=${currentPage + 1}&limit=${limit}`;
  }
  if (hasPrev) {
    paginationObj.prev_page_url = `http://${hostHeader}/api/v1/search?q=${encodeURIComponent(query)}&page=${currentPage - 1}&limit=${limit}`;
  }

  return {
    pagination: paginationObj,
    data: resultsWithDownload
  };
}

/**
 * Start Professional REST API Server
 */
function startServer() {
  const startTime = Date.now();

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = reqUrl.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // Health Check Endpoint: /api/v1/health
    if (pathname === '/api/v1/health' || pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        message: 'YouTube API v1 is active and running smoothly',
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        active_streams: Object.keys(streamRegistry).length
      }, null, 2));
    }

    // Paginated Search + Download Endpoint: /api/v1/search?q=QUERY&page=1&limit=5
    if (pathname === '/api/v1/search' || pathname === '/api/search') {
      const query = reqUrl.searchParams.get('q') || reqUrl.searchParams.get('query');
      const pageParam = parseInt(reqUrl.searchParams.get('page') || '1', 10);
      const limitParam = parseInt(reqUrl.searchParams.get('limit') || '5', 10);

      if (!query) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: false,
          error: 'Parameter kata kunci ?q=... wajib diisi. Contoh: /api/v1/search?q=rick+astley&page=1&limit=5'
        }, null, 2));
      }

      try {
        const resultData = await searchAndScrapeYoutube(query, req.headers.host, pageParam, limitParam);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          query: query,
          ...resultData
        }, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: err.message }, null, 2));
      }
    }

    // Single Downloader & Scraper Endpoint: /api/v1/download?url=YOUTUBE_URL
    if (pathname === '/api/v1/download' || pathname === '/api/scrape') {
      const targetUrl = reqUrl.searchParams.get('url');
      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: false,
          error: 'Parameter ?url=... wajib diisi. Contoh: /api/v1/download?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ'
        }, null, 2));
      }

      try {
        const data = await scrapeYoutube(targetUrl, req.headers.host);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, data }, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: err.message }, null, 2));
      }
    }

    // ============================================================
    // STREAM PROXY v3: Smart TTL Cache + Fallback Re-scrape
    // ============================================================
    // Layer 1: Check TTL cache (instant, < 1ms)
    // Layer 2: If cache miss/expired, re-scrape fresh URL (~3-5s)
    // Layer 3: If cached URL returns 403, invalidate + re-scrape
    // ============================================================
    if (pathname.startsWith('/stream/') || pathname.startsWith('/d/')) {
      const hash = pathname.replace(/^\/(stream|d)\//, '').trim();
      loadRegistry();
      const meta = streamRegistry[hash];

      if (!meta || !meta.videoUrl) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 Stream Tidak Ditemukan atau Kadaluarsa');
      }

      try {
        const proxyHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://www.youtube.com/',
          'Origin': 'https://www.youtube.com',
          'Accept': '*/*'
        };

        if (req.headers['range']) {
          proxyHeaders['Range'] = req.headers['range'];
        }

        // Layer 1: Try TTL cache first (instant!)
        let targetUrl = getCachedUrl(hash);
        let remoteRes;

        if (targetUrl) {
          console.log(`⚡ [Stream Proxy] Cache HIT for ${meta.type} ${meta.quality} — instant!`);
          remoteRes = await fetch(targetUrl, { headers: proxyHeaders, redirect: 'follow' });

          // Layer 3: If cached URL expired upstream (403/410), invalidate and re-scrape
          if (remoteRes.status === 403 || remoteRes.status === 410) {
            console.log(`⚠️  [Stream Proxy] Cached URL expired (${remoteRes.status}), re-scraping...`);
            invalidateCachedUrl(hash);
            targetUrl = null; // Fall through to Layer 2
          }
        }

        // Layer 2: Cache miss or expired — re-scrape fresh URL
        if (!targetUrl || (remoteRes && (remoteRes.status === 403 || remoteRes.status === 410))) {
          console.log(`🔄 [Stream Proxy] Cache MISS for ${meta.type} ${meta.quality}, resolving fresh URL...`);
          targetUrl = await resolveFreshUrl(meta.videoUrl, meta.quality, meta.type);
          setCachedUrl(hash, targetUrl); // Cache the fresh URL
          console.log(`✅ [Stream Proxy] Got fresh URL, cached for ${URL_TTL_MS / 1000}s`);
          remoteRes = await fetch(targetUrl, { headers: proxyHeaders, redirect: 'follow' });
        }

        if (!remoteRes.ok && remoteRes.status !== 206) {
          throw new Error(`Upstream responded with ${remoteRes.status}`);
        }

        const responseHeaders = {};
        for (const [key, value] of remoteRes.headers.entries()) {
          const lowerKey = key.toLowerCase();
          if (['content-type', 'content-length', 'content-range', 'accept-ranges'].includes(lowerKey)) {
            responseHeaders[key] = value;
          }
        }

        responseHeaders['Content-Disposition'] = 'inline';
        responseHeaders['Access-Control-Allow-Origin'] = '*';

        // Fix content-type if missing or generic
        if (!responseHeaders['content-type'] || responseHeaders['content-type'].includes('octet-stream')) {
          responseHeaders['Content-Type'] = meta.type === 'audio' ? 'audio/mpeg' : 'video/mp4';
        }

        res.writeHead(remoteRes.status, responseHeaders);

        if (remoteRes.body) {
          const nodeStream = Readable.fromWeb(remoteRes.body);
          await pipeline(nodeStream, res);
        } else {
          res.end();
        }

      } catch (err) {
        console.error(`❌ [Stream Proxy] Error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Stream Proxy Error: ' + err.message);
        }
      }
      return;
    }

    // Interactive Web Dashboard & Documentation
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YouTube Search & Downloader API v1</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 2rem; }
    .container { max-width: 900px; margin: 0 auto; background: #1e293b; padding: 2.5rem; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    h1 { color: #38bdf8; margin-top: 0; font-size: 2.2rem; }
    p.subtitle { color: #94a3b8; font-size: 1.1rem; margin-top: -0.5rem; }
    .endpoint-badge { display: inline-block; background: #0284c7; color: white; padding: 0.3rem 0.8rem; border-radius: 6px; font-weight: bold; font-family: monospace; font-size: 0.95rem; }
    code { background: #090d16; padding: 0.2rem 0.5rem; border-radius: 6px; color: #f43f5e; font-family: monospace; }
    .tab-group { display: flex; gap: 1rem; margin: 1.5rem 0 1rem 0; }
    .tab { padding: 0.6rem 1.2rem; border-radius: 8px; background: #334155; color: #cbd5e1; cursor: pointer; font-weight: bold; }
    .tab.active { background: #0284c7; color: white; }
    .input-group { display: flex; gap: 0.75rem; margin-bottom: 1.5rem; }
    input[type="text"] { flex: 1; padding: 0.85rem 1.2rem; border-radius: 10px; border: 1px solid #334155; background: #0f172a; color: #fff; font-size: 1rem; outline: none; }
    button { padding: 0.85rem 1.8rem; border-radius: 10px; border: none; background: #0284c7; color: white; font-weight: bold; cursor: pointer; font-size: 1rem; }
    button:hover { background: #0369a1; }
    pre { background: #090d16; padding: 1.2rem; border-radius: 10px; overflow-x: auto; color: #a7f3d0; font-size: 0.95rem; }
    video { width: 100%; max-height: 420px; border-radius: 10px; margin-top: 1rem; background: #000; display: none; }
    .docs-section { margin-top: 2.5rem; border-top: 1px solid #334155; padding-top: 1.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎬 YouTube API v1</h1>
    <p class="subtitle">Search with Pagination (Max 5/page) & Auto Stream Download Links</p>

    <div class="tab-group">
      <div class="tab active" id="tabSearch" onclick="setMode('search')">🔍 Search + Stream Links API</div>
      <div class="tab" id="tabDownload" onclick="setMode('download')">📥 Single URL Downloader API</div>
    </div>

    <div class="input-group">
      <input type="text" id="inputQuery" placeholder="Cari judul lagu / kata kunci..." value="rick astley">
      <button id="btnSubmit" onclick="testSubmit()">Cari Video</button>
    </div>

    <video id="player" controls></video>
    <pre id="jsonResult">// Response JSON akan tampil di sini...</pre>

    <div class="docs-section">
      <h3>📚 Dokumentasi API Endpoint:</h3>
      <p><span class="endpoint-badge">GET</span> <code>/api/v1/search?q={KATA_KUNCI}&page=1&limit=5</code> — Paginated Search + Stream Links.</p>
      <p><span class="endpoint-badge">GET</span> <code>/api/v1/download?url={YOUTUBE_URL}</code> — Single Video Stream Downloader.</p>
      <p><span class="endpoint-badge">GET</span> <code>/stream/{STREAM_ID}</code> — Direct Stream Player in Browser (auto-refreshes URL).</p>
      <p><span class="endpoint-badge">GET</span> <code>/api/v1/health</code> — Health Check Status Server.</p>
    </div>
  </div>

  <script>
    let mode = 'search';

    function setMode(m) {
      mode = m;
      document.getElementById('tabSearch').className = m === 'search' ? 'tab active' : 'tab';
      document.getElementById('tabDownload').className = m === 'download' ? 'tab active' : 'tab';
      document.getElementById('inputQuery').placeholder = m === 'search' ? 'Cari kata kunci...' : 'Tempel URL YouTube...';
      document.getElementById('inputQuery').value = m === 'search' ? 'rick astley' : 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      document.getElementById('btnSubmit').textContent = m === 'search' ? 'Cari & Get Stream' : 'Get Media';
    }

    async function testSubmit() {
      const val = document.getElementById('inputQuery').value;
      const resElem = document.getElementById('jsonResult');
      const player = document.getElementById('player');
      resElem.textContent = 'Memproses...';
      player.style.display = 'none';

      try {
        const endpoint = mode === 'search' ? '/api/v1/search?q=' : '/api/v1/download?url=';
        const res = await fetch(endpoint + encodeURIComponent(val));
        const data = await res.json();
        resElem.textContent = JSON.stringify(data, null, 2);

        if (mode === 'search' && data.success && data.data.length > 0 && data.data[0].resolutions?.video?.length > 0) {
          player.src = data.data[0].resolutions.video[0].stream_url;
          player.style.display = 'block';
        } else if (mode === 'download' && data.success && data.data.resolutions.video.length > 0) {
          player.src = data.data.resolutions.video[0].stream_url;
          player.style.display = 'block';
        }
      } catch (err) {
        resElem.textContent = 'Error: ' + err.message;
      }
    }
  </script>
</body>
</html>
    `);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {}
  });

  server.listen(PORT, () => {
    console.log(`\n🚀 YouTube REST API v1 berjalan di http://localhost:${PORT}`);
    console.log(`🔍 Search API   : http://localhost:${PORT}/api/v1/search?q=rick+astley&page=1&limit=5`);
    console.log(`📡 Download API : http://localhost:${PORT}/api/v1/download?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ`);
    console.log(`🩺 Health API   : http://localhost:${PORT}/api/v1/health\n`);
  });

  return server;
}

/**
 * Interactive Terminal CLI Loop
 */
async function startInteractiveCli(query, initialPage = 1, limit = 5) {
  startServer();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let currentPage = initialPage;

  async function renderPage(p) {
    try {
      const results = await searchAndScrapeYoutube(query, `localhost:${PORT}`, p, limit);
      console.log(JSON.stringify({ success: true, query: query, ...results }, null, 2));

      const { total_pages, has_next, has_prev } = results.pagination;
      console.log(`\n================================================================`);
      console.log(`📌 HALAMAN PADA SERVISE CLI: [ Halaman ${p} dari ${total_pages} ]`);
      console.log(`💡 Pilihan:`);
      console.log(`   • Ketik angka (misal: 2, 3, 4) untuk pindah ke halaman tersebut.`);
      console.log(`   • Ketik 'n' (Next) | 'p' (Prev) | 'q' (Keluar)`);
      console.log(`================================================================\n`);

      rl.question('Pilih Halaman > ', async (input) => {
        const str = input.trim().toLowerCase();
        if (str === 'q' || str === 'exit' || str === 'quit') {
          console.log('👋 Keluar dari CLI Search.');
          rl.close();
          process.exit(0);
        } else if (str === 'n' || str === 'next') {
          if (has_next) await renderPage(p + 1);
          else {
            console.log('\n⚠️  Anda sudah berada di halaman terakhir!');
            await renderPage(p);
          }
        } else if (str === 'p' || str === 'prev') {
          if (has_prev) await renderPage(p - 1);
          else {
            console.log('\n⚠️  Anda sudah berada di halaman pertama!');
            await renderPage(p);
          }
        } else if (!isNaN(parseInt(str, 10))) {
          const num = parseInt(str, 10);
          if (num >= 1 && num <= total_pages) {
            await renderPage(num);
          } else {
            console.log(`\n⚠️  Halaman tidak valid! Masukkan angka antara 1 sampai ${total_pages}`);
            await renderPage(p);
          }
        } else {
          await renderPage(p);
        }
      });
    } catch (err) {
      console.error('❌ Error:', err.message);
      rl.close();
      process.exit(1);
    }
  }

  await renderPage(currentPage);
}

function showHelp() {
  console.log(`
📚 PANDUAN PENGGUNAAN yt.js (CLI & SERVER MODE)
=================================================

1️⃣ Mode Server REST API & Proxy
   ---------------------------------
   node yt.js
   node yt.js --server

2️⃣ Mode CLI Interaktif (Pencarian Kata Kunci)
   ---------------------------------
   node yt.js "rick astley"
   (Dapat langsung mengetik angka 2, 3, 4, 'n', 'p', 'q' di terminal!)

3️⃣ Mode CLI Non-Interaktif (Satu Kali Panggil / Scripting)
   ---------------------------------
   node yt.js "rick astley" --json
   node yt.js "rick astley" 2 --json

4️⃣ Mode CLI Downloader (Single Video URL)
   ---------------------------------
   node yt.js "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
=================================================
  `);
}

// MAIN ENTRY POINT (Combined CLI & REST API Server)
const args = process.argv.slice(2);
const cliInput = args[0];

if (cliInput === '--help' || cliInput === '-h') {
  showHelp();
  process.exit(0);
}

if (cliInput && cliInput !== '--server') {
  const isUrl = cliInput.startsWith('http://') || cliInput.startsWith('https://');
  const isJsonOnly = args.includes('--json') || !process.stdin.isTTY;
  
  if (isUrl) {
    startServer();
    scrapeYoutube(cliInput, `localhost:${PORT}`)
      .then(data => console.log(JSON.stringify({ success: true, data }, null, 2)))
      .catch(err => console.log(JSON.stringify({ success: false, error: err.message }, null, 2)));
  } else {
    // Parse Page and Limit from CLI args
    let pageArg = 1;
    let limitArg = 5;

    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('--page=')) pageArg = parseInt(a.split('=')[1], 10) || 1;
      else if (a.startsWith('--limit=')) limitArg = parseInt(a.split('=')[1], 10) || 5;
      else if (!isNaN(parseInt(a, 10)) && i === 1) pageArg = parseInt(a, 10);
      else if (!isNaN(parseInt(a, 10)) && i === 2) limitArg = parseInt(a, 10);
    }

    if (isJsonOnly) {
      startServer();
      searchAndScrapeYoutube(cliInput, `localhost:${PORT}`, pageArg, limitArg)
        .then(results => console.log(JSON.stringify({ success: true, query: cliInput, ...results }, null, 2)))
        .catch(err => console.log(JSON.stringify({ success: false, error: err.message }, null, 2)));
    } else {
      startInteractiveCli(cliInput, pageArg, limitArg);
    }
  }
} else {
  startServer();
}
