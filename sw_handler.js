// ── Service Worker — background connection + notifications ────────────
// The SW maintains a parallel WebSocket when the page is backgrounded,
// buffers incoming messages in IndexedDB, and shows system notifications.
// On wake, the page drains the SW inbox so nothing is missed.

let _swRegistration = null;

async function registerSW() {
  if (!('serviceWorker' in navigator)) {
    console.log('[App] ServiceWorker not supported in this browser');
    return;
  }
  // SW requires HTTPS (or localhost). On plain HTTP it won't register
  // but the app still works — just without background notifications.
  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    console.log('[App] SW skipped — requires HTTPS');
    return;
  }
  try {
    _swRegistration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    console.log('[App] SW registered, scope:', _swRegistration.scope);

    // Listen for messages from the SW
    navigator.serviceWorker.addEventListener('message', onSWMessage);

    // Handle notification-click → open-chat
    if (location.search) {
      const params = new URLSearchParams(location.search);
      const chatPid = params.get('chat');
      if (chatPid && App.appVisible) {
        // Wait for app to fully load then open the chat
        setTimeout(() => { if (App.conversations.has(chatPid)) openChat(chatPid); }, 500);
      }
    }
  } catch(e) {
    console.warn('[App] SW registration failed:', e.message);
  }
}

// Configure the SW with our identity + server URL after joining
function swConfigure() {
  if (!navigator.serviceWorker?.controller) return;
  navigator.serviceWorker.controller.postMessage({
    type      : 'sw-config',
    serverUrl : App.serverUrl,
    peerId    : App.me.id,
    peerName  : App.me.name,
    peerAvatar: App.me.avatar,
  });
}

// Tell SW to stop its background WS (called on disconnect/reset)
function swDisconnect() {
  if (!navigator.serviceWorker?.controller) return;
  navigator.serviceWorker.controller.postMessage({ type: 'sw-disconnect' });
}

// Drain the SW inbox when the tab becomes visible
async function swDrain() {
  if (!navigator.serviceWorker?.controller) return;
  navigator.serviceWorker.controller.postMessage({ type: 'sw-drain' });
}

// Handle messages coming from the SW
function onSWMessage(e) {
  const data = e.data;
  if (!data || !data.type) return;

  if (data.type === 'sw-ready') {
    console.log('[App] SW acknowledged config');
  }

  else if (data.type === 'sw-drain-done') {
    if (data.count > 0) {
      console.log(`[App] Drained ${data.count} buffered SW messages`);
      flushPendingChatRefresh();
      if (App.currentChat && document.visibilityState === 'visible') {
        renderAllMsgs(App.currentChat);
        scrollBottom();
      }
      renderPeerList();
    }
  }

  else if (data.type === 'sw-message') {
    // SW received a message while we were backgrounded/asleep
    // The SW already wrote it to IndexedDB conversations store.
    // We just need to update in-memory state and UI.
    if (data.gid) {
      // Group message
      (async () => {
        let payload = data.payload;
        let dec = payload;
        if(payload.e2ee) dec = await decryptGroupMsg(data.gid, payload);
        if(!dec) return;
        dec.time = payload.time; dec.direction = payload.direction;
        const gid = data.gid; const g = App.groups.get(gid); if (!g) return;
        if (!App.conversations.has(gid)) App.conversations.set(gid, []);
        const existing = App.conversations.get(gid);
        if (!existing.some(m => m.id === dec.id)) existing.push({ ...dec });
        if (App.currentChat === gid && document.visibilityState === 'visible') { renderAllMsgs(gid); scrollBottom(); } 
        else { queueChatRefresh(gid); incUnread(gid); renderPeerList(); }
      })();
    } else if (data.pid) {
      // P2P direct message (via SW relay fallback)
      (async () => {
        let payload = data.payload;
        let dec = payload;
        if(payload.e2ee) dec = await decryptMsg(data.pid, payload);
        if(!dec) return;
        dec.from = payload.from || data.pid; dec.time = payload.time; dec.direction = payload.direction;
        if(dec.type === 'group-sync') { handleDataMsg(dec.from, dec); return; }
        const pid = data.pid;
        if (!App.conversations.has(pid)) App.conversations.set(pid, []);
        const existing = App.conversations.get(pid);
        if (!existing.some(m => m.id === dec.id)) existing.push({ ...dec });
        if (App.currentChat === pid && document.visibilityState === 'visible') { renderAllMsgs(pid); scrollBottom(); }
        else { queueChatRefresh(pid); incUnread(pid); renderPeerList(); }
      })();
    }
  }

  else if (data.type === 'sw-signal') {
    // SW forwarded a WS signal (peer-joined, call-request, etc.)
    // Feed it into our normal signal handler
    if (data.signal) handleSignal(data.signal).catch(e => console.warn('[App] SW signal error:', e));
  }

  else if (data.type === 'sw-open-chat') {
    // User tapped a notification → open the specific chat
    const pid = data.pid;
    if (!pid) return;
    if (!App.appVisible) {
      // App not yet fully loaded — wait for it
      const wait = setInterval(() => {
        if (App.appVisible) { clearInterval(wait); openChat(pid); }
      }, 200);
      setTimeout(() => clearInterval(wait), 5000); // give up after 5s
    } else {
      openChat(pid);
      if (isMobile()) {
        document.getElementById('sidebar').classList.add('hidden');
        document.getElementById('sidebar-backdrop').classList.remove('show');
      }
    }
  }
}

// ── Improved showPush: uses SW notification when page is backgrounded ──
// The old implementation used new Notification() directly — that only
// works when the page is visible. SW showNotification() works always.
function showPush(title, body, pid) {
  // If SW is active, it handles notifications — don't duplicate
  if (navigator.serviceWorker?.controller) return;
  // Fallback: direct Notification API (only works if page is visible/active)
  if (window.Notification && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    try {
      const n = new Notification(title, { body, icon: '/icon-192.png' });
      if (pid) n.onclick = () => { window.focus(); openChat(pid); };
    } catch {}
  }
}

// ── Drain SW inbox + reconnect on tab visibility change ────────────────
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    flushConvSaves();
    return;
  }
  if (!document.hidden) {
    // Tab became visible
    if (App.appVisible) {
      flushPendingChatRefresh();
      // Reconnect WS if it died while backgrounded
      if (!App.ws || App.ws.readyState === WebSocket.CLOSED || App.ws.readyState === WebSocket.CLOSING) {
        App.ws = null; connectWS();
      }
      // Drain any messages the SW buffered
      swDrain();
      // Tell SW we're in the foreground (it can step back its own WS)
      navigator.serviceWorker?.controller?.postMessage({ type: 'sw-foreground' });
      setTimeout(flushPendingChatRefresh,150);
    }
  }
});
window.addEventListener('beforeunload', flushConvSaves);
function connectWS(){
  if(App.ws&&(App.ws.readyState===WebSocket.CONNECTING||App.ws.readyState===WebSocket.OPEN))return;
  clearTimeout(App.reconnectTimer);
  let ws;
  try{ws=new WebSocket(App.serverUrl);}catch{
    if(!App.appVisible){
      const btn = document.querySelector('button[onclick="joinNetwork()"]');
      if(btn){ btn.textContent='Join Network →'; btn.disabled=false; }
      toast('❌ Invalid server address');
    } else {
      scheduleReconnect();
    }
    return;
  }
  App.ws=ws;
  ws.onopen=()=>{
    App.reconnectDelay=RECONNECT_BASE_MS;
    App.wsLatencyMs=null;updateWsPingIndicator(null);
    wsSend({type:'register',id:App.me.id,name:App.me.name,avatar:App.me.avatar,pubKey:E2E.pubKey64});
    setAppConn(true);hideBanner();startPing();
    if(!App.appVisible){showApp();App.appVisible=true;}
    // Tell SW our current identity so it can maintain a parallel connection
    swConfigure();
    // Drain any messages SW buffered while we were disconnected
    swDrain();
  };
  ws.onmessage=e=>{
    const raw=typeof e.data==='string'?e.data:e.data.toString();
    if(raw==='__pong__'){resetPong(true);return;}
    resetPong(false);
    try{handleSignal(JSON.parse(raw));}catch(err){console.error('Signal:',err);}
  };
  ws.onerror=()=>{};
  ws.onclose=()=>{
    stopPing();App.wsLatencyMs=null;updateWsPingIndicator(null);setAppConn(false);
    if(App.appVisible){
      showBanner();scheduleReconnect();
    } else {
      App.ws=null;
      const btn = document.querySelector('button[onclick="joinNetwork()"]');
      if(btn){ btn.textContent='Join Network →'; btn.disabled=false; }
      toast('❌ Connection failed. Check server address.');
      setSetupStatus('error','Connection failed');
    }
  };
}
function scheduleReconnect(){
  clearTimeout(App.reconnectTimer);
  if(App.ws?.readyState===WebSocket.OPEN)return;
  App.reconnectTimer=setTimeout(()=>{App.ws=null;connectWS();},App.reconnectDelay);
  App.reconnectDelay=Math.min(App.reconnectDelay*1.5,RECONNECT_MAX_MS);
}
function startPing(){
  stopPing();
  const sendPing=()=>{
    if(App.ws?.readyState!==WebSocket.OPEN)return;
    App.lastPingSentAt=performance.now();
    App.ws.send('__ping__');
    App.pongTimer=setTimeout(()=>{try{App.ws.close();}catch{}App.ws=null;scheduleReconnect();},PONG_TIMEOUT_MS);
  };
  sendPing();
  App.pingTimer=setInterval(sendPing,CLIENT_PING_MS);
}
function stopPing(){clearInterval(App.pingTimer);clearTimeout(App.pongTimer);}
function resetPong(fromPong){
  clearTimeout(App.pongTimer);
  if(fromPong&&App.lastPingSentAt){
    App.wsLatencyMs=Math.max(0,performance.now()-App.lastPingSentAt);
    updateWsPingIndicator(App.wsLatencyMs);
  }
}
function wsSend(obj){if(App.ws?.readyState===WebSocket.OPEN)App.ws.send(JSON.stringify(obj));}
function showBanner(){const b=document.getElementById('reconn-banner');if(b)b.style.display='block';}
function hideBanner(){const b=document.getElementById('reconn-banner');if(b)b.style.display='none';}

