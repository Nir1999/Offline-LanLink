// ── Signal handler ────────────────────────────────────────────────────
async function handleSignal(msg){
  switch(msg.type){
    case 'welcome':
      if(msg.yourIp)document.getElementById('my-ip-display').textContent=msg.yourIp;
      App.me.isHost = !!msg.isHost;
      const adminBtn = document.getElementById('admin-btn');
      if (adminBtn) adminBtn.style.display = App.me.isHost ? '' : 'none';
      App.allowGroups = msg.config ? (msg.config.allowGroups !== false) : true;
      const newGrpBtn = document.querySelector('button[title="New Group"]');
      if (newGrpBtn) newGrpBtn.style.display = App.allowGroups ? '' : 'none';
      break;
    case 'peer-list': msg.peers.forEach(p=>{if(p.id!==App.me.id)addPeer(p);}); renderPeerList();updatePeerCount(); break;
    case 'peer-joined':
      if(msg.id!==App.me.id){
        if(App.chatPCs.has(msg.id))cleanupChatConn(msg.id);
        addPeer(msg);addSysMsg(msg.id,`${msg.name} joined`);
        renderPeerList();updatePeerCount();toast(`📡 ${msg.name} joined`);
        if(App.currentChat===msg.id)updateChatHeader(msg.id);
      } break;
    case 'peer-left':
      if(App.peers.has(msg.id)){
        addSysMsg(msg.id,`${App.peers.get(msg.id).name} left`);
        App.peers.delete(msg.id);cleanupChatConn(msg.id);
        renderPeerList();updatePeerCount();
        if(App.currentChat===msg.id)updateChatHeader(msg.id);
      } break;
    case 'offer':         if(msg.forCall)await handleCallOffer(msg); else await handleChatOffer(msg); break;
    case 'answer':        if(msg.forCall)await handleCallAnswer(msg); else await handleChatAnswer(msg); break;
    case 'ice-candidate': await handleIce(msg); break;
    case 'call-request':  showIncomingCall(msg); break;
    case 'call-accepted': await onCallAccepted(msg); break;
    case 'call-declined': toast('📵 Call declined'); endCall(true); break;
    case 'call-ended':    toast('📵 Call ended');    endCall(true); break;
    case 'group-message': handleGroupMessage(msg); break;
    case 'sw-direct':
      if(msg.from&&msg.payload) {
        let payload = msg.payload;
        if(payload.e2ee) payload = await decryptMsg(msg.from, payload);
        if(payload) handleDataMsg(msg.from, payload);
      }
      break;
    case 'announcements':
      if(!msg.data) break;
      App.conversations.set('board', msg.data.map(a => ({
        id: a.id, from: a.senderId, type: a.type || 'text', text: a.text,
        url: a.url, fileName: a.fileName, fileSize: a.fileSize, mimeType: a.mimeType,
        folderName: a.folderName, files: a.files,
        time: new Date(a.time), direction: a.senderId === App.me.id ? 'out' : 'in',
        senderName: a.senderName
      })));
      if(App.currentChat === 'board') { renderAllMsgs('board'); scrollBottom(); }
      renderPeerList();
      break;
    case 'new-announcement': {
      const a = msg.data;
      const m = {
        id: a.id, from: a.senderId, type: a.type || 'text', text: a.text,
        url: a.url, fileName: a.fileName, fileSize: a.fileSize, mimeType: a.mimeType,
        folderName: a.folderName, files: a.files,
        time: new Date(a.time), direction: a.senderId === App.me.id ? 'out' : 'in', senderName: a.senderName
      };
      if(!App.conversations.has('board')) App.conversations.set('board', []);
      const existing = App.conversations.get('board');
      if(!existing.some(x => x.id === m.id)) {
        existing.push(m);
        saveConvToDB('board');
        if(App.currentChat === 'board' && document.visibilityState === 'visible') { renderMsg(m); scrollBottom(); }
        else {
          incUnread('board');
          if (m.direction === 'in') {
            const body = m.type === 'text' ? m.text : `📎 ${m.fileName || m.folderName || 'attachment'}`;
            toast(`📢 Notice from ${a.senderName}`); playMsgSound(); showPush(`Notice from ${a.senderName}`, body, 'board');
          }
        }
        renderPeerList();
      }
      break;
    }
    case 'announcements-cleared': {
      App.conversations.set('board', []);
      saveConvToDB('board');
      if(App.currentChat === 'board') renderAllMsgs('board');
      renderPeerList();
      break;
    }
    case 'server-shutdown': toast('⚠️ Server shutting down'); break;
    case 'security-state': {
      const tg = document.getElementById('sec-toggle');
      if(tg) tg.checked = msg.enabled;
      const ctr = document.getElementById('mac-list-container');
      if(ctr) ctr.style.display = msg.enabled ? 'flex' : 'none';
      const ml = document.getElementById('mac-list');
      if(ml && msg.devices) {
        ml.innerHTML = '';
        msg.devices.forEach(d => {
          const row = mkEl('div');
          row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; background:var(--surface2); padding:10px 12px; border-radius:8px; border:1px solid var(--border);';
          row.innerHTML = `<div style="display:flex; flex-direction:column; gap:2px; flex:1; min-width:0;"><span style="font-weight:500; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(d.name)}</span><span style="font-family:var(--font-mono); font-size:11px; color:var(--text3);">${d.mac}</span></div>`;
          if(d.mac !== 'localhost') {
            const del = mkEl('button', 'btn-clear-chat');
            del.textContent = '✕';
            del.onclick = () => removeMacAddress(d.mac);
            row.appendChild(del);
          } else {
            const b = mkEl('span'); b.textContent = 'HOST'; b.style.cssText='font-size:10px; font-family:var(--font-mono); color:var(--accent2); background:rgba(0,212,170,.1); padding: 2px 6px; border-radius:6px;';
            row.appendChild(b);
          }
          ml.appendChild(row);
        });
      }
      break;
    }
    case 'server-config': {
      const mbInp = document.getElementById('cfg-max-mb');
      const retInp = document.getElementById('cfg-retention');
      const annInp = document.getElementById('cfg-max-announcements');
      const grpInp = document.getElementById('cfg-allow-groups');
      const sizeLbl = document.getElementById('cfg-uploads-size');
      if (mbInp && msg.config) mbInp.value = msg.config.maxUploadMb;
      if (retInp && msg.config) retInp.value = msg.config.retentionDays;
      if (annInp && msg.config) annInp.value = msg.config.maxAnnouncements !== undefined ? msg.config.maxAnnouncements : 100;
      if (grpInp && msg.config) grpInp.checked = msg.config.allowGroups !== false;
      if (sizeLbl && msg.uploadsSize !== undefined) sizeLbl.textContent = fmtBytes(msg.uploadsSize);
      break;
    }
    case 'config-update': {
      App.allowGroups = msg.allowGroups;
      const newGrpBtn = document.querySelector('button[title="New Group"]');
      if (newGrpBtn) newGrpBtn.style.display = App.allowGroups ? '' : 'none';
      break;
    }
  }
}

// ── Chat WebRTC ───────────────────────────────────────────────────────
function ensureIceQ(pid){if(!App.pendingIce.has(pid))App.pendingIce.set(pid,{chat:[],call:[]});}
function getChatPC(pid){
  if(App.chatPCs.has(pid))return App.chatPCs.get(pid);
  const pc=new RTCPeerConnection(ICE_CONFIG);App.chatPCs.set(pid,pc);ensureIceQ(pid);
  pc.onicecandidate=e=>{if(e.candidate)wsSend({type:'ice-candidate',to:pid,from:App.me.id,candidate:e.candidate,forChat:true});};
  pc.ondatachannel=e=>setupDC(e.channel,pid);
  pc.onconnectionstatechange=()=>{if(['failed','closed'].includes(pc.connectionState))cleanupChatConn(pid);};
  pc.oniceconnectionstatechange=()=>{if(pc.iceConnectionState==='failed'){try{pc.restartIce();}catch{}}};
  return pc;
}
function setupDC(ch,pid){
  App.dataChannels.set(pid,ch);
  ch.onopen=()=>{clearRelayMode(pid);};
  ch.onmessage=async e=>{
    try{
      let data=JSON.parse(e.data);
      if(data.e2ee) data = await decryptMsg(pid, data);
      if(data) handleDataMsg(pid,data);
    }catch(err){console.warn('DC:',err);}
  };
  ch.onerror=e=>console.warn('DC error',pid,e);
  ch.onclose=()=>{if(App.dataChannels.get(pid)===ch)App.dataChannels.delete(pid);};
}
async function connectToPeer(pid){
  const ex=App.dataChannels.get(pid);if(ex?.readyState==='open')return true;
  const existingPc=App.chatPCs.get(pid);
  if(existingPc&&['failed','disconnected','closed'].includes(existingPc.connectionState))cleanupChatConn(pid);
  const pc=getChatPC(pid);
  if(pc.signalingState!=='stable'||pc.connectionState==='connecting')return waitDC(pid,5000);
  const dc=pc.createDataChannel('chat',{ordered:true});setupDC(dc,pid);
  const offer=await pc.createOffer();await pc.setLocalDescription(offer);
  wsSend({type:'offer',to:pid,from:App.me.id,sdp:offer});
  return waitDC(pid,8000);
}
function waitDC(pid,ms){
  return new Promise(resolve=>{
    const t0=Date.now(),t=setInterval(()=>{
      if(App.dataChannels.get(pid)?.readyState==='open'){clearInterval(t);resolve(true);}
      else if(Date.now()-t0>ms){clearInterval(t);cleanupChatConn(pid);resolve(false);}
    },150);
  });
}
async function flushIce(pid,kind,pc){
  ensureIceQ(pid);
  for(const c of App.pendingIce.get(pid)[kind]){try{await pc.addIceCandidate(new RTCIceCandidate(c));}catch{}}
  App.pendingIce.get(pid)[kind]=[];
}
async function handleChatOffer(msg){
  const pc=getChatPC(msg.from);
  try{await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));await flushIce(msg.from,'chat',pc);const ans=await pc.createAnswer();await pc.setLocalDescription(ans);wsSend({type:'answer',to:msg.from,from:App.me.id,sdp:ans});}
  catch(e){console.error('chatOffer:',e);}
}
async function handleChatAnswer(msg){
  const pc=App.chatPCs.get(msg.from);
  if(pc?.signalingState==='have-local-offer'){try{await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));await flushIce(msg.from,'chat',pc);}catch(e){console.error('chatAnswer:',e);}}
}
async function handleIce(msg){
  const isCall=!!msg.forCall,pc=isCall?App.callPCs.get(msg.from):App.chatPCs.get(msg.from);
  ensureIceQ(msg.from);const q=App.pendingIce.get(msg.from);
  if(pc?.remoteDescription){try{await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));}catch{}}
  else{if(isCall)q.call.push(msg.candidate);else q.chat.push(msg.candidate);}
}
function cleanupChatConn(pid){try{App.chatPCs.get(pid)?.close();}catch{}App.chatPCs.delete(pid);App.dataChannels.delete(pid);}

// ── Call WebRTC (P2P only — never triggered for groups) ───────────────
async function initiateCall(callType){
  if(!App.currentChat||isGroup(App.currentChat))return;
  if(!App.peers.has(App.currentChat)){toast('⚠️ Peer is offline');return;}
  const stream=await requestMedia(callType);if(!stream)return;
  App.localStream=stream;
  App.activeCall={peerId:App.currentChat,type:callType,outgoing:true};
  wsSend({type:'call-request',to:App.currentChat,from:App.me.id,callerName:App.me.name,callerAvatar:App.me.avatar,callType});
  showCallOverlay(App.peers.get(App.currentChat),'📲 Calling…',callType);
  attachLocalVideo(stream,callType);
  if(callType==='video')await enumerateCameras();
}
async function onCallAccepted(msg){
  if(!App.activeCall||App.activeCall.peerId!==msg.from)return;
  setCallStatus('🔗 Connecting…');
  const stream=App.localStream;if(!stream){endCall(false);return;}
  const pc=createCallPC(msg.from);
  stream.getTracks().forEach(t=>pc.addTrack(t,stream));
  await tuneCallSenders(pc);
  const offer=await pc.createOffer();await pc.setLocalDescription(offer);
  wsSend({type:'offer',to:msg.from,from:App.me.id,sdp:offer,forCall:true});
}
async function handleCallOffer(msg){
  const pid=msg.from;let stream=App.localStream;
  if(!stream){
    const callType=App.activeCall?.type||'audio';
    stream=await requestMedia(callType);
    if(!stream){wsSend({type:'call-declined',to:pid,from:App.me.id});endCall(false);return;}
    App.localStream=stream;attachLocalVideo(stream,callType);
    if(callType==='video')await enumerateCameras();
  }
  const pc=createCallPC(pid);stream.getTracks().forEach(t=>pc.addTrack(t,stream));
  await tuneCallSenders(pc);
  try{await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));await flushIce(pid,'call',pc);const ans=await pc.createAnswer();await pc.setLocalDescription(ans);wsSend({type:'answer',to:pid,from:App.me.id,sdp:ans,forCall:true});}
  catch(e){console.error('callOffer:',e);showCallErr('Failed: '+e.message);}
}
async function handleCallAnswer(msg){
  const pc=App.callPCs.get(msg.from);
  if(pc?.signalingState==='have-local-offer'){try{await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));await flushIce(msg.from,'call',pc);}catch(e){console.error('callAnswer:',e);}}
}
function createCallPC(pid){
  try{App.callPCs.get(pid)?.close();}catch{}
  const pc=new RTCPeerConnection(ICE_CONFIG);App.callPCs.set(pid,pc);ensureIceQ(pid);
  pc.onicecandidate=e=>{if(e.candidate)wsSend({type:'ice-candidate',to:pid,from:App.me.id,candidate:e.candidate,forCall:true});};
  pc.ontrack=e=>{const rv=document.getElementById('remote-video');if(rv&&e.streams[0])rv.srcObject=e.streams[0];};
  pc.onconnectionstatechange=()=>{
    if(pc.connectionState==='connected'){startCallTimer();document.getElementById('call-err').style.display='none';startQualityMonitor(pc);}
    else if(['failed','disconnected'].includes(pc.connectionState)&&App.activeCall?.peerId===pid){toast('📵 Call lost');endCall(true);}
  };
  pc.oniceconnectionstatechange=()=>{if(pc.iceConnectionState==='failed'){try{pc.restartIce();}catch{}}};
  return pc;
}
async function requestMedia(callType){
  if(!window.isSecureContext){showPermModal(callType,true);return null;}
  if(!navigator.mediaDevices?.getUserMedia){showCallErr('Browser media not supported. Use Chrome/Firefox over HTTPS.');return null;}
  const attempts=callType==='video'
    ?[{audio:true,video:getCallVideoConstraints('user')},{audio:true,video:{facingMode:'user'}},{audio:true,video:true}]
    :[{audio:true,video:false}];
  for(const c of attempts){
    try{return await navigator.mediaDevices.getUserMedia(c);}
    catch(err){
      if(err.name==='NotAllowedError'||err.name==='PermissionDeniedError'){showPermModal(callType,false);return null;}
      if(err.name==='NotFoundError'&&callType==='video')continue;
      if(err.name==='NotFoundError'){toast('❌ No microphone found');return null;}
      if(err.name==='NotReadableError'||err.name==='AbortError'){toast('❌ Mic/camera busy — close other apps');return null;}
      if(err.name==='SecurityError'){showPermModal(callType,true);return null;}
    }
  }
  if(callType==='video'){
    toast('⚠️ Camera unavailable — starting voice call instead');
    try{return await navigator.mediaDevices.getUserMedia({audio:true,video:false});}catch{}
  }
  toast('❌ Cannot access microphone');return null;
}
async function tuneSenderForRealtime(sender){
  if(!sender?.track||!sender.getParameters||!sender.setParameters)return;
  const profile=getCallQualityProfile();
  const params=sender.getParameters()||{};
  params.encodings=params.encodings?.length?params.encodings:[{}];
  if(sender.track.kind==='video'){
    params.degradationPreference='maintain-framerate';
    params.encodings[0].maxBitrate=profile.videoBitrate;
    params.encodings[0].maxFramerate=profile.videoFps;
  }else if(sender.track.kind==='audio'){
    params.priority='high';
    params.encodings[0].maxBitrate=profile.audioBitrate;
  }
  try{await sender.setParameters(params);}catch{}
}
async function tuneCallSenders(pc){
  if(!pc?.getSenders)return;
  await Promise.allSettled(pc.getSenders().map(tuneSenderForRealtime));
}
function updateZoomUI(){
  const wrap=document.getElementById('call-zoom');
  const slider=document.getElementById('zoom-slider');
  const value=document.getElementById('zoom-value');
  if(!wrap||!slider||!value)return;
  const z=App.zoomState;
  const supported=!!z.supported&&App.activeCall?.type==='video'&&!App.screenStream;
  wrap.classList.toggle('active',supported);
  if(!supported)return;
  slider.min=String(z.min);
  slider.max=String(z.max);
  slider.step=String(z.step||0.1);
  slider.value=String(z.value);
  value.textContent=`${Number(z.value).toFixed(1)}x`;
}
function refreshZoomCapabilities(track){
  const caps=track?.getCapabilities?.()||{};
  if(typeof caps.zoom==='object'&&caps.zoom){
    App.zoomState.supported=true;
    App.zoomState.min=Number(caps.zoom.min ?? 1);
    App.zoomState.max=Number(caps.zoom.max ?? App.zoomState.min);
    App.zoomState.step=Number(caps.zoom.step ?? 0.1);
    const settings=track.getSettings?.()||{};
    App.zoomState.value=Number(settings.zoom ?? App.zoomState.min);
  }else{
    App.zoomState={ supported:false, min:1, max:1, step:0.1, value:1 };
  }
  updateZoomUI();
}
async function applyCameraZoom(value){
  const track=App.localStream?.getVideoTracks?.()[0];
  if(!track||!App.zoomState.supported||!track.applyConstraints)return;
  const next=Math.min(App.zoomState.max,Math.max(App.zoomState.min,Number(value)));
  try{
    await track.applyConstraints({ advanced:[{ zoom:next }] });
    App.zoomState.value=next;
    updateZoomUI();
  }catch(e){
    console.warn('zoom:',e.message);
  }
}
function onZoomSliderInput(value){
  applyCameraZoom(value);
}
async function applyCurrentCallQuality(){
  if(!App.activeCall||App.activeCall.type!=='video'||!App.localStream)return;
  const track=App.localStream.getVideoTracks()[0];
  const facing=(track?.getSettings?.().facingMode)||App.currentFacingMode||'user';
  if(track?.applyConstraints){
    try{await track.applyConstraints(getCallVideoConstraints(facing));}catch{}
  }
  const pc=App.callPCs.get(App.activeCall.peerId);
  if(pc)await tuneCallSenders(pc);
}
function syncActiveCameraState(){
  const track=App.localStream?.getVideoTracks?.()[0];
  if(!track)return;
  const settings=track.getSettings?.()||{};
  if(settings.facingMode)App.currentFacingMode=settings.facingMode;
  if(settings.deviceId&&App.cameras.length){
    const idx=App.cameras.findIndex(cam=>cam.deviceId===settings.deviceId);
    if(idx>=0)App.currentCameraIdx=idx;
  }
  refreshZoomCapabilities(track);
}
async function enumerateCameras(){
  try{
    const devices=await navigator.mediaDevices.enumerateDevices();
    App.cameras=devices.filter(d=>d.kind==='videoinput');
    syncActiveCameraState();
    const fw=document.getElementById('flip-wrap');if(fw)fw.style.display=App.cameras.length>=2?'':'none';
  }catch{}
}
async function getSwitchedCameraStream(nextIdx){
  const nextFacing=App.currentFacingMode==='environment'?'user':'environment';
  const cam=App.cameras[nextIdx];
  const attempts=[];
  if(cam?.deviceId){
    const q=getCallQualityProfile();
    attempts.push({video:{deviceId:{exact:cam.deviceId},width:q.video.width,height:q.video.height,frameRate:q.video.frameRate}});
    attempts.push({video:{deviceId:{ideal:cam.deviceId}}});
  }
  const q=getCallQualityProfile();
  attempts.push({video:{facingMode:{exact:nextFacing},width:q.video.width,height:q.video.height,frameRate:q.video.frameRate}});
  attempts.push({video:{facingMode:nextFacing}});
  attempts.push({video:true});
  let lastErr=null;
  for(const constraints of attempts){
    try{return await navigator.mediaDevices.getUserMedia(constraints);}
    catch(err){lastErr=err;}
  }
  throw lastErr||new Error('Unable to access alternate camera');
}
async function flipCamera(){
  if(!App.activeCall||!App.localStream)return;
  if(!App.localStream.getVideoTracks().length){toast('⚠️ No active camera to switch');return;}
  const nextIdx=(App.currentCameraIdx+1)%Math.max(App.cameras.length,1);
  try{
    const ns=await getSwitchedCameraStream(nextIdx);
    const nvt=ns.getVideoTracks()[0];
    if(!nvt)throw new Error('No video track returned');
    const pid=App.activeCall.peerId;const pc=App.callPCs.get(pid);
    if(pc){const s=pc.getSenders().find(s=>s.track?.kind==='video');if(s)await s.replaceTrack(nvt);}
    if(pc)await tuneCallSenders(pc);
    App.localStream.getVideoTracks().forEach(t=>{t.stop();App.localStream.removeTrack(t);});
    App.localStream.addTrack(nvt);
    const settings=nvt.getSettings?.()||{};
    App.currentCameraIdx=nextIdx;
    App.currentFacingMode=settings.facingMode||((App.currentFacingMode==='environment')?'user':'environment');
    document.getElementById('local-video').srcObject=App.localStream;
    refreshZoomCapabilities(nvt);
    toast('🔄 Camera switched');
  }catch(e){toast('❌ Camera switch failed: '+e.message);}
}
async function toggleScreenShare(){if(App.screenStream)await stopScreenShare();else await startScreenShare();}
async function startScreenShare(){
  if(!navigator.mediaDevices?.getDisplayMedia){toast('❌ Screen sharing not supported');return;}
  try{
    const ss=await navigator.mediaDevices.getDisplayMedia({video:{cursor:'always'},audio:false});
    App.screenStream=ss;const st=ss.getVideoTracks()[0];
    const pid=App.activeCall?.peerId;
    if(pid){const pc=App.callPCs.get(pid);if(pc){const s=pc.getSenders().find(s=>s.track?.kind==='video');if(s)await s.replaceTrack(st);}}
    document.getElementById('local-video').srcObject=new MediaStream([st]);
    App.zoomState={ supported:false, min:1, max:1, step:0.1, value:1 };
    updateZoomUI();
    const sb=document.getElementById('share-btn');if(sb)sb.classList.add('screen-active');
    st.onended=()=>stopScreenShare();
    toast('🖥️ Screen sharing started');
  }catch(e){if(e.name!=='NotAllowedError')toast('❌ Screen share: '+e.message);}
}
async function stopScreenShare(){
  if(!App.screenStream)return;
  App.screenStream.getTracks().forEach(t=>t.stop());App.screenStream=null;
  if(App.localStream){
    document.getElementById('local-video').srcObject=App.localStream;
    refreshZoomCapabilities(App.localStream.getVideoTracks()[0]);
    const ct=App.localStream.getVideoTracks()[0];const pid=App.activeCall?.peerId;
    if(pid&&ct){const pc=App.callPCs.get(pid);if(pc){const s=pc.getSenders().find(s=>s.track?.kind==='video');if(s)await s.replaceTrack(ct).catch(()=>{});}}
  }
  const sb=document.getElementById('share-btn');if(sb)sb.classList.remove('screen-active');
  toast('🖥️ Screen sharing stopped');
}
function toggleFullscreen(){
  const ol=document.getElementById('call-overlay');
  if(!document.fullscreenElement){
    (ol.requestFullscreen||ol.webkitRequestFullscreen||function(){}).call(ol);
    const b=document.getElementById('fs-btn');if(b)b.textContent='⊡';
  }else{
    (document.exitFullscreen||document.webkitExitFullscreen||function(){}).call(document);
  }
}
document.addEventListener('fullscreenchange',()=>{const b=document.getElementById('fs-btn');if(b&&!document.fullscreenElement)b.textContent='⛶';});
document.addEventListener('webkitfullscreenchange',()=>{const b=document.getElementById('fs-btn');if(b&&!document.fullscreenElement)b.textContent='⛶';});
function togglePiP(e){
  if(e) e.stopPropagation();
  const ol = document.getElementById('call-overlay');
  if(ol) {
    ol.classList.toggle('minimized');
    ol.classList.remove('controls-hidden');
    if(!ol.classList.contains('minimized')){ol.style.transform='';ol.dataset.tx='0';ol.dataset.ty='0';}
    const b = document.getElementById('pip-btn');
    if(b) b.textContent = ol.classList.contains('minimized') ? '↙' : '⧉';
  }
}
(function initDraggablePiP(){
  const lv=document.getElementById('local-video');
  let drag=false,ox=0,oy=0,lx=16,ly=16;
  function down(e){
    if(!document.getElementById('call-overlay').classList.contains('has-video'))return;
    drag=true;lv.classList.add('dragging');
    const t=e.touches?.[0]||e;ox=t.clientX;oy=t.clientY;if(e.type==='mousedown')e.preventDefault();
  }
  function move(e){
    if(!drag)return;
    const t=e.touches?.[0]||e;const dx=t.clientX-ox,dy=t.clientY-oy;ox=t.clientX;oy=t.clientY;
    lx=Math.max(8,Math.min(window.innerWidth-lv.offsetWidth-8,lx+dx));
    ly=Math.max(8,Math.min(window.innerHeight-lv.offsetHeight-8,ly+dy));
    lv.style.right='auto';lv.style.bottom='auto';lv.style.left=lx+'px';lv.style.top=ly+'px';
    e.preventDefault();
  }
  function up(){drag=false;lv.classList.remove('dragging');}
  lv.addEventListener('mousedown',down);lv.addEventListener('touchstart',down,{passive:false});
  document.addEventListener('mousemove',move);document.addEventListener('touchmove',move,{passive:false});
  document.addEventListener('mouseup',up);document.addEventListener('touchend',up);
})();
(function initDraggableOverlay(){
  const co=document.getElementById('call-overlay');
  let drag=false,ox=0,oy=0,sx=0,sy=0;
  function down(e){
    if(!co.classList.contains('minimized'))return;
    if(e.target.closest('.call-btn')||e.target.closest('input')||e.target.closest('#local-video')||e.target.closest('#call-minimize-btn'))return;
    drag=true;co.dataset.dragged='false';co.classList.add('dragging');
    const t=e.touches?.[0]||e;ox=t.clientX;oy=t.clientY;sx=ox;sy=oy;
    if(e.type==='mousedown')e.preventDefault();
  }
  function move(e){
    if(!drag)return;
    const t=e.touches?.[0]||e;const dx=t.clientX-ox,dy=t.clientY-oy;
    if(Math.abs(t.clientX-sx)>5||Math.abs(t.clientY-sy)>5)co.dataset.dragged='true';
    ox=t.clientX;oy=t.clientY;
    const rect=co.getBoundingClientRect();
    let adx=dx,ady=dy;
    if(rect.left+dx<0)adx=-rect.left;
    if(rect.right+dx>window.innerWidth)adx=window.innerWidth-rect.right;
    if(rect.top+dy<0)ady=-rect.top;
    if(rect.bottom+dy>window.innerHeight)ady=window.innerHeight-rect.bottom;
    const tx=parseFloat(co.dataset.tx||0)+adx,ty=parseFloat(co.dataset.ty||0)+ady;
    co.dataset.tx=tx;co.dataset.ty=ty;
    co.style.transform=`translate(${tx}px,${ty}px)`;
    if(e.cancelable)e.preventDefault();
  }
  function up(){drag=false;co.classList.remove('dragging');}
  co.addEventListener('mousedown',down);co.addEventListener('touchstart',down,{passive:false});
  document.addEventListener('mousemove',move);document.addEventListener('touchmove',move,{passive:false});
  document.addEventListener('mouseup',up);document.addEventListener('touchend',up);
})();
let _hideCtrlTimer;
const _co=document.getElementById('call-overlay');
_co.addEventListener('mousemove',()=>{
  if(!_co.classList.contains('has-video'))return;
  _co.classList.remove('controls-hidden');
  clearTimeout(_hideCtrlTimer);_hideCtrlTimer=setTimeout(()=>_co.classList.add('controls-hidden'),3500);
});
_co.addEventListener('click',e=>{
  if(_co.classList.contains('minimized')){
    if(!e.target.closest('.call-controls-bar') && !e.target.closest('#call-minimize-btn')){
      if(_co.dataset.dragged==='true'){_co.dataset.dragged='false';return;}
      _co.classList.remove('minimized');
      _co.style.transform='';_co.dataset.tx='0';_co.dataset.ty='0';
      const b = document.getElementById('pip-btn'); if(b) b.textContent = '⧉';
      return;
    }
  }
  if(!_co.classList.contains('has-video'))return;
  if(e.target.closest('.call-controls-bar'))return;
  _co.classList.toggle('controls-hidden');
});
let _qualityInterval;
function startQualityMonitor(pc){
  clearInterval(_qualityInterval);
  const badge=document.getElementById('call-quality');if(badge)badge.style.display='';
  App.callStatsPrev=null;
  _qualityInterval=setInterval(async()=>{
    if(!pc||pc.connectionState!=='connected'){clearInterval(_qualityInterval);if(badge)badge.style.display='none';return;}
    try{
      const stats=await pc.getStats();let rtt=null, transport='P2P', uplink='--', downlink='--', fps='--';
      let activePair=null, outboundVideo=null, inboundVideo=null;
      stats.forEach(s=>{
        if(s.type==='candidate-pair'&&s.state==='succeeded'&&(s.nominated||s.selected)){
          activePair=s;
          if(s.currentRoundTripTime!=null)rtt=s.currentRoundTripTime*1000;
        }
        if(s.type==='outbound-rtp'&&s.kind==='video'&&!s.isRemote)outboundVideo=s;
        if(s.type==='inbound-rtp'&&s.kind==='video'&&!s.isRemote)inboundVideo=s;
      });
      if(rtt===null||!badge)return;
      badge.style.display='';
      if(rtt<80){badge.textContent=`📶 ${rtt|0}ms`;badge.className='call-quality good';}
      else if(rtt<200){badge.textContent=`📶 ${rtt|0}ms`;badge.className='call-quality fair';}
      else{badge.textContent=`📶 ${rtt|0}ms`;badge.className='call-quality poor';}
      if(activePair){
        const local=stats.get(activePair.localCandidateId);
        const remote=stats.get(activePair.remoteCandidateId);
        transport=`${local?.candidateType||'?'}/${remote?.candidateType||'?'}`;
      }
      const now=Date.now();
      if(App.callStatsPrev&&outboundVideo){
        const dt=(now-App.callStatsPrev.t)/1000;
        const prevOut=App.callStatsPrev.outBytes||0;
        uplink=dt>0?`${((((outboundVideo.bytesSent||0)-prevOut)*8)/dt/1000).toFixed(0)} kbps`:'--';
        fps=outboundVideo.framesPerSecond?`${outboundVideo.framesPerSecond|0}`:'--';
      }
      if(App.callStatsPrev&&inboundVideo){
        const dt=(now-App.callStatsPrev.t)/1000;
        const prevIn=App.callStatsPrev.inBytes||0;
        downlink=dt>0?`${((((inboundVideo.bytesReceived||0)-prevIn)*8)/dt/1000).toFixed(0)} kbps`:'--';
      }
      App.callStatsPrev={ t:now, outBytes:outboundVideo?.bytesSent||0, inBytes:inboundVideo?.bytesReceived||0 };
      const setDiag=(id,val)=>{const el=document.getElementById(id);if(el)el.textContent=val;};
      setDiag('diag-ping',`${rtt|0} ms`);
      setDiag('diag-transport',transport);
      setDiag('diag-uplink',uplink);
      setDiag('diag-downlink',downlink);
      setDiag('diag-fps',fps==='--'?'--':`${fps} fps`);
      setDiag('diag-quality-mode',getCallQualityProfile().label);
    }catch{}
  },3000);
}
function attachLocalVideo(stream,callType){
  document.getElementById('local-video').srcObject=stream;
  const isVideo=callType==='video'&&stream.getVideoTracks().length>0;
  if(isVideo){
    document.getElementById('video-area').style.display='block';
    document.getElementById('local-video').style.display='block';
    document.getElementById('call-overlay').classList.add('has-video');
    document.getElementById('call-overlay').classList.remove('voice-only');
    document.getElementById('call-container').style.display='none';
    ['cam-wrap','quality-wrap','diag-wrap'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display='';});
    if(window.isSecureContext&&navigator.mediaDevices?.getDisplayMedia){const el=document.getElementById('share-wrap');if(el)el.style.display='';}
    if(document.fullscreenEnabled){const el=document.getElementById('fs-wrap');if(el)el.style.display='';}
    if(document.pictureInPictureEnabled){const el=document.getElementById('pip-wrap');if(el)el.style.display='';}
    refreshZoomCapabilities(stream.getVideoTracks()[0]);
    setCallQualityMode(App.callQualityMode,true);
  }else{
    App.zoomState={ supported:false, min:1, max:1, step:0.1, value:1 };
    updateZoomUI();
  }
}
function showCallOverlay(peer,status,callType){
  const overlay=document.getElementById('call-overlay');
  document.getElementById('call-avatar').textContent=peer.avatar||'👤';
  document.getElementById('call-peer-name-display').textContent=peer.name;
  setCallStatus(status);
  document.getElementById('call-err').style.display='none';
  overlay.style.display='flex';
  const q=document.getElementById('call-quality');if(q)q.style.display='none';
  const diag=document.getElementById('call-diagnostics');if(diag)diag.classList.toggle('hidden',!App.showCallDiagnostics);
  if(callType!=='video'){
    overlay.classList.remove('has-video');
    overlay.classList.add('voice-only');
    document.getElementById('call-container').style.display='';
    document.getElementById('video-area').style.display='none';
    document.getElementById('local-video').style.display='none';
    ['cam-wrap','flip-wrap','quality-wrap','diag-wrap','share-wrap','fs-wrap','pip-wrap'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display='none';});
    App.zoomState={ supported:false, min:1, max:1, step:0.1, value:1 };
    updateZoomUI();
  }else{
    overlay.classList.remove('voice-only');
  }
}
function setCallStatus(s){document.getElementById('call-status-display').textContent=s;}
function showCallErr(s){const el=document.getElementById('call-err');el.style.display='block';el.textContent=s;}
function showIncomingCall(data){
  App.incomingCallData=data;
  document.getElementById('incoming-avatar').innerHTML=esc(data.callerAvatar||'👤')+'<div class="presence"></div>';
  document.getElementById('incoming-name').textContent=data.callerName;
  document.getElementById('incoming-type').textContent=data.callType==='video'?'📹 Video Call':'📞 Voice Call';
  document.getElementById('incoming-call').style.display='flex';
  startRingtone();showPush('Incoming Call',`${data.callType==='video'?'Video':'Voice'} call from ${data.callerName}`,data.from);
  setTimeout(()=>{if(document.getElementById('incoming-call').style.display!=='none')declineCall();},30000);
}
async function acceptCall(){
  document.getElementById('incoming-call').style.display='none';stopRingtone();
  const data=App.incomingCallData;if(!data)return;
  App.activeCall={peerId:data.from,type:data.callType,outgoing:false};
  const peer=App.peers.get(data.from)||{name:data.callerName,avatar:data.callerAvatar};
  showCallOverlay(peer,'🔗 Connecting…',data.callType);
  wsSend({type:'call-accepted',to:data.from,from:App.me.id,callType:data.callType});
}
function declineCall(){
  document.getElementById('incoming-call').style.display='none';stopRingtone();
  if(App.incomingCallData){wsSend({type:'call-declined',to:App.incomingCallData.from,from:App.me.id});App.incomingCallData=null;}
}
function endCall(isRemote=false){
  clearInterval(App.callTimer);clearInterval(_qualityInterval);App.callSecs=0;stopRingtone();
  App.callStatsPrev=null;App.showCallDiagnostics=false;
  App.zoomState={ supported:false, min:1, max:1, step:0.1, value:1 };
  if(App.screenStream){App.screenStream.getTracks().forEach(t=>t.stop());App.screenStream=null;}
  if(App.mixedAudioCtx){App.mixedAudioCtx.close().catch(()=>{});App.mixedAudioCtx=null;}
  if(App.localStream){App.localStream.getTracks().forEach(t=>t.stop());App.localStream=null;}
  document.getElementById('remote-video').srcObject=null;
  document.getElementById('local-video').srcObject=null;
  if(App.activeCall){
    const pid=App.activeCall.peerId;
    if(!isRemote)wsSend({type:'call-ended',to:pid,from:App.me.id});
    try{App.callPCs.get(pid)?.close();}catch{}App.callPCs.delete(pid);App.activeCall=null;
  }
  if(document.pictureInPictureElement)document.exitPictureInPicture().catch(()=>{});
  if(document.fullscreenElement)(document.exitFullscreen||document.webkitExitFullscreen||function(){}).call(document).catch(()=>{});
  const ol=document.getElementById('call-overlay');
  ol.style.display='none';ol.classList.remove('has-video','controls-hidden','voice-only','minimized');
  ol.style.transform='';ol.dataset.tx='0';ol.dataset.ty='0';
  document.getElementById('call-container').style.display='';
  document.getElementById('video-area').style.display='none';
  document.getElementById('local-video').style.display='none';
  const q=document.getElementById('call-quality');if(q)q.style.display='none';
  const diag=document.getElementById('call-diagnostics');if(diag)diag.classList.add('hidden');
  updateZoomUI();
  const sb=document.getElementById('share-btn');if(sb)sb.classList.remove('screen-active');
  _muted=false;_camOff=false;_spkOff=false;
  const mb=document.getElementById('mute-btn');if(mb){mb.textContent='🎤';mb.classList.remove('toggled');}
  const cb=document.getElementById('cam-btn');if(cb){cb.textContent='📷';cb.classList.remove('toggled');}
  const spb=document.getElementById('speaker-btn');if(spb){spb.textContent='🔊';spb.classList.remove('toggled');}
  const pb=document.getElementById('pip-btn');if(pb)pb.textContent='⧉';
  const fb=document.getElementById('fs-btn');if(fb)fb.textContent='⛶';
  ['cam-wrap','flip-wrap','quality-wrap','diag-wrap','share-wrap','fs-wrap','pip-wrap'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display='none';});
  App.cameras=[];App.currentCameraIdx=0;App.currentFacingMode='user';
}
function startCallTimer(){
  clearInterval(App.callTimer);App.callSecs=0;
  App.callTimer=setInterval(()=>{App.callSecs++;const m=String(Math.floor(App.callSecs/60)).padStart(2,'0'),s=String(App.callSecs%60).padStart(2,'0');setCallStatus(`🟢 ${m}:${s}`);},1000);
}
let _muted=false,_camOff=false,_spkOff=false;
function toggleMute(){_muted=!_muted;App.localStream?.getAudioTracks().forEach(t=>{t.enabled=!_muted;});const b=document.getElementById('mute-btn');b.textContent=_muted?'🔇':'🎤';b.classList.toggle('toggled',_muted);}
function toggleCamera(){if(!App.localStream?.getVideoTracks().length)return;_camOff=!_camOff;App.localStream.getVideoTracks().forEach(t=>{t.enabled=!_camOff;});const b=document.getElementById('cam-btn');b.textContent=_camOff?'🚫':'📷';b.classList.toggle('toggled',_camOff);}
function toggleSpeaker(){_spkOff=!_spkOff;const rv=document.getElementById('remote-video');if(rv)rv.muted=_spkOff;const b=document.getElementById('speaker-btn');b.textContent=_spkOff?'🔇':'🔊';b.classList.toggle('toggled',_spkOff);}
let _retryCallType='audio';
function showPermModal(callType,isHTTPS=false){
  _retryCallType=callType;const iv=callType==='video';
  document.getElementById('perm-icon').textContent=iv?'📹':'🎤';
  document.getElementById('perm-title').textContent=iv?'Camera & Mic Needed':'Microphone Needed';
  document.getElementById('perm-desc').textContent=isHTTPS?'Calls need HTTPS. Add certs to server.js and restart.':`Allow ${iv?'camera & ':''}microphone to make ${iv?'video':'voice'} calls.`;
  document.getElementById('perm-modal').style.display='flex';endCall(false);
}
function closePerm(){document.getElementById('perm-modal').style.display='none';}
async function retryMedia(){closePerm();await initiateCall(_retryCallType);}

