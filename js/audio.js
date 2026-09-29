// 소리: 엔진음(합성) · 바람 · 경고음 · 음성 콜아웃(브라우저 음성합성)
export class Audio {
  constructor() {
    this.on = true;
    this.ctx = null;
    this.lastSay = {};
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.gain.value = 0.7; this.master.connect(ctx.destination);
    // 갈색 잡음 (엔진 저음·바람)
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; data[i] = last * 3.5; }
    const noise = () => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };
    // 엔진 저음
    this.rumbleF = ctx.createBiquadFilter(); this.rumbleF.type = 'lowpass'; this.rumbleF.frequency.value = 200;
    this.rumbleG = ctx.createGain(); this.rumbleG.gain.value = 0;
    noise().connect(this.rumbleF); this.rumbleF.connect(this.rumbleG); this.rumbleG.connect(this.master);
    // 팬 소리 (고음 윙)
    this.fan = ctx.createOscillator(); this.fan.type = 'sawtooth'; this.fan.frequency.value = 300;
    this.fanF = ctx.createBiquadFilter(); this.fanF.type = 'bandpass'; this.fanF.Q.value = 6; this.fanF.frequency.value = 600;
    this.fanG = ctx.createGain(); this.fanG.gain.value = 0;
    this.fan.connect(this.fanF); this.fanF.connect(this.fanG); this.fanG.connect(this.master); this.fan.start();
    this.whine = ctx.createOscillator(); this.whine.type = 'sine'; this.whine.frequency.value = 2400;
    this.whineG = ctx.createGain(); this.whineG.gain.value = 0;
    this.whine.connect(this.whineG); this.whineG.connect(this.master); this.whine.start();
    // 바람
    this.windF = ctx.createBiquadFilter(); this.windF.type = 'bandpass'; this.windF.frequency.value = 800; this.windF.Q.value = 0.5;
    this.windG = ctx.createGain(); this.windG.gain.value = 0;
    noise().connect(this.windF); this.windF.connect(this.windG); this.windG.connect(this.master);
    // 바퀴 굴림
    this.rollF = ctx.createBiquadFilter(); this.rollF.type = 'lowpass'; this.rollF.frequency.value = 120;
    this.rollG = ctx.createGain(); this.rollG.gain.value = 0;
    noise().connect(this.rollF); this.rollF.connect(this.rollG); this.rollG.connect(this.master);
  }

  setOn(on) { this.on = on; if (this.master) this.master.gain.value = on ? 0.7 : 0; if (!on && window.speechSynthesis) speechSynthesis.cancel(); }

  // 매 프레임
  update(fm, view, paused) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = paused ? 0 : 1;
    const n1 = Math.pow(Math.max(fm.spool, 0), 0.4);
    const inside = view === 'cockpit';
    const k = inside ? 0.45 : 1;
    const set = (p, v) => p.setTargetAtTime(v, t, 0.15);
    set(this.rumbleG.gain, s * k * (0.05 + 0.35 * fm.spool) * (inside ? 0.6 : 1));
    set(this.rumbleF.frequency, 120 + 380 * n1);
    set(this.fan.frequency, 120 + 520 * n1);
    set(this.fanF.frequency, 300 + 1500 * n1);
    set(this.fanG.gain, s * k * 0.05 * n1);
    set(this.whine.frequency, 1500 + 2600 * n1);
    set(this.whineG.gain, s * k * 0.006 * n1);
    const v = fm.d.V / 150;
    set(this.windG.gain, s * (inside ? 0.18 : 0.08) * Math.min(1.2, v * v));
    set(this.windF.frequency, 500 + 900 * Math.min(1.5, v));
    set(this.rollG.gain, s * (fm.onGround ? Math.min(0.4, fm.d.gs / 60) : 0));
  }

  tone(freqs, dur = 0.25, type = 'sine', vol = 0.25) {
    if (!this.ctx || !this.on) return;
    const t = this.ctx.currentTime;
    freqs.forEach((f, i) => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * dur); g.gain.linearRampToValueAtTime(vol, t + i * dur + 0.02);
      g.gain.linearRampToValueAtTime(0, t + (i + 1) * dur);
      o.connect(g); g.connect(this.master); o.start(t + i * dur); o.stop(t + (i + 1) * dur + 0.05);
    });
  }

  apOff(family) {
    if (family === 'airbus') this.tone([1100, 1500, 1100, 1500, 1100, 1500], 0.12, 'triangle', 0.18);
    else this.tone([880, 660, 880, 660], 0.18, 'square', 0.1);
  }
  chime() { this.tone([1300], 0.4, 'sine', 0.2); }
  clacker() { this.tone([2200, 0, 2200, 0], 0.07, 'square', 0.08); }

  // 영어 음성 콜아웃 (실제 조종실 콜아웃이 영어)
  say(text, key = text, minGap = 2) {
    if (!this.on || !window.speechSynthesis) return;
    const now = performance.now() / 1000;
    if (this.lastSay[key] && now - this.lastSay[key] < minGap) return;
    this.lastSay[key] = now;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US'; u.rate = 1.15; u.pitch = 0.9; u.volume = 0.9;
    const v = speechSynthesis.getVoices().find((x) => /en-US/.test(x.lang) && /Fred|Daniel|Alex|Samantha|Google US/.test(x.name));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }
}
