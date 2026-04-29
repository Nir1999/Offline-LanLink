// ── Group management ──────────────────────────────────────────────────
// Groups support text messages and file sharing only.
// No voice or video calls in groups by design.
let _editingGroupId=null;

function openCreateGroup(){
  if (App.allowGroups === false) return toast('⚠️ Group creation is disabled by the server');
  if(!App.peers.size){toast('⚠️ No peers online to add');return;}
  _editingGroupId=null;
  document.getElementById('group-modal-title').textContent='Create Group';
  document.getElementById('group-modal-save-btn').textContent='Create Group';
  document.getElementById('group-modal-delete-btn').style.display='none';
  document.getElementById('group-name-input').value='';
  buildMemberList([]);
  document.getElementById('group-modal').classList.add('open');
  setTimeout(()=>document.getElementById('group-name-input').focus(),80);
}
function openManageGroup(gid){
  const targetGid=gid||App.currentChat;
  if(!targetGid||!isGroup(targetGid))return;
  const g=App.groups.get(targetGid);if(!g)return;
  if(g.createdBy!==App.me.id){toast('⚠️ Only the creator can manage this group');return;}
  _editingGroupId=targetGid;
  document.getElementById('group-modal-title').textContent='Manage Group';
  document.getElementById('group-modal-save-btn').textContent='Save Changes';
  document.getElementById('group-modal-delete-btn').style.display='';
  document.getElementById('group-name-input').value=g.name;
  buildMemberList((g.members||[]).filter(id=>id!==App.me.id));
  document.getElementById('group-modal').classList.add('open');
}
function buildMemberList(preSelected){
  const list=document.getElementById('member-list');
  list.innerHTML='';
  if(!App.peers.size){
    list.innerHTML='<div style="color:var(--text3);font-size:13px;padding:8px 0;">No peers online.</div>';
    updateMemberCount();return;
  }
  App.peers.forEach((peer,pid)=>{
    const row=mkEl('div','member-row');
    const cb=document.createElement('input');
    cb.type='checkbox';cb.id='mbr_'+pid;cb.value=pid;cb.checked=preSelected.includes(pid);
    cb.addEventListener('change',()=>{row.classList.toggle('selected',cb.checked);updateMemberCount();});
    if(cb.checked)row.classList.add('selected');
    const lbl=document.createElement('label');lbl.htmlFor='mbr_'+pid;
    lbl.innerHTML=`<span style="font-size:20px;">${esc(peer.avatar)}</span>${esc(peer.name)}`;
    row.appendChild(cb);row.appendChild(lbl);
    // clicking anywhere on row toggles checkbox
    row.addEventListener('click',e=>{if(e.target!==cb){cb.checked=!cb.checked;row.classList.toggle('selected',cb.checked);updateMemberCount();}});
    list.appendChild(row);
  });
  updateMemberCount();
}
function updateMemberCount(){
  const n=document.querySelectorAll('#member-list input:checked').length;
  const lbl=document.getElementById('member-count-label');
  if(lbl)lbl.textContent=n===0?'No members selected':`${n} member${n!==1?'s':''} selected`;
}

// ── Group Keys ────────────────────────────────────────────────────────
async function getGroupKey(gid) {
  const g = App.groups.get(gid);
  if(!g || !g.key) return null;
  if(E2E.shared.has(gid)) return E2E.shared.get(gid);
  try {
    const raw = Uint8Array.from(atob(g.key), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", raw, {name:"AES-GCM"}, false, ["encrypt","decrypt"]);
    E2E.shared.set(gid, key); return key;
  } catch(e) { return null; }
}
async function encryptGroupMsg(gid, payload) {
  if(!E2E.enabled) return payload; const key = await getGroupKey(gid); if(!key) return payload;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({name:"AES-GCM", iv}, key, new TextEncoder().encode(JSON.stringify(payload)));
  return { e2ee: true, gid: gid, iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...new Uint8Array(enc))) };
}
async function decryptGroupMsg(gid, payload) {
  if(!payload.e2ee || !E2E.enabled) return payload; const key = await getGroupKey(gid); if(!key) return null;
  try {
    const iv = Uint8Array.from(atob(payload.iv), c => c.charCodeAt(0));
    const data = Uint8Array.from(atob(payload.data), c => c.charCodeAt(0));
    const dec = await crypto.subtle.decrypt({name:"AES-GCM", iv}, key, data);
    return JSON.parse(new TextDecoder().decode(dec));
  } catch(e) { return null; }
}

async function saveGroup(){
  const name=document.getElementById('group-name-input').value.trim();
  if(!name){toast('⚠️ Enter a group name');document.getElementById('group-name-input').focus();return;}
  const selected=[...document.querySelectorAll('#member-list input:checked')].map(cb=>cb.value);
  if(!selected.length){toast('⚠️ Select at least one member');return;}
  const members=[App.me.id,...selected];
  if(_editingGroupId){
    const g=App.groups.get(_editingGroupId);
    if(g){g.name=name;g.members=members;App.groups.set(_editingGroupId,g);saveGroupsToStorage();broadcastGroupSync(g);toast(`✅ "${name}" updated`);if(App.currentChat===_editingGroupId)updateChatHeader(_editingGroupId);}
  }else{
    const gid='g_'+Date.now();
    const g={id:gid,name,avatar:'👥',members,createdBy:App.me.id};
    if(E2E.enabled) {
      const k = await crypto.subtle.generateKey({name:"AES-GCM", length:256}, true, ["encrypt","decrypt"]);
      const raw = await crypto.subtle.exportKey("raw", k);
      g.key = btoa(String.fromCharCode(...new Uint8Array(raw)));
    }
    App.groups.set(gid,g);
    if(!App.conversations.has(gid))App.conversations.set(gid,[]);
    saveGroupsToStorage();saveConvToDB(gid);
    broadcastGroupSync(g);
    toast(`👥 "${name}" created`);
    closeGroupModal();renderPeerList();openChat(gid);return;
  }
  closeGroupModal();renderPeerList();
}
async function broadcastGroupSync(g){
  const others=(g.members||[]).filter(id=>id!==App.me.id);
  const sync = {type:'group-sync',group:g,from:App.me.id};
  for(const m of others) {
    const secure = await encryptMsg(m, sync);
    wsSend({type:'sw-direct', to:m, from:App.me.id, senderName:App.me.name, payload:secure});
  }
}
function closeGroupModal(){
  document.getElementById('group-modal').classList.remove('open');
  _editingGroupId=null;
}
document.getElementById('group-modal').addEventListener('click',function(e){if(e.target===this)closeGroupModal();});
function deleteGroup(gid){
  const g=App.groups.get(gid);if(!g)return;
  if(!confirm(`Delete group "${g.name}"? This cannot be undone.`))return;
  App.groups.delete(gid);saveGroupsToStorage();
  if(App.currentChat===gid)goBack();
  renderPeerList();toast('Group deleted');
  if(_editingGroupId===gid) closeGroupModal();
}
async function handleGroupMessage(msg){
  let payload=msg.payload;if(!payload)return;
  if(payload.e2ee) {
    payload = await decryptGroupMsg(msg.gid, payload);
    if(!payload) return;
  }
  const gid=msg.gid;const g=App.groups.get(gid);if(!g)return;
  const sender=App.peers.get(payload.from)||App.historyPeers.get(payload.from)||{name:payload.from||'Unknown',avatar:'👤'};
  if(payload.type==='text'){
    const message={id:payload.id,from:payload.from,type:'text',text:payload.text,time:new Date(payload.time),direction:'in',senderName:sender.name,senderAvatar:sender.avatar,replyTo:payload.replyTo||null};
    pushMsg(gid,message);
    if(App.currentChat===gid&&document.visibilityState==='visible'){renderMsg(message);scrollBottom();}
    else{incUnread(gid);toast(`💬 [${g.name}] ${sender.name}: ${payload.text.substring(0,40)}`);playMsgSound();showPush(`[${g.name}] ${sender.name}`,payload.text,gid);}
  }else if(payload.type==='attachment'){
    const message={...payload,time:new Date(payload.time),direction:'in',senderName:sender.name,senderAvatar:sender.avatar};
    pushMsg(gid,message);
    if(App.currentChat===gid&&document.visibilityState==='visible'){renderMsg(message);scrollBottom();}
    else{incUnread(gid);toast(`📁 [${g.name}] ${sender.name}: ${payload.fileName}`);playMsgSound();}
  }
}

