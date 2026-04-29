// ── E2EE ─────────────────────────────────────────────────────────────
const E2E = {
  enabled: !!(window.crypto && window.crypto.subtle),
  keyPair: null, pubKey64: null,
  shared: new Map(),
};
function idbKeyStore(key, val) {
  return new Promise((res, rej) => {
    const req = indexedDB.open('LanLinkE2E', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('keys');
    req.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction('keys', 'readwrite');
      const st = tx.objectStore('keys');
      const act = val !== undefined ? st.put(val, key) : st.get(key);
      act.onsuccess = () => res(act.result);
      act.onerror = () => rej(act.error);
              act.onsuccess = () => { res(act.result); db.close(); };
              act.onerror = () => { rej(act.error); db.close(); };
    };
    req.onerror = () => rej(req.error);
  });
}
async function initE2E() {
  if(!E2E.enabled) return;
  try {
    if(localStorage.getItem('lanlink_e2e_priv')){ localStorage.removeItem('lanlink_e2e_priv'); localStorage.removeItem('lanlink_e2e_pub'); }
    let storedPair = await idbKeyStore('keyPair');
    let storedPub64 = await idbKeyStore('pubKey64');
    if(storedPair && storedPub64) {
      E2E.keyPair = storedPair;
      E2E.pubKey64 = storedPub64;
    } else {
      E2E.keyPair = await crypto.subtle.generateKey({name:"ECDH", namedCurve:"P-256"}, false, ["deriveKey","deriveBits"]);
      const pubRaw = await crypto.subtle.exportKey("spki", E2E.keyPair.publicKey);
      E2E.pubKey64 = btoa(String.fromCharCode(...new Uint8Array(pubRaw)));
      await idbKeyStore('keyPair', E2E.keyPair);
      await idbKeyStore('pubKey64', E2E.pubKey64);
    }
  } catch(e) { E2E.enabled = false; console.warn("E2E init failed", e); }
}
async function getSharedKey(pid) {
  if(E2E.shared.has(pid)) return E2E.shared.get(pid);
  const peer = App.peers.get(pid) || App.historyPeers.get(pid);
  if(!peer || !peer.pubKey) return null;
  try {
    const raw = Uint8Array.from(atob(peer.pubKey), c => c.charCodeAt(0));
    const pKey = await crypto.subtle.importKey("spki", raw, {name:"ECDH", namedCurve:"P-256"}, true, []);
    const sKey = await crypto.subtle.deriveKey({name:"ECDH", public:pKey}, E2E.keyPair.privateKey, {name:"AES-GCM", length:256}, false, ["encrypt","decrypt"]);
    E2E.shared.set(pid, sKey); return sKey;
  } catch(e) { return null; }
}
async function encryptMsg(pid, payload) {
  if(!E2E.enabled) return payload; const key = await getSharedKey(pid); if(!key) return payload;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({name:"AES-GCM", iv}, key, new TextEncoder().encode(JSON.stringify(payload)));
  return { e2ee: true, iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...new Uint8Array(enc))) };
}
async function decryptMsg(pid, payload) {
  if(!payload.e2ee || !E2E.enabled) return payload; const key = await getSharedKey(pid); if(!key) return null;
  try {
    const iv = Uint8Array.from(atob(payload.iv), c => c.charCodeAt(0));
    const data = Uint8Array.from(atob(payload.data), c => c.charCodeAt(0));
    const dec = await crypto.subtle.decrypt({name:"AES-GCM", iv}, key, data);
    return JSON.parse(new TextDecoder().decode(dec));
  } catch(e) { return null; }
}

