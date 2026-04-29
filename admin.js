// ── E2EE Verification ────────────────────────────────────────────────
async function showVerifyModal() {
  if (!App.currentChat || isGroup(App.currentChat)) return;
  const peer = App.peers.get(App.currentChat) || App.historyPeers.get(App.currentChat);
  if (!peer) return;

  document.getElementById('verify-peer-name').textContent = peer.name;
  document.getElementById('verify-modal').classList.add('open');
  const box = document.getElementById('safety-number');
  box.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:8px 0;">Generating...</div>';

  if (!peer.pubKey || !E2E.pubKey64) {
    box.innerHTML = '<div style="color:var(--accent3);font-size:13px;padding:8px 0;">Public key not available.</div>';
    return;
  }

  const combined = E2E.pubKey64 < peer.pubKey ? E2E.pubKey64 + peer.pubKey : peer.pubKey + E2E.pubKey64;
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(combined));
  const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  const digits = hashHex.replace(/\D/g, '').substring(0, 30);
  const groups = Array.from({ length: 6 }, (_, i) => digits.substring(i * 5, i * 5 + 5));
  box.textContent = groups.join(' ');
}
function closeVerifyModal() {
  document.getElementById('verify-modal').classList.remove('open');
}
document.getElementById('verify-modal').addEventListener('click',function(e){if(e.target===this)closeVerifyModal();});

// ── Server Health ─────────────────────────────────────────────────────
let _healthTimer = null;
function openHealthModal() {
  document.getElementById('health-modal').classList.add('open');
  fetchHealth();
  _healthTimer = setInterval(fetchHealth, 2000);
}
function closeHealthModal() {
  document.getElementById('health-modal').classList.remove('open');
  clearInterval(_healthTimer);
}
document.getElementById('health-modal').addEventListener('click',function(e){if(e.target===this)closeHealthModal();});

async function fetchHealth() {
  try {
    const res = await fetch((App.serverBase || '') + '/api/health');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const grid = document.getElementById('health-grid');
    
    const formatUptime = (secs) => {
      const d = Math.floor(secs/86400), h = Math.floor((secs%86400)/3600), m = Math.floor((secs%3600)/60), s = Math.floor(secs%60);
      return `${d}d ${h}h ${m}m ${s}s`;
    };
    const sysMemUsed = data.memSystem.total - data.memSystem.free;
    const memPct = (sysMemUsed / data.memSystem.total * 100).toFixed(1);
    
    let diskHtml = '';
    let sysSpan = ''; // Default to no span since Base(6) + Net(1) + Sys(1) = 8 items (Even)
    if (data.diskSpace) {
      const diskPct = (data.diskSpace.total - data.diskSpace.free) / data.diskSpace.total * 100;
      diskHtml = `<div class="health-item"><span class="health-label">STORAGE FREE</span><span class="health-val ${diskPct > 90 ? 'bad' : diskPct > 80 ? 'warn' : ''}">${fmtBytes(data.diskSpace.free)}</span></div>`;
      sysSpan = 'style="grid-column:1/-1;"'; // 9 items total, span the last one to preserve UI
    }

    const netHtml = `<div class="health-item"><span class="health-label">APP TRAFFIC</span><span class="health-val" style="font-size:13px;white-space:nowrap;">↓ ${fmtBytes(data.networkRx||0)} &nbsp;↑ ${fmtBytes(data.networkTx||0)}</span></div>`;

    grid.innerHTML = `
      <div class="health-item"><span class="health-label">UPTIME</span><span class="health-val">${formatUptime(data.uptime)}</span></div>
      <div class="health-item"><span class="health-label">ACTIVE PEERS</span><span class="health-val good">${data.peersOnline}</span></div>
      <div class="health-item"><span class="health-label">CPU (SYSTEM)</span><span class="health-val ${data.cpuUsage > 85 ? 'bad' : data.cpuUsage > 70 ? 'warn' : ''}">${(data.cpuUsage||0).toFixed(1)}%</span></div>
      <div class="health-item"><span class="health-label">RAM (SYSTEM)</span><span class="health-val ${memPct > 85 ? 'bad' : memPct > 70 ? 'warn' : ''}">${memPct}%</span></div>
      <div class="health-item"><span class="health-label">RAM (PROCESS)</span><span class="health-val">${fmtBytes(data.memProcess.rss)}</span></div>
      <div class="health-item"><span class="health-label">LOAD AVG</span><span class="health-val">${data.loadAvg.map(n=>n.toFixed(2)).join(', ')}</span></div>
      ${diskHtml}
      ${netHtml}
      <div class="health-item" ${sysSpan}><span class="health-label">SYSTEM</span><span class="health-val" style="text-transform:capitalize;">${data.platform} / Node ${data.nodeVersion}</span></div>
    `;
    document.getElementById('health-dot').className = 'status-dot online';
  } catch(e) {
    document.getElementById('health-dot').className = 'status-dot error';
    document.getElementById('health-grid').innerHTML = `<div style="color:var(--accent3);font-size:13px;padding:8px 0;grid-column:1/-1;">Error: ${e.message}</div>`;
  }
}

// ── Admin Modal (Security & Settings) ────────────────────────────────
function switchAdminTab(tab, el) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('admin-' + tab + '-tab').classList.add('active');
}
function openAdminModal() {
  if (!App.me.isHost) return;
  document.getElementById('admin-modal').classList.add('open');
  wsSend({ type: 'get-server-config' });
  wsSend({ type: 'get-security' });
}
function closeAdminModal() { document.getElementById('admin-modal').classList.remove('open'); }
document.getElementById('admin-modal').addEventListener('click', e => { if(e.target===e.currentTarget) closeAdminModal(); });

function toggleProtectedMode(enabled) { wsSend({ type: 'toggle-security', enabled }); }
function formatMacInput(e) {
  let val = e.target.value.replace(/[^a-fA-F0-9]/g, '');
  if (val.length > 12) val = val.substring(0, 12);
  const parts = val.match(/.{1,2}/g);
  e.target.value = parts ? parts.join(':').toUpperCase() : val.toUpperCase();
}
function addMacAddress() {
  const macInp = document.getElementById('new-mac-input');
  const nameInp = document.getElementById('new-mac-name-input');
  const mac = macInp.value.trim();
  if (!mac) return;
  if (mac.replace(/[^a-fA-F0-9]/g, '').length !== 12) return toast('⚠️ Invalid MAC address length');
  wsSend({ type: 'add-mac', mac, name: nameInp.value.trim() });
  macInp.value = '';
  nameInp.value = '';
}
function removeMacAddress(mac) {
  if (mac === 'localhost') return toast('Cannot remove host MAC');
  wsSend({ type: 'remove-mac', mac });
}
function saveServerSettings() {
  const maxMb = parseInt(document.getElementById('cfg-max-mb').value, 10);
  const retDays = parseInt(document.getElementById('cfg-retention').value, 10);
  const maxAnn = parseInt(document.getElementById('cfg-max-announcements').value, 10);
  const allowGrp = document.getElementById('cfg-allow-groups').checked;
  if (isNaN(maxMb) || maxMb < 1) return toast('⚠️ Invalid max upload size');
  if (isNaN(retDays) || retDays < 0) return toast('⚠️ Invalid retention days');
  if (isNaN(maxAnn) || maxAnn < 1) return toast('⚠️ Invalid max announcements limit');
  wsSend({ type: 'update-server-config', config: { maxUploadMb: maxMb, retentionDays: retDays, maxAnnouncements: maxAnn, allowGroups: allowGrp } });
  toast('✅ Server settings saved');
}
function clearServerUploads() {
  if (!confirm('⚠️ Are you sure you want to delete ALL files stored on the server? This cannot be undone and files will break in existing chats.')) return;
  wsSend({ type: 'clear-uploads' });
  toast('🗑️ Clearing uploads...');
}
function clearNoticeBoard() {
  if (!confirm('⚠️ Are you sure you want to delete all announcements for everyone? This cannot be undone.')) return;
  wsSend({ type: 'clear-announcements' });
  toast('🗑️ Clearing notice board...');
}

