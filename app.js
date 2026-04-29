'use strict';
// ═══════════════════════════════════════════════════════════════════
//  LanLink v9 — Final
//  P2P: text, files, voice calls, video calls (1-to-1)
//  Groups: text + files only — no voice/video
// ═══════════════════════════════════════════════════════════════════

// ── ICE ──────────────────────────────────────────────────────────────
let ICE_CONFIG = { iceServers:[], iceTransportPolicy:'all', iceCandidatePoolSize:4 };
function applyICEConfig(stunUrl) {
  ICE_CONFIG = { iceServers:stunUrl?[{urls:stunUrl}]:[], iceTransportPolicy:'all', iceCandidatePoolSize:4 };
}

// ── Constants ─────────────────────────────────────────────────────────
const CLIENT_PING_MS    = 25000;   // send __ping__ every 25s
const PONG_TIMEOUT_MS   = 25000;   // wait 25s for pong before forcing reconnect
                                    // (was 12s — too aggressive on slow WiFi/mobile wake)
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS  = 30000;
const DB_NAME           = 'LanLinkDB';
const DB_VERSION        = 4;
const PROFILE_KEY       = 'lanlink_v9_profile';
const PEERS_CACHE_KEY   = 'lanlink_v9_peers';
const GROUPS_KEY        = 'lanlink_v9_groups';
const CHAT_WINDOW_STEP  = 120;
const CALL_QUALITY_PROFILES = {
  low:      { label:'LOW',      video:{ facingMode:'user', width:{ ideal:640 },  height:{ ideal:360 }, frameRate:{ ideal:15, max:20 } }, videoBitrate:350000,  videoFps:15, audioBitrate:48000 },
  balanced: { label:'BAL',      video:{ facingMode:'user', width:{ ideal:960 },  height:{ ideal:540 }, frameRate:{ ideal:24, max:30 } }, videoBitrate:900000,  videoFps:24, audioBitrate:64000 },
  hd:       { label:'HD',       video:{ facingMode:'user', width:{ ideal:1280 }, height:{ ideal:720 }, frameRate:{ ideal:30, max:30 } }, videoBitrate:1500000, videoFps:30, audioBitrate:96000 },
};

// ── Emoji (Array.from — works on iOS Safari, no lookbehind regex) ─────
const EMOJI_ALL = Array.from('😀😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗😙😚🙂🤗🤩🤔🤨😐😑😶🙄😏😣😥😮🤐😯😪😫🥱😴😌😛😜😝🤤😒😓😔😕🙃🤑😲☹🙁😖😞😟😤😢😭😦😧😨😩🤯😬😰😱🥵🥶😳🤪😵🥴😠😡🤬😷🤒🤕🤢🤮🤧😇🥳🥺🤠🤡🤥🤫🤭🧐🤓😈👿👹👺💀☠👋🤚🖐✋🖖👌✌🤞🤟🤘🤙👈👉👆👇☝👍👎✊👊🤛🤜👏🙌👐🤲🙏💪❤🧡💛💚💙💜🖤🤍🤎💔❣💕💞💓💗💖💘💝💟🔥💥✨🌟⭐🌈🎉🎊🎈🎁🏆🥇🎯🎮🎲🃏🧩🔑🗝🔒🔓💡🔔🎵🎶📱💻🖥⌨🖱📷📸🎥📞☎📡📺📻🍕🍔🌮🌯🥗🍜🍣🍱🍩🍪🍫🍿🥤☕🍵🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🐔🌍🌎🌏☀🌤⛅🌧⛈❄🌊🏔🌋🏖✅❌⚠ℹ🔴🟡🟢🔵⚡💯♻🔄⏰📅📌');

// ── State ─────────────────────────────────────────────────────────────
const App = {
  me:{id:null,name:null,avatar:'🦊'},
  ws:null, serverUrl:null, serverBase:null,
  peers:new Map(),
  historyPeers:new Map(),
  conversations:new Map(),
  groups:new Map(),
  chatPCs:new Map(), dataChannels:new Map(),
  callPCs:new Map(), pendingIce:new Map(),
  currentChat:null,
  unreadCounts:new Map(), typingTimers:new Map(),
  relayPeers:new Set(),
  renderWindowStarts:new Map(),
  activeCall:null, localStream:null, screenStream:null, mixedAudioCtx:null,
  incomingCallData:null,
  selectedAvatar:'🦊', activeTab:'chats',
  callTimer:null, callSecs:0,
  callQualityMode:'balanced',
  callStatsPrev:null,
  showCallDiagnostics:false,
  appVisible:false,
  pendingChatRefresh:new Set(),
  pendingConvSaves:new Set(),
  convSaveTimer:null,
  peerListRenderQueued:false,
  reconnectTimer:null, reconnectDelay:RECONNECT_BASE_MS,
  pingTimer:null, pongTimer:null,
  wsLatencyMs:null, lastPingSentAt:0,
  cameras:[], currentCameraIdx:0,
  currentFacingMode:'user',
  zoomState:{ supported:false, min:1, max:1, step:0.1, value:1 },
  ctxMsg:null, ctxPeer:null,
  replyTo:null,
  allowGroups:true,
};
function isGroup(pid){ return typeof pid==='string' && pid.startsWith('g_'); }
function isMobile(){ return window.innerWidth<=680; }
function getCallQualityProfile(){ return CALL_QUALITY_PROFILES[App.callQualityMode] || CALL_QUALITY_PROFILES.balanced; }
function getCallVideoConstraints(facingMode='user'){
  const profile=getCallQualityProfile();
  return { ...profile.video, facingMode };
}
function ensureRenderWindow(pid){
  if(!pid)return 0;
  const total=(App.conversations.get(pid)||[]).length;
  if(!App.renderWindowStarts.has(pid))App.renderWindowStarts.set(pid,Math.max(0,total-CHAT_WINDOW_STEP));
  return App.renderWindowStarts.get(pid);
}
function expandRenderWindow(pid){
  const start=ensureRenderWindow(pid);
  const next=Math.max(0,start-CHAT_WINDOW_STEP);
  App.renderWindowStarts.set(pid,next);
  return next!==start;
}
function resetRenderWindow(pid){
  if(!pid)return;
  const total=(App.conversations.get(pid)||[]).length;
  App.renderWindowStarts.set(pid,Math.max(0,total-CHAT_WINDOW_STEP));
}
function updateWsPingIndicator(value){
  const el=document.getElementById('app-ping-indicator');if(!el)return;
  el.className='ping-pill';
  if(value==null){el.textContent='Ping --';return;}
  el.textContent=`Ping ${value|0}ms`;
  if(value<80)el.classList.add('good');
  else if(value<180)el.classList.add('fair');
  else el.classList.add('poor');
}
function setCallQualityMode(mode,silent=false){
  if(!CALL_QUALITY_PROFILES[mode])return;
  App.callQualityMode=mode;
  const label=CALL_QUALITY_PROFILES[mode].label;
  const modeEl=document.getElementById('quality-mode-label');if(modeEl)modeEl.textContent=label;
  const diagEl=document.getElementById('diag-quality-mode');if(diagEl)diagEl.textContent=label;
  if(!silent&&App.activeCall?.type==='video')applyCurrentCallQuality().then(()=>toast(`🎛️ Call quality: ${label}`));
}
function cycleCallQualityMode(){
  const modes=['low','balanced','hd'];
  const idx=modes.indexOf(App.callQualityMode);
  setCallQualityMode(modes[(idx+1)%modes.length]);
}
function toggleCallDiagnostics(){
  App.showCallDiagnostics=!App.showCallDiagnostics;
  const panel=document.getElementById('call-diagnostics');
  if(panel)panel.classList.toggle('hidden',!App.showCallDiagnostics);
}

function queueChatRefresh(pid){
  if(pid)App.pendingChatRefresh.add(pid);
}
function flushPendingChatRefresh(){
  if(document.visibilityState!=='visible')return;
  if(!App.currentChat)return;
  if(!App.pendingChatRefresh.has(App.currentChat))return;
  App.pendingChatRefresh.delete(App.currentChat);
  App.unreadCounts.set(App.currentChat,0);
  renderAllMsgs(App.currentChat);
  renderPeerList();
  scrollBottom();
}

// ── Utilities ─────────────────────────────────────────────────────────
function addPeer(p){
  App.peers.set(p.id,p);
  if(!App.conversations.has(p.id))App.conversations.set(p.id,[]);
  const hp = {name:p.name,avatar:p.avatar};
  if(p.pubKey) hp.pubKey = p.pubKey;
  App.historyPeers.set(p.id, hp);
  saveHistoryPeers();
  if(typeof E2E!=='undefined') E2E.shared.delete(p.id);
}
function pushMsg(pid,msg){
  if(!App.conversations.has(pid))App.conversations.set(pid,[]);
  App.conversations.get(pid).push(msg);
  if(App.currentChat===pid)resetRenderWindow(pid);
  saveConvToDB(pid);
}
function addSysMsg(pid,text){pushMsg(pid,{type:'system',text,time:new Date()});if(App.currentChat===pid){renderMsg({type:'system',text});scrollBottom();}}
function incUnread(pid){App.unreadCounts.set(pid,(App.unreadCounts.get(pid)||0)+1);renderPeerList();}
function scrollBottom(){const c=document.getElementById('messages-container');if(c)c.scrollTop=c.scrollHeight;}
function toast(msg,ms=3500){const c=document.getElementById('toast-container');const el=mkEl('div','toast');el.textContent=msg;c.appendChild(el);setTimeout(()=>el.remove(),ms);}
function dlFile(url,name){const a=document.createElement('a');a.href=url+'?dl=1';a.download=name||'file';document.body.appendChild(a);a.click();document.body.removeChild(a);}
function viewImg(src){
  const ov=document.createElement('div');ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.96);display:flex;align-items:center;justify-content:center;z-index:9999;cursor:zoom-out;padding:16px;';
  const img=document.createElement('img');img.src=src;img.style.cssText='max-width:100%;max-height:100%;border-radius:8px;object-fit:contain;';
  ov.appendChild(img);ov.onclick=()=>ov.remove();document.body.appendChild(ov);
}
function mkEl(tag,cls,html){const el=document.createElement(tag);if(cls)el.className=cls;if(html!==undefined)el.innerHTML=html;return el;}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmtTime(d){if(!d)return'';const dt=d instanceof Date?d:new Date(d);return dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}
function fmtBytes(b){if(!b)return'0 B';const i=Math.floor(Math.log(b)/Math.log(1024));return(b/1024**i).toFixed(1)+' '+['B','KB','MB','GB'][i];}
function fileIcon(mime,name){const ext=(name||'').split('.').pop().toLowerCase();if((mime||'').startsWith('image/'))return'🖼️';if((mime||'').startsWith('video/'))return'🎬';if((mime||'').startsWith('audio/'))return'🎵';if((mime||'').includes('pdf'))return'📕';if(['zip','rar','7z','gz','tar'].includes(ext))return'📦';if(['doc','docx'].includes(ext))return'📝';if(['xls','xlsx','csv'].includes(ext))return'📊';return'📄';}

// ── Auto-Backup ───────────────────────────────────────────────────────
let _lastBackupCheck = 0;
function checkAutoBackup() {
  const now = Date.now();
  if (now - _lastBackupCheck < 60000) return; // Check at most once per minute
  _lastBackupCheck = now;
  if (!App.me.id) return;
  const last = parseInt(localStorage.getItem('lanlink_v9_last_backup') || '0', 10);
  if (last > 0 && now - last > 24 * 60 * 60 * 1000) exportData(true);
  else if (last === 0) try{localStorage.setItem('lanlink_v9_last_backup', now.toString());}catch{}
}
document.addEventListener('click', checkAutoBackup, { passive: true });

// ── Boot ──────────────────────────────────────────────────────────────
async function boot(){
  await registerSW();               // Start SW early so it's ready by join time
  await initDB();
  await loadHistoryFromDB();
  loadLocalProfile();
  loadHistoryPeers();
  loadGroupsFromStorage();
  await initE2E();
  setCallQualityMode(App.callQualityMode,true);
  updateWsPingIndicator(null);
  await autoFillServerUrl();
  
  if (App.me.name && document.getElementById('server-input').value) {
    joinNetwork();
  } else {
    document.getElementById('username-input').focus();
  }

  // If we were already joined (profile has serverUrl), the SW may have
  // buffered messages — drain them now
  if(App.serverUrl && App.me.id) swDrain();
}
boot();
document.getElementById('username-input').addEventListener('keydown',e=>{if(e.key==='Enter')joinNetwork();});
