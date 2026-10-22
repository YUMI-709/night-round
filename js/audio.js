/* =========================================================
   audio.js  —— 全程序化音效（无外部音频文件）
   ========================================================= */
const Sfx = (() => {
  let ctx = null, master = null, drone = null, started = false;

  function init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
  }

  function resume() {
    init();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  const now = () => (ctx ? ctx.currentTime : 0);

  /* ---------- 基础音块 ---------- */
  function tone(freq, dur, type, vol, slideTo) {
    if (!ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, now());
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), now() + dur);
    g.gain.setValueAtTime(0, now());
    g.gain.linearRampToValueAtTime(vol, now() + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, now() + dur);
    o.connect(g); g.connect(master);
    o.start(now()); o.stop(now() + dur + 0.05);
  }

  function noise(dur, vol, lp, hp) {
    if (!ctx) return;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f1 = ctx.createBiquadFilter(); f1.type = 'lowpass'; f1.frequency.value = lp || 1200;
    const f2 = ctx.createBiquadFilter(); f2.type = 'highpass'; f2.frequency.value = hp || 60;
    const g = ctx.createGain(); g.gain.value = vol;
    src.connect(f1); f1.connect(f2); f2.connect(g); g.connect(master);
    src.start(now());
  }

  /* ---------- 环境低频嗡鸣 ---------- */
  function startDrone() {
    init();
    if (!ctx || drone) return;
    drone = ctx.createGain(); drone.gain.value = 0; drone.connect(master);
    [38, 57, 76, 114].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = i % 2 ? 'sawtooth' : 'triangle';
      o.frequency.value = f + Math.random() * 1.5;
      const g = ctx.createGain(); g.gain.value = 0.055 / (i + 1);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05 + i * 0.031;
      const lg = ctx.createGain(); lg.gain.value = 0.03;
      lfo.connect(lg); lg.connect(g.gain);
      o.connect(g); g.connect(drone); o.start(); lfo.start();
    });
    drone.gain.linearRampToValueAtTime(0.9, now() + 4);
  }

  /* 节流：setTargetAtTime 每次调用都会在 AudioParam 时间线上留下
     一个事件且不会自动清理，之前每帧调用 60 次/秒，几分钟后事件
     堆到上万条，音频线程被拖垮 → 整个页面越来越卡。现在最多
     200ms 一次，且数值变化可忽略时直接跳过。 */
  let tensionLast = -1, tensionSentAt = -1;
  function setTension(v01) { // 0..1
    if (!drone) return;
    const t = now();
    if (tensionSentAt >= 0 && t - tensionSentAt < 0.2) return;
    if (tensionLast >= 0 && Math.abs(v01 - tensionLast) < 0.015) return;
    tensionLast = v01; tensionSentAt = t;
    drone.gain.setTargetAtTime(0.55 + v01 * 0.9, t, 0.4);
    // 音乐跟着紧张度走：被追时八音盒沉下去、旋律开始走调
    musicWarp = v01;
    if (music) music.bus.gain.setTargetAtTime(0.9 - v01 * 0.55, t, 0.9);
  }

  function stopDrone() {
    if (!drone) return;
    drone.gain.setTargetAtTime(0, now(), 0.5);
    const d = drone; drone = null;
    setTimeout(() => { try { d.disconnect(); } catch (e) {} }, 2500);
  }

  /* ---------- 梦核八音盒 BGM（实时合成 · 无缝循环） ----------
     A 小调摇篮曲 × 八音盒音色 × 磁带音分漂移 × 回声延迟。
     梦核感来自三件事：走调的童谣、过长的尾音回声、慢半拍的呼吸感。 */
  let music = null;          // { bus, wet, gain, timer, idx, nextT }
  let musicWarp = 0;         // 0..1 紧张度 → 越危险旋律越走音
  const N = { A4: 440, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880 };
  const MB = {
    stepDur: 0.42,
    melody: [
      N.A4, 0, N.C5, 0, N.E5, 0, N.C5, 0,  N.B4, 0, N.D5, 0, N.B4, 0, 0, 0,
      N.A4, 0, N.C5, 0, N.E5, 0, N.A5, 0,  N.G5, 0, N.E5, 0, N.C5, 0, 0, 0,
      N.F5, 0, N.E5, 0, N.D5, 0, N.C5, 0,  N.B4, 0, N.D5, 0, N.F5, 0, N.E5, 0,
      N.A4, 0, N.C5, 0, N.E5, 0, N.C5, 0,  N.A4, 0, 0, 0, 0, 0, 0, 0,
    ],
    chords: [
      [110.00, 164.81, 261.63],   // Am
      [ 87.31, 174.61, 220.00],   // F
      [130.81, 164.81, 196.00],   // C
      [ 82.41, 123.47, 196.00],   // Em
    ],
  };

  /** 八音盒音符：正弦主音 + 4.1 倍泛音，带慢速音高漂移（磁带感） */
  function bell(freq, t, vel) {
    const cents = (Math.random() * 2 - 1) * 5 + musicWarp * musicWarp * 26;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.value = freq * Math.pow(2, cents / 1200);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.3 + Math.random() * 0.5;
    const lg = ctx.createGain(); lg.gain.value = freq * 0.004;
    lfo.connect(lg); lg.connect(o.frequency);
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 4.1;
    const g2 = ctx.createGain(); g2.gain.value = 0.10;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0006, t + 2.6);
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(music.bus);
    [o, o2, lfo].forEach(x => { x.start(t); x.stop(t + 2.8); });
  }

  /** 铺底和弦：极轻的三角波，长起长落，像隔着墙听到的旧音乐 */
  function pad(freqs, t, dur) {
    freqs.forEach(f => {
      const o = ctx.createOscillator(); o.type = 'triangle';
      o.frequency.value = f;
      o.detune.value = (Math.random() * 2 - 1) * 9 + musicWarp * 18;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.026, t + 1.4);
      g.gain.setValueAtTime(0.026, t + dur - 1.2);
      g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(g); g.connect(music.bus);
      o.start(t); o.stop(t + dur + 0.1);
    });
  }

  function startMusic() {
    init();
    if (!ctx || music) return;
    const bus = ctx.createGain(); bus.gain.value = 0;
    // 干声
    bus.connect(master);
    // 回声：延迟 → 低通（把回声磨旧）→ 反馈，梦核的长尾
    const dly = ctx.createDelay(2); dly.delayTime.value = 0.63;
    const fb = ctx.createGain(); fb.gain.value = 0.44;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2100;
    const wet = ctx.createGain(); wet.gain.value = 0.55;
    bus.connect(dly); dly.connect(lp); lp.connect(fb); fb.connect(dly);
    lp.connect(wet); wet.connect(master);
    music = { bus, wet, timer: 0, idx: 0, nextT: now() + 0.3 };
    bus.gain.linearRampToValueAtTime(0.9, now() + 5);
    // 前瞻调度器：永远提前 0.6s 排音符，循环无缝
    const tick = () => {
      if (!music || !ctx) return;
      const t0 = now();
      while (music.nextT < t0 + 0.6) {
        const i = music.idx, m = MB.melody.length;
        const note = MB.melody[i % m];
        if (note) bell(note, music.nextT, 0.15 + Math.random() * 0.03);
        if (i % 16 === 0)
          pad(MB.chords[(i / 16) % MB.chords.length | 0], music.nextT, 16 * MB.stepDur);
        music.idx++; music.nextT += MB.stepDur;
      }
    };
    tick();
    music.timer = setInterval(tick, 240);
  }

  function stopMusic() {
    if (!music) return;
    const m = music; music = null;
    clearInterval(m.timer);
    m.bus.gain.setTargetAtTime(0, now(), 0.9);
    setTimeout(() => { try { m.bus.disconnect(); m.wet.disconnect(); } catch (e) {} }, 4500);
  }

  /* ---------- 具体音效 ---------- */
  const api = {
    resume, startDrone, stopDrone, setTension, startMusic, stopMusic,

    /** 全体骤停：被抓瞬间的「绝对安静」——比任何音效都可怕 */
    stopAll() { try { stopDrone(); stopMusic(); } catch (e) {} },

    /** 艾尔海森查房敲门：咚、咚、咚（低频闷响） */
    knock() {
      if (!ctx) return;
      for (let i = 0; i < 3; i++) {
        const t0 = now() + i * 0.34;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(115, t0);
        o.frequency.exponentialRampToValueAtTime(58, t0 + 0.16);
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.30, t0 + 0.014);
        g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.22);
        o.connect(g); g.connect(master);
        o.start(t0); o.stop(t0 + 0.3);
      }
    },

    /** 玩家脚步 step: 0=轻 1=正常 2=跑 */
    step(kind) {
      const v = kind === 2 ? 0.20 : kind === 0 ? 0.045 : 0.10;
      noise(0.075, v, kind === 2 ? 2600 : 900, 90);
      if (kind === 2) tone(120 + Math.random() * 40, 0.07, 'triangle', 0.05);
    },

    /** 艾尔海森脚步（按距离衰减由外部算好） */
    doctorStep(vol) {
      if (vol <= 0.004) return;
      noise(0.11, Math.min(0.4, vol), 480, 45);
      tone(78, 0.14, 'sine', Math.min(0.22, vol * 0.9), 52);
    },

    heartbeat(intensity) { // 0..1
      const v = 0.10 + intensity * 0.34;
      tone(56, 0.16, 'sine', v, 34);
      setTimeout(() => tone(48, 0.20, 'sine', v * 0.72, 28), 168);
    },

    pickup() {
      tone(880, 0.14, 'square', 0.10);
      setTimeout(() => tone(1320, 0.22, 'square', 0.085), 105);
      setTimeout(() => tone(1760, 0.34, 'sine', 0.06), 230);
    },

    door() {
      noise(0.55, 0.22, 700, 40);
      tone(92, 0.5, 'sawtooth', 0.08, 60);
    },

    locked() {
      tone(180, 0.09, 'square', 0.13);
      setTimeout(() => tone(150, 0.13, 'square', 0.11), 95);
    },

    /** 被发现 —— 尖锐刺耳 */
    spotted() {
      tone(1900, 0.5, 'sawtooth', 0.13, 380);
      noise(0.6, 0.30, 5200, 400);
      setTimeout(() => tone(1400, 0.7, 'sawtooth', 0.10, 240), 130);
    },

    /** 抓住 —— 重击 + 耳鸣 */
    caught() {
      noise(0.9, 0.55, 900, 30);
      tone(70, 1.6, 'sawtooth', 0.30, 34);
      setTimeout(() => tone(2960, 2.2, 'sine', 0.10, 2760), 120);
      setTimeout(() => tone(2210, 1.4, 'sine', 0.06), 240);
    },

    /** 胜利 —— 门外夜风 */
    escape() {
      noise(2.4, 0.18, 3200, 120);
      [523, 659, 784, 1046].forEach((f, i) =>
        setTimeout(() => tone(f, 1.1, 'triangle', 0.10), i * 210));
    },

    /** 远处金属声 / 随机惊吓 */
    scare() {
      const pick = Math.random();
      if (pick < 0.4) { noise(0.35, 0.16, 3000, 600); }
      else if (pick < 0.75) { tone(320, 0.5, 'square', 0.07, 96); }
      else { noise(0.7, 0.13, 400, 30); tone(46, 0.9, 'sine', 0.10, 30); }
    },

    /** 翻找 / 抽屉 */
    rustle() { noise(0.28, 0.10, 1600, 200); },

    get ready() { return !!ctx; }
  };

  return api;
})();
