// ═══════════════════════════════════════════════════════════════════
//  LanLink Service Worker v1
//
//  Responsibilities:
//    1. Maintain a WebSocket connection to the LanLink server even
//       when the page tab is backgrounded or the screen is locked.
//    2. When a message arrives and the page is not visible, show a
//       system notification via self.registration.showNotification().
//    3. Buffer received messages in IndexedDB (sw_inbox store) so
//       the page can drain them when it wakes up.
//    4. On notification click, focus or open the LanLink tab and
//       pass along which chat to open.
//    5. Post received messages to any live page clients immediately
//       if they are visible and accepting.
//
//  The SW does NOT handle WebRTC — that stays in the page.
//  The SW only needs to handle incoming text/attachment messages
//  and call-request signals (so it can show "Incoming call" notif).
//
//  Communication with the page:
//    Page → SW:   postMessage({ type:'sw-config', ... })
//                 postMessage({ type:'sw-drain' })       ← page woke up
//                 postMessage({ type:'sw-disconnect' })  ← user left
//    SW   → Page: postMessage({ type:'sw-message', msg, pid, gid })
//                 postMessage({ type:'sw-call', data })
// ═══════════════════════════════════════════════════════════════════

'use strict';

const SW_VERSION   = 1;
const DB_NAME      = 'LanLinkDB';
const DB_VERSION   = 4;      // bumped: adds sw_inbox store
const INBOX_STORE  = 'sw_inbox';
const CONV_STORE   = 'conversations';
const PING_MS      = 25000;
const PONG_TIMEOUT = 25000;

// ── State (lives only while SW is running — may be killed by browser) ──
let _ws        = null;
let _cfg       = null;   // { serverUrl, peerId, peerName, peerAvatar }
let _pingTimer = null;
let _pongTimer = null;
let _reconTimer= null;
let _reconDelay= 3000;

// ── IndexedDB helper ────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onerror = () => reject(r.error);
    r.onsuccess = e => resolve(e.target.result);
    r.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CONV_STORE))
        db.createObjectStore(CONV_STORE);
      if (!db.objectStoreNames.contains(INBOX_STORE))
        db.createObjectStore(INBOX_STORE, { keyPath: 'id', autoIncrement: true });
    };
  });
}

async function dbPut(storeName, value, key) {
  try {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction(storeName, 'readwrite');
      const req = key !== undefined
        ? tx.objectStore(storeName).put(value, key)
        : tx.objectStore(storeName).put(value);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
  } catch(e) { console.warn('[SW] dbPut error:', e); }
}

async function dbGetAll(storeName) {
  try {
    const db = await openDB();
    return new Promise((res, rej) => {
      const req = db.transaction(storeName,'readonly').objectStore(storeName).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
  } catch(e) { console.warn('[SW] dbGetAll error:', e); return []; }
}

async function dbClear(storeName) {
  try {
    const db = await openDB();
    return new Promise((res, rej) => {
      const req = db.transaction(storeName,'readwrite').objectStore(storeName).clear();
      req.onsuccess = () => res();
      req.onerror   = () => rej(req.error);
    });
  } catch(e) { console.warn('[SW] dbClear error:', e); }
}

async function dbDeleteKey(storeName, key) {
  try {
    const db = await openDB();
    return new Promise((res, rej) => {
      const req = db.transaction(storeName,'readwrite').objectStore(storeName).delete(key);
      req.onsuccess = () => res();
      req.onerror   = () => rej(req.error);
    });
  } catch(e) { console.warn('[SW] dbDelete error:', e); }
}

// Append a message to the peer's conversation in IndexedDB
// (mirrors what the page does — so the page sees it on wake)
async function appendConversation(pid, msg) {
  try {
    const db  = await openDB();
    const existing = await new Promise((res, rej) => {
      const req = db.transaction(CONV_STORE,'readonly').objectStore(CONV_STORE).get(pid);
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
    // Deduplicate by id — avoid double-write if page woke up quickly
    if (msg.id && existing.some(m => m.id === msg.id)) return;
    const updated = [...existing, msg].slice(-300);
    await dbPut(CONV_STORE, updated, pid);
  } catch(e) { console.warn('[SW] appendConversation error:', e); }
}

// ── Notify all live page clients ────────────────────────────────────────
async function postToClients(payload) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(c => c.postMessage(payload));
}

// ── Determine if any page client is currently visible ───────────────────
async function hasVisibleClient() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return clients.some(c => c.visibilityState === 'visible');
}

// ── Show system notification ─────────────────────────────────────────────
async function showNotification(title, body, tag, data) {
  try {
    // Don't show if the page is already in the foreground
    if (await hasVisibleClient()) return;
    const perm = await self.registration.showNotification(title, {
      body,
      tag,              // collapses multiple notifs for same chat
      data,             // passed to notificationclick handler
      icon  : '/icon-192.png',
      badge : '/icon-96.png',
      vibrate: [200, 100, 200],
      requireInteraction: false,
      silent : false,
    });
    return perm;
  } catch(e) {
    console.warn('[SW] showNotification failed:', e);
  }
}

// ── WebSocket management ─────────────────────────────────────────────────
function stopWS() {
  clearInterval(_pingTimer);
  clearTimeout(_pongTimer);
  clearTimeout(_reconTimer);
  if (_ws) {
    try { _ws.close(); } catch {}
    _ws = null;
  }
}

function startWS() {
  if (!_cfg?.serverUrl || !_cfg?.peerId) return;
  if (_ws && (_ws.readyState === WebSocket.CONNECTING || _ws.readyState === WebSocket.OPEN)) return;

  clearTimeout(_reconTimer);

  let ws;
  try { ws = new WebSocket(_cfg.serverUrl); }
  catch(e) { scheduleReconnect(); return; }
  _ws = ws;

  ws.onopen = () => {
    _reconDelay = 3000;
    // Register with the same peer ID — server will kill any stale socket
    ws.send(JSON.stringify({
      type  : 'register',
      id    : _cfg.peerId,
      name  : _cfg.peerName  || 'Unknown',
      avatar: _cfg.peerAvatar || '👤',
    }));
    startPing();
    console.log('[SW] WS connected');
  };

  ws.onmessage = async e => {
    resetPong();
    const raw = typeof e.data === 'string' ? e.data : e.data.toString();
    if (raw === '__pong__') return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    await handleServerMsg(msg);
  };

  ws.onerror = () => {};
  ws.onclose = () => {
    stopPing();
    console.log('[SW] WS closed, reconnecting…');
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(_reconTimer);
  _reconTimer = setTimeout(() => { _ws = null; startWS(); }, _reconDelay);
  _reconDelay = Math.min(_reconDelay * 1.5, 60000);
}

function startPing() {
  stopPing();
  _pingTimer = setInterval(() => {
    if (_ws?.readyState !== WebSocket.OPEN) return;
    _ws.send('__ping__');
    _pongTimer = setTimeout(() => {
      console.warn('[SW] pong timeout, reconnecting');
      try { _ws.close(); } catch {}
      _ws = null;
      scheduleReconnect();
    }, PONG_TIMEOUT);
  }, PING_MS);
}
function stopPing()  { clearInterval(_pingTimer); clearTimeout(_pongTimer); }
function resetPong() { clearTimeout(_pongTimer); }

// ── Handle incoming server signal ────────────────────────────────────────
async function handleServerMsg(msg) {
  // Signals we don't need to handle in SW
  if (['welcome','peer-list','peer-joined','peer-left',
       'offer','answer','ice-candidate','server-shutdown'].includes(msg.type)) {
    // Forward to page so WebRTC state stays current when page wakes
    await postToClients({ type: 'sw-signal', signal: msg });
    return;
  }

  if (msg.type === 'call-request') {
    await handleIncomingCall(msg);
    return;
  }

  if (msg.type === 'call-declined' || msg.type === 'call-ended') {
    await postToClients({ type: 'sw-signal', signal: msg });
    return;
  }

  if (msg.type === 'call-accepted') {
    await postToClients({ type: 'sw-signal', signal: msg });
    return;
  }

  // P2P signaling messages that contain a data-channel message
  // We can't open WebRTC in SW, so we just forward to page
  if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice-candidate') {
    await postToClients({ type: 'sw-signal', signal: msg });
    return;
  }

  // Group messages
  if (msg.type === 'group-message') {
    await handleGroupMessage(msg);
    return;
  }

  // Direct text/attachment messages via WS relay (sw-direct)
  // These come when the sender routes through the server because
  // the WebRTC data channel couldn't be established
  if (msg.type === 'sw-direct') {
    await handleDirectMessage(msg);
    return;
  }
}

async function handleIncomingCall(data) {
  const callType = data.callType || 'audio';
  const callerName = data.callerName || 'Someone';

  // Store in inbox so page can process when it wakes
  const inboxEntry = {
    swType    : 'call-request',
    data,
    receivedAt: Date.now(),
  };
  await dbPut(INBOX_STORE, inboxEntry);

  // Post to visible page client if available
  await postToClients({ type: 'sw-signal', signal: { type: 'call-request', ...data } });

  // Show notification
  await showNotification(
    `📞 Incoming ${callType === 'video' ? 'Video' : 'Voice'} Call`,
    `${callerName} is calling you`,
    'call-' + data.from,
    { action: 'call', from: data.from, callerName, callType }
  );
}

async function handleGroupMessage(msg) {
  const payload = msg.payload;
  if (!payload || payload.type === 'group-sync') {
    // Forward group-sync to page
    await postToClients({ type: 'sw-signal', signal: msg });
    return;
  }

  const gid  = msg.gid;
  const from = payload.from;

  if (payload.type === 'text' || payload.type === 'attachment') {
    const msgObj = {
      ...payload,
      time     : new Date(payload.time || Date.now()),
      direction: 'in',
    };

    // Save to conversations store so page sees it on wake
    await appendConversation(gid, msgObj);

    // Put in inbox for the page to process (unread count, render, etc.)
    const inboxEntry = {
      swType    : 'group-message',
      gid,
      payload   : msgObj,
      senderName: payload.senderName || from,
      receivedAt: Date.now(),
    };
    await dbPut(INBOX_STORE, inboxEntry);

    // Post to live clients immediately
    await postToClients({ type: 'sw-message', gid, payload: msgObj });

    // Show notification if page is in background
    const title = `[${payload.groupName || 'Group'}] ${payload.senderName || from}`;
    const body  = payload.type === 'text'
      ? (payload.text || '').substring(0, 100)
      : `📎 ${payload.fileName || 'file'}`;
    await showNotification(title, body, 'group-' + gid, {
      action: 'open-chat',
      pid   : gid,
    });
  }
}

async function handleDirectMessage(msg) {
  // This path is for messages that come through WS relay
  // (fallback when WebRTC can't connect)
  const pid     = msg.from;
  const payload = msg.payload;
  if (!payload) return;

  const msgObj = {
    ...payload,
    from     : pid,
    time     : new Date(payload.time || Date.now()),
    direction: 'in',
  };

  await appendConversation(pid, msgObj);

  const inboxEntry = {
    swType    : 'direct-message',
    pid,
    payload   : msgObj,
    senderName: msg.senderName || pid,
    receivedAt: Date.now(),
  };
  await dbPut(INBOX_STORE, inboxEntry);
  await postToClients({ type: 'sw-message', pid, payload: msgObj });

  const title = msg.senderName || 'New message';
  const body  = payload.type === 'text'
    ? (payload.text || '').substring(0, 100)
    : `📎 ${payload.fileName || 'file'}`;
  await showNotification(title, body, 'peer-' + pid, {
    action: 'open-chat',
    pid,
  });
}

// ── Service Worker lifecycle ─────────────────────────────────────────────
self.addEventListener('install', () => {
  console.log('[SW] Installing v' + SW_VERSION);
  self.skipWaiting();   // Activate immediately, don't wait for old SW to die
});

self.addEventListener('activate', e => {
  console.log('[SW] Activated v' + SW_VERSION);
  e.waitUntil(self.clients.claim()); // Take control of all open tabs immediately
});

// ── Message from page ────────────────────────────────────────────────────
self.addEventListener('message', async e => {
  const data = e.data;
  if (!data || !data.type) return;

  if (data.type === 'sw-config') {
    // Page is providing connection config (called after joinNetwork)
    _cfg = {
      serverUrl : data.serverUrl,
      peerId    : data.peerId,
      peerName  : data.peerName,
      peerAvatar: data.peerAvatar,
    };
    console.log('[SW] Config received, starting WS for', _cfg.peerId);
    // Stop any existing connection and start fresh with new config
    stopWS();
    startWS();
    e.source?.postMessage({ type: 'sw-ready' });
  }

  else if (data.type === 'sw-drain') {
    // Page woke up — send all buffered inbox items then clear them
    const items = await dbGetAll(INBOX_STORE);
    if (items.length > 0) {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.length > 0) {
        const c = clients[0]; // send to the requesting client
        items.forEach(item => {
          if (item.swType === 'group-message') {
            c.postMessage({ type: 'sw-message', gid: item.gid, payload: item.payload });
          } else if (item.swType === 'direct-message') {
            c.postMessage({ type: 'sw-message', pid: item.pid, payload: item.payload });
          } else if (item.swType === 'call-request') {
            c.postMessage({ type: 'sw-signal', signal: { type: 'call-request', ...item.data } });
          }
        });
        await dbClear(INBOX_STORE);
      }
    }
    e.source?.postMessage({ type: 'sw-drain-done', count: items.length });
  }

  else if (data.type === 'sw-disconnect') {
    // User left the network — stop the background WS
    console.log('[SW] Disconnect requested');
    stopWS();
    _cfg = null;
  }

  else if (data.type === 'sw-foreground') {
    // Page became visible — if WS is dead, page will reconnect itself
    // SW can safely close its own WS to avoid competing registrations
    // We keep SW WS alive as a backup but it won't fight the page
  }
});

// ── Notification click ───────────────────────────────────────────────────
self.addEventListener('notificationclick', async e => {
  e.notification.close();

  const data      = e.notification.data || {};
  const action    = data.action;
  const targetPid = data.pid || data.from;

  e.waitUntil((async () => {
    const clients = await self.clients.matchAll({
      type             : 'window',
      includeUncontrolled: true,
    });

    // Try to find an existing LanLink tab
    const existing = clients.find(c => {
      try { return new URL(c.url).pathname === '/'; } catch { return false; }
    });

    if (existing) {
      await existing.focus();
      if (targetPid) {
        existing.postMessage({ type: 'sw-open-chat', pid: targetPid });
      }
      if (action === 'call') {
        existing.postMessage({ type: 'sw-signal', signal: {
          type       : 'call-request',
          ...data,
        }});
      }
    } else {
      // Open a new tab
      const url = targetPid
        ? `/?chat=${encodeURIComponent(targetPid)}`
        : '/';
      const newClient = await self.clients.openWindow(url);
      // postMessage after a short delay so the page has time to boot
      if (newClient && targetPid) {
        setTimeout(() => {
          newClient.postMessage({ type: 'sw-open-chat', pid: targetPid });
        }, 2000);
      }
    }
  })());
});

// ── Notification close ───────────────────────────────────────────────────
self.addEventListener('notificationclose', () => {
  // Nothing special needed
});

// ── Fetch — pass through (no caching, LanLink is a live app) ─────────────
self.addEventListener('fetch', e => {
  // Let all fetches pass through to the network normally
  // SW is not a cache layer — it's a background connection manager
  e.respondWith(fetch(e.request));
});
