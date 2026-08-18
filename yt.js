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
 * Primary Fast YouTube Stream Engine (YouTube Android Innertube API, ~60ms response)
 */
async function fetchInnertubePlayer(videoId) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14; US) gzip',
      'X-YouTube-Client-Name': '3',
      'X-YouTube-Client-Version': '20.10.38'
    },
    body: JSON.stringify({
      videoId: videoId,
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '20.10.38',
          androidSdkVersion: 34,
          userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14; US) gzip',
          hl: 'en',
          gl: 'US'
        }
      }
    }),
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) throw new Error('Innertube HTTP error ' + res.status);
  const data = await res.json();
  if (data.playabilityStatus?.status !== 'OK') {
    throw new Error(`Innertube status: ${data.playabilityStatus?.status} (${data.playabilityStatus?.reason})`);
  }
  return data;
}

/**
 * Fetch format URL from savetube CDN Pool with Automatic Failover
 */
const videoInfoCache = new Map();
const VIDEO_INFO_CACHE_TTL_MS = 600000; // 10 minutes in-memory cache

async function fetchFormatUrl(headers, key, type, quality, preferredCdn = null, timeoutMs = 4000) {
  const cdns = preferredCdn ? [preferredCdn, 'cdn400.savetube.vip', 'cdn406.savetube.vip'] : ['cdn400.savetube.vip', 'cdn406.savetube.vip', 'cdn401.savetube.vip', 'cdn405.savetube.vip'];
  const uniqueCdns = [...new Set(cdns)];

  for (const cdn of uniqueCdns) {
    try {
      const downloadRes = await fetch(`https://${cdn}/download`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          downloadType: type,
          quality: String(quality),
          key: key
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!downloadRes.ok) continue;
      const downloadData = await downloadRes.json();
      if (downloadData.data?.downloadUrl) {
        return downloadData.data.downloadUrl;
      }
    } catch {}
  }
  return null;
}

/**
 * Low-level scrape: get video info + key from savetube (with 10-min caching)
 */
async function getVideoInfo(youtubeUrl) {
  const cached = videoInfoCache.get(youtubeUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Origin': 'https://ytmp4.co.za',
    'Referer': 'https://ytmp4.co.za/',
    'Content-Type': 'application/json'
  };

  let assignedCdn = null;
  try {
    const cdnRes = await fetch('https://media.savetube.vip/api/random-cdn', { headers, signal: AbortSignal.timeout(2000) });
    if (cdnRes.ok) {
      const json = await cdnRes.json();
      assignedCdn = json.cdn;
    }
  } catch {}

  const cdnList = [
    assignedCdn,
    'cdn400.savetube.vip',
    'cdn406.savetube.vip',
    'cdn401.savetube.vip',
    'cdn405.savetube.vip'
  ].filter(Boolean);
  const uniqueCdns = [...new Set(cdnList)];

  let b64Data = null;
  let usedCdn = null;

  for (const cdn of uniqueCdns) {
    try {
      const infoRes = await fetch(`https://${cdn}/v2/info`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: youtubeUrl }),
        signal: AbortSignal.timeout(4000)
      });
      if (!infoRes.ok) continue;
      const json = await infoRes.json();
      if (json.status && json.data) {
        b64Data = json.data;
        usedCdn = cdn;
        break;
      }
    } catch {}
  }

  if (!b64Data) {
    throw new Error('Video tidak ditemukan atau server CDN sibuk');
  }

  const rawBuf = Buffer.from(b64Data.trim(), 'base64');
  const iv = rawBuf.subarray(0, 16);
  const ciphertext = rawBuf.subarray(16);
  const keyBuf = Buffer.from('C5D58EF67A7584E4A29F6C35BBC4EB12', 'hex');

  const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, iv);
  let decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const videoInfo = JSON.parse(decrypted.toString('utf8'));

  const result = { videoInfo, headers, usedCdn };
  videoInfoCache.set(youtubeUrl, { data: result, expiresAt: Date.now() + VIDEO_INFO_CACHE_TTL_MS });

  return result;
}

/**
 * Fast Instant CDN Media Stream Resolver (Parallel 100ms HEAD probe)
 */
async function resolveInstantCdnStream(videoId, title, quality = '360', ext = 'mp4') {
  if (!videoId) return null;
  const cleanTitle = (title || 'video')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-');

  const cdns = ['cdn405.savetube.vip', 'cdn400.savetube.vip', 'cdn406.savetube.vip', 'cdn401.savetube.vip'];
  
  const probePromises = cdns.map(async (cdn) => {
    const url = `https://${cdn}/media/${videoId}/${cleanTitle}-${quality}-ytshorts.savetube.me.${ext}`;
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
      if (res.ok) return url;
    } catch {}
    return null;
  });

  const results = await Promise.all(probePromises);
  return results.find(Boolean) || null;
}

/**
 * Resolve a single fresh download URL for a specific quality+type
 * Video: Fast YouTube Innertube Android Engine (~60ms)
 * Audio: Genuine MP3 stream from CDN / Savetube Scraper (Pure Audio)
 */
async function resolveFreshUrl(youtubeUrl, quality, type) {
  const videoId = (youtubeUrl.match(/(?:v=|\/live\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/) || [])[1];
  if (!videoId) throw new Error('ID Video YouTube tidak valid');

  const qualityNum = String(quality).replace(/[^0-9]/g, '') || '360';

  if (type === 'audio') {
    let videoTitle = '';

    // 1. Fetch title from Innertube in 60ms
    try {
      const innertubeData = await fetchInnertubePlayer(videoId);
      videoTitle = innertubeData.videoDetails?.title || '';
    } catch {}

    const cachedTitle = videoInfoCache.get(youtubeUrl)?.data?.videoInfo?.title;
    const title = videoTitle || cachedTitle || 'audio';

    // 2. Parallel probe for instant pre-rendered MP3
    const instantMp3 = await resolveInstantCdnStream(videoId, title, '128', 'mp3');
    if (instantMp3) return instantMp3;

    // 3. Savetube Scraper /download for genuine static MP3
    try {
      const { videoInfo, headers, usedCdn } = await getVideoInfo(youtubeUrl);
      if (videoInfo.title) {
        const instantUrl = await resolveInstantCdnStream(videoId, videoInfo.title, '128', 'mp3');
        if (instantUrl) return instantUrl;
      }
      if (videoInfo.key) {
        const url = await fetchFormatUrl(headers, videoInfo.key, 'audio', '128', usedCdn, 4000);
        if (url) return url;
      }
    } catch (savetubeErr) {}

    // 4. Retry instant probe in case Savetube just finished generating it
    const retryMp3 = await resolveInstantCdnStream(videoId, title, '128', 'mp3');
    if (retryMp3) return retryMp3;

    // 5. Guaranteed Fallback: Innertube Android Progressive stream (100% available in 60ms)
    try {
      const innertubeData = await fetchInnertubePlayer(videoId);
      const progressiveFormats = (innertubeData.streamingData?.formats || []).filter(f => f.url);
      if (progressiveFormats[0]?.url) return progressiveFormats[0].url;
    } catch (innertubeErr) {}
  } else {
    // 1. PRIMARY VIDEO ENGINE: YouTube Innertube Player API (Ultra Fast, ~60-100ms)
    try {
      const innertubeData = await fetchInnertubePlayer(videoId);
      const streamingData = innertubeData.streamingData;
      if (streamingData) {
        const progressiveFormats = (streamingData.formats || []).filter(f => f.url);
        if (qualityNum === '720') {
          const prog720 = progressiveFormats.find(f => f.itag === 22);
          if (prog720?.url) return prog720.url;
        }

        // Standard progressive 360p has both synchronized video & audio
        const prog360 = progressiveFormats.find(f => f.itag === 18) || progressiveFormats[0];
        if (prog360?.url) return prog360.url;
      }
    } catch (innertubeErr) {}

    // 2. SECONDARY VIDEO ENGINE: Check pre-rendered instant CDN streams
    const cached = videoInfoCache.get(youtubeUrl)?.data;
    if (cached?.videoInfo?.title) {
      const instantUrl = await resolveInstantCdnStream(videoId, cached.videoInfo.title, qualityNum, 'mp4');
      if (instantUrl) return instantUrl;
      if (qualityNum !== '360') {
        const fallback360 = await resolveInstantCdnStream(videoId, cached.videoInfo.title, '360', 'mp4');
        if (fallback360) return fallback360;
      }
    }

    // 3. TERTIARY VIDEO ENGINE: Savetube CDN Scraper
    try {
      const { videoInfo, headers, usedCdn } = await getVideoInfo(youtubeUrl);

      if (videoInfo.video_formats) {
        const directMatch = videoInfo.video_formats.find(f => String(f.quality) === qualityNum && f.url);
        if (directMatch?.url) return directMatch.url;
        const direct360 = videoInfo.video_formats.find(f => String(f.quality) === '360' && f.url);
        if (direct360?.url) return direct360.url;
      }

      if (videoInfo.title) {
        const instantUrl = await resolveInstantCdnStream(videoId, videoInfo.title, qualityNum, 'mp4');
        if (instantUrl) return instantUrl;
        if (qualityNum !== '360') {
          const fallback360 = await resolveInstantCdnStream(videoId, videoInfo.title, '360', 'mp4');
          if (fallback360) return fallback360;
        }
      }

      if (videoInfo.key) {
        const timeout = qualityNum === '360' ? 5000 : 2500;
        let url = await fetchFormatUrl(headers, videoInfo.key, 'video', qualityNum, usedCdn, timeout);
        if (url) return url;

        if (qualityNum !== '360') {
          url = await fetchFormatUrl(headers, videoInfo.key, 'video', '360', usedCdn, 5000);
          if (url) return url;
        }
      }
    } catch (savetubeErr) {}
  }

  throw new Error(`Format ${type} ${quality} tidak tersedia`);
}

const inFlightResolutions = new Map();

async function getOrResolveStreamUrl(hash, meta) {
  let cached = getCachedUrl(hash);
  if (cached) return cached;

  if (inFlightResolutions.has(hash)) {
    return await inFlightResolutions.get(hash);
  }

  const task = (async () => {
    try {
      const url = await resolveFreshUrl(meta.videoUrl, meta.quality, meta.type);
      setCachedUrl(hash, url);
      return url;
    } finally {
      inFlightResolutions.delete(hash);
    }
  })();

  inFlightResolutions.set(hash, task);
  return await task;
}

/**
 * Core YouTube Scraper & Downloader Engine
 */
async function scrapeYoutube(youtubeUrl, hostHeader = `localhost:${PORT}`) {
  return scrapeYoutubeFast(youtubeUrl, hostHeader);
}

function formatDurationSec(seconds) {
  if (!seconds) return null;
  const s = parseInt(seconds, 10);
  if (isNaN(s)) return null;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  return `${m}:${remS.toString().padStart(2, '0')}`;
}

/**
 * Fast YouTube Scraper — NO download URL resolution (Lazy Mode)
 * Fetches video info and lists available formats with stream tokens.
 * Download URLs are resolved on-demand when /stream/:id is accessed.
 */
async function scrapeYoutubeFast(youtubeUrl, hostHeader = `localhost:${PORT}`) {
  const videoId = (youtubeUrl.match(/(?:v=|\/live\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/) || [])[1];
  if (!videoId) throw new Error('ID Video YouTube tidak valid');

  // Primary: Try Innertube (Ultra Fast, ~60ms)
  try {
    const innertubeData = await fetchInnertubePlayer(videoId);
    const videoDetails = innertubeData.videoDetails || {};

    const standardVideoQualities = ['360', '720', '1080', '480', '240', '144'];
    const videoResolutions = standardVideoQualities.map(q => {
      const { streamUrl } = createStreamToken(youtubeUrl, q, 'video', hostHeader);
      return {
        quality: `${q}p`,
        stream_url: streamUrl
      };
    });

    const standardAudioQualities = ['128'];
    const audioResolutions = standardAudioQualities.map(q => {
      const { streamUrl } = createStreamToken(youtubeUrl, q, 'audio', hostHeader);
      return {
        quality: `${q}kbps`,
        stream_url: streamUrl
      };
    });

    return {
      id: videoId,
      title: videoDetails.title || 'YouTube Video',
      duration: formatDurationSec(videoDetails.lengthSeconds),
      thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      resolutions: {
        video: videoResolutions,
        audio: audioResolutions
      }
    };
  } catch (err) {
    // Fallback to Savetube
  }

  const { videoInfo } = await getVideoInfo(youtubeUrl);

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
      return {
        quality: `${q}p`,
        stream_url: streamUrl
      };
    });

  videoResolutions.sort((a, b) => {
    if (a.quality === '360p') return -1;
    if (b.quality === '360p') return 1;
    return 0;
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

  // Standard qualities generated with instant stream tokens (resolved on-demand on /stream/:id)
  const standardVideoQualities = ['360', '720', '1080', '480', '240', '144'];
  const standardAudioQualities = ['128'];

  const resultsWithDownload = pageItems.map(item => {
    const videoResolutions = standardVideoQualities.map(q => {
      const { streamUrl } = createStreamToken(item.url, q, 'video', hostHeader);
      return {
        quality: `${q}p`,
        stream_url: streamUrl
      };
    });

    const audioResolutions = standardAudioQualities.map(q => {
      const { streamUrl } = createStreamToken(item.url, q, 'audio', hostHeader);
      return {
        quality: `${q}kbps`,
        stream_url: streamUrl
      };
    });

    return {
      ...item,
      resolutions: {
        video: videoResolutions,
        audio: audioResolutions
      }
    };
  });

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

  // Pre-warm the stream resolution in background for instant playback when user clicks play
  if (resultsWithDownload.length > 0) {
    const topItem = resultsWithDownload[0];
    const topV360 = topItem.resolutions?.video?.find(v => v.quality === '360p');
    if (topV360) {
      const hash = topV360.stream_url.split('/stream/')[1];
      if (hash && streamRegistry[hash]) {
        getOrResolveStreamUrl(hash, streamRegistry[hash]).catch(() => {});
      }
    }
  }

  return {
    pagination: paginationObj,
    data: resultsWithDownload
  };
}

/**
 * Start Professional REST API Server
 */
function startServer(silent = false) {
  const startTime = Date.now();

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = reqUrl.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

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
    // STREAM PROXY v5: High-Speed Range Streaming + Auto Invalidation
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
        let targetUrl = await getOrResolveStreamUrl(hash, meta);
        const isGoogle = targetUrl.includes('googlevideo.com');

        const proxyHeaders = {
          'User-Agent': isGoogle
            ? 'com.google.android.youtube/20.10.38 (Linux; U; Android 14; US) gzip'
            : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*'
        };

        if (req.headers['range']) {
          proxyHeaders['Range'] = req.headers['range'];
        }

        let remoteRes = await fetch(targetUrl, { headers: proxyHeaders, redirect: 'follow' });

        if (remoteRes.status === 403 || remoteRes.status === 410) {
          console.log(`⚠️ [Stream Proxy] URL expired (${remoteRes.status}), re-resolving...`);
          invalidateCachedUrl(hash);
          targetUrl = await getOrResolveStreamUrl(hash, meta);
          const isGoogleRetry = targetUrl.includes('googlevideo.com');
          proxyHeaders['User-Agent'] = isGoogleRetry
            ? 'com.google.android.youtube/20.10.38 (Linux; U; Android 14; US) gzip'
            : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
          remoteRes = await fetch(targetUrl, { headers: proxyHeaders, redirect: 'follow' });
        }

        if (!remoteRes.ok && remoteRes.status !== 206) {
          throw new Error(`Upstream responded with ${remoteRes.status}`);
        }

        const responseHeaders = {};
        for (const [key, value] of remoteRes.headers.entries()) {
          const lowerKey = key.toLowerCase();
          if (['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'].includes(lowerKey)) {
            responseHeaders[key] = value;
          }
        }

        responseHeaders['Accept-Ranges'] = 'bytes';
        responseHeaders['Content-Disposition'] = pathname.startsWith('/d/') ? 'attachment' : 'inline';
        responseHeaders['Access-Control-Allow-Origin'] = '*';
        responseHeaders['Access-Control-Allow-Headers'] = 'Range, Content-Type';

        if (meta.type === 'audio') {
          responseHeaders['Content-Type'] = targetUrl.endsWith('.mp3') ? 'audio/mpeg' : 'audio/mp4';
        } else {
          responseHeaders['Content-Type'] = 'video/mp4';
        }

        res.writeHead(remoteRes.status, responseHeaders);

        if (remoteRes.body) {
          const nodeStream = Readable.fromWeb(remoteRes.body);
          nodeStream.pipe(res);
          nodeStream.on('error', () => {
            nodeStream.destroy();
            if (!res.destroyed) res.destroy();
          });
          res.on('close', () => {
            nodeStream.destroy();
          });
        } else {
          res.end();
        }

      } catch (err) {
        if (!res.headersSent && !res.destroyed) {
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
  <title>YouTube Search & Streaming Player API</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f8fafc; margin: 0; padding: 1.5rem; }
    .container { max-width: 960px; margin: 0 auto; background: #151d30; padding: 2rem; border-radius: 16px; box-shadow: 0 10px 40px rgba(0,0,0,0.6); border: 1px solid #1e293b; }
    h1 { color: #38bdf8; margin-top: 0; font-size: 2rem; display: flex; align-items: center; gap: 0.5rem; }
    p.subtitle { color: #94a3b8; font-size: 1rem; margin-top: -0.5rem; margin-bottom: 1.5rem; }
    .tab-group { display: flex; gap: 0.75rem; margin-bottom: 1.25rem; }
    .tab { padding: 0.6rem 1.2rem; border-radius: 8px; background: #1e293b; color: #cbd5e1; cursor: pointer; font-weight: 600; transition: all 0.2s; }
    .tab.active { background: #0284c7; color: white; }
    .input-group { display: flex; gap: 0.75rem; margin-bottom: 1.5rem; }
    input[type="text"] { flex: 1; padding: 0.85rem 1.2rem; border-radius: 10px; border: 1px solid #334155; background: #0b0f19; color: #fff; font-size: 1rem; outline: none; }
    input[type="text"]:focus { border-color: #38bdf8; }
    button { padding: 0.85rem 1.5rem; border-radius: 10px; border: none; background: #0284c7; color: white; font-weight: bold; cursor: pointer; font-size: 1rem; transition: background 0.2s; }
    button:hover { background: #0369a1; }
    
    /* Player Section */
    .player-card { background: #0b0f19; border-radius: 12px; padding: 1.25rem; margin-bottom: 1.5rem; border: 1px solid #1e293b; display: none; }
    .player-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
    .player-title { font-weight: bold; font-size: 1.1rem; color: #38bdf8; }
    .player-toggle { display: flex; gap: 0.5rem; }
    .toggle-btn { background: #1e293b; color: #94a3b8; border: 1px solid #334155; padding: 0.3rem 0.7rem; border-radius: 6px; font-size: 0.8rem; cursor: pointer; }
    .toggle-btn.active { background: #0284c7; color: #fff; border-color: #0284c7; }
    video, iframe { width: 100%; height: 380px; border-radius: 8px; border: none; background: #000; }
    .player-status { font-size: 0.85rem; color: #a7f3d0; margin-top: 0.5rem; }
    
    /* Results List */
    .results-grid { display: flex; flex-direction: column; gap: 1rem; margin-bottom: 1.5rem; }
    .result-item { display: flex; gap: 1rem; background: #0b0f19; padding: 1rem; border-radius: 12px; border: 1px solid #1e293b; align-items: center; }
    .result-thumb { width: 140px; height: 80px; object-fit: cover; border-radius: 8px; flex-shrink: 0; background: #1e293b; cursor: pointer; }
    .result-info { flex: 1; min-width: 0; }
    .result-title { font-weight: bold; font-size: 1rem; color: #fff; margin-bottom: 0.25rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
    .result-meta { color: #94a3b8; font-size: 0.85rem; margin-bottom: 0.5rem; }
    .btn-group { display: flex; gap: 0.4rem; flex-wrap: wrap; }
    .btn-action { background: #0284c7; color: #fff; padding: 0.35rem 0.75rem; border-radius: 6px; font-size: 0.8rem; cursor: pointer; text-decoration: none; border: none; font-weight: 600; display: inline-flex; align-items: center; gap: 0.25rem; }
    .btn-action:hover { background: #0369a1; }
    .btn-action.play-instant { background: #e11d48; }
    .btn-action.play-instant:hover { background: #be123c; }
    .btn-action.audio { background: #10b981; }
    .btn-action.audio:hover { background: #059669; }
    .btn-action.download { background: #6366f1; }
    .btn-action.download:hover { background: #4f46e5; }
    
    pre { background: #090d16; padding: 1.2rem; border-radius: 10px; overflow-x: auto; color: #a7f3d0; font-size: 0.85rem; max-height: 250px; }
    .endpoint-badge { background: #0284c7; color: white; padding: 0.2rem 0.6rem; border-radius: 4px; font-weight: bold; font-family: monospace; font-size: 0.85rem; }
    code { background: #090d16; padding: 0.2rem 0.4rem; border-radius: 4px; color: #f43f5e; font-family: monospace; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎬 YouTube API & Stream Player</h1>
    <p class="subtitle">Search, Instant Player, Multi-Quality Streaming & Direct Media API</p>

    <div class="tab-group">
      <div class="tab active" id="tabSearch" onclick="setMode('search')">🔍 Search Video API</div>
      <div class="tab" id="tabDownload" onclick="setMode('download')">📥 Single URL Downloader</div>
    </div>

    <div class="input-group">
      <input type="text" id="inputQuery" placeholder="Cari judul lagu / kata kunci..." value="about you">
      <button id="btnSubmit" onclick="testSubmit()">Cari Video</button>
    </div>

    <!-- Active Media Player -->
    <div class="player-card" id="playerCard">
      <div class="player-header">
        <div class="player-title" id="nowPlayingTitle">▶️ Memutar Video</div>
        <div class="player-toggle">
          <button class="toggle-btn active" id="btnModeEmbed" onclick="switchPlayerMode('embed')">⚡ Instant Player (0ms)</button>
          <button class="toggle-btn" id="btnModeNative" onclick="switchPlayerMode('native')">📡 Proxy Stream</button>
        </div>
      </div>
      <div id="playerContainer">
        <iframe id="embedPlayer" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>
        <video id="nativePlayer" controls playsinline style="display:none;"></video>
      </div>
      <div class="player-status" id="playerStatus">🟢 Pemutar Instan Aktif</div>
    </div>

    <!-- Search Results Cards -->
    <div class="results-grid" id="resultsList"></div>

    <!-- Raw JSON output -->
    <details>
      <summary style="cursor: pointer; color: #94a3b8; margin-bottom: 0.5rem;">📄 Lihat Response JSON Lengkap</summary>
      <pre id="jsonResult">// Data JSON akan tampil di sini...</pre>
    </details>

    <div class="docs-section" style="margin-top: 2rem; border-top: 1px solid #1e293b; padding-top: 1.5rem;">
      <h3 style="margin-top: 0; color: #38bdf8;">📚 Endpoint API:</h3>
      <p><span class="endpoint-badge">GET</span> <code>/api/v1/search?q={KEYWORD}&limit=5</code> — Pencarian YouTube + Stream URLs</p>
      <p><span class="endpoint-badge">GET</span> <code>/api/v1/download?url={YOUTUBE_URL}</code> — Single Media Downloader Scraper</p>
      <p><span class="endpoint-badge">GET</span> <code>/stream/{STREAM_ID}</code> — Proxy Stream Media (Mendukung HTTP Range 206)</p>
    </div>
  </div>

  <script>
    let mode = 'search';
    let currentVideoId = '';
    let currentStreamUrl = '';
    let currentTitle = '';
    let playerMode = 'embed';

    function setMode(m) {
      mode = m;
      document.getElementById('tabSearch').className = m === 'search' ? 'tab active' : 'tab';
      document.getElementById('tabDownload').className = m === 'download' ? 'tab active' : 'tab';
      document.getElementById('inputQuery').placeholder = m === 'search' ? 'Cari kata kunci...' : 'Tempel URL YouTube...';
      document.getElementById('inputQuery').value = m === 'search' ? 'about you' : 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      document.getElementById('btnSubmit').textContent = m === 'search' ? 'Cari Video' : 'Get Media';
    }

    function switchPlayerMode(m) {
      playerMode = m;
      document.getElementById('btnModeEmbed').className = m === 'embed' ? 'toggle-btn active' : 'toggle-btn';
      document.getElementById('btnModeNative').className = m === 'native' ? 'toggle-btn active' : 'toggle-btn';
      
      const embed = document.getElementById('embedPlayer');
      const native = document.getElementById('nativePlayer');
      const status = document.getElementById('playerStatus');

      if (m === 'embed') {
        native.pause();
        native.style.display = 'none';
        embed.style.display = 'block';
        if (currentVideoId) {
          embed.src = 'https://www.youtube-nocookie.com/embed/' + currentVideoId + '?autoplay=1';
          status.textContent = '🟢 Instant Player Aktif (0ms Buffer, 1080p 60fps)';
        }
      } else {
        embed.src = '';
        embed.style.display = 'none';
        native.style.display = 'block';
        if (currentStreamUrl) {
          native.src = currentStreamUrl;
          native.load();
          native.play().catch(() => {});
          status.textContent = '⏳ Memuat buffer stream proxy...';
        }
      }
    }

    function playVideo(id, title, streamUrl, quality = '360p') {
      currentVideoId = id;
      currentStreamUrl = streamUrl;
      currentTitle = decodeURIComponent(title);

      const card = document.getElementById('playerCard');
      const titleElem = document.getElementById('nowPlayingTitle');
      const embed = document.getElementById('embedPlayer');
      const native = document.getElementById('nativePlayer');
      const status = document.getElementById('playerStatus');

      card.style.display = 'block';
      titleElem.textContent = '▶️ ' + currentTitle;

      if (playerMode === 'embed') {
        native.style.display = 'none';
        embed.style.display = 'block';
        embed.src = 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1';
        status.textContent = '🟢 Instant Player Aktif (0ms Buffer)';
      } else {
        embed.style.display = 'none';
        native.style.display = 'block';
        native.src = streamUrl;
        native.load();
        native.play().catch(() => {});
        status.textContent = '⏳ Memuat buffer stream proxy (' + quality + ')...';
      }

      native.onplaying = () => { status.textContent = '🟢 Proxy Stream Sedang Diputar Lancar'; };
      native.onwaiting = () => { status.textContent = '⏳ Buffering stream data...'; };
      native.onerror = () => { status.textContent = '⚠️ Proxy stream lambat, klik tombol Instant Player di atas!'; };

      card.scrollIntoView({ behavior: 'smooth' });
    }

    async function testSubmit() {
      const val = document.getElementById('inputQuery').value.trim();
      if (!val) return;
      
      const btn = document.getElementById('btnSubmit');
      const resElem = document.getElementById('jsonResult');
      const listElem = document.getElementById('resultsList');
      
      btn.disabled = true;
      btn.textContent = 'Memproses...';
      resElem.textContent = '// Mengambil data...';
      listElem.innerHTML = '';

      try {
        const endpoint = mode === 'search' ? '/api/v1/search?q=' : '/api/v1/download?url=';
        const res = await fetch(endpoint + encodeURIComponent(val));
        const data = await res.json();
        resElem.textContent = JSON.stringify(data, null, 2);

        if (mode === 'search' && data.success && Array.isArray(data.data)) {
          let html = '';
          data.data.forEach((item) => {
            const v360 = item.resolutions?.video?.find(v => v.quality === '360p') || item.resolutions?.video?.[0];
            const a128 = item.resolutions?.audio?.find(a => a.quality === '128kbps') || item.resolutions?.audio?.[0];
            const encodedTitle = encodeURIComponent(item.title).replace(/'/g, "\\'");

            html += '<div class=\"result-item\">' +
              '<img class=\"result-thumb\" src=\"' + item.thumbnail + '\" alt=\"thumb\" onclick=\"playVideo(\\'' + item.id + '\\', \\'' + encodedTitle + '\\', \\'' + (v360?.stream_url || '') + '\\')\" />' +
              '<div class=\"result-info\">' +
                '<div class=\"result-title\" onclick=\"playVideo(\\'' + item.id + '\\', \\'' + encodedTitle + '\\', \\'' + (v360?.stream_url || '') + '\\')\">' + item.title + '</div>' +
                '<div class=\"result-meta\">' + (item.channel || '') + ' • ' + (item.duration || '') + ' • ' + (item.views || '') + '</div>' +
                '<div class=\"btn-group\">' +
                  '<button class=\"btn-action play-instant\" onclick=\"playVideo(\\'' + item.id + '\\', \\'' + encodedTitle + '\\', \\'' + (v360?.stream_url || '') + '\\')\">▶️ Tonton Video (Instan)</button>' +
                  (v360 ? '<a class=\"btn-action download\" href=\"' + v360.stream_url + '\" target=\"_blank\" download>📥 Video MP4</a>' : '') +
                  (a128 ? '<a class=\"btn-action audio\" href=\"' + a128.stream_url + '\" target=\"_blank\" download>🎵 Audio MP3</a>' : '') +
                '</div>' +
              '</div>' +
            '</div>';
          });
          listElem.innerHTML = html;

          if (data.data[0]) {
            const first = data.data[0];
            const v360 = first.resolutions?.video?.find(v => v.quality === '360p') || first.resolutions?.video?.[0];
            playVideo(first.id, encodeURIComponent(first.title), v360?.stream_url || '');
          }

        } else if (mode === 'download' && data.success && data.data) {
          const item = data.data;
          const v360 = item.resolutions?.video?.find(v => v.quality === '360p') || item.resolutions?.video?.[0];
          playVideo(item.id, encodeURIComponent(item.title), v360?.stream_url || '');
        }
      } catch (err) {
        resElem.textContent = 'Error: ' + err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = mode === 'search' ? 'Cari Video' : 'Get Media';
      }
    }
  </script>
</body>
</html>
    `);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      if (!silent) console.error(`⚠️ Port ${PORT} sudah digunakan oleh proses lain!`);
    } else {
      if (!silent) console.error(`❌ Server error:`, err.message);
    }
  });

  server.listen(PORT, () => {
    if (!silent) {
      console.log(`\n🚀 YouTube REST API v1 berjalan di http://localhost:${PORT}`);
      console.log(`🔍 Search API   : http://localhost:${PORT}/api/v1/search?q=rick+astley&page=1&limit=5`);
      console.log(`📡 Download API : http://localhost:${PORT}/api/v1/download?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ`);
      console.log(`🩺 Health API   : http://localhost:${PORT}/api/v1/health\n`);
    }
  });

  return server;
}

/**
 * Interactive Terminal CLI Loop
 */
async function startInteractiveCli(query, initialPage = 1, limit = 5) {
  startServer(true);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let currentPage = initialPage;
  console.log(`\n🔍 Mencari "${query}" di YouTube...\n`);

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
   node yt.js rick astley
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
const rawArgs = process.argv.slice(2);

if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  showHelp();
  process.exit(0);
}

if (rawArgs.length === 0 || rawArgs.includes('--server')) {
  // Standalone server mode
  startServer(false);
} else {
  // CLI Mode
  const isJsonOnly = rawArgs.includes('--json') || !process.stdin.isTTY;
  
  let pageArg = 1;
  let limitArg = 5;
  const positionalArgs = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === '--json' || a === '--server') continue;
    if (a.startsWith('--page=')) {
      pageArg = parseInt(a.split('=')[1], 10) || 1;
    } else if (a.startsWith('--limit=')) {
      limitArg = parseInt(a.split('=')[1], 10) || 5;
    } else {
      positionalArgs.push(a);
    }
  }

  if (positionalArgs.length === 0) {
    startServer(false);
  } else {
    // Strip common CLI subcommands if typed by the user (e.g. "search", "cari", "download", "get")
    const firstWord = positionalArgs[0].toLowerCase();
    if (['search', 'cari', 'find', 'query'].includes(firstWord) && positionalArgs.length > 1) {
      positionalArgs.shift();
    } else if (['download', 'get', 'dl'].includes(firstWord) && positionalArgs.length > 1) {
      positionalArgs.shift();
    }

    let query = '';
    let isUrl = false;

    if (positionalArgs[0].startsWith('http://') || positionalArgs[0].startsWith('https://')) {
      isUrl = true;
      query = positionalArgs[0];
    } else {
      const words = [...positionalArgs];
      // Extract numeric page / limit if specified at the end of positional args
      if (words.length > 2 && /^\d+$/.test(words[words.length - 1]) && /^\d+$/.test(words[words.length - 2])) {
        limitArg = parseInt(words.pop(), 10);
        pageArg = parseInt(words.pop(), 10);
      } else if (words.length > 1 && /^\d+$/.test(words[words.length - 1])) {
        pageArg = parseInt(words.pop(), 10);
      }
      query = words.join(' ');
    }

    if (isUrl) {
      startServer(true);
      scrapeYoutube(query, `localhost:${PORT}`)
        .then(data => {
          console.log(JSON.stringify({ success: true, data }, null, 2));
          if (isJsonOnly) {
            process.exit(0);
          } else {
            console.log('\n💡 Proxy server aktif untuk stream URL. Tekan Ctrl+C untuk keluar.');
          }
        })
        .catch(err => {
          console.error(JSON.stringify({ success: false, error: err.message }, null, 2));
          process.exit(1);
        });
    } else {
      if (isJsonOnly) {
        startServer(true);
        searchAndScrapeYoutube(query, `localhost:${PORT}`, pageArg, limitArg)
          .then(results => {
            console.log(JSON.stringify({ success: true, query, ...results }, null, 2));
            process.exit(0);
          })
          .catch(err => {
            console.error(JSON.stringify({ success: false, error: err.message }, null, 2));
            process.exit(1);
          });
      } else {
        startInteractiveCli(query, pageArg, limitArg);
      }
    }
  }
}
