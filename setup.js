// ── Setup screen ──────────────────────────────────────────────────────
document.querySelectorAll('.avatar-opt').forEach(el=>{
  el.addEventListener('click',()=>{
    document.querySelectorAll('.avatar-opt').forEach(e=>e.classList.remove('selected'));
    el.classList.add('selected');App.selectedAvatar=el.dataset.emoji;
  });
});
(function checkSecure(){
  if(!window.isSecureContext&&location.hostname!=='localhost'&&location.hostname!=='127.0.0.1')
    document.getElementById('https-notice').style.display='block';
})();

async function autoFillServerUrl(){
  if(location.protocol==='http:'||location.protocol==='https:'){
    try{
      const cfg=await fetch('/api/config',{cache:'no-store'}).then(r=>r.json());
      if(cfg.wsUrl)document.getElementById('server-input').value=cfg.wsUrl;
      if(cfg.httpBase)App.serverBase=cfg.httpBase;
      if(cfg.stunUrl)applyICEConfig(cfg.stunUrl);
      if(cfg.wsUrl)return;
    }catch(e){console.warn('/api/config:',e.message);}
  }
  if(App.serverUrl) {
    document.getElementById('server-input').value = App.serverUrl;
  } else {
    const isHttps=location.protocol==='https:';
    const host=location.hostname||'192.168.1.1';
    const port=location.port||(isHttps?'8443':'8080');
    document.getElementById('server-input').value=`${isHttps?'wss':'ws'}://${host}:${port}`;
  }
}

async function runDiag(){
  const out=document.getElementById('diag-output');out.style.display='block';out.textContent='🔍 Running…\n';
  const url=document.getElementById('server-input').value.trim();
  const OK=s=>`✅  ${s}`,ERR=s=>`❌  ${s}`,WRN=s=>`⚠️  ${s}`;
  const lines=[];
  let wsHost='',httpBase='',wsPort='';
  try{
    const u=new URL(url);wsHost=u.hostname;wsPort=u.port||(u.protocol==='wss:'?'443':'80');
    httpBase=`${u.protocol==='wss:'?'https':'http'}://${wsHost}${u.port?`:${u.port}`:''}`;
    lines.push(OK(`URL OK → host=${wsHost} port=${wsPort}`));
  }catch{lines.push(ERR('Invalid URL'));out.textContent=lines.join('\n');return;}
  out.textContent='🔍 Testing HTTP…';
  try{
    const t0=Date.now(),r=await fetch(httpBase+'/api/config',{cache:'no-store',signal:AbortSignal.timeout(5000)});
    if(r.ok){const c=await r.json();lines.push(OK(`HTTP OK (${Date.now()-t0}ms)`));if(c.wsUrl)lines.push(OK(`WS: ${c.wsUrl}`));if(c.stunUrl)lines.push(OK(`STUN: ${c.stunUrl}`));}
    else lines.push(ERR(`HTTP ${r.status}`));
  }catch(e){lines.push(ERR(`HTTP unreachable: ${e.message}`));lines.push(WRN(`Open ${httpBase} in the host firewall / allow its TCP port`));}
  out.textContent=lines.join('\n')+'\n🔍 Testing WS…';
  try{
    await new Promise((res,rej)=>{const ws=new WebSocket(url);const t=setTimeout(()=>{ws.close();rej(new Error('timeout'));},5000);ws.onopen=()=>{clearTimeout(t);ws.close();res();};ws.onerror=()=>{clearTimeout(t);rej(new Error('refused'));};});
    lines.push(OK(`WS reachable → ${url}`));
  }catch(e){lines.push(ERR(`WS: ${e.message}`));lines.push(WRN(`Open WebSocket TCP port ${wsPort} in the host firewall`));}
  lines.push('');
  lines.push(window.isSecureContext?OK('HTTPS — calls will work'):WRN('Plain HTTP — calls blocked; add certs for HTTPS'));
  lines.push(typeof RTCPeerConnection!=='undefined'?OK('WebRTC supported'):ERR('WebRTC not supported'));
  lines.push(db?OK('IndexedDB — history will persist'):WRN('IndexedDB unavailable'));
  lines.push('');
  // Service Worker + notification status
  if('serviceWorker' in navigator){
    const sw=await navigator.serviceWorker.getRegistration('/').catch(()=>null);
    if(sw&&sw.active) lines.push(OK('Service Worker active — background messages enabled'));
    else if(sw) lines.push(WRN(`Service Worker registered but state: ${sw.installing?'installing':sw.waiting?'waiting':'unknown'}`));
    else lines.push(WRN('Service Worker not registered yet — join the network first'));
  } else {
    lines.push(WRN('Service Worker not supported in this browser (background notifications unavailable)'));
  }
  const notifStatus=window.Notification?Notification.permission:'unsupported';
  if(notifStatus==='granted') lines.push(OK('Notification permission granted'));
  else if(notifStatus==='denied') lines.push(ERR('Notification permission DENIED — allow in browser settings'));
  else if(notifStatus==='unsupported') lines.push(WRN('Notifications are not supported in this browser'));
  else lines.push(WRN('Notification permission not yet granted — you will be asked when you Join'));
  out.textContent=lines.join('\n');
}
async function testConn(){
  const url=document.getElementById('server-input').value.trim();if(!url){toast('⚠️ Enter server address');return;}
  setSetupStatus('','Testing…');
  try{
    const ws=new WebSocket(url);
    await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;setTimeout(rej,5000);});
    ws.close();setSetupStatus('online','Reachable ✓');
  }catch{setSetupStatus('error','Cannot connect — check IP, port, firewall');}
}
function setSetupStatus(cls,msg){
  document.getElementById('conn-dot').className='status-dot '+cls;
  document.getElementById('conn-status').textContent=msg;
}
async function joinNetwork(){
  const name=document.getElementById('username-input').value.trim();
  const url=document.getElementById('server-input').value.trim();
  if(!name){toast('⚠️ Enter your name');return;}
  if(!url){toast('⚠️ Enter server address');return;}
  App.me.name=name;App.me.avatar=App.selectedAvatar;
  if(!App.me.id)App.me.id='u_' + (window.crypto?.randomUUID ? crypto.randomUUID().replace(/-/g,'').substring(0,9) : Math.random().toString(36).substr(2,9));
  App.serverUrl=url;
  if(!App.serverBase){
    try{
      const u=new URL(url);
      u.protocol=u.protocol==='wss:'?'https:':'http:';
      App.serverBase=u.toString().replace(/\/$/,'');
    }catch{
      App.serverBase='';
    }
  }
  await initE2E();
  saveProfile();
  if(window.Notification && Notification.permission==='default'){
    Notification.requestPermission().then(()=>swConfigure()).catch(()=>{});
  }
  initAudio();connectWS();
}

