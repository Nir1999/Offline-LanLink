// ── IndexedDB ─────────────────────────────────────────────────────────
let db=null;
function initDB(){
  return new Promise(res=>{
    const r=indexedDB.open(DB_NAME,DB_VERSION);
    r.onerror=()=>{console.warn('IndexedDB unavailable');res(null);};
    r.onsuccess=e=>{db=e.target.result;res(db);};
    r.onupgradeneeded=e=>{
      const d=e.target.result;
      if(!d.objectStoreNames.contains('conversations'))d.createObjectStore('conversations');
      if(!d.objectStoreNames.contains('sw_inbox'))d.createObjectStore('sw_inbox',{keyPath:'id',autoIncrement:true});
    };
  });
}
async function loadHistoryFromDB(){
  if(!db)return;
  return new Promise(resolve=>{
    const req=db.transaction('conversations','readonly').objectStore('conversations').openCursor();
    req.onsuccess=e=>{
      const cur=e.target.result;
      if(!cur){resolve();return;}
      try{App.conversations.set(cur.key,(cur.value||[]).map(m=>({...m,time:m.time?new Date(m.time):new Date()})));}catch{}
      cur.continue();
    };
    req.onerror=()=>resolve();
  });
}
function saveConvToDB(pid){
  if(!pid)return;
  if(!db)return;
  App.pendingConvSaves.add(pid);
  if(App.convSaveTimer)return;
  App.convSaveTimer=setTimeout(flushConvSaves,120);
}
function flushConvSaves(){
  if(!db||!App.pendingConvSaves.size){App.convSaveTimer=null;return;}
  try{
    const tx=db.transaction('conversations','readwrite');
    const store=tx.objectStore('conversations');
    App.pendingConvSaves.forEach(pid=>{
      store.put((App.conversations.get(pid)||[]).slice(-300),pid);
    });
    tx.onerror=()=>console.warn('saveConvToDB: transaction failed');
  }catch(e){console.warn('saveConvToDB:',e);}
  App.pendingConvSaves.clear();
  App.convSaveTimer=null;
}

