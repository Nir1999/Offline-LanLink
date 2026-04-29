// ── Audio ─────────────────────────────────────────────────────────────
let audioCtx;
function initAudio(){
  if(!audioCtx){
    try {
      audioCtx=new(window.AudioContext||window.webkitAudioContext)();
      const unlock = () => {
        if(audioCtx.state==='suspended') audioCtx.resume().catch(()=>{});
        ['click','touchstart','keydown'].forEach(e => document.removeEventListener(e, unlock));
      };
      ['click','touchstart','keydown'].forEach(e => document.addEventListener(e, unlock, {passive: true}));
    } catch(e) {}
  }
  if(audioCtx && audioCtx.state==='suspended') audioCtx.resume().catch(()=>{});
}
function playTone(freq,type,dur,vol=0.12){
  if(!audioCtx||audioCtx.state!=='running')return;
  const osc=audioCtx.createOscillator(),g=audioCtx.createGain();
  osc.type=type;osc.frequency.value=freq;osc.connect(g);g.connect(audioCtx.destination);
  g.gain.setValueAtTime(vol,audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+dur);
  osc.start();osc.stop(audioCtx.currentTime+dur);
}
function playMsgSound(){playTone(600,'sine',.15,.2);setTimeout(()=>playTone(820,'sine',.15,.2),110);}
let _ringTimer;
function startRingtone(){const r=()=>{playTone(400,'sine',.2,.25);setTimeout(()=>playTone(520,'sine',.2,.2),220);};r();_ringTimer=setInterval(r,1600);}
function stopRingtone(){clearInterval(_ringTimer);}

