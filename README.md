<div align="center">

<!-- Animated Header -->
<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0f0c29,50:302b63,100:24243e&height=220&section=header&text=TEMPE&fontSize=80&fontColor=ffffff&animation=fadeIn&fontAlignY=35&desc=YouTube%20Search%20%26%20Stream%20Proxy%20API&descSize=18&descAlignY=55&descAlign=50" width="100%" />

<!-- Animated Badges -->
<p>
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=node.js&logoColor=white&labelColor=1a1a2e" />
  <img src="https://img.shields.io/badge/Zero-Dependencies-ff6b6b?style=for-the-badge&logo=npm&logoColor=white&labelColor=1a1a2e" />
  <img src="https://img.shields.io/badge/Tests-38%2F38%20Passed-00d26a?style=for-the-badge&logo=checkmarx&logoColor=white&labelColor=1a1a2e" />
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge&logo=opensourceinitiative&logoColor=white&labelColor=1a1a2e" />
</p>

<p>
  <img src="https://img.shields.io/badge/REST%20API-v1-7c3aed?style=flat-square" />
  <img src="https://img.shields.io/badge/Stream%20Proxy-Anti%20403-f59e0b?style=flat-square" />
  <img src="https://img.shields.io/badge/Search-Paginated-06b6d4?style=flat-square" />
  <img src="https://img.shields.io/badge/CLI-Interactive-10b981?style=flat-square" />
</p>

<!-- Typing SVG -->
<a href="https://git.io/typing-svg">
  <img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=600&size=22&pause=1000&color=7C3AED&center=true&vCenter=true&multiline=true&repeat=true&width=700&height=80&lines=YouTube+Search+%2B+Download+%2B+Stream+Proxy;Zero+Dependencies+%E2%80%A2+Single+File+%E2%80%A2+Blazing+Fast" alt="Typing SVG" />
</a>

<br />

> **YouTube REST API + Stream Proxy + Interactive CLI**
> dalam **satu file** tanpa dependensi eksternal apapun.

</div>

<br />

<!-- ═══════════════════ FEATURES ═══════════════════ -->

## ✨ Fitur Utama

<table>
<tr>
<td width="50%">

### 🔍 YouTube Search
- Pencarian video native tanpa API Key
- Parsing `ytInitialData` langsung dari YouTube
- **Paginated** — max 5 hasil per halaman
- Navigasi halaman otomatis

</td>
<td width="50%">

### 📥 Video Downloader
- Scrape info video lengkap (judul, durasi, thumbnail)
- **8 resolusi video** (144p → 4K)
- Format audio MP3 (128kbps)
- CDN Pool Failover (anti rate-limit)

</td>
</tr>
<tr>
<td width="50%">

### 🎬 Stream Proxy
- Anti-403 dengan header spoofing
- **Smart TTL Cache** (4 menit)
- Lazy URL resolution (on-demand)
- Bisa embed di `<video>` tag

</td>
<td width="50%">

### 💻 Interactive CLI
- Auto-detect: URL vs search query
- Terminal prompt interaktif (ketik `2`, `3`, `n`, `p`, `q`)
- `--json` flag untuk scripting/bot
- `--help` panduan lengkap

</td>
</tr>
</table>

<br />

<!-- ═══════════════════ ARSITEKTUR ═══════════════════ -->

<details>
<summary><h2>🏗️ Arsitektur & Alur Kerja</h2></summary>

<br />

```
┌─────────────────────────────────────────────────────────────┐
│                         TEMPE                                │
│              YouTube Search & Stream Proxy API               │
├──────────────┬──────────────┬────────────┬──────────────────┤
│  🔍 Search   │  📥 Download  │  🎬 Stream  │  🩺 Health      │
│  /api/v1/    │  /api/v1/    │  /stream/  │  /api/v1/       │
│  search      │  download    │  :id       │  health         │
├──────────────┴──────────────┴────────────┴──────────────────┤
│                                                              │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────────┐ │
│  │ Fast Scrape  │   │ Full Scrape   │   │ TTL Cache (4min) │ │
│  │ (info only)  │   │ (all formats) │   │ + Lazy Resolve   │ │
│  └──────┬──────┘   └──────┬───────┘   └────────┬─────────┘ │
│         │                  │                     │           │
│  ┌──────▼──────────────────▼─────────────────────▼─────────┐│
│  │              Savetube CDN Pool Failover                  ││
│  │   cdn400 → cdn401 → cdn402 → cdn403 → cdn405 → cdn406  ││
│  └─────────────────────────────────────────────────────────┘│
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │           Anti-403 YouTube Header Spoofing              ││
│  │   Referer: youtube.com  •  Origin: youtube.com          ││
│  └─────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

### 🔄 Stream Proxy v3 — 3-Layer Cache System

```
Request → /stream/:id
         │
         ▼
   ┌─────────────┐     ✅ Cache HIT (~1s)
   │  Layer 1:    │ ──────────────────────→ Proxy video bytes
   │  TTL Cache   │
   │  (< 4 min?)  │
   └──────┬──────┘
          │ ❌ Cache MISS
          ▼
   ┌─────────────┐     ✅ Got fresh URL
   │  Layer 2:    │ ──────────────────────→ Cache it + Proxy
   │  Re-scrape   │
   │  fresh URL   │
   └──────┬──────┘
          │ ⚠️ URL returns 403
          ▼
   ┌─────────────┐     ✅ New URL works
   │  Layer 3:    │ ──────────────────────→ Replace cache + Proxy
   │  Invalidate  │
   │  + Re-scrape │
   └─────────────┘
```

</details>

<br />

<!-- ═══════════════════ QUICK START ═══════════════════ -->

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) **v18+** (uses built-in `fetch`)

### Instalasi

```bash
# Clone repository
git clone https://github.com/lannreal/aduh.git
cd aduh

# Jalankan (zero dependencies — tidak perlu npm install!)
node yt.js
```

> **💡 Tidak ada `npm install`** — project ini menggunakan 100% Node.js built-in modules.

### Output saat server berjalan:

```
🚀 YouTube REST API v1 berjalan di http://localhost:3000
🔍 Search API   : http://localhost:3000/api/v1/search?q=rick+astley&page=1&limit=5
📡 Download API : http://localhost:3000/api/v1/download?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ
🩺 Health API   : http://localhost:3000/api/v1/health
```

<br />

<!-- ═══════════════════ API DOCS ═══════════════════ -->

## 📚 API Endpoints

<details open>
<summary><h3>🔍 Search — <code>GET /api/v1/search</code></h3></summary>

Cari video YouTube dengan pagination. Response cepat (~2 detik) karena menggunakan **Fast Mode**.

**Parameters:**

| Parameter | Wajib | Default | Keterangan |
|-----------|:-----:|:-------:|------------|
| `q` | ✅ | — | Kata kunci pencarian |
| `page` | ❌ | `1` | Nomor halaman |
| `limit` | ❌ | `5` | Maks item per halaman |

**Request:**
```bash
curl "http://localhost:3000/api/v1/search?q=rick+astley&page=1&limit=5"
```

**Response:**
```jsonc
{
  "success": true,
  "query": "rick astley",
  "pagination": {
    "page": 1,
    "limit": 5,
    "total_items": 20,
    "total_pages": 4,
    "has_next": true,
    "has_prev": false,
    "next_page_url": "http://localhost:3000/api/v1/search?q=rick+astley&page=2&limit=5"
  },
  "data": [
    {
      "id": "dQw4w9WgXcQ",
      "title": "Rick Astley - Never Gonna Give You Up",
      "channel": "Rick Astley",
      "duration": "3:33",
      "views": "1.5B views",
      "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "resolutions": {
        "video": [
          { "quality": "360p", "stream_url": "http://localhost:3000/stream/1ed99905" }
        ],
        "audio": [
          { "quality": "128kbps", "stream_url": "http://localhost:3000/stream/76d56d56" }
        ]
      }
    }
    // ... (max 5 items)
  ]
}
```

> 💡 **Search menggunakan Fast Mode** — hanya menyediakan `stream_url` (tanpa `direct_url`) agar response tetap cepat. Gunakan `/api/v1/download` jika butuh `direct_url`.

</details>

<details>
<summary><h3>📥 Download — <code>GET /api/v1/download</code></h3></summary>

Ambil info lengkap 1 video termasuk **semua resolusi** (144p - 4K) dan link download langsung.

**Parameters:**

| Parameter | Wajib | Keterangan |
|-----------|:-----:|------------|
| `url` | ✅ | URL YouTube lengkap |

**Request:**
```bash
curl "http://localhost:3000/api/v1/download?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

**Response:**
```jsonc
{
  "success": true,
  "data": {
    "id": "dQw4w9WgXcQ",
    "title": "Rick Astley - Never Gonna Give You Up",
    "duration": "3:33",
    "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
    "resolutions": {
      "video": [
        {
          "quality": "360p",
          "stream_url": "http://localhost:3000/stream/1ed99905",
          "direct_url": "https://rr2---.googlevideo.com/videoplayback?..."
        },
        { "quality": "720p",  "stream_url": "...", "direct_url": "..." },
        { "quality": "1080p", "stream_url": "...", "direct_url": "..." },
        { "quality": "2160p", "stream_url": "...", "direct_url": "..." }
        // ... hingga 8 resolusi
      ],
      "audio": [
        {
          "quality": "128kbps",
          "stream_url": "http://localhost:3000/stream/76d56d56",
          "direct_url": "https://cdn405.savetube.vip/media/..."
        }
      ]
    }
  }
}
```

</details>

<details>
<summary><h3>🎬 Stream Proxy — <code>GET /stream/:id</code></h3></summary>

Proxy streaming yang aman. Buka di browser → video/audio langsung diputar.

**Request:**
```bash
# Putar di browser
http://localhost:3000/stream/1ed99905

# Embed di HTML
<video src="http://localhost:3000/stream/1ed99905" controls></video>
```

**Behavior:**
- ✅ **Anti-403** — header YouTube spoofing otomatis
- ✅ **Smart Cache** — akses pertama ~3-5s, akses berikutnya ~1s
- ✅ **Auto-refresh** — URL expired? otomatis resolve yang baru
- ✅ **Range requests** — mendukung seeking/skipping di video player
- ✅ **CORS enabled** — bisa diakses dari frontend manapun

**Response Headers:**
```
Content-Type: video/mp4 | audio/mpeg
Content-Disposition: inline
Access-Control-Allow-Origin: *
```

</details>

<details>
<summary><h3>🩺 Health Check — <code>GET /api/v1/health</code></h3></summary>

Cek status server.

**Request:**
```bash
curl http://localhost:3000/api/v1/health
```

**Response:**
```json
{
  "success": true,
  "message": "YouTube API v1 is active and running smoothly",
  "uptime_seconds": 120,
  "active_streams": 15
}
```

</details>

<br />

<!-- ═══════════════════ CLI ═══════════════════ -->

## 💻 CLI Mode

<details open>
<summary><h3>Panduan Penggunaan CLI</h3></summary>

```bash
# ─── Mode 1: Server REST API ───
node yt.js
node yt.js --server

# ─── Mode 2: Pencarian Interaktif ───
node yt.js "rick astley"
# → Ketik angka (2, 3, 4) untuk pindah halaman
# → Ketik 'n' (next), 'p' (prev), 'q' (quit)

# ─── Mode 3: Pencarian Non-Interaktif (JSON output) ───
node yt.js "rick astley" --json
node yt.js "rick astley" 2 --json          # halaman 2
node yt.js "rick astley" --page=3 --limit=2 # custom

# ─── Mode 4: Download Single Video ───
node yt.js "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# ─── Bantuan ───
node yt.js --help
```

**Contoh Interactive CLI:**
```
$ node yt.js "lofi hip hop"

{
  "success": true,
  "query": "lofi hip hop",
  "pagination": { "page": 1, "total_pages": 4, "has_next": true },
  "data": [ ... 5 results ... ]
}

================================================================
📌 HALAMAN PADA SERVISE CLI: [ Halaman 1 dari 4 ]
💡 Pilihan:
   • Ketik angka (misal: 2, 3, 4) untuk pindah ke halaman tersebut.
   • Ketik 'n' (Next) | 'p' (Prev) | 'q' (Keluar)
================================================================

Pilih Halaman > _
```

</details>

<br />

<!-- ═══════════════════ PERFORMANCE ═══════════════════ -->

## ⚡ Performa

<table>
<tr>
<th>Operasi</th>
<th>Waktu</th>
<th>Keterangan</th>
</tr>
<tr>
<td>🔍 Search API (5 results)</td>
<td><b>~2.4s</b></td>
<td>Fast Mode — tanpa resolve URL</td>
</tr>
<tr>
<td>📥 Download API (1 video)</td>
<td><b>~5-10s</b></td>
<td>Full scrape semua resolusi</td>
</tr>
<tr>
<td>🎬 Stream (pertama kali)</td>
<td><b>~3-5s</b></td>
<td>Lazy resolve URL on-demand</td>
</tr>
<tr>
<td>⚡ Stream (cache HIT)</td>
<td><b>~1s</b></td>
<td>TTL cache 4 menit</td>
</tr>
<tr>
<td>🩺 Health Check</td>
<td><b>< 10ms</b></td>
<td>Instant</td>
</tr>
</table>

### Optimasi yang Diterapkan

- **🧠 Smart TTL Cache** — URL yang sudah di-resolve disimpan 4 menit, akses ulang instan
- **🔄 Pre-warm Cache** — saat scrape, URL langsung di-cache sebelum response dikirim
- **⚡ Lazy Resolution** — Search hanya ambil info video, download URL di-resolve saat dibutuhkan
- **🌐 CDN Pool Failover** — 6 CDN gateway dirotasi acak, anti rate-limit 429
- **🛡️ Anti-403 Spoofing** — Header YouTube (Referer + Origin) otomatis ditambahkan

<br />

<!-- ═══════════════════ TECH ═══════════════════ -->

## 🛠️ Tech Stack

```
📦 Zero External Dependencies!
```

| Komponen | Teknologi |
|----------|-----------|
| Runtime | Node.js 18+ (built-in `fetch`) |
| HTTP Server | `node:http` |
| Encryption | `node:crypto` (AES-128-CBC) |
| Streaming | `node:stream` + `pipeline` |
| File Cache | `node:fs` (JSON persistence) |
| CLI | `node:readline` |
| YouTube Parser | Native `ytInitialData` parser |
| CDN Backend | Savetube.vip (shuffled pool) |

<br />

<!-- ═══════════════════ TESTING ═══════════════════ -->

## 🧪 Testing

```bash
# Pastikan server berjalan di terminal terpisah
node yt.js

# Jalankan test suite (38 test cases)
node test_all.js

# Jalankan speed benchmark
node test_speed.js
```

**Test Coverage:**

| Section | Tests | Status |
|---------|:-----:|:------:|
| Health Check | 3 | ✅ |
| Search API | 12 | ✅ |
| Download API | 8 | ✅ |
| Stream Proxy | 8 | ✅ |
| Web Dashboard | 3 | ✅ |
| CORS & Headers | 4 | ✅ |
| **Total** | **38** | **✅ 100%** |

<br />

<!-- ═══════════════════ STRUCTURE ═══════════════════ -->

## 📁 Struktur Project

```
TEMPE/
├── yt.js            # 🎯 Single-file: REST API + Stream Proxy + CLI
├── test_all.js      # 🧪 Comprehensive test suite (38 tests)
├── test_speed.js    # ⚡ Performance benchmark
├── urls.json        # 💾 Stream token registry (auto-generated)
└── README.md        # 📚 Dokumentasi (file ini)
```

> **💡 Seluruh logic ada dalam 1 file `yt.js`** (~800 baris) — mudah di-deploy, mudah di-maintain.

<br />

<!-- ═══════════════════ ENV ═══════════════════ -->

## ⚙️ Environment Variables

| Variable | Default | Keterangan |
|----------|:-------:|------------|
| `PORT` | `3000` | Port HTTP server |

```bash
# Custom port
PORT=8080 node yt.js
```

<br />

<!-- ═══════════════════ ERROR CODES ═══════════════════ -->

<details>
<summary><h2>🔴 Error Handling</h2></summary>

| Status | Endpoint | Penyebab |
|:------:|----------|----------|
| `400` | `/api/v1/search` | Parameter `?q=` kosong atau tidak ada |
| `400` | `/api/v1/download` | Parameter `?url=` kosong atau tidak ada |
| `404` | `/stream/:id` | Stream token tidak ditemukan atau kadaluarsa |
| `500` | Semua | Error internal (YouTube tidak bisa diakses, video privat, dll) |
| `502` | `/stream/:id` | Upstream CDN tidak bisa diakses |

**Contoh Error Response:**
```json
{
  "success": false,
  "error": "Parameter kata kunci ?q=... wajib diisi. Contoh: /api/v1/search?q=rick+astley&page=1&limit=5"
}
```

</details>

<br />

<!-- ═══════════════════ COMPARISON ═══════════════════ -->

<details>
<summary><h2>🆚 Search vs Download — Kapan Pakai Yang Mana?</h2></summary>

| | `/api/v1/search` | `/api/v1/download` |
|---|---|---|
| **Input** | Kata kunci | URL YouTube |
| **Hasil** | Banyak video (5/halaman) | 1 video |
| **Kecepatan** | ⚡ ~2 detik | 🐢 ~5-10 detik |
| **Resolusi** | Terbatas | Lengkap (144p → 4K) |
| **`direct_url`** | ❌ | ✅ |
| **`stream_url`** | ✅ | ✅ |
| **Pagination** | ✅ | ❌ |

**Rekomendasi:**
- Gunakan **Search** untuk browse/cari video → akses via `stream_url`
- Gunakan **Download** untuk 1 video spesifik yang butuh pilihan resolusi lengkap

</details>

<br />

<!-- ═══════════════════ GLOSSARY ═══════════════════ -->

<details>
<summary><h2>📖 Glosarium</h2></summary>

| Istilah | Penjelasan |
|---------|------------|
| `stream_url` | Link proxy lokal (`/stream/xxx`). Aman, tidak pernah expired. Buka di browser = langsung putar. |
| `direct_url` | Link asli ke CDN (googlevideo/savetube). Bisa expired dalam ~5 menit. |
| `stream_id` | Kode 8 karakter (misal `1ed99905`) yang merepresentasikan kombinasi video + kualitas + tipe. |
| TTL Cache | Time-To-Live cache. URL yang sudah di-resolve disimpan selama 4 menit. |
| CDN Pool | 6 server gateway savetube yang dirotasi acak untuk menghindari rate-limit. |
| Fast Mode | Scrape ringan yang hanya ambil info video tanpa resolve download URL. |
| Lazy Resolve | URL download di-resolve saat `/stream/:id` diakses, bukan saat search. |

</details>

<br />

<!-- Footer -->
<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0f0c29,50:302b63,100:24243e&height=120&section=footer" width="100%" />

<p>
  <sub>Built with ❤️ using pure Node.js — Zero Dependencies</sub>
</p>

</div>
