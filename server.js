#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  LanLink Server v8 — 100% Offline LAN Messenger             ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  Ports (open ALL in firewall):                              ║
 * ║    8080  — HTTP  (app page + file hosting)                  ║
 * ║    8765  — WS    (WebSocket signaling)                      ║
 * ║    3478  — STUN  (offline WebRTC peer discovery, UDP)       ║
 * ║                                                              ║
 * ║  HTTPS mode (enables mic/camera on remote devices):         ║
 * ║    Place key.pem + cert.pem next to server.js              ║
 * ║    → Restarts on port 8443 (HTTP+WS share same port)       ║
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
const { WebSocketServer, WebSocket } = require('ws');

// ── Configuration ──────────────────────────────────────────────────
const KEY_PATH  = path.join(__dirname, 'key.pem');
const CERT_PATH = path.join(__dirname, 'cert.pem');
const HAS_CERTS = fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH);

const HTTP_PORT = HAS_CERTS ? 8443 : 8080;
const WS_PORT   = HAS_CERTS ? HTTP_PORT : 8765;
const STUN_PORT = 3478;

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;  // 500 MB
const UPLOADS_DIR      = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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

// ── Peer registry ──────────────────────────────────────────────────
const peers = new Map();  // peerId → { ws, id, name, avatar, ip }

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
    .map(({ id, name, avatar, ip }) => ({ id, name, avatar, ip }));
}

// ── HTTP handler ───────────────────────────────────────────────────
function handleHTTP(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'x-filename, content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let pathname, searchParams;
  try {
    const u  = new URL(req.url, 'http://x');
    pathname = u.pathname;
    searchParams = u.searchParams;
  } catch { res.writeHead(400); res.end('Bad request'); return; }

  // ── Serve app ──────────────────────────────────────────────────
  if (pathname === '/' || pathname === '/index.html') {
    const f = path.join(__dirname, 'app.html');
    if (!fs.existsSync(f)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`app.html not found in: ${__dirname}\nMake sure app.html and server.js are in the same folder.`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(res);
    return;
  }

  // ── Serve Service Worker — must be at root scope ───────────────
  // IMPORTANT headers:
  //   Service-Worker-Allowed: /  → allows SW to control all paths
  //   Cache-Control: no-store    → browser must always fetch fresh SW
  //   Content-Type: application/javascript  → required by spec
  if (pathname === '/sw.js') {
    const f = path.join(__dirname, 'sw.js');
    if (!fs.existsSync(f)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('sw.js not found — make sure sw.js is in the same folder as server.js');
      return;
    }
    res.writeHead(200, {
      'Content-Type'           : 'application/javascript; charset=utf-8',
      'Service-Worker-Allowed' : '/',
      'Cache-Control'          : 'no-store, no-cache',
    });
    fs.createReadStream(f).pipe(res);
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
    const hostHeader = req.headers.host || `localhost:${HTTP_PORT}`;
    const hostIP     = hostHeader.split(':')[0];
    const wsProto    = HAS_CERTS ? 'wss'   : 'ws';
    const httpProto  = HAS_CERTS ? 'https' : 'http';
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      wsUrl    : `${wsProto}://${hostIP}:${WS_PORT}`,
      httpBase : `${httpProto}://${hostIP}:${HTTP_PORT}`,
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

  // ── /upload — file upload ──────────────────────────────────────
  if (pathname === '/upload' && req.method === 'POST') {
    const rawName  = req.headers['x-filename']
      ? decodeURIComponent(req.headers['x-filename'])
      : 'file.bin';
    const safeName = `${Date.now()}_${rawName.replace(/[^a-zA-Z0-9._\-]/g, '_').substring(0, 100)}`;
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
      const host  = req.headers.host || `localhost:${HTTP_PORT}`;
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
    const filePath   = path.join(__dirname, normalized);
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
webServer.listen(HTTP_PORT, '0.0.0.0');
webServer.on('error', err => {
  if (err.code === 'EADDRINUSE')
    console.error(`\n❌  Port ${HTTP_PORT} in use. Stop the other process or change the port.\n`);
  else
    console.error('\n❌  Server error:', err.message);
  process.exit(1);
});

// ── WebSocket signaling ────────────────────────────────────────────
let wss;
if (HAS_CERTS) {
  wss = new WebSocketServer({ server: webServer });
} else {
  wss = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0' });
}

wss.on('connection', (ws, req) => {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  let peerId = null;

  ws.on('pong', () => { ws.missedPings = 0; });  // reset on pong (handled above too)

  ws.on('message', rawBuf => {
    const raw = rawBuf.toString();
    ws.missedPings = 0;  // any message from client = connection is alive

    // Client-side ping for application-level keepalive
    if (raw === '__ping__') { try { ws.send('__pong__'); } catch {} return; }

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
        broadcast({ type: 'peer-joined', id: peerId, name: msg.name, avatar: msg.avatar, ip }, peerId);
        log(`[+] ${msg.name} (${peerId}) from ${ip}  [${peers.size} online]`);
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
      (addrs || []).filter(a => a.family === 'IPv4' && !a.internal).map(a => ({ iface, ip: a.address }))
    );
}
function log(msg) { console.log('  ' + msg); }

// ── Startup banner ─────────────────────────────────────────────────
webServer.on('listening', () => {
  const ips     = getLANIPs();
  const proto   = HAS_CERTS ? 'https' : 'http';
  const wsProto = HAS_CERTS ? 'wss'   : 'ws';

  console.log('\n');
  console.log('  ╔══════════════════════════════════════════════════════════╗');
  console.log('  ║         LanLink v9 — Offline LAN Messenger              ║');
  console.log(`  ║  ${HAS_CERTS ? '🔒 HTTPS+WSS — calls ENABLED on all devices!   ' : '🌐 HTTP+WS  — text & files OK; add certs for calls'}  ║`);
  console.log('  ╚══════════════════════════════════════════════════════════╝\n');

  if (ips.length === 0) {
    console.log('  ⚠️  No network interfaces detected — check your connection.\n');
    console.log(`  Localhost only:  ${proto}://localhost:${HTTP_PORT}\n`);
  } else {
    console.log('  ┌─ OPEN ON EVERY DEVICE ───────────────────────────────────┐');
    ips.forEach(({ iface, ip }) => {
      console.log(`  │  [${iface}]  ${ip}`);
      console.log(`  │   🌐  ${proto}://${ip}:${HTTP_PORT}`);
      if (!HAS_CERTS) console.log(`  │   🔌  ${wsProto}://${ip}:${WS_PORT}  ← server address field`);
    });
    console.log('  └──────────────────────────────────────────────────────────┘\n');
  }

  console.log('  ── FIREWALL (most common issue) ───────────────────────────');
  console.log('  Windows — Administrator PowerShell:');
  console.log(`    netsh advfirewall firewall add rule name="LanLink-HTTP" dir=in action=allow protocol=tcp localport=${HTTP_PORT}`);
  if (!HAS_CERTS) console.log(`    netsh advfirewall firewall add rule name="LanLink-WS"   dir=in action=allow protocol=tcp localport=${WS_PORT}`);
  console.log(`    netsh advfirewall firewall add rule name="LanLink-STUN" dir=in action=allow protocol=udp localport=${STUN_PORT}`);
  console.log('');
  console.log(`  macOS:  System Settings → Firewall → allow Node`);
  console.log(`  Linux:  sudo ufw allow ${HTTP_PORT}/tcp && sudo ufw allow ${WS_PORT}/tcp && sudo ufw allow ${STUN_PORT}/udp\n`);

  if (!HAS_CERTS) {
    console.log('  ── ENABLE CALLS (one-time HTTPS setup) ────────────────────');
    console.log('  openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=LanLink"');
    console.log(`  Then restart and open: https://YOUR_IP:8443\n`);
  }

  console.log(`  📁  Uploads: ${UPLOADS_DIR}`);
  console.log('  Ctrl+C to stop.\n');
});

wss.on('listening', () => { if (!HAS_CERTS) log(`WS    listening on  ws://0.0.0.0:${WS_PORT}`); });

process.on('SIGINT', () => {
  clearInterval(heartbeat);
  try { stunSocket.close(); } catch {}
  console.log('\n  👋 Shutting down…');
  broadcast({ type: 'server-shutdown' });
  setTimeout(() => process.exit(0), 300);
});

process.on('uncaughtException', err => console.error('  [UNCAUGHT]', err.message, '\n', err.stack));
