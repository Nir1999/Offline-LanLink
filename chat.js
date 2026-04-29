// ── Emoji picker ──────────────────────────────────────────────────────
function buildEmojiGrid(emojis){
  const g=document.getElementById('ep-grid');if(!g)return;g.innerHTML='';
  emojis.slice(0,128).forEach(e=>{const s=mkEl('span','ep-emoji');s.textContent=e;s.onclick=()=>insertEmoji(e);g.appendChild(s);});
}
function insertEmoji(emoji){
  const inp=document.getElementById('msg-input');const pos=inp.selectionStart||inp.value.length;
  inp.value=inp.value.slice(0,pos)+emoji+inp.value.slice(pos);
  inp.selectionStart=inp.selectionEnd=pos+[...emoji].length;inp.focus();handleTyping();
}
function filterEmoji(q){buildEmojiGrid(q?EMOJI_ALL.filter(e=>e.includes(q)):EMOJI_ALL);}
function toggleEmojiPanel(e){
  e.stopPropagation();
  const p=document.getElementById('emoji-panel');const opening=!p.classList.contains('open');
  p.classList.toggle('open');
  if(opening){buildEmojiGrid(EMOJI_ALL);const s=p.querySelector('.ep-search');if(s)s.value='';}
}
document.addEventListener('click',e=>{
  const p=document.getElementById('emoji-panel');
  if(p&&p.classList.contains('open')&&!p.contains(e.target)&&!e.target.closest('.emoji-btn'))p.classList.remove('open');
});

// ── Context menu ──────────────────────────────────────────────────────
function showCtxMenu(e,msg,pid){
  e.preventDefault();closeCtxMenu();
  App.ctxMsg=msg;App.ctxPeer=pid;
  const menu=document.getElementById('ctx-menu');menu.classList.add('open');
  const x=Math.min((e.clientX||e.touches?.[0]?.clientX||0),window.innerWidth-180);
  const y=Math.min((e.clientY||e.touches?.[0]?.clientY||0),window.innerHeight-130);
  menu.style.left=x+'px';menu.style.top=y+'px';
  const isBoard = pid === 'board';
  const rr = document.getElementById('ctx-react-row'); if(rr) rr.style.display = isBoard ? 'none' : 'flex';
  const rpl = document.getElementById('ctx-reply'); if(rpl) rpl.style.display = isBoard ? 'none' : '';
  const ci=document.getElementById('ctx-copy');if(ci)ci.style.display=msg.type==='text'?'':'none';
}
function closeCtxMenu(){const m=document.getElementById('ctx-menu');if(m)m.classList.remove('open');}
function ctxReply(){closeCtxMenu();if(App.ctxMsg)setReplyTo(App.ctxMsg);}
function ctxCopy(){closeCtxMenu();if(App.ctxMsg?.text)navigator.clipboard?.writeText(App.ctxMsg.text).then(()=>toast('📋 Copied'));}
document.addEventListener('click',e=>{const m=document.getElementById('ctx-menu');if(m&&!m.contains(e.target))closeCtxMenu();});

// ── Reactions ─────────────────────────────────────────────────────────
function sendReaction(emoji){
  closeCtxMenu();
  if(!App.ctxMsg||!App.ctxPeer)return;
  const msg=App.ctxMsg,pid=App.ctxPeer;
  if(!msg.reactions)msg.reactions={};
  if(!msg.reactions[emoji])msg.reactions[emoji]=[];
  const idx=msg.reactions[emoji].indexOf(App.me.id);
  if(idx>=0)msg.reactions[emoji].splice(idx,1);else msg.reactions[emoji].push(App.me.id);
  if(!msg.reactions[emoji].length)delete msg.reactions[emoji];
  saveConvToDB(isGroup(pid)?pid:App.currentChat);
  const el=document.getElementById('react_'+(msg.id||''));if(el)renderReactions(el,msg);
  if(idx<0&&!isGroup(pid))sendVia(pid,{type:'reaction',msgId:msg.id,emoji,from:App.me.id});
}
function rxReaction(pid,data){
  const msgs=App.conversations.get(App.currentChat)||[];
  const msg=msgs.find(m=>m.id===data.msgId);if(!msg)return;
  if(!msg.reactions)msg.reactions={};
  if(!msg.reactions[data.emoji])msg.reactions[data.emoji]=[];
  if(!msg.reactions[data.emoji].includes(pid))msg.reactions[data.emoji].push(pid);
  saveConvToDB(App.currentChat);
  const el=document.getElementById('react_'+(data.msgId||''));if(el)renderReactions(el,msg);
}
function renderReactions(el,msg){
  el.innerHTML='';if(!msg.reactions)return;
  Object.entries(msg.reactions).forEach(([emoji,users])=>{
    if(!users.length)return;
    const chip=mkEl('span','react-chip');
    if(users.includes(App.me.id))chip.classList.add('mine');
    const em=document.createElement('span');em.textContent=emoji;
    const cnt=mkEl('span','react-count');cnt.textContent=users.length;
    chip.appendChild(em);chip.appendChild(cnt);
    chip.title=users.map(id=>App.historyPeers.get(id)?.name||id).join(', ');
    chip.onclick=()=>{App.ctxMsg=msg;App.ctxPeer=App.currentChat;sendReaction(emoji);};
    el.appendChild(chip);
  });
}

// ── Reply-to ──────────────────────────────────────────────────────────
function setReplyTo(msg){
  App.replyTo=msg;
  document.getElementById('reply-preview').classList.add('active');
  const name=msg.from===App.me.id?'You':(App.peers.get(msg.from)||App.historyPeers.get(msg.from))?.name||'Peer';
  document.getElementById('reply-preview-text').textContent=`${name}: ${msg.text||msg.fileName||'📎 attachment'}`;
  document.getElementById('msg-input').focus();
}
function cancelReply(){App.replyTo=null;document.getElementById('reply-preview').classList.remove('active');}

// ── Messaging ─────────────────────────────────────────────────────────
function handleDataMsg(pid,data){
  if(data.type==='group-sync') {
    const g = data.group;
    if(g && (g.members||[]).includes(App.me.id)){
      App.groups.set(g.id,g);
      if(!App.conversations.has(g.id))App.conversations.set(g.id,[]);
      saveGroupsToStorage();renderPeerList();
      toast(`👥 Added to group "${g.name}"`);
    }
    return;
  }
  if(data.type==='text')rxText(pid,data);
  if(data.type==='attachment')rxAttachment(pid,data);
  if(data.type==='folder')rxFolder(pid,data);
  if(data.type==='typing')showTyping(pid);
  if(data.type==='delivered')markDelivered(data.msgId);
  if(data.type==='reaction')rxReaction(pid,data);
}
function canRelayViaServer(){
  return App.ws?.readyState===WebSocket.OPEN;
}
function noteRelayMode(pid){
  if(App.relayPeers.has(pid))return;
  App.relayPeers.add(pid);
  if(App.currentChat===pid)toast('ℹ️ Direct peer link unavailable — relaying via server');
}
function clearRelayMode(pid){
  App.relayPeers.delete(pid);
}
function relayViaServer(pid,data,isSilent=false){
  if(!canRelayViaServer())return false;
  if(!isSilent) noteRelayMode(pid);
  wsSend({
    type:'sw-direct',
    to:pid,
    from:App.me.id,
    senderName:App.me.name,
    payload:data,
  });
  return true;
}
function rxText(pid,data){
  const peer=App.peers.get(pid)||App.historyPeers.get(pid);if(!peer)return;
  const msg={id:data.id,from:pid,type:'text',text:data.text,time:new Date(data.time),direction:'in',replyTo:data.replyTo||null};
  pushMsg(pid,msg);
  sendVia(pid,{type:'delivered',msgId:data.id});
  if(App.currentChat===pid&&document.visibilityState==='visible'){renderMsg(msg);scrollBottom();}
  else{incUnread(pid);toast(`💬 ${peer.name||pid}: ${data.text.substring(0,50)}`);playMsgSound();showPush(`Message from ${peer.name||pid}`,data.text,pid);}
}
function rxAttachment(pid,data){
  const peer=App.peers.get(pid)||App.historyPeers.get(pid);if(!peer)return;
  const msg={...data,time:new Date(data.time),direction:'in'};
  pushMsg(pid,msg);
  sendVia(pid,{type:'delivered',msgId:data.id});
  if(App.currentChat===pid&&document.visibilityState==='visible'){renderMsg(msg);scrollBottom();}
  else{incUnread(pid);toast(`📁 ${peer.name||pid}: ${data.fileName}`);playMsgSound();showPush(`File from ${peer.name||pid}`,data.fileName,pid);}
}
function rxFolder(pid,data){
  const peer=App.peers.get(pid)||App.historyPeers.get(pid);if(!peer)return;
  const msg={...data,time:new Date(data.time),direction:'in'};
  pushMsg(pid,msg);
  sendVia(pid,{type:'delivered',msgId:data.id});
  if(App.currentChat===pid&&document.visibilityState==='visible'){renderMsg(msg);scrollBottom();}
  else{incUnread(pid);toast(`📁 ${peer.name||pid} shared folder: ${data.folderName}`);playMsgSound();showPush(`Folder from ${peer.name||pid}`,data.folderName,pid);}
}
function markDelivered(msgId){
  const el=document.getElementById('tick_'+msgId);
  if(el){el.textContent='✓✓';el.classList.add('delivered');}
  App.conversations.forEach(msgs=>{const m=msgs.find(x=>x.id===msgId);if(m)m.delivered=true;});
}
function showTyping(pid){
  if(App.currentChat!==pid)return;
  const el=document.getElementById('typing-area');el.style.display='block';
  clearTimeout(App.typingTimers.get(pid));
  App.typingTimers.set(pid,setTimeout(()=>{if(App.currentChat===pid)el.style.display='none';},2500));
}
async function sendVia(pid,data){
  const secureData = await encryptMsg(pid, data);
  const lowPriority=data?.type==='typing'||data?.type==='delivered'||data?.type==='reaction';
  let dc=App.dataChannels.get(pid);
  if(lowPriority&&dc?.readyState!=='open')return relayViaServer(pid,secureData,true);
  if(!dc||dc.readyState!=='open'){
    const ok=await connectToPeer(pid);
    if(!ok)return relayViaServer(pid,secureData,false);
    dc=App.dataChannels.get(pid);
  }
  if(dc?.readyState==='open'){
    clearRelayMode(pid);
    dc.send(JSON.stringify(secureData));
    return true;
  }
  return relayViaServer(pid,secureData,false);
}
async function sendMessage(){
  const inp=document.getElementById('msg-input');
  const text=inp.value.trim();if(!text||!App.currentChat)return;

  if(App.currentChat === 'board') {
    wsSend({type: 'add-announcement', text: text});
    inp.value=''; inp.style.height='auto';
    cancelReply();
    return;
  }

  if(isGroup(App.currentChat)){
    // Group: relay via server, no WebRTC
    const g=App.groups.get(App.currentChat);if(!g){toast('⚠️ Group not found');return;}
    inp.value='';inp.style.height='auto';
    const id='m_'+Date.now()+'_'+(window.crypto?.randomUUID ? crypto.randomUUID().split('-')[0] : Math.random().toString(36).substr(2,4));
    const payload={id,type:'text',text,time:new Date().toISOString(),from:App.me.id};
    if(App.replyTo)payload.replyTo={id:App.replyTo.id,text:App.replyTo.text||null,from:App.replyTo.from};
    const securePayload = await encryptGroupMsg(App.currentChat, payload);
    wsSend({type:'group-message',members:(g.members||[]).filter(id=>id!==App.me.id),gid:App.currentChat,payload:securePayload});
    const local={...payload,time:new Date(),direction:'out',replyTo:payload.replyTo||null,senderName:App.me.name,senderAvatar:App.me.avatar};
    pushMsg(App.currentChat,local);renderMsg(local);scrollBottom();renderPeerList();cancelReply();
    return;
  }

  // P2P: WebRTC data channel
  if(!App.peers.has(App.currentChat)){toast('⚠️ Peer is offline');return;}
  inp.value='';inp.style.height='auto';
  const id='m_'+Date.now()+'_'+(window.crypto?.randomUUID ? crypto.randomUUID().split('-')[0] : Math.random().toString(36).substr(2,4));
  const data={id,type:'text',text,time:new Date().toISOString(),from:App.me.id};
  if(App.replyTo)data.replyTo={id:App.replyTo.id,text:App.replyTo.text||null,fileName:App.replyTo.fileName||null,from:App.replyTo.from};
  const local={...data,time:new Date(),direction:'out',replyTo:data.replyTo||null};
  pushMsg(App.currentChat,local);renderMsg(local);scrollBottom();renderPeerList();cancelReply();
  const ok=await sendVia(App.currentChat,data);
  if(!ok)toast('⚠️ Could not reach peer');
}
async function doUploadChunked(file, onProgress) {
  const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE) || 1;
  const fileId = Date.now() + '_' + file.name.replace(/[^a-zA-Z0-9.\-]/g, '_').substring(0, 100);
  let url, mime;
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);
    let retries = 3;
    while(retries > 0) {
      try {
        const res = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', (App.serverBase||'') + '/upload-chunk');
          xhr.setRequestHeader('x-file-id', fileId);
          xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
          xhr.setRequestHeader('x-chunk-index', i);
          xhr.setRequestHeader('x-total-chunks', totalChunks);
          xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress((start + e.loaded) / file.size); };
          xhr.onload = () => { if (xhr.status === 200) resolve(JSON.parse(xhr.responseText)); else reject(new Error(`HTTP ${xhr.status}`)); };
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.send(chunk);
        });
        if (i === totalChunks - 1) { url = res.url; mime = res.mimeType; }
        break;
      } catch(e) {
        retries--; if (retries === 0) throw e;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  return { url, mimeType: mime };
}
function showUploadProgress(name){
  const bar=document.getElementById('upload-progress');if(!bar)return;
  bar.classList.add('active');
  const n=document.getElementById('up-name');if(n)n.textContent=name;
  const f=document.getElementById('up-fill');if(f)f.style.width='0%';
  const p=document.getElementById('up-pct');if(p)p.textContent='0%';
}
function updateUploadProgress(pct){
  const p=Math.round(pct*100);
  const f=document.getElementById('up-fill');if(f)f.style.width=p+'%';
  const pt=document.getElementById('up-pct');if(pt)pt.textContent=p+'%';
}
function hideUploadProgress(){const bar=document.getElementById('upload-progress');if(bar)bar.classList.remove('active');}
async function sendFile(inp){
  if(!App.currentChat||!inp.files[0])return;
  const file=inp.files[0];inp.value='';
  const isBoard=App.currentChat==='board';
  const grp=isGroup(App.currentChat);
  if(!isBoard&&!grp&&!App.peers.has(App.currentChat)){toast('⚠️ Peer is offline');return;}
  showUploadProgress(file.name);
  try{
    const result=await doUploadChunked(file,p=>updateUploadProgress(p));
    hideUploadProgress();
    if(isBoard){
      wsSend({type:'add-announcement', messageType:'attachment', url:result.url, fileName:file.name, fileSize:file.size, mimeType:result.mimeType||file.type});
      toast('✅ File posted to board!');
      return;
    }
    const payload={id:'f_'+Date.now()+'_'+(window.crypto?.randomUUID ? crypto.randomUUID().split('-')[0] : Math.random().toString(36).substr(2,4)),type:'attachment',url:result.url,fileName:file.name,fileSize:file.size,mimeType:result.mimeType||file.type,time:new Date().toISOString(),from:App.me.id};
    if(grp){
      const g=App.groups.get(App.currentChat);
      if(g) { const securePayload = await encryptGroupMsg(App.currentChat, payload); wsSend({type:'group-message',members:(g.members||[]).filter(id=>id!==App.me.id),gid:App.currentChat,payload:securePayload}); }
      const local={...payload,time:new Date(),direction:'out',senderName:App.me.name,senderAvatar:App.me.avatar};
      pushMsg(App.currentChat,local);renderMsg(local);scrollBottom();toast('✅ File sent to group!');
    }else{
      const local={...payload,time:new Date(),direction:'out'};
      pushMsg(App.currentChat,local);renderMsg(local);scrollBottom();
      const ok=await sendVia(App.currentChat,payload);
      toast(ok?'✅ File sent!':'⚠️ Uploaded but peer not notified');
    }
  }catch(e){hideUploadProgress();toast(`❌ Upload: ${e.message}`);}
}
async function sendImage(inp){
  if(!App.currentChat||!inp.files[0])return;
  const file=inp.files[0];inp.value='';
  const isBoard=App.currentChat==='board';
  const grp=isGroup(App.currentChat);
  if(!isBoard&&!grp&&!App.peers.has(App.currentChat)){toast('⚠️ Peer is offline');return;}
  showUploadProgress(file.name);
  try{
    const result=await doUploadChunked(file,p=>updateUploadProgress(p));
    hideUploadProgress();
    if(isBoard){
      wsSend({type:'add-announcement', messageType:'attachment', url:result.url, fileName:file.name, fileSize:file.size, mimeType:result.mimeType||file.type});
      toast('✅ Image posted to board!');
      return;
    }
    const payload={id:'i_'+Date.now()+'_'+(window.crypto?.randomUUID ? crypto.randomUUID().split('-')[0] : Math.random().toString(36).substr(2,4)),type:'attachment',url:result.url,fileName:file.name,fileSize:file.size,mimeType:result.mimeType||file.type,time:new Date().toISOString(),from:App.me.id};
    if(grp){
      const g=App.groups.get(App.currentChat);
      if(g) { const securePayload = await encryptGroupMsg(App.currentChat, payload); wsSend({type:'group-message',members:(g.members||[]).filter(id=>id!==App.me.id),gid:App.currentChat,payload:securePayload}); }
      const local={...payload,time:new Date(),direction:'out',senderName:App.me.name,senderAvatar:App.me.avatar};
      pushMsg(App.currentChat,local);renderMsg(local);scrollBottom();toast('✅ Image sent to group!');
    }else{
      const local={...payload,time:new Date(),direction:'out'};
      pushMsg(App.currentChat,local);renderMsg(local);scrollBottom();
      await sendVia(App.currentChat,payload);toast('✅ Image sent!');
    }
  }catch(e){hideUploadProgress();toast(`❌ Upload: ${e.message}`);}
}
let _mediaRecorder=null, _audioChunks=[], _recTimer=null, _recStart=0, _recStream=null, _recChatId=null;
async function toggleVoiceMemo(){
  if(!App.currentChat)return;
  if(App.currentChat!=='board'&&!isGroup(App.currentChat)&&!App.peers.has(App.currentChat)){toast('⚠️ Peer is offline');return;}
  if(_mediaRecorder&&_mediaRecorder.state==='recording'){_mediaRecorder.stop();return;}
  try{
    _recStream=await navigator.mediaDevices.getUserMedia({audio:true});
    _mediaRecorder=new MediaRecorder(_recStream);
    _audioChunks=[];_recChatId=App.currentChat;
    _mediaRecorder.ondataavailable=e=>{if(e.data.size>0)_audioChunks.push(e.data);};
    _mediaRecorder.onstop=async()=>{
      clearInterval(_recTimer);
      _recStream.getTracks().forEach(t=>t.stop());
      document.getElementById('recording-indicator').style.display='none';
      document.getElementById('msg-input').style.display='block';
      const mb=document.getElementById('mic-btn');mb.textContent='🎤';mb.classList.remove('recording');
      if(_audioChunks.length===0)return;
      const blob=new Blob(_audioChunks,{type:'audio/webm'});
      if(blob.size<100)return;
      const file=new File([blob],`VoiceMemo_${Date.now()}.webm`,{type:'audio/webm'});
      await sendVoiceMemo(file,_recChatId);
      _audioChunks=[];_mediaRecorder=null;
    };
    _mediaRecorder.start();
    _recStart=Date.now();
    document.getElementById('msg-input').style.display='none';
    document.getElementById('recording-indicator').style.display='flex';
    const mb=document.getElementById('mic-btn');mb.textContent='⏹️';mb.classList.add('recording');
    _recTimer=setInterval(()=>{
      const s=Math.floor((Date.now()-_recStart)/1000);
      document.getElementById('rec-time').textContent=`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
    },1000);
    document.getElementById('rec-time').textContent="0:00";
  }catch(err){toast('❌ Mic access denied (HTTPS required)');}
}
function cancelVoiceMemo(){if(_mediaRecorder&&_mediaRecorder.state==='recording'){_audioChunks=[];_mediaRecorder.stop();}}
async function sendVoiceMemo(file,pid){
  showUploadProgress('Voice Memo');
  try{
    const result=await doUploadChunked(file,p=>updateUploadProgress(p));
    hideUploadProgress();
    if(pid==='board'){
      wsSend({type:'add-announcement', messageType:'attachment', url:result.url, fileName:file.name, fileSize:file.size, mimeType:result.mimeType||file.type});
      toast('✅ Voice memo posted to board!');
      return;
    }
    const payload={id:'a_'+Date.now()+'_'+(window.crypto?.randomUUID ? crypto.randomUUID().split('-')[0] : Math.random().toString(36).substr(2,4)),type:'attachment',url:result.url,fileName:file.name,fileSize:file.size,mimeType:result.mimeType||file.type,time:new Date().toISOString(),from:App.me.id};
    const local={...payload,time:new Date(),direction:'out',senderName:App.me.name,senderAvatar:App.me.avatar};
    if(isGroup(pid)){
      const g=App.groups.get(pid);
      if(g) { const securePayload = await encryptGroupMsg(pid, payload); wsSend({type:'group-message',members:(g.members||[]).filter(id=>id!==App.me.id),gid:pid,payload:securePayload}); }
    }else{
      await sendVia(pid,payload);
    }
    pushMsg(pid,local);if(App.currentChat===pid){renderMsg(local);scrollBottom();}
  }catch(e){hideUploadProgress();toast(`❌ Upload: ${e.message}`);}
}
async function sendFolder(inp){
  if(!App.currentChat||!inp.files.length)return;
  const files = Array.from(inp.files);
  inp.value='';
  const isBoard=App.currentChat==='board';
  const grp=isGroup(App.currentChat);
  if(!isBoard&&!grp&&!App.peers.has(App.currentChat)){toast('⚠️ Peer is offline');return;}
  const folderName = files[0].webkitRelativePath.split('/')[0] || 'Folder';
  
  let totalSize = files.reduce((acc, f) => acc + f.size, 0);
  if (!confirm(`Send folder "${folderName}" containing ${files.length} files (${fmtBytes(totalSize)})?`)) return;

  showUploadProgress(folderName + ` (${files.length} files)`);
  const uploadedFiles = [];
  let totalUploaded = 0;
  try{
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const result = await doUploadChunked(file, p => {
        const overallPct = (totalUploaded + (p * file.size)) / totalSize;
        updateUploadProgress(overallPct);
      });
      totalUploaded += file.size;
      uploadedFiles.push({ path: file.webkitRelativePath || file.name, url: result.url, size: file.size });
    }
    hideUploadProgress();
    if(isBoard){
      wsSend({type:'add-announcement', messageType:'folder', folderName, files:uploadedFiles});
      toast('✅ Folder posted to board!');
      return;
    }
    const payload={id:'d_'+Date.now()+'_'+(window.crypto?.randomUUID ? crypto.randomUUID().split('-')[0] : Math.random().toString(36).substr(2,4)),type:'folder',folderName,files:uploadedFiles,time:new Date().toISOString(),from:App.me.id};
    if(grp){
      const g=App.groups.get(App.currentChat);
      if(g) { const securePayload = await encryptGroupMsg(App.currentChat, payload); wsSend({type:'group-message',members:(g.members||[]).filter(id=>id!==App.me.id),gid:App.currentChat,payload:securePayload}); }
      const local={...payload,time:new Date(),direction:'out',senderName:App.me.name,senderAvatar:App.me.avatar};
      pushMsg(App.currentChat,local);renderMsg(local);scrollBottom();toast('✅ Folder sent to group!');
    }else{
      const local={...payload,time:new Date(),direction:'out'};
      pushMsg(App.currentChat,local);renderMsg(local);scrollBottom();
      const ok = await sendVia(App.currentChat,payload);
      toast(ok?'✅ Folder sent!':'⚠️ Uploaded but peer not notified');
    }
  }catch(e){hideUploadProgress();toast(`❌ Folder Upload: ${e.message}`);}
}
let _typTO;
function handleTyping(){
  const inp=document.getElementById('msg-input');
  if(inp._lastVal !== inp.value){ inp.style.height='auto';inp.style.height=Math.min(inp.scrollHeight,100)+'px'; inp._lastVal = inp.value; }
  if(!App.currentChat||isGroup(App.currentChat))return;
  clearTimeout(_typTO);sendVia(App.currentChat,{type:'typing'});_typTO=setTimeout(()=>{},2000);
}
function handleKeydown(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}}

