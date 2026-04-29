// ── Profile ───────────────────────────────────────────────────────────
function loadLocalProfile(){
  try{
    const raw=localStorage.getItem(PROFILE_KEY);
    if(raw){
      const p=JSON.parse(raw);
      App.me.id     = p.id     || ('u_' + (window.crypto?.randomUUID ? crypto.randomUUID().replace(/-/g,'').substring(0,9) : Math.random().toString(36).substr(2,9)));
      App.me.name   = p.name   || '';
      App.me.avatar = p.avatar || '🦊';
      if(p._serverUrl)  App.serverUrl  = p._serverUrl;
      if(p._serverBase) App.serverBase = p._serverBase;
      App.selectedAvatar = App.me.avatar;
      const ni=document.getElementById('username-input'); if(ni)ni.value=App.me.name;
      const opt=document.querySelector(`.avatar-opt[data-emoji="${App.me.avatar}"]`);
      if(opt){document.querySelectorAll('.avatar-opt').forEach(e=>e.classList.remove('selected'));opt.classList.add('selected');}
    } else { App.me.id='u_' + (window.crypto?.randomUUID ? crypto.randomUUID().replace(/-/g,'').substring(0,9) : Math.random().toString(36).substr(2,9)); }
  } catch { App.me.id='u_' + (window.crypto?.randomUUID ? crypto.randomUUID().replace(/-/g,'').substring(0,9) : Math.random().toString(36).substr(2,9)); }
}
function saveProfile(){
  try{localStorage.setItem(PROFILE_KEY,JSON.stringify({...App.me,_serverUrl:App.serverUrl||'',_serverBase:App.serverBase||''}));}catch{}
}
function loadHistoryPeers(){
  try{App.historyPeers=new Map(Object.entries(JSON.parse(localStorage.getItem(PEERS_CACHE_KEY)||'{}')));}catch{}
}
function saveHistoryPeers(){
  try{const o={};App.historyPeers.forEach((v,k)=>{o[k]=v;});localStorage.setItem(PEERS_CACHE_KEY,JSON.stringify(o));}catch{}
}
function loadGroupsFromStorage(){
  try{
    const raw=localStorage.getItem(GROUPS_KEY);
    if(!raw)return;
    Object.entries(JSON.parse(raw)).forEach(([k,g])=>{
      App.groups.set(k,g);
      if(!App.conversations.has(k))App.conversations.set(k,[]);
    });
  }catch(e){console.warn('loadGroups:',e);}
}
function saveGroupsToStorage(){
  try{const o={};App.groups.forEach((g,k)=>{o[k]=g;});localStorage.setItem(GROUPS_KEY,JSON.stringify(o));}catch{}
}
async function exportData(isAuto = false){
  const data={
    profile:localStorage.getItem(PROFILE_KEY),
    peers:localStorage.getItem(PEERS_CACHE_KEY),
    groups:localStorage.getItem(GROUPS_KEY),
    conversations:[]
  };
  if(db){
    const tx=db.transaction('conversations','readonly');
    const store=tx.objectStore('conversations');
    const req=store.getAll(), keysReq=store.getAllKeys();
    await new Promise(res=>{
      req.onsuccess=()=>{ keysReq.onsuccess=()=>{ data.conversations=keysReq.result.map((k,i)=>({key:k,value:req.result[i]})); res(); }; };
      req.onerror=res;
    });
  }
  const blob=new Blob([JSON.stringify(data)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`LanLink_Backup_${Date.now()}.json`;
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  try{localStorage.setItem('lanlink_v9_last_backup', Date.now().toString());}catch{}
  if(isAuto) toast('💾 Daily auto-backup downloaded');
}
function importData(file){
  if(!file)return;
  const reader=new FileReader();
  reader.onload=async e=>{
    try{
      const data=JSON.parse(e.target.result);
      if(data.profile)localStorage.setItem(PROFILE_KEY,data.profile);
      if(data.peers)localStorage.setItem(PEERS_CACHE_KEY,data.peers);
      if(data.groups)localStorage.setItem(GROUPS_KEY,data.groups);
      if(data.conversations&&db){ const tx=db.transaction('conversations','readwrite'); const store=tx.objectStore('conversations'); store.clear(); data.conversations.forEach(c=>store.put(c.value,c.key)); await new Promise(res=>tx.oncomplete=res); }
      alert('✅ Backup restored! The app will now reload.'); location.reload();
    }catch(err){alert('❌ Invalid backup file');}
  };
  reader.readAsText(file);
}
function clearAllData(){
  if(!confirm('⚠️ Delete all history and profile? Cannot be undone.'))return;
  swDisconnect();   // Stop SW background connection before wiping state
  [PROFILE_KEY,PEERS_CACHE_KEY,GROUPS_KEY].forEach(k=>localStorage.removeItem(k));
  if(db){try{db.transaction('conversations','readwrite').objectStore('conversations').clear();}catch{}}
  location.reload();
}

