// ── Clear chat ────────────────────────────────────────────────────────
function clearCurrentChat(){
  if(!App.currentChat)return;
  const label=isGroup(App.currentChat)
    ?App.groups.get(App.currentChat)?.name||'this group'
    :(App.peers.get(App.currentChat)||App.historyPeers.get(App.currentChat))?.name||'this chat';
  if(!confirm(`Clear all messages in "${label}"? Only clears your local copy.`))return;
  App.conversations.set(App.currentChat,[]);
  saveConvToDB(App.currentChat);
  renderAllMsgs(App.currentChat);
  toast('🗑️ Chat cleared');
}

// ── Rendering ─────────────────────────────────────────────────────────
function openChat(pid){
  App.currentChat=pid;App.unreadCounts.set(pid,0);resetRenderWindow(pid);
  App.pendingChatRefresh.delete(pid);
  document.getElementById('empty-chat').style.display='none';
  document.getElementById('active-chat').style.display='flex';
  updateChatHeader(pid);
  document.getElementById('typing-area').style.display='none';
  cancelReply();
  const isBoard = pid === 'board';
  const grp=isGroup(pid);
  const isOnline=!grp&&!isBoard&&App.peers.has(pid);
  const inp=document.getElementById('msg-input');if(inp)inp.disabled=(!grp&&!isOnline&&!isBoard);
  const sb=document.querySelector('.send-btn');if(sb)sb.disabled=(!grp&&!isOnline&&!isBoard);
  
  const attachBtn = document.querySelector('.attach-btn'); if(attachBtn) attachBtn.style.display = '';
  const micBtn = document.getElementById('mic-btn'); if(micBtn) micBtn.style.display = '';
  
  renderAllMsgs(pid);renderPeerList();setTimeout(scrollBottom,50);
  if(grp||isOnline||isBoard){const i=document.getElementById('msg-input');if(i)i.focus();}
  if(isMobile()){document.getElementById('sidebar').classList.add('hidden');document.getElementById('sidebar-backdrop').classList.remove('show');}
}
function updateChatHeader(pid){
  const grp=isGroup(pid);
  // Reset all action buttons first
  const vcBtn=document.getElementById('btn-voice-call');
  const vidBtn=document.getElementById('btn-video-call');
  const mgBtn=document.getElementById('btn-manage-group');
  const verifyBtn=document.getElementById('btn-verify-peer');
  const sfBtn=document.getElementById('btn-send-folder');
  const sflBtn=document.getElementById('btn-send-file');
  if(pid === 'board') {
    document.getElementById('chat-peer-avatar').innerHTML='📢<div class="presence" style="background:var(--accent);box-shadow:0 0 5px var(--accent);"></div>';
    document.getElementById('chat-peer-name').innerHTML='Notice Board<span class="group-badge" style="background:var(--accent3);color:#fff;">PUBLIC</span>';
    const st=document.getElementById('chat-peer-status');if(st)st.textContent='Visible to everyone';
    const dt=document.getElementById('chat-peer-dot');if(dt)dt.className='status-dot online';
    if(vcBtn)vcBtn.style.display='none';
    if(vidBtn)vidBtn.style.display='none';
    if(mgBtn)mgBtn.style.display='none';
    if(verifyBtn)verifyBtn.style.display='none';
    if(sfBtn)sfBtn.style.display='';
    if(sflBtn)sflBtn.style.display='';
    return;
  }
  if(sflBtn)sflBtn.style.display='';
  if(grp){
    const g=App.groups.get(pid)||{name:'Group',avatar:'👥',members:[]};
    document.getElementById('chat-peer-avatar').innerHTML=esc(g.avatar||'👥')+'<div class="presence" style="background:var(--accent);box-shadow:0 0 5px var(--accent);"></div>';
    document.getElementById('chat-peer-name').innerHTML=esc(g.name)+'<span class="group-badge">GROUP</span>';
    const mc=(g.members||[]).length;
    const oc=(g.members||[]).filter(id=>id!==App.me.id&&App.peers.has(id)).length;
    const st=document.getElementById('chat-peer-status');if(st)st.textContent=`${mc} members · ${oc} online`;
    const dt=document.getElementById('chat-peer-dot');if(dt)dt.className='status-dot '+(oc>0?'online':'');
    // Groups: NO voice/video calls
    if(vcBtn)vcBtn.style.display='none';
    if(vidBtn)vidBtn.style.display='none';
    if(mgBtn)mgBtn.style.display=g.createdBy===App.me.id?'':'none';
    if(verifyBtn)verifyBtn.style.display='none';
    if(sfBtn)sfBtn.style.display='';
  }else{
    const peer=App.peers.get(pid)||App.historyPeers.get(pid)||{name:pid,avatar:'👤',ip:''};
    const isOnline=App.peers.has(pid);
    document.getElementById('chat-peer-avatar').innerHTML=esc(peer.avatar||'👤')+'<div class="presence"></div>';
    document.getElementById('chat-peer-name').textContent=peer.name||pid;
    const st=document.getElementById('chat-peer-status');if(st)st.textContent=isOnline?`Online · ${peer.ip||'LAN'}`:'Offline — history only';
    const dt=document.getElementById('chat-peer-dot');if(dt)dt.className='status-dot '+(isOnline?'online':'error');
    if(vcBtn)vcBtn.style.display=isOnline?'':'none';
    if(vidBtn)vidBtn.style.display=isOnline?'':'none';
    if(verifyBtn)verifyBtn.style.display=isOnline?'':'none';
    if(mgBtn)mgBtn.style.display='none';
    if(sfBtn)sfBtn.style.display='none';
  }
}
function goBack(){App.currentChat=null;document.getElementById('active-chat').style.display='none';document.getElementById('sidebar').classList.remove('hidden');cancelReply();}
function closeSidebar(){if(isMobile()&&App.currentChat){document.getElementById('sidebar').classList.add('hidden');document.getElementById('sidebar-backdrop').classList.remove('show');}}
function schedulePeerListRender(){
  if(App.peerListRenderQueued)return;
  App.peerListRenderQueued=true;
  requestAnimationFrame(()=>{
    App.peerListRenderQueued=false;
    renderPeerListNow();
  });
}
const _dateCache = new Map();
function getFastDateString(time) {
  const d = new Date(time);
  const key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
  let str = _dateCache.get(key);
  if(!str) {
    str = d.toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'});
    _dateCache.set(key, str);
  }
  return str;
}
function handleChatScroll(c) {
  if (c.scrollTop < 40 && App.currentChat) {
    const pid = App.currentChat;
    const start = ensureRenderWindow(pid);
    if (start > 0 && !c._isLoading) {
      c._isLoading = true;
      const oldH = c.scrollHeight;
      const oldT = c.scrollTop;
      if (expandRenderWindow(pid)) {
        renderAllMsgs(pid);
        c.scrollTop = c.scrollHeight - oldH + oldT;
      }
      setTimeout(() => { c._isLoading = false; }, 150);
    }
  }
}
function renderAllMsgs(pid){
  const c=document.getElementById('messages-container');c.innerHTML='';let lastDate=null;
  const frag=document.createDocumentFragment();
  const msgs=App.conversations.get(pid)||[];
  const start=ensureRenderWindow(pid);
  if(start>0){
    const loadOlder=mkEl('div','sys-msg');
    loadOlder.textContent=`Scroll up to load more (${start} older)`;
    loadOlder.style.cssText='cursor:pointer; opacity:0.6; margin:8px auto;';
    loadOlder.onclick=()=>{
      const oldH = c.scrollHeight, oldT = c.scrollTop;
      if(expandRenderWindow(pid)){ renderAllMsgs(pid); c.scrollTop = c.scrollHeight - oldH + oldT; }
    };
    frag.appendChild(loadOlder);
  }
  msgs.slice(start).forEach(m=>{
    if(m.time&&m.type!=='system'){
      const ds=getFastDateString(m.time);
      if(ds!==lastDate){const sep=mkEl('div','msg-date-sep');sep.textContent=ds;frag.appendChild(sep);lastDate=ds;}
    }
    renderMsg(m,false,frag);
  });
  c.appendChild(frag);
}
function renderMsg(msg,scroll=true,target){
  const c=target||document.getElementById('messages-container');if(!c)return;
  if(msg.type==='system'){const el=mkEl('div','sys-msg');el.textContent=msg.text;c.appendChild(el);if(scroll)scrollBottom();return;}
  const isOut=msg.direction==='out'||msg.from===App.me.id;
  const pid=isOut?App.currentChat:msg.from;
  const grp=mkEl('div',`msg-group ${isOut?'outgoing':'incoming'}`);

  // Context menu
  grp.addEventListener('contextmenu',e=>{e.preventDefault();showCtxMenu(e,msg,pid);});
  let _lpt;
  grp.addEventListener('touchstart',e=>{_lpt=setTimeout(()=>showCtxMenu(e,msg,pid),600);},{passive:true});
  grp.addEventListener('touchend',()=>clearTimeout(_lpt),{passive:true});
  grp.addEventListener('touchmove',()=>clearTimeout(_lpt),{passive:true});

  // Reply quote
  if(msg.replyTo){
    const rname=msg.replyTo.from===App.me.id?'You':(App.peers.get(msg.replyTo.from)||App.historyPeers.get(msg.replyTo.from))?.name||'Peer';
    const q=mkEl('div','reply-quote');q.textContent=`${rname}: ${msg.replyTo.text||msg.replyTo.fileName||'📎 attachment'}`;grp.appendChild(q);
  }

  // Sender name in group chats (incoming only)
  if(!isOut&&(isGroup(App.currentChat) || App.currentChat === 'board')){
    const sn=msg.senderName||(App.peers.get(msg.from)||App.historyPeers.get(msg.from))?.name||msg.from;
    const nameEl=mkEl('div','msg-sender-name');nameEl.textContent=sn;grp.appendChild(nameEl);
  }

  if(msg.type==='text'){
    const b=mkEl('div',`message ${isOut?'out':'in'}`);
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = msg.text.split(urlRegex);
    parts.forEach(part => {
      if (urlRegex.test(part)) {
        const a = document.createElement('a');
        a.href = part; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.style.color = 'var(--accent2)'; a.textContent = part;
        b.appendChild(a);
      } else {
        part.split('\n').forEach((line,i,arr)=>{b.appendChild(document.createTextNode(line));if(i<arr.length-1)b.appendChild(document.createElement('br'));});
      }
    });
    grp.appendChild(b);
  }else if(msg.type==='attachment'){
    const mime=msg.mimeType||'';
    const mkDlBtn=()=>{const b=document.createElement('button');b.textContent='⬇️';b.style.cssText='position:absolute;top:8px;right:8px;background:rgba(0,0,0,.65);color:#fff;border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;font-size:14px;';b.onclick=ev=>{ev.stopPropagation();dlFile(msg.url,msg.fileName);};return b;};
    if(mime.startsWith('video/')){
      const w=mkEl('div');w.style.cssText='position:relative;display:inline-block;max-width:min(280px,75vw);';
      const vid=document.createElement('video');vid.controls=true;vid.src=msg.url;vid.style.cssText='width:100%;border-radius:10px;display:block;';
      w.appendChild(vid);w.appendChild(mkDlBtn());grp.appendChild(w);
    }else if(mime.startsWith('image/')){
      const w=mkEl('div');w.style.cssText='position:relative;display:inline-block;';
      const img=document.createElement('img');img.src=msg.url;img.alt='Image';img.style.cssText='max-width:min(240px,72vw);max-height:190px;border-radius:10px;display:block;cursor:zoom-in;';
      img.onclick=()=>viewImg(msg.url);w.appendChild(img);w.appendChild(mkDlBtn());grp.appendChild(w);
    }else if(mime.startsWith('audio/')){
      const w=mkEl('div');w.style.cssText='position:relative;display:inline-block;min-width:220px;max-width:min(280px,75vw);padding-right:34px;';
      const aud=document.createElement('audio');aud.controls=true;aud.src=msg.url;aud.style.cssText='width:100%;height:36px;border-radius:18px;outline:none;background:var(--surface2);';
      w.appendChild(aud);w.appendChild(mkDlBtn());grp.appendChild(w);
    }else{
      const fm=mkEl('div','file-msg');fm.onclick=()=>dlFile(msg.url,msg.fileName);
      const ico=mkEl('div','file-ico');ico.textContent=fileIcon(mime,msg.fileName);
      const fi=mkEl('div','file-info');
      const fn=mkEl('div','file-name');fn.textContent=msg.fileName||'file';
      const fs2=mkEl('div','file-size');fs2.textContent=fmtBytes(msg.fileSize)+' · tap to download';
      fi.appendChild(fn);fi.appendChild(fs2);fm.appendChild(ico);fm.appendChild(fi);
      fm.appendChild(Object.assign(document.createElement('span'),{textContent:'⬇️'}));
      grp.appendChild(fm);
    }
  }else if(msg.type==='folder'){
    const fm=mkEl('div','file-msg');
    fm.style.flexDirection='column'; fm.style.alignItems='stretch'; fm.style.maxWidth='300px'; fm.style.cursor='default';
    const header=mkEl('div'); header.style.display='flex'; header.style.alignItems='center'; header.style.gap='10px';
    const ico=mkEl('div','file-ico');ico.textContent='📁';
    const fi=mkEl('div','file-info');
    const fn=mkEl('div','file-name');fn.textContent=msg.folderName||'Folder';
    const fs2=mkEl('div','file-size');fs2.textContent=`${msg.files.length} files`;
    fi.appendChild(fn);fi.appendChild(fs2);header.appendChild(ico);header.appendChild(fi);
    fm.appendChild(header);
    const list=mkEl('div'); list.style.maxHeight='180px'; list.style.overflowY='auto'; list.style.marginTop='8px'; list.style.fontSize='11px'; list.style.background='rgba(0,0,0,0.15)'; list.style.padding='4px'; list.style.borderRadius='6px'; list.style.display='flex'; list.style.flexDirection='column'; list.style.gap='2px';
    msg.files.forEach(f => {
      const fItem = mkEl('div');
      fItem.style.display='flex'; fItem.style.justifyContent='space-between'; fItem.style.padding='6px'; fItem.style.borderRadius='4px'; fItem.style.background='var(--surface2)'; fItem.style.cursor='pointer';
      fItem.innerHTML = `<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-right:8px;flex:1;" title="${esc(f.path)}">${esc(f.path)}</span><span style="flex-shrink:0;">⬇️</span>`;
      fItem.onclick = (e) => { e.stopPropagation(); dlFile(f.url, f.path.split('/').pop()); };
      fItem.onmouseenter = () => fItem.style.background='var(--surface3)';
      fItem.onmouseleave = () => fItem.style.background='var(--surface2)';
      list.appendChild(fItem);
    });
    fm.appendChild(list);
    grp.appendChild(fm);
  }

  // Time + tick
  const t=mkEl('div','msg-time');t.appendChild(document.createTextNode(fmtTime(msg.time)));
  if(isOut&&!isGroup(App.currentChat)){
    const tick=mkEl('span','msg-tick');tick.id='tick_'+(msg.id||'');
    tick.textContent=msg.delivered?'✓✓':'✓';
    if(msg.delivered)tick.classList.add('delivered');
    t.appendChild(document.createTextNode(' '));t.appendChild(tick);
  }
  grp.appendChild(t);

  const reactEl=mkEl('div','msg-reactions');reactEl.id='react_'+(msg.id||'');
  if(msg.reactions)renderReactions(reactEl,msg);
  grp.appendChild(reactEl);
  c.appendChild(grp);if(scroll)scrollBottom();
}
function renderPeerList(){
  schedulePeerListRender();
}
function renderPeerListNow(){
  const cnt=document.getElementById('peer-list');
  if(App.activeTab==='groups'){
    if(!App.groups.size){cnt.innerHTML=`<div class="no-peers"><div class="ico">👥</div><p>No groups yet.<br>Tap 👥 to create one.</p></div>`;return;}
    cnt.innerHTML='';
    App.groups.forEach((g,gid)=>{
      const{last,txt}=getLastMsg(gid);
      const unread=App.unreadCounts.get(gid)||0;
      const mc=(g.members||[]).length;
      const oc=(g.members||[]).filter(id=>id!==App.me.id&&App.peers.has(id)).length;
      const el=mkEl('div',`peer-item${App.currentChat===gid?' active':''}`);el.onclick=()=>openChat(gid);
      el.innerHTML=`<div class="avatar">👥<div class="presence" style="background:var(--accent);box-shadow:0 0 4px var(--accent);"></div></div>
        <div class="peer-info"><div class="peer-name">${esc(g.name)}</div><div class="peer-last">${esc(txt)} · ${oc}/${mc} online</div></div>
        <div class="peer-meta" style="align-items:flex-end;gap:4px;">
          ${last?`<div class="peer-time">${fmtTime(last.time)}</div>`:''}
          ${unread>0?`<div class="unread-badge">${unread}</div>`:''}
          ${g.createdBy===App.me.id?`<button class="group-manage-btn" onclick="event.stopPropagation();openManageGroup('${esc(gid)}')">⚙️ Edit</button>`:''}
        </div>`;
      cnt.appendChild(el);
    });
    return;
  }
  const online=[...App.peers.values()];
  const historyIds=[...App.conversations.keys()].filter(id=>id!=='board'&&!App.peers.has(id)&&!isGroup(id)&&(App.conversations.get(id)||[]).some(m=>m.type!=='system'));
  if(App.activeTab==='peers'){
    if(!online.length){cnt.innerHTML=`<div class="no-peers"><div class="ico">📡</div><p>No peers online.</p></div>`;return;}
    cnt.innerHTML='';cnt.appendChild(mkEl('div','section-label',`${online.length} ONLINE`));
    online.forEach(p=>{const{last,txt}=getLastMsg(p.id);cnt.appendChild(peerItem(p.id,p.name,p.avatar,txt,last?fmtTime(last.time):'',App.unreadCounts.get(p.id)||0,true));});
    return;
  }
  cnt.innerHTML='';
  
  // Pinned Notice Board
  const boardLast = getLastMsg('board');
  const boardUnread = App.unreadCounts.get('board')||0;
  cnt.appendChild(peerItem('board', 'Notice Board', '📢', boardLast.txt || 'Public announcements', boardLast.last ? fmtTime(boardLast.last.time) : '', boardUnread, true));

  if(online.length){
    cnt.appendChild(mkEl('div','section-label','ONLINE'));
    online.forEach(p=>{const{last,txt}=getLastMsg(p.id);cnt.appendChild(peerItem(p.id,p.name,p.avatar,txt,last?fmtTime(last.time):'',App.unreadCounts.get(p.id)||0,true));});
  }
  if(historyIds.length){
    cnt.appendChild(mkEl('div','section-label','HISTORY'));
    historyIds.forEach(id=>{
      const{last,txt}=getLastMsg(id);if(!last)return;
      const hp=App.historyPeers.get(id)||{name:id,avatar:'👤'};
      cnt.appendChild(peerItem(id,hp.name,hp.avatar,txt,fmtTime(last.time),App.unreadCounts.get(id)||0,false));
    });
  }
}
function getLastMsg(pid){const msgs=(App.conversations.get(pid)||[]).filter(m=>m.type!=='system');const last=msgs[msgs.length-1];const txt=last?(last.type==='text'?last.text:last.type==='attachment'?`📎 ${last.fileName}`:'…'):'Tap to chat';return{last,txt};}
function peerItem(id,name,avatar,lastTxt,lastTime,unread,isOnline=true){
  const el=mkEl('div',`peer-item${App.currentChat===id?' active':''}`);el.onclick=()=>openChat(id);
  const ps=isOnline?'':'background:var(--text3);box-shadow:none;';
  el.innerHTML=`<div class="avatar">${esc(avatar)}<div class="presence" style="${ps}"></div></div>
    <div class="peer-info"><div class="peer-name">${esc(name)}${!isOnline?'<span class="peer-offline-badge">offline</span>':''}</div><div class="peer-last">${esc(lastTxt)}</div></div>
    <div class="peer-meta">${lastTime?`<div class="peer-time">${lastTime}</div>`:''}${unread>0?`<div class="unread-badge">${unread}</div>`:''}</div>`;
  return el;
}

// ── App UI ────────────────────────────────────────────────────────────
function showApp(){
  document.getElementById('setup-screen').style.display='none';
  document.getElementById('app').style.display='flex';
  const btn = document.querySelector('button[onclick="joinNetwork()"]');
  if(btn){ btn.textContent='Join Network →'; btn.disabled=false; }
  document.body.style.overflow='hidden';
  document.getElementById('my-avatar-display').innerHTML=esc(App.me.avatar)+'<div class="presence"></div>';
  document.getElementById('my-name-display').textContent=App.me.name;
  document.getElementById('my-id-display').textContent='#'+App.me.id.split('_')[1];
  if(isMobile())document.getElementById('active-chat').style.display='none';
}
function setAppConn(ok){
  document.getElementById('app-conn-dot').className='status-dot '+(ok?'online':'error');
  document.getElementById('app-conn-status').textContent=ok?'Connected':'Disconnected';
  if(!ok)updateWsPingIndicator(null);
}
function updatePeerCount(){document.getElementById('peer-count').textContent=`${App.peers.size} peer${App.peers.size!==1?'s':''}`;}
function switchTab(tab,el){App.activeTab=tab;document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));if(el)el.classList.add('active');renderPeerList();}
function filterPeers(q){document.querySelectorAll('.peer-item').forEach(el=>{el.style.display=(el.querySelector('.peer-name')?.textContent||'').toLowerCase().includes(q.toLowerCase())?'':'none';});}

