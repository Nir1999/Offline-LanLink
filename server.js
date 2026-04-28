#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  LanLink Server v8 — 100% Offline LAN Messenger             ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  Ports (open in firewall):                                  ║
 * ║    8080+ — HTTP/WS (first free port starting at 8080)       ║
 * ║    3478  — STUN  (offline WebRTC peer discovery, UDP)       ║
 * ║                                                              ║
 * ║  HTTPS mode (enables mic/camera on remote devices):         ║
 * ║    Place key.pem + cert.pem next to server.js              ║
 * ║    → Uses first free port starting at 8443                 ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  Install:  npm install ws                                   ║
 * ║  Run:      node server.js                                   ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const dgram = require('dgram');
const net   = require('net');
const { WebSocketServer, WebSocket } = require('ws');

// ── Configuration ──────────────────────────────────────────────────
const isCompiled = typeof process.pkg !== 'undefined';
const runDir = isCompiled ? path.dirname(process.execPath) : __dirname;

const KEY_PATH  = path.join(runDir, 'key.pem');
const CERT_PATH = path.join(runDir, 'cert.pem');
let HAS_CERTS = fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH);

if (!HAS_CERTS) {
  try {
    console.log('  ⏳ Generating self-signed HTTPS certificates for WebRTC calls...');
    const forge = require('node-forge');
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
    const attrs = [{ name: 'commonName', value: 'LanLink' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    fs.writeFileSync(KEY_PATH, forge.pki.privateKeyToPem(keys.privateKey));
    fs.writeFileSync(CERT_PATH, forge.pki.certificateToPem(cert));
    HAS_CERTS = true;
    console.log('  ✅ Certificates saved successfully.\n');
  } catch (e) {
    // node-forge not installed, will fallback to HTTP
  }
}

const PREFERRED_PORT = HAS_CERTS ? 8443 : 8080;
const MAX_PORT_TRIES = 20;
const STUN_PORT = 3478;
let ACTIVE_PORT = null;

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;  // 500 MB
const UPLOADS_DIR      = path.join(runDir, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const STATIC_FILES = {
  '/': { path: path.join(__dirname, 'app.html'), contentType: 'text/html; charset=utf-8', headers: { 'Cache-Control': 'no-store' } },
  '/index.html': { path: path.join(__dirname, 'app.html'), contentType: 'text/html; charset=utf-8', headers: { 'Cache-Control': 'no-store' } },
  '/sw.js': {
    path: path.join(__dirname, 'sw.js'),
    contentType: 'application/javascript; charset=utf-8',
    headers: { 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-store, no-cache' },
  },
};
const staticCache = new Map();

// ── MIME type map for correct Content-Type on served files ─────────
const MIME_MAP = {
  '.html':'.html', '.htm':'text/html',
  '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png',
  '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml',
  '.mp4':'video/mp4', '.webm':'video/webm', '.mov':'video/quicktime',
  '.mp3':'audio/mpeg', '.ogg':'audio/ogg', '.wav':'audio/wav',
  '.pdf':'application/pdf',
  '.zip':'application/zip', '.tar':'application/x-tar',
  '.doc':'application/msword',
  '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls':'application/vnd.ms-excel',
  '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt':'text/plain', '.json':'application/json',
};
function getMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function getSafeFilename(rawName) {
  if (!rawName) return 'file.bin';
  let safe = rawName.replace(/[^a-zA-Z0-9._\-]/g, '_').substring(0, 200);
  const ext = path.extname(safe).toLowerCase();
  if (['.exe', '.bat', '.cmd', '.sh', '.vbs', '.js', '.msi', '.jar', '.scr', '.html', '.htm'].includes(ext)) {
    safe += '.txt'; // Neutralize dangerous extensions
  }
  return safe;
}

function serveCachedStatic(pathname, res, missingMessage) {
  const entry = STATIC_FILES[pathname];
  if (!entry) return false;

  let cached = staticCache.get(entry.path);
  if (!cached) {
    if (!fs.existsSync(entry.path)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(missingMessage);
      return true;
    }
    cached = fs.readFileSync(entry.path);
    staticCache.set(entry.path, cached);
  }

  res.writeHead(200, { 'Content-Type': entry.contentType, ...entry.headers });
  res.end(cached);
  return true;
}

// ── Peer registry ──────────────────────────────────────────────────
const peers = new Map();  // peerId → { ws, id, name, avatar, ip }

const ANNOUNCEMENTS_FILE = path.join(runDir, 'announcements.json');
let announcements = [];
try {
  if (fs.existsSync(ANNOUNCEMENTS_FILE)) {
    announcements = JSON.parse(fs.readFileSync(ANNOUNCEMENTS_FILE, 'utf8'));
  }
} catch(e) {
  console.error('Failed to load announcements:', e.message);
}
function saveAnnouncements() {
  fs.writeFile(ANNOUNCEMENTS_FILE, JSON.stringify(announcements), err => {
    if (err) console.error('Failed to save announcements:', err.message);
  });
}

function broadcast(data, excludeId = null) {
  const json = JSON.stringify(data);
  for (const [id, p] of peers)
    if (id !== excludeId && p.ws.readyState === WebSocket.OPEN)
      p.ws.send(json);
}

function sendTo(toId, data) {
  const p = peers.get(toId);
  if (p?.ws.readyState === WebSocket.OPEN)
    p.ws.send(JSON.stringify(data));
}

function peerSnapshot(excludeId = null) {
  // BUG FIX: exclude the registering peer so they don't see themselves
  return [...peers.values()]
    .filter(p => p.id !== excludeId)
    .map(({ id, name, avatar }) => ({ id, name, avatar }));
}

// ── CPU Usage tracking ─────────────────────────────────────────────
let currentCpuUsage = 0;
let lastCpus = os.cpus();
setInterval(() => {
  const cpus = os.cpus();
  let idle = 0, total = 0, lastIdle = 0, lastTotal = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) total += cpu.times[type];
    idle += cpu.times.idle;
  }
  for (const cpu of lastCpus) {
    for (const type in cpu.times) lastTotal += cpu.times[type];
    lastIdle += cpu.times.idle;
  }
  const totalDiff = total - lastTotal;
  // Calculate percentage (100% minus the percentage of idle time)
  currentCpuUsage = totalDiff === 0 ? 0 : 100 - (100 * (idle - lastIdle) / totalDiff);
  lastCpus = cpus;
}, 2000).unref();

// ── Network Bandwidth tracking ─────────────────────────────────────
let totalNetworkRx = 0;
let totalNetworkTx = 0;
const activeSockets = new Set();
function getNetworkUsage() {
  let rx = totalNetworkRx;
  let tx = totalNetworkTx;
  for (const socket of activeSockets) {
    rx += socket.bytesRead || 0;
    tx += socket.bytesWritten || 0;
  }
  return { rx, tx };
}

// ── HTTP handler ───────────────────────────────────────────────────
function handleHTTP(req, res) {
  // ── Security Headers ──
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; connect-src 'self' ws: wss: http: https:; img-src 'self' data: blob:; manifest-src 'self' data:;");

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let pathname, searchParams;
  try {
    const u  = new URL(req.url, 'http://x');
    pathname = u.pathname;
    searchParams = u.searchParams;
  } catch { res.writeHead(400); res.end('Bad request'); return; }

  // ── Serve app ──────────────────────────────────────────────────
  if (pathname === '/' || pathname === '/index.html') {
    serveCachedStatic(pathname, res, `app.html not found in: ${__dirname}\nMake sure app.html and server.js are in the same folder.`);
    return;
  }

  // ── Serve Service Worker — must be at root scope ───────────────
  // IMPORTANT headers:
  //   Service-Worker-Allowed: /  → allows SW to control all paths
  //   Cache-Control: no-store    → browser must always fetch fresh SW
  //   Content-Type: application/javascript  → required by spec
  if (pathname === '/sw.js') {
    serveCachedStatic(pathname, res, 'sw.js not found — make sure sw.js is in the same folder as server.js');
    return;
  }

  // ── PWA icons — generated as inline SVG so no image files needed ─
  if (pathname === '/icon-192.png' || pathname === '/icon-96.png') {
    const size = pathname === '/icon-192.png' ? 192 : 96;
    const fontSize = Math.round(size * 0.55);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${Math.round(size*0.2)}" fill="#7c6aff"/><text y="${Math.round(size*0.72)}" x="${Math.round(size*0.13)}" font-size="${fontSize}">📡</text></svg>`;
    // Return as SVG (browsers accept this for PWA icons)
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    res.end(svg);
    return;
  }

  // ── /api/config — client calls this to auto-discover WS URL ────
  if (pathname === '/api/config') {
    const hostHeader = req.headers.host || `localhost:${ACTIVE_PORT || PREFERRED_PORT}`;
    const hostIP     = hostHeader.split(':')[0];
    const wsProto    = HAS_CERTS ? 'wss'   : 'ws';
    const httpProto  = HAS_CERTS ? 'https' : 'http';
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      wsUrl    : `${wsProto}://${hostIP}:${ACTIVE_PORT || PREFERRED_PORT}`,
      httpBase : `${httpProto}://${hostIP}:${ACTIVE_PORT || PREFERRED_PORT}`,
      stunUrl  : `stun:${hostIP}:${STUN_PORT}`,
      isHttps  : HAS_CERTS,
      version  : 9,
    }));
    return;
  }

  // ── /api/peers — peer list for debugging ───────────────────────
  if (pathname === '/api/peers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(peerSnapshot()));
    return;
  }

  // ── /api/announcements — get current announcements ───────────────
  if (pathname === '/api/announcements') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(announcements));
    return;
  }

  // ── /api/health — server health metrics ───────────────
  if (pathname === '/api/health') {
    let diskSpace = null;
    try {
      if (fs.statfsSync) { // Supported in Node v19.6.0+
        const stat = fs.statfsSync(UPLOADS_DIR);
        diskSpace = { free: stat.bavail * stat.bsize, total: stat.blocks * stat.bsize };
      }
    } catch (e) {}

    const netUsage = getNetworkUsage();

    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      uptime: process.uptime(),
      osUptime: os.uptime(),
      cpuUsage: currentCpuUsage,
      memProcess: process.memoryUsage(),
      memSystem: { free: os.freemem(), total: os.totalmem() },
      diskSpace: diskSpace,
      loadAvg: os.loadavg(),
      networkRx: netUsage.rx,
      networkTx: netUsage.tx,
      peersOnline: peers.size,
      nodeVersion: process.version,
      platform: os.platform()
    }));
    return;
  }

  // ── /upload-chunk — chunked resumable file upload ───────────────
  if (pathname === '/upload-chunk' && req.method === 'POST') {
    const fileId      = req.headers['x-file-id'];
    const chunkIndex  = parseInt(req.headers['x-chunk-index']);
    const totalChunks = parseInt(req.headers['x-total-chunks']);
    const rawName     = req.headers['x-filename'] ? decodeURIComponent(req.headers['x-filename']) : 'file.bin';
    const safeFileId  = getSafeFilename(fileId);
    const destPath    = path.join(UPLOADS_DIR, safeFileId);

    // Open file in append mode. (chunk 0 truncates and starts fresh).
    const stream = fs.createWriteStream(destPath, { flags: chunkIndex === 0 ? 'w' : 'a' });
    let received = 0, aborted = false;

    req.on('data', chunk => {
      if (aborted) return;
      received += chunk.length;
      
      // Prevent individual chunks from being excessively large
      if (received > 10 * 1024 * 1024) {
        aborted = true; stream.destroy(); try { fs.unlinkSync(destPath); } catch {}
        if (!res.headersSent) { res.writeHead(413); res.end(JSON.stringify({ error: 'Chunk too large' })); }
        return;
      }
      
      // Prevent total aggregated file size from bypassing MAX_UPLOAD_BYTES
      const currentSize = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
      if (currentSize + chunk.length > MAX_UPLOAD_BYTES) {
        aborted = true; stream.destroy(); try { fs.unlinkSync(destPath); } catch {}
        if (!res.headersSent) { res.writeHead(413); res.end(JSON.stringify({ error: 'Total file size exceeded' })); }
      }
    });

    req.on('end', () => {
      if (aborted) return;
      stream.end();
      if (chunkIndex === totalChunks - 1) {
        const host  = req.headers.host || `localhost:${ACTIVE_PORT || PREFERRED_PORT}`;
        const proto = HAS_CERTS ? 'https' : 'http';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          url      : `${proto}://${host}/uploads/${safeFileId}`,
          fileName : rawName,
          mimeType : getMime(rawName),
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      }
    });

    req.on('error', err => {
      if (!aborted) { stream.destroy(); try { fs.unlinkSync(destPath); } catch {} }
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    });

    stream.on('error', err => {
      if (!aborted) { aborted = true; stream.destroy(); try { fs.unlinkSync(destPath); } catch {} }
      if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: 'Write error' })); }
    });

    req.pipe(stream, { end: false });
    return;
  }

  // ── /upload — file upload ──────────────────────────────────────
  if (pathname === '/upload' && req.method === 'POST') {
    const rawName  = req.headers['x-filename']
      ? decodeURIComponent(req.headers['x-filename'])
      : 'file.bin';
    const safeName = `${Date.now()}_${getSafeFilename(rawName)}`;
    const destPath = path.join(UPLOADS_DIR, safeName);
    const stream   = fs.createWriteStream(destPath);
    let received = 0, aborted = false;

    req.on('data', chunk => {
      if (aborted) return;
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        aborted = true;
        stream.destroy();
        try { fs.unlinkSync(destPath); } catch {}
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `File too large (max ${MAX_UPLOAD_BYTES/1024/1024|0} MB)` }));
        }
      }
    });

    req.on('end', () => {
      if (aborted) return;
      stream.end();
      const host  = req.headers.host || `localhost:${ACTIVE_PORT || PREFERRED_PORT}`;
      const proto = HAS_CERTS ? 'https' : 'http';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        url      : `${proto}://${host}/uploads/${safeName}`,
        fileName : rawName,
        mimeType : getMime(rawName),
      }));
    });

    req.on('error', err => {
      if (!aborted) { stream.destroy(); try { fs.unlinkSync(destPath); } catch {} }
      if (!res.headersSent) { res.writeHead(500); res.end(); }
      console.error('Upload stream error:', err.message);
    });

    stream.on('error', err => {
      if (!aborted) { aborted = true; stream.destroy(); try { fs.unlinkSync(destPath); } catch {} }
      if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: 'Write error' })); }
      console.error('Upload file write error:', err.message);
    });

    req.pipe(stream, { end: false });
    return;
  }

  // ── /uploads/:file — serve uploaded files ──────────────────────
  if (pathname.startsWith('/uploads/')) {
    const normalized = path.normalize(pathname).replace(/^(\.\.[\\/])+/, '');
    const filePath   = path.join(runDir, normalized);
    if (!filePath.startsWith(UPLOADS_DIR + path.sep) && filePath !== UPLOADS_DIR) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const stat    = fs.statSync(filePath);
    const mime    = getMime(filePath);
    const headers = {
      'Content-Length' : stat.size,
      'Content-Type'   : mime,
      'Accept-Ranges'  : 'bytes',
    };
    if (searchParams.get('dl') === '1')
      headers['Content-Disposition'] = `attachment; filename="${path.basename(filePath)}"`;
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404); res.end('Not found');
}

// ── Create HTTP(S) server ──────────────────────────────────────────
let webServer;
if (HAS_CERTS) {
  webServer = https.createServer({ key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CERT_PATH) }, handleHTTP);
} else {
  webServer = http.createServer(handleHTTP);
}

webServer.on('connection', socket => {
  activeSockets.add(socket);
  socket.on('close', () => {
    totalNetworkRx += socket.bytesRead || 0;
    totalNetworkTx += socket.bytesWritten || 0;
    activeSockets.delete(socket);
  });
});

// ── WebSocket signaling ────────────────────────────────────────────
const wss = new WebSocketServer({ 
  server: webServer, 
  perMessageDeflate: false,
  maxPayload: 2 * 1024 * 1024, // Fix: 2MB hard limit on WS frames
  verifyClient: (info, cb) => {
    if (!info.origin) return cb(true); // Allow non-browser clients
    const host = info.req.headers.host;
    // Strict origin check: block Cross-Site WebSocket Hijacking
    if (info.origin.includes(host)) return cb(true);
    cb(false, 403, 'Forbidden Origin');
  }
});

const ipRateLimits = new Map();

wss.on('connection', (ws, req) => {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  let peerId = null;

  ws.on('pong', () => { ws.missedPings = 0; });  // reset on pong (handled above too)

  ws.on('message', rawBuf => {
    ws.missedPings = 0;  // any message from client = connection is alive

    // ── Rate Limiter ──
    const now = Date.now();
    const limit = ipRateLimits.get(ip) || { count: 0, time: now };
    if (now - limit.time > 1000) { limit.count = 0; limit.time = now; }
    limit.count++;
    ipRateLimits.set(ip, limit);
    if (limit.count > 100) { // Limit to 100 messages per second per IP
      ws.terminate();
      return;
    }

    // Client-side ping for application-level keepalive
    if (rawBuf.length === 8 && rawBuf.toString('utf8', 0, 8) === '__ping__') { try { ws.send('__pong__'); } catch {} return; }

    const raw = rawBuf.toString();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'keep-alive') return;

    switch (msg.type) {
      case 'register': {
        if (!msg.id) break;
        // Kill stale socket first; delete BEFORE terminate so the stale
        // socket's close handler doesn't re-delete the new registration
        if (peers.has(msg.id)) {
          const stale = peers.get(msg.id);
          peers.delete(msg.id);
          try { stale.ws.terminate(); } catch {}
        }
        peerId = msg.id;
        peers.set(peerId, { ws, id: peerId, name: msg.name || 'Anonymous', avatar: msg.avatar || '👤', ip });
        ws.send(JSON.stringify({ type: 'welcome', yourId: peerId, yourIp: ip }));
        // BUG FIX: exclude registering peer from their own peer-list
        ws.send(JSON.stringify({ type: 'peer-list', peers: peerSnapshot(peerId) }));
        broadcast({ type: 'peer-joined', id: peerId, name: msg.name, avatar: msg.avatar }, peerId);
        log(`[+] ${msg.name} (${peerId}) from ${ip}  [${peers.size} online]`);
        // Send existing announcements to the newly connected peer
        ws.send(JSON.stringify({ type: 'announcements', data: announcements }));
        break;
      }

      // Relay all signaling messages verbatim
      case 'offer':
      case 'answer':
      case 'ice-candidate':
      case 'call-request':
      case 'call-accepted':
      case 'call-declined':
      case 'call-ended':
        if (msg.to && peers.has(msg.to)) sendTo(msg.to, { ...msg, from: peerId });
        break;

      case 'group-message':
        if (Array.isArray(msg.members))
          msg.members.filter(id => id !== peerId && peers.has(id)).forEach(id => sendTo(id, msg));
        break;

      // sw-direct: page sends a message via WS as fallback when WebRTC
      // data channel is unavailable (e.g. peer's tab is backgrounded).
      // Server relays it to the target peer — the peer's SW picks it up.
      case 'sw-direct':
        if (msg.to && peers.has(msg.to))
          sendTo(msg.to, { ...msg, from: peerId });
        break;

      case 'add-announcement': {
        if (!msg.text && !msg.url && !msg.files) break;
        
        // Enforce upper bounds on payloads to prevent OOM memory exhaustion
        if (msg.text && msg.text.length > 50000) break; 
        if (msg.files && msg.files.length > 200) break;
        
        const entry = {
          id: Date.now().toString() + '-' + Math.floor(Math.random() * 1000),
          type: msg.messageType || 'text',
          text: msg.text,
          url: msg.url,
          fileName: msg.fileName,
          fileSize: msg.fileSize,
          mimeType: msg.mimeType,
          folderName: msg.folderName,
          files: msg.files,
          senderId: peerId,
          senderName: peers.get(peerId)?.name || 'Anonymous',
          time: Date.now()
        };
        if (announcements.length >= 100) announcements.shift(); // Retain last 100 only
        announcements.push(entry);
        saveAnnouncements();
        broadcast({ type: 'new-announcement', data: entry });
        break;
      }
    }
  });

  ws.on('close', () => {
    // Only remove if this is still the active socket for this peer
    if (peerId && peers.has(peerId) && peers.get(peerId).ws === ws) {
      const name = peers.get(peerId).name;
      peers.delete(peerId);
      broadcast({ type: 'peer-left', id: peerId });
      log(`[-] ${name} (${peerId}) left  [${peers.size} online]`);
    }
  });

  ws.on('error', err => {
    if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE')
      console.error(`[!] WS error (${peerId || 'unregistered'}): ${err.message}`);
  });
});

// Native WS heartbeat — terminates silently-dead connections.
// Interval is 60 s (was 30 s) so that mobile browsers throttled to
// fire timers once per minute don't get their connections killed
// while the tab is in the background.
// Two consecutive missed pings (missedPings >= 2) before termination,
// giving ~120 s of tolerance — enough for any background freeze.
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.missedPings >= 2) { ws.terminate(); return; }
    ws.missedPings = (ws.missedPings || 0) + 1;
    try { ws.ping(); } catch {}
  });
}, 60000);
wss.on('connection', ws => { ws.missedPings = 0; ws.on('pong', () => { ws.missedPings = 0; }); });
wss.on('close', () => clearInterval(heartbeat));

// ══════════════════════════════════════════════════════════════════
// Built-in STUN server (RFC 5389) — works 100% offline
// Handles WebRTC Binding Requests to reveal each device's LAN IP.
// Critical for mesh WiFi and multi-router/subnet setups.
// ══════════════════════════════════════════════════════════════════
function startSTUN() {
  const sock = dgram.createSocket('udp4');

  sock.on('message', (msg, rinfo) => {
    totalNetworkRx += msg.length;
    if (msg.length < 20) return;
    const msgType = msg.readUInt16BE(0);
    if (msgType !== 0x0001) return;  // only Binding Request

    const txId    = msg.slice(8, 20);
    const ipParts = rinfo.address.split('.').map(Number);
    const port    = rinfo.port;

    // XOR with magic cookie per RFC 5389
    const xorPort = port ^ 0x2112;
    const xorIp   = Buffer.from([
      ipParts[0] ^ 0x21, ipParts[1] ^ 0x12,
      ipParts[2] ^ 0xA4, ipParts[3] ^ 0x42,
    ]);

    // XOR-MAPPED-ADDRESS attribute
    const attr = Buffer.alloc(12);
    attr.writeUInt16BE(0x0020, 0);  // XOR-MAPPED-ADDRESS
    attr.writeUInt16BE(8, 2);
    attr[4] = 0x00; attr[5] = 0x01;  // reserved + IPv4 family
    attr.writeUInt16BE(xorPort, 6);
    xorIp.copy(attr, 8);

    // Build response
    const resp = Buffer.alloc(32);
    resp.writeUInt16BE(0x0101, 0);     // Binding Response
    resp.writeUInt16BE(12, 2);          // attr length
    resp.writeUInt32BE(0x2112A442, 4);  // magic cookie
    txId.copy(resp, 8);
    attr.copy(resp, 20);

    sock.send(resp, 0, 32, rinfo.port, rinfo.address);
    totalNetworkTx += 32;
  });

  sock.on('error', err => {
    if (err.code === 'EADDRINUSE')
      console.log(`  ⚠️  STUN UDP:${STUN_PORT} in use — another STUN server may be running`);
    else
      console.warn(`  STUN error: ${err.message}`);
  });

  sock.bind(STUN_PORT, '0.0.0.0', () => log(`STUN  listening on UDP  :${STUN_PORT}`));
  return sock;
}

const stunSocket = startSTUN();

// ── Utilities ──────────────────────────────────────────────────────
function getLANIPs() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([iface, addrs]) =>
      (addrs || []).filter(a => a.family === 'IPv4' && !a.internal && !iface.toLowerCase().includes('veth') && !iface.toLowerCase().includes('docker') && !iface.toLowerCase().includes('wsl')).map(a => ({ iface, ip: a.address }))
    );
}
function log(msg) { console.log('  ' + msg); }

function isPortFree(port, host = '0.0.0.0') {
  return new Promise(resolve => {
    const tester = net.createServer();
    tester.unref();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, host);
  });
}

async function findAvailablePort(startPort, maxTries, host = '0.0.0.0') {
  for (let offset = 0; offset <= maxTries; offset++) {
    const port = startPort + offset;
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(`No free TCP port found between ${startPort} and ${startPort + maxTries}`);
}

// ── Startup banner ─────────────────────────────────────────────────
webServer.on('listening', () => {
  const ips     = getLANIPs();
  const proto   = HAS_CERTS ? 'https' : 'http';
  const wsProto = HAS_CERTS ? 'wss'   : 'ws';
  const usingFallbackPort = ACTIVE_PORT !== PREFERRED_PORT;

  console.log('\n');
  console.log('  ╔══════════════════════════════════════════════════════════╗');
  console.log('  ║         LanLink v9 — Offline LAN Messenger              ║');
  console.log(`  ║  ${HAS_CERTS ? '🔒 HTTPS+WSS — calls ENABLED on all devices!   ' : '🌐 HTTP+WS  — text & files OK; add certs for calls'}  ║`);
  console.log('  ╚══════════════════════════════════════════════════════════╝\n');
  console.log(`  TCP app port: ${ACTIVE_PORT}${usingFallbackPort ? `  (preferred ${PREFERRED_PORT} was busy)` : ''}`);
  console.log(`  UDP STUN port: ${STUN_PORT}\n`);

  if (ips.length === 0) {
    console.log('  ⚠️  No network interfaces detected — check your connection.\n');
    console.log(`  Localhost only:  ${proto}://localhost:${ACTIVE_PORT}\n`);
  } else {
    console.log('  ┌─ OPEN ON EVERY DEVICE ───────────────────────────────────┐');
    ips.forEach(({ iface, ip }) => {
      console.log(`  │  [${iface}]  ${ip}`);
      console.log(`  │   🌐  ${proto}://${ip}:${ACTIVE_PORT}`);
      console.log(`  │   🔌  ${wsProto}://${ip}:${ACTIVE_PORT}  ← server address field`);
    });
    console.log('  └──────────────────────────────────────────────────────────┘\n');
  }

  console.log('  ── FIREWALL (most common issue) ───────────────────────────');
  console.log('  Windows — Administrator PowerShell:');
  console.log(`    netsh advfirewall firewall add rule name="LanLink-App"  dir=in action=allow protocol=tcp localport=${ACTIVE_PORT}`);
  console.log(`    netsh advfirewall firewall add rule name="LanLink-STUN" dir=in action=allow protocol=udp localport=${STUN_PORT}`);
  console.log('');
  console.log(`  macOS:  System Settings → Firewall → allow Node`);
  console.log(`  Linux:  sudo ufw allow ${ACTIVE_PORT}/tcp && sudo ufw allow ${STUN_PORT}/udp\n`);

  if (!HAS_CERTS) {
    console.log('  ⚠️  Running in HTTP mode (Voice/Video calls disabled).');
    console.log('      To enable calls, run: npm install node-forge\n');
  }

  console.log(`  📁  Uploads: ${UPLOADS_DIR}`);
  console.log('  Ctrl+C to stop.\n');
});

wss.on('listening', () => log(`WS    listening on  ${HAS_CERTS ? 'wss' : 'ws'}://0.0.0.0:${ACTIVE_PORT}`));

const gracefulShutdown = () => {
  console.log('\n  👋 Shutting down…');
  clearInterval(heartbeat);
  broadcast({ type: 'server-shutdown' });
  
  try { stunSocket.close(); } catch {}
  try { wss.close(); } catch {}
  
  for (const socket of activeSockets) {
    try { socket.destroy(); } catch {}
  }
  activeSockets.clear();
  try { webServer.close(); } catch {}

  setTimeout(() => process.exit(0), 300);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

process.on('uncaughtException', err => console.error('  [UNCAUGHT]', err.message, '\n', err.stack));

(async () => {
  try {
    ACTIVE_PORT = await findAvailablePort(PREFERRED_PORT, MAX_PORT_TRIES);
    webServer.on('error', err => {
      console.error('\n❌  Server error:', err.message);
      process.exit(1);
    });
    webServer.listen(ACTIVE_PORT, '0.0.0.0');
  } catch (err) {
    console.error(`\n❌  ${err.message}\n`);
    process.exit(1);
  }
})();
