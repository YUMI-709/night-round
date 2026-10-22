/* =========================================================
   game.js —— 主循环 / 玩家 / 关卡目标 / 氛围调度
   ========================================================= */
(() => {
  /* ---- 音频方法兜底补丁 ----
     线上曾出现「Sfx.stopAll is not a function」：浏览器缓存了旧版 audio.js，
     而新版 game.js 调用了新增方法 → 新旧文件错配直接崩。
     这里把缺失的方法补成空实现：宁可那一刻没声音，也绝不让游戏崩掉。 */
  const SFX_REQUIRED = ['stopAll', 'knock', 'startMusic', 'stopMusic', 'startDrone',
    'stopDrone', 'setTension', 'doctorStep', 'step', 'heartbeat', 'pickup', 'door',
    'locked', 'spotted', 'caught', 'escape', 'scare', 'rustle', 'resume'];
  function patchSfx() {
    let fixed = 0;
    SFX_REQUIRED.forEach(k => {
      try {
        if (!Sfx || typeof Sfx[k] !== 'function') { Sfx[k] = function () {}; fixed++; }
      } catch (e) { /* Sfx 都没有时，后续调用由各处 try 包住 */ }
    });
    return fixed;
  }
  patchSfx();

  const cv = document.getElementById('screen');
  const subEl = document.getElementById('sub');
  const keysEl = document.getElementById('keys');
  const objEl = document.getElementById('objective');
  const statusEl = document.getElementById('status');
  const pulseEl = document.getElementById('pulse');
  const hintEl = document.getElementById('hint');
  const panels = {
    warn: document.getElementById('p-warn'),
    title: document.getElementById('p-title'),
    pause: document.getElementById('p-pause'),
    lose: document.getElementById('p-lose'),
    win: document.getElementById('p-win'),
    egg: document.getElementById('p-egg'),
    fail: document.getElementById('p-fail'),
    third: document.getElementById('p-third'),   // 结局三：三振出局
    stay: document.getElementById('p-stay'),     // 结局四：自愿留下
  };

  /* ---------------- 初始化世界 ---------------- */
  World.build();
  World.buildTextures();
  World.buildSprites();
  // 走廊两侧挂病房门（纯装饰，仍是实体墙）
  (() => {
    const g = World.grid(), T = World.T;
    const putDoor = (x, y) => {
      if (x < 1 || y < 1 || x > World.W - 2 || y > World.H - 2) return;
      if (g[y][x] !== T.WALL && g[y][x] !== T.ROT) return;
      g[y][x] = T.DOOR;
    };
    World.ROOMS.forEach(r => {
      // 左 / 右 / 上 / 下 外墙，隔一段挂一扇门
      for (let y = r.y + 1; y < r.y + r.h - 1; y += 3) { putDoor(r.x - 1, y); putDoor(r.x + r.w, y + 1); }
      for (let x = r.x + 1; x < r.x + r.w - 1; x += 4) { putDoor(x + 1, r.y - 1); putDoor(x, r.y + r.h); }
      // 房间四角各挂一扇，密度看起来更像住院部
      putDoor(r.x, r.y + 1); putDoor(r.x + r.w - 1, r.y + r.h);
    });
  })();
  const DECOS = World.decorate();

  /* ---- 环境叙事数据（文案在下方 kv 定义后组装） ---- */
  const loreSeen = { board: false, strap: false, sheet: false };
  const loreItems = (() => {
    const arr = [];
    DECOS.forEach(d => {
      const key = Object.keys(World.SPR).find(k => World.SPR[k] === d.spr);
      if (key === 'board' || key === 'strap' || key === 'sheet') arr.push({ key, x: d.x, y: d.y });
    });
    return arr;
  })();
  function checkLore() {
    if (subT > 0) return;
    for (const it of loreItems) {
      if (loreSeen[it.key]) continue;
      if (Math.hypot(it.x - P.x, it.y - P.y) < 2.1) {
        loreSeen[it.key] = true;
        say(LORE_TEXT[it.key], 5.2);
        return;
      }
    }
  }

  Renderer.init(cv);
  const R = Renderer;

  /** 内部分辨率随窗口自适应：缩放取整数倍，像素才不会糊/闪 */
  let perfScale = 1;   // 卡顿时自动下调（0.8 → 0.66 → 0.55 → 0.45 封底）
  function fitCanvas() {
    try {
      const wrap = document.getElementById('wrap');
      const bw = wrap && wrap.clientWidth, bh = wrap && wrap.clientHeight;
      if (!bw || !bh) return;
      const zoom = Math.max(2, Math.round(bw / 480));
      let w = Math.round(bw / zoom) * perfScale;
      w = Math.max(256, Math.min(720, w));
      let h = Math.round(w * bh / bw);
      h = Math.max(160, Math.min(450, h));
      if (cv.width === w && cv.height === h) return;
      cv.width = w; cv.height = h;
      R.init(cv);
    } catch (e) { /* 拿不到尺寸就沿用默认值 */ }
  }
  fitCanvas();
  addEventListener('resize', fitCanvas);

  /* ---------------- 玩家 ---------------- */
  const P = {
    x: 15.5, y: 3.5, a: Math.PI / 2,
    vx: 0, vy: 0, moveSpeed: 0, bob: 0, bobT: 0,
    stam: 1, bumpT: 0, pickT: 0, hurt: 0,
  };
  const FOV = 0.72;

  /* ---------------- 关卡状态 ---------------- */
  let doctor, cards, permit, state = 'title', t0 = 0, playT = 0;
  let caughtCount = 0, spooked = 0;
  let totalCaught = 0;          // 累计被抓次数（跨重试，结局三用）
  let spottedThisRun = false;   // 本局是否被医师发现过（结局五用）
  let stayShown = false;        // 出口选择浮层是否显示
  let eggTarget = 'end2';       // 通关面板「几天后」按钮指向的彩蛋
  let flicker = 1, blackout = 0, flashT = 0, scareT = 14, beatT = 0, hintT = 0;
  let tension = 0, subT = 0, chaseAnnounced = false;
  let twoCardT = 0;   // 集齐两张后计时，每 3 分钟提示第三张卡的位置

  const CANDIDATE_ROOMS = ['药房', '档案室', '太平间', '手术室', '值班室', '接待大厅'];

  function resetLevel() {
    // 清掉上一次被抓残留的红闪层与定时器（重试时必须是干净画面）
    hitClear();
    if (hitEl) hitEl.classList.remove('play');
    hideMirror();      // 镜面也一并收起（白大褂只在整页第一次照镜时闪）
    P.x = 15.5; P.y = 3.5; P.a = Math.PI / 2;
    P.vx = P.vy = 0; P.stam = 1; P.bumpT = 0; P.pickT = 0;
    doctor = new Doctor(14.5, 12.5);
    // 三张门禁卡，随机分布在候选房间
    const pool = CANDIDATE_ROOMS.slice();
    cards = [];
    for (let i = 0; i < 3; i++) {
      const name = pool.splice((Math.random() * pool.length) | 0, 1)[0];
      const r = World.ROOMS.find(rr => rr.n === name);
      let px = r.x + 0.5 + Math.random() * (r.w - 1);
      let py = r.y + 0.5 + Math.random() * (r.h - 1);
      if (!World.walkable(px, py)) { px = r.x + 0.5; py = r.y + 0.5; }
      cards.push({ x: px, y: py, got: false, room: name, bob: Math.random() * 6 });
    }
    // 出院许可单：固定刷在值班室（离艾尔海森巡逻路线最近的高危房间）
    {
      const r = World.ROOMS.find(rr => rr.n === '值班室') || World.ROOMS[0];
      let px = r.x + 0.5 + Math.random() * (r.w - 1);
      let py = r.y + 0.5 + Math.random() * (r.h - 1);
      if (!World.walkable(px, py)) { px = r.x + 0.5; py = r.y + 0.5; }
      permit = { x: px, y: py, got: false, bob: Math.random() * 6 };
    }
    playT = 0; caughtCount = 0; spooked = 0; twoCardT = 0;
    spottedThisRun = false; stayShown = false;
    flicker = 1; blackout = 0; flashT = 0; scareT = 12 + Math.random() * 10;
    beatT = 0; tension = 0; subT = 0; chaseAnnounced = false;
    hudSig = '';   // 强制下一帧刷新 HUD
    updateHUD();
  }

  /* ---------------- 字幕 ---------------- */
  function say(html, dur) {
    subEl.innerHTML = html;
    subEl.style.opacity = 1;
    subT = dur || 3.6;
  }
  const ea = t => '<span class="who ea">艾尔海森</span>　' + t;
  const kv = t => '<span class="who">卡维</span>　' + t;

  /* ---- 环境叙事：靠近特定物件时的一次性旁白 ---- */
  const LORE_TEXT = {
    board: kv('值班室的黑板：「0709 号患者，情况稳定」——「稳定」两个字被划掉，又写上。反反复复，写了七遍。'),
    strap: kv('床脚有一副约束带——是被硬挣断的，断口还很新。床单拖到了地上。'),
    sheet: kv('太平间的签收单。主治医师签名栏——每一张，都是同一个名字。'),
  };

  /* ---- 彩蛋·活镜子：镜子贴在病房 B 的墙上，倒影实时跟随玩家
         （渲染器里的空间镜像，路过时会在玻璃里滑动）。可重复照，
         只有第一次镜中深处会闪过艾尔海森的白大褂——纯幻觉：无声、
         不惊动 AI、医生的真实位置一动不动，回头永远只剩空走廊。 ---- */
  const mirrorItems = DECOS.filter(d => d.spr === World.SPR.mirror)
    .map(d => ({ x: d.x, y: d.y, nx: d.nx || 0, ny: d.ny || 1 }));
  const MIRROR_FIRST =
    '镜子里的你比记忆中瘦。<br>玻璃下压着一张便签，是他的字迹：' +
    '「体重持续下降。原因：拒食，与逃跑念头成正比。已记录。」<br>' +
    '<span class="dim">—— 镜子深处，白大褂一闪。你猛地回头。走廊是空的。</span>';
  const MIRROR_AGAIN =
    '镜子里的你，还是那么瘦。<br>' +
    '<span class="dim">玻璃下压着的便签还在。你把它读了一遍，又一遍。</span>';
  let mirrorSeen = false;        // 白大褂是否已经闪过（整页只闪一次）
  let mirrorActive = false;      // 镜前字幕是否正在显示
  let mirrorT = 0;               // 字幕剩余时间
  let mirrorDur = 1;             // 本次字幕总时长（算白大褂闪过的时间轴用）
  let mirrorLock = false;        // 站在镜前时不重复触发，走开后才解锁
  let mirrorLastGhost = false;   // 本次照镜是否带了白大褂一闪（供回归测试观察）
  function showMirror() {
    const first = !mirrorSeen;
    mirrorSeen = true;
    mirrorLastGhost = first;
    mirrorActive = true; mirrorLock = true;
    mirrorDur = first ? 5.2 : 3.2;
    mirrorT = mirrorDur;
    say(first ? MIRROR_FIRST : MIRROR_AGAIN, mirrorDur);
  }
  function hideMirror() {
    mirrorActive = false; mirrorT = 0;
    if (subT > 0) { subT = 0; subEl.style.opacity = 0; }
  }
  /** 白大褂在镜中的透明度时间轴：0.78s 后亮起 → 0.95s 全亮 → 1.5s 消失 */
  function ghostAlpha() {
    if (!mirrorActive || !mirrorLastGhost) return 0;
    const t = mirrorDur - mirrorT;
    if (t < 0.78) return 0;
    if (t < 0.95) return (t - 0.78) / 0.17 * 0.85;
    if (t < 1.5) return 0.85 * (1 - (t - 0.95) / 0.55);
    return 0;
  }
  function checkMirror(dt) {
    if (!mirrorItems.length) return;
    let d = Infinity;
    for (const m of mirrorItems) {
      const dd = Math.hypot(m.x - P.x, m.y - P.y);
      if (dd < d) d = dd;
    }
    if (mirrorActive) {                 // 到点或走开就收字幕（倒影一直在）
      mirrorT -= dt;
      if (mirrorT <= 0) { mirrorActive = false; mirrorT = 0; }
      if (d > 3.6) hideMirror();
      return;
    }
    if (d > 1.95) { mirrorLock = false; return; }   // 离开镜前 → 解锁，可以再看
    if (mirrorLock) return;
    showMirror();
  }

  /* ---------------- HUD ---------------- */
  let hudSig = '';
  function updateHUD() {
    const got = cards ? cards.filter(c => c.got).length : 0;
    const hasP = !!(permit && permit.got);
    const full = Math.round(P.stam * 10);
    // 内容没变就别重写 innerHTML（重排成本高，是之前发卡的诱因之一）
    const sig = got + '|' + full + '|' + (hasP ? 1 : 0);
    if (sig === hudSig) return;
    hudSig = sig;
    let s = '';
    for (let i = 0; i < 3; i++) s += `<span class="${i < got ? '' : 'off'}">◆</span>`;
    let bar = '';
    for (let i = 0; i < 10; i++) bar += `<span class="${i < full ? '' : 'off'}">▮</span>`;
    keysEl.innerHTML = `门禁卡 ${s} · 许可单 <span class="${hasP ? '' : 'off'}">✦</span><br><span style="color:#7a6f66;font-size:.85em">体力 </span><span style="font-size:.85em">${bar}</span>`;
    objEl.innerHTML = got < 3
      ? '目标：<b>找到 3 张门禁卡</b> · 南侧消防通道'
      : hasP
        ? '目标：<b>前往南侧消防通道 EXIT</b>'
        : '目标：<b>值班室 · 拿到签好字的出院许可单</b>';
  }

  /* ---------------- 结局收集（localStorage 持久化，失败则静默降级） ---------------- */
  const EGG_LABEL = {
    end1: '失败之后', end2: '几天后', end5: '被放走的人',
  };
  function loadSeen() {
    try { return JSON.parse(localStorage.getItem('nr_endings') || '[]') || []; }
    catch (e) { return []; }
  }
  function saveSeen(a) { try { localStorage.setItem('nr_endings', JSON.stringify(a)); } catch (e) {} }
  let seenEndings = loadSeen();
  function markEnding(id) {
    if (seenEndings.includes(id)) return;
    seenEndings.push(id);
    saveSeen(seenEndings);
    renderBadges();
  }
  function renderBadges() {
    const box = document.getElementById('end-badges');
    if (!box) return;
    const names = { 1: '逃跑失败', 2: '逃出去了', 3: '特殊病房', 4: '自愿留下', 5: '被放走的' };
    box.innerHTML = Object.keys(names).map(k =>
      `<span class="bdg ${seenEndings.includes(k) ? 'on' : 'off'}" title="${names[k]}">◆</span>`
    ).join('') + '<span class="bdg-label">结局收集</span>';
  }

  /* ---------------- 输入 ---------------- */
  const K = {};
  addEventListener('keydown', e => {
    K[e.code] = true;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    if (e.code === 'KeyE' && state === 'play') {
      if (stayShown) { hideStayChoice(); win(); return; }   // 出口浮层：E = 离开
      tryPick();
    }
    if (e.code === 'KeyQ' && state === 'play' && stayShown) { endingStay(); return; }
    if (e.code === 'Escape' && state === 'play') togglePause(true);
    if (state === 'title' && (e.code === 'Enter' || e.code === 'Space' || e.code === 'NumpadEnter')) startGame();
    if (state === 'egg' && (e.code === 'Enter' || e.code === 'Space' || e.code === 'NumpadEnter')) eggAdvance(false);
  });
  addEventListener('keyup', e => { K[e.code] = false; });

  /** 指针锁定：浏览器在 ESC 退出后短时间内会抛 SecurityError，需要延迟 + 兜底 */
  function lockPointer(delay) {
    const go = () => {
      try {
        if (cv.requestPointerLock && document.pointerLockElement !== cv) {
          const p = cv.requestPointerLock();
          if (p && p.catch) p.catch(() => {});
        }
      } catch (e) { /* 忽略：无手势 / 冷却期 */ }
    };
    if (delay) setTimeout(go, delay); else go();
  }
  cv.addEventListener('click', () => {
    if (state === 'title') { startGame(); return; }      // 点画面也能开始
    if (state === 'lose' || state === 'win') return;
    lockPointer(0);
  });
  // 视角异常自转的修复：1) 位移尖峰过滤（重锁指针瞬间浏览器会报一个大位移）
  // 2) 失焦/切页/暂停时清空全部按键状态（keyup 丢失会导致方向键"永远按着"）
  function clearKeys() { for (const k in K) { if (k !== 'MouseDown') K[k] = false; } }
  addEventListener('blur', clearKeys);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearKeys(); });
  document.addEventListener('mousemove', e => {
    if (state !== 'play') return;
    const mx = e.movementX || 0;
    if (Math.abs(mx) > 300) return;          // 尖峰过滤
    if (document.pointerLockElement === cv) P.a += mx * 0.0026;
    else if (K.MouseDown) P.a += mx * 0.004;
  });
  cv.addEventListener('mousedown', () => { K.MouseDown = true; });
  addEventListener('mouseup', () => { K.MouseDown = false; });
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== cv) {
      clearKeys();
      if (state === 'play') togglePause(true);
    }
  });

  /* ---------------- 触屏支持（手机 / 平板） ----------------
     左半屏：虚拟摇杆移动（模拟量，轻推慢走）
     右半屏：滑动转头
     按钮：拾取 / 跑(切换) / 蹲(切换) / 暂停 */
  P.touch = { vx: 0, vy: 0, run: false, crouch: false };
  (() => {
    const coarse = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window;
    if (!coarse) return;
    document.body.classList.add('touch');
    const hintBar = document.getElementById('hint');
    if (hintBar) hintBar.textContent = '左半屏摇杆移动 · 右半屏滑动转头 · 右下按钮：拾取 / 跑 / 蹲';
    const joyBase = document.getElementById('joy-base');
    const joyKnob = document.getElementById('joy-knob');
    const R = Math.min(75, innerWidth * 0.17);
    const T = { joy: -1, jx: 0, jy: 0, bx: 0, by: 0, look: -1, lx: 0 };

    const btn = id => document.getElementById(id);
    btn('tb-use').addEventListener('touchstart', e => { e.preventDefault(); if (state === 'play') tryPick(); }, { passive: false });
    btn('tb-run').addEventListener('touchstart', e => {
      e.preventDefault();
      P.touch.run = !P.touch.run; P.touch.crouch = false;
      btn('tb-run').classList.toggle('on', P.touch.run);
      btn('tb-crouch').classList.remove('on');
    }, { passive: false });
    btn('tb-crouch').addEventListener('touchstart', e => {
      e.preventDefault();
      P.touch.crouch = !P.touch.crouch; P.touch.run = false;
      btn('tb-crouch').classList.toggle('on', P.touch.crouch);
      btn('tb-run').classList.remove('on');
    }, { passive: false });
    btn('tb-pause').addEventListener('touchstart', e => { e.preventDefault(); if (state === 'play') togglePause(true); }, { passive: false });

    function joyShow(x, y) {
      joyBase.style.display = 'block';
      joyBase.style.left = (x - joyBase.offsetWidth / 2) + 'px';
      joyBase.style.top = (y - joyBase.offsetHeight / 2) + 'px';
      joyKnob.style.transform = 'translate(-50%,-50%)';
    }
    function joySet(dx, dy) {
      const d = Math.hypot(dx, dy), m = d > R ? R / d : 1;
      let kx = dx * m, ky = dy * m;
      // 死区：推杆在中心 15% 内视为不动，防止手托住屏幕时缓慢漂移
      const nd = Math.hypot(kx, ky);
      if (nd < R * 0.15) { kx = 0; ky = 0; }
      joyKnob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;
      P.touch.vx = kx / R; P.touch.vy = ky / R;
    }
    function joyEnd() {
      joyBase.style.display = 'none';
      P.touch.vx = P.touch.vy = 0; T.joy = -1;
    }

    cv.addEventListener('touchstart', e => {
      e.preventDefault();
      Sfx.resume();
      for (const t of e.changedTouches) {
        if (t.clientX < innerWidth * 0.45 && T.joy === -1) {
          T.joy = t.identifier; T.bx = t.clientX; T.by = t.clientY;
          joyShow(t.clientX, t.clientY); joySet(0, 0);
        } else if (T.look === -1) {
          T.look = t.identifier; T.lx = t.clientX;
        }
      }
    }, { passive: false });
    cv.addEventListener('touchmove', e => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === T.joy) joySet(t.clientX - T.bx, t.clientY - T.by);
        else if (t.identifier === T.look) {
          if (state === 'play') P.a += (t.clientX - T.lx) * 0.0068;
          T.lx = t.clientX;
        }
      }
    }, { passive: false });
    const end = e => {
      for (const t of e.changedTouches) {
        if (t.identifier === T.joy) joyEnd();
        else if (t.identifier === T.look) T.look = -1;
      }
    };
    cv.addEventListener('touchend', end);
    cv.addEventListener('touchcancel', end);
    addEventListener('blur', () => joyEnd());
  })();

  /* ---------------- 面板控制 ---------------- */
  function showPanel(name) {
    Object.keys(panels).forEach(k => panels[k].classList.toggle('show', k === name));
    hintEl.style.display = name === 'title' ? 'none' : '';
    hideStayChoice();   // 任何面板出现时都收起出口选择浮层
  }
  function togglePause(on) {
    if (on && state === 'play') { state = 'pause'; renderBadges(); showPanel('pause'); }
    else if (!on && state === 'pause') {
      state = 'play'; showPanel(''); hideAll();
      lockPointer(160);
    }
  }
  function hideAll() { Object.values(panels).forEach(p => p.classList.remove('show')); }

  /* 内容预警：未点确认按钮前，任何入口都不能开始游戏 */
  let warned = false;
  document.getElementById('btn-warn-ok').onclick = () => {
    warned = true;
    panels.warn.classList.remove('show');
    panels.title.classList.add('show');
  };

  function startGame() {
    if (!warned) return;              // 预警未确认，禁止开始
    if (state === 'play') return;
    Sfx.resume(); Sfx.startDrone(); Sfx.startMusic();
    resetLevel(); state = 'play'; hideAll();
    lockPointer(0);
    // 立刻给一条明确的操作提示，让人一眼看出"游戏已经开始了"
    say('WASD 移动 · 鼠标转头 · <b>E</b> 拾取 · 集齐 3 张门禁卡与出院许可单，从南侧消防通道逃出去', 4.2);
    setTimeout(() => say(kv('……手腕上没有约束带了。门开着一道缝。'), 4.5), 4300);
  }
  document.getElementById('btn-start').onclick = startGame;
  // 兜底：整个标题界面任意处点击都能开始，避免"点了没反应"
  panels.title.addEventListener('click', () => { if (state === 'title') startGame(); });
  function startLoop() {
    cancelAnimationFrame(raf);
    last = 0;
    raf = requestAnimationFrame(frame);
  }
  document.getElementById('btn-resume').onclick = () => togglePause(false);
  document.getElementById('btn-retry').onclick = () => {
    Sfx.resume(); Sfx.startDrone(); Sfx.startMusic();
    resetLevel(); state = 'play'; hideAll(); startLoop();
    lockPointer(0);
  };
  document.getElementById('btn-restart2').onclick = () => document.getElementById('btn-retry').onclick();
  document.getElementById('btn-again').onclick = () => document.getElementById('btn-retry').onclick();
  document.getElementById('btn-egg').onclick = () => startEgg(eggTarget);
  document.getElementById('btn-fail-egg').onclick = () => startEgg('end1');
  document.getElementById('btn-fail-retry').onclick = () => document.getElementById('btn-retry').onclick();
  document.getElementById('btn-egg-again').onclick = () => document.getElementById('btn-retry').onclick();
  document.getElementById('btn-third-retry').onclick = () => {
    totalCaught = 0;   // 特殊病房结局后重新做人
    document.getElementById('btn-retry').onclick();
  };
  document.getElementById('btn-stay-retry').onclick = () => document.getElementById('btn-retry').onclick();
  // 出口分岔：离开（结局二/五） or 撕掉许可单留下（结局四）
  document.getElementById('btn-stay-go').onclick = () => { hideStayChoice(); win(); };
  document.getElementById('btn-stay-tear').onclick = () => endingStay();
  // 结局一彩蛋的「只能回答是」按钮
  // stopPropagation：防止点击冒泡到面板再推进一格（会跳过问题句，导致两个「是」连按）
  document.getElementById('egg-b1').onclick = e => { if (e && e.stopPropagation) e.stopPropagation(); eggAdvance(true); };
  document.getElementById('egg-b2').onclick = e => { if (e && e.stopPropagation) e.stopPropagation(); eggAdvance(true); };
  panels.egg.addEventListener('click', e => {
    // 点在「是」按钮上时不要重复推进（双保险，按钮本身已 stopPropagation）
    if (e && e.target && typeof e.target.id === 'string' && e.target.id.indexOf('egg-b') === 0) return;
    eggAdvance(false);   // 点面板任意处推进对话（强制选项时无效）
  });

  /* ---------------- 拾取 ---------------- */
  function tryPick() {
    for (const c of cards) {
      if (c.got) continue;
      if (Math.hypot(c.x - P.x, c.y - P.y) < 0.85) {
        c.got = true; P.pickT = 0.5;
        Sfx.pickup();
        const left = cards.filter(k => !k.got).length;
        say(kv(pickLine(LINE.pick).replace('{n}', left)), 3.2);
        updateHUD();
        return;
      }
    }
    if (permit && !permit.got && Math.hypot(permit.x - P.x, permit.y - P.y) < 0.85) {
      permit.got = true; P.pickT = 0.5;
      Sfx.pickup();
      say(kv('出院许可单。主治医师的签名——落款日期，比今天更早。'), 4);
      updateHUD();
      return;
    }
  }

  /* ---------------- 医师事件 ---------------- */
  function onDoctorEvent(type, arg) {
    if (type === 'step') Sfx.doctorStep(arg);
    else if (type === 'knock') Sfx.knock();   // 查房仪式：咚、咚、咚
    else if (type === 'spotted') {
      Sfx.spotted();
      statusEl.classList.add('on');
      say(ea(pickLine(LINES.spotted)), 3.0);
      chaseAnnounced = true;
    } else if (type === 'lost') {
      statusEl.classList.remove('on');
      say(ea(pickLine(LINES.search)), 3.4);
      chaseAnnounced = false;
    } else if (type === 'gaveup') {
      statusEl.classList.remove('on');
      chaseAnnounced = false;
    } else if (type === 'line') {
      if (!subEl.innerHTML || subT <= 0) say(ea(arg ? pickLine(LINES[arg]) : ''), 3.6);
    }
  }

  /* ---------------- 结局 ---------------- */
  let cutTimers = [];
  /* 被抓瞬间：红色爆闪 + 大字
     —— 之前是 stopAll 后干等 1.5 秒才出 CG，中间那段「什么都不发生」被
     感受成了卡顿。现在画面第一帧就炸出来，声音在 0.35s 处补一记重击。 */
  const hitEl = document.getElementById('hit');
  const hitWord = hitEl && hitEl.querySelector ? hitEl.querySelector('.hit-word') : null;
  function hitFlash(word) {
    if (!hitEl) return;
    if (hitWord) hitWord.textContent = word || '被 抓 住 了';
    hitEl.classList.remove('play');
    void hitEl.offsetWidth;            // 强制重排，保证动画能重播
    hitEl.classList.add('play');
  }
  let hitTimers = [];
  function hitClear() { hitTimers.forEach(clearTimeout); hitTimers = []; }
  /** 结局一：没有许可单 → 刷卡红灯，艾尔海森从背后出现拦截 */
  function failEscape() {
    state = 'cut';
    cutTimers.forEach(clearTimeout);
    Sfx.locked();
    const pulseEl = document.getElementById('pulse');
    if (pulseEl) { pulseEl.style.opacity = 0.78; pulseEl.style.transition = 'opacity .12s'; }
    // 他从玩家背后出现
    doctor.x = P.x - Math.cos(P.a) * 1.15;
    doctor.y = P.y - Math.sin(P.a) * 1.15;
    doctor.state = 'chase';
    say(kv('刷卡。红灯。「未查检出·院·许·可——已通知主治医师。」'), 2.6);
    cutTimers = [
      setTimeout(() => {
        if (state !== 'cut') return;
        say(ea('「许可单呢？」他就站在你身后，声音贴着后颈，「没有我的签字，你哪里也去不了。」'), 2.6);
      }, 1500),
      setTimeout(() => {
        if (state !== 'cut') return;
        Sfx.caught();
        if (pulseEl) pulseEl.style.opacity = 0;
        cancelAnimationFrame(raf);
        markEnding('1');
        document.getElementById('fail-stat').textContent =
          `门禁卡 ${cards.filter(c => c.got).length}/3 · 许可单 未取得 · 逃跑失败`;
        showPanel('fail');
        if (document.exitPointerLock) document.exitPointerLock();
      }, 3100),
    ];
  }
  function lose() {
    state = 'lose';
    cancelAnimationFrame(raf);
    hitClear();
    // ① 声音：先抽掉环境（音乐/嗡鸣）→ 0.35s 后一记重击，制造「静—炸」的落差
    Sfx.stopAll();
    hitTimers.push(setTimeout(() => Sfx.caught(), 350));
    // ② 画面：第一帧就红闪，不再有干等的空档
    hitFlash('被 抓 住 了');
    hideStayChoice();
    // 分档随机结束语：本局第 1 次被抓走 tier1，第 2 次起走 tier2（惩罚落地）
    // 注意：checkCatch 是先自增 caughtCount 再调 lose()，所以第 1 次时它已经是 1
    const tier = caughtCount >= 2 ? 2 : 1;
    const pool = (typeof CAUGHT_TIERS !== 'undefined' && CAUGHT_TIERS[tier]) || [];
    const pick = pool.length ? pool[(Math.random() * pool.length) | 0] : null;
    document.getElementById('lose-line').innerHTML =
      pick ? pick.line : ('「' + pickLine(LINES.caught) + '」');
    const noteEl = document.getElementById('lose-p');
    if (noteEl) noteEl.innerHTML = pick ? pick.note : '你被按回病床上。约束带重新系紧，比上一次更牢。';
    // 被抓立绘：两张表情随机一张
    document.getElementById('lose-img').src =
      'images/IMG_426' + (Math.random() < 0.5 ? '0' : '1') + '.PNG';
    const stat = `存活 ${playT.toFixed(1)} 秒 · 门禁卡 ${cards.filter(c => c.got).length}/3 · 被抓住 ${caughtCount} 次`;
    // 红闪 1.15s，CG 在 0.95s 时淡入 —— 红雾化开的同时立绘压上来，衔接不留空
    hitTimers.push(setTimeout(() => {
      document.getElementById('lose-stat').textContent = stat;
      showPanel('lose');
      if (document.exitPointerLock) document.exitPointerLock();
    }, 950));
  }
  function win() {
    state = 'win';
    Sfx.escape(); Sfx.stopDrone(); Sfx.stopMusic();
    cancelAnimationFrame(raf);
    hideStayChoice();
    if (!spottedThisRun) {
      /* -------- 结局五：零发现 · 他放你走的 -------- */
      markEnding('5');
      eggTarget = 'end5';
      document.getElementById('win-line').innerHTML =
        '「零次。」他在你身后说，没有追。「整晚，一次都没有。」<br>' +
        '「我调整了三处巡逻，熄了两段走廊的灯。……你以为是你赢了？」<br>' +
        '「我只是想看看，你全力以赴的样子，卡维。」<br>' +
        '<span style="color:#7a6f66">走廊里的灯全亮着。你逃得太顺利了——顺利得像有人提前挪开了巡逻路线。</span>';
      document.getElementById('win-stat').textContent =
        `用时 ${playT.toFixed(1)} 秒 · 被抓住 0 次 · 许可单 ✓ · 未被发现 ✓`;
    } else {
      /* -------- 结局二：成功逃出去 -------- */
      markEnding('2');
      eggTarget = 'end2';
      document.getElementById('win-line').innerHTML =
        '「卡维。」他在你身后三步远的地方停下，没有追。<br>' +
        '「……你不追？」<br>' +
        '「门禁卡是你自己找到的，路线也是你自己选的。」他合上病历本，' +
        '「至于许可单——字是我签的，可走到这一步的是你。」<br>' +
        '「这个诊断我写了很多次：<span class="blood">反复出逃，反复归来。</span>」' +
        '「你每一次都是这么走的，卡维。也是每一次，都这么回来。」<br>' +
        '<span style="color:#7a6f66">凌晨的风灌进喉咙。你没有回头。可你知道他在看你——他不需要追，你的路线，本来就是他教的。</span>';
      document.getElementById('win-stat').textContent =
        `用时 ${playT.toFixed(1)} 秒 · 被抓住 ${caughtCount} 次 · 许可单 ✓`;
    }
    showPanel('win');
    if (document.exitPointerLock) document.exitPointerLock();
  }

  /* -------- 结局三：累计被抓三次 · 特殊病房 -------- */
  function thirdStrike() {
    state = 'lose';
    cancelAnimationFrame(raf);
    hitClear();
    Sfx.stopAll();
    hitTimers.push(setTimeout(() => Sfx.caught(), 350));
    hitFlash('再 也 不 用 跑 了');
    hideStayChoice();
    const stat = `累计被抓 ${totalCaught} 次 · 逃跑资格 已取消`;
    hitTimers.push(setTimeout(() => {
      document.getElementById('third-stat').textContent = stat;
      showPanel('third');
      markEnding('3');
      if (document.exitPointerLock) document.exitPointerLock();
    }, 950));
  }

  /* -------- 结局四：撕掉许可单 · 自愿留下 -------- */
  function endingStay() {
    hideStayChoice();
    state = 'stay';
    Sfx.stopDrone(); Sfx.stopMusic();
    cancelAnimationFrame(raf);
    document.getElementById('stay-stat').textContent =
      `用时 ${playT.toFixed(1)} 秒 · 许可单 已撕毁 · 「自愿」留下`;
    markEnding('4');
    showPanel('stay');
    if (document.exitPointerLock) document.exitPointerLock();
  }

  /* ---------------- 彩蛋：几天后（两个结局各一段） ---------------- */
  const EGG_SEQS = {
    // 结局二彩蛋：卡维低头归来，艾尔海森料定一切
    end2: [
      { img: 'images/IMG_4274.PNG', who: 'ea', name: '艾尔海森',
        text: '「六天。你比我记录的归期，晚了一天。」' },
      { img: 'images/IMG_4272.PNG', who: 'kv', name: '卡维',
        text: '「……你凭什么觉得我一定会回来。」' },
      { img: 'images/IMG_4271.PNG', who: 'kv', name: '卡维',
        text: '「……」' },
      { img: 'images/IMG_4275.PNG', who: 'ea', name: '艾尔海森',
        text: '「那我们开始，新的治疗。」' },
    ],
    // 结局一彩蛋：逃跑失败后，卡维被驯化——他说什么，卡维做什么。
    // ui 字段 = 「只能回答是」机制：
    //   yes2 → 两个按钮（是 / 好的），选哪个都是顺从
    //   yes1 → 只剩一个按钮（是）
    //   none → 没有按钮，字幕自动替你说出「……是」
    end1: [
      { img: 'images/IMG_4265.PNG', who: 'kv', name: '卡维',
        text: '「……对不起。我不该跑的。」' },
      { img: 'images/IMG_4262.PNG', who: 'ea', name: '艾尔海森',
        text: '「知道错就好。门禁卡我收走了——反正你用不上。外面的世界会让你生病，以后连想都不用想。」' },
      { img: 'images/IMG_4263.PNG', who: 'ea', name: '艾尔海森', ui: 'yes2',
        text: '「从今天起，治疗方案升级。每天早上一小时的问话，你只需要回答『是』。不需要想——想，是我替你做的事。」' },
      { img: 'images/IMG_4266.PNG', who: 'kv', name: '卡维',
        text: '「好。都听你的。」' },
      { img: 'images/IMG_4263.PNG', who: 'ea', name: '艾尔海森', ui: 'yes1',
        text: '「那么，第一课：留下来，对你来说是幸福的。对吗？」' },
      { img: 'images/IMG_4267.PNG', who: 'kv', name: '卡维', ui: 'none',
        text: '……是。' },
      { img: 'images/IMG_4264.PNG', who: 'ea', name: '艾尔海森',
        text: '『真乖。』他难得笑了一下。「看，你是自己走回来的，一步都没有犹豫。这才是我的病人。」' },
    ],
    // 结局五彩蛋：零发现通关——你以为你赢了
    end5: [
      { img: 'images/IMG_4274.PNG', who: 'ea', name: '艾尔海森',
        text: '「外面怎么样？路灯很亮，床很软，没有人半夜查房。」' },
      { img: 'images/IMG_4275.PNG', who: 'ea', name: '艾尔海森',
        text: '「第三天你就会开始失眠。第五天，你会去打听回来的路。我都写进病程记录了——你看，又对了。」' },
    ],
  };
  const EGG_FINAL = {
    end2: '他从来没有追过你。<br>他只是站在原地，等你走回来——<br>你果然，走回来了。',
    end1: '门还是没有锁。<br>因为门从来就不是锁你的东西。',
    end5: '你从来没有逃出去过。<br>你只是，被放出去的。',
  };
  let eggIdx = 0, eggEnded = false, eggWhich = 'end2', eggTimer = 0;
  function eggShow() {
    const seq = EGG_SEQS[eggWhich];
    const e = seq[eggIdx];
    document.getElementById('egg-img').src = e.img;
    const nm = document.getElementById('egg-name');
    nm.textContent = e.name;
    nm.className = e.who;
    document.getElementById('egg-line').textContent = e.text;
    document.getElementById('btn-egg-again').style.display = 'none';
    // 强制选项 UI
    const b1 = document.getElementById('egg-b1');
    const b2 = document.getElementById('egg-b2');
    const hint = document.getElementById('egg-hint');
    b1.style.display = 'none'; b2.style.display = 'none';
    const ui = e.ui || 'click';
    if (ui === 'yes2') {
      b1.textContent = '是'; b2.textContent = '好的';
      b1.style.display = ''; b2.style.display = '';
      hint.style.display = 'none';
    } else if (ui === 'yes1') {
      b1.textContent = '是'; b1.style.display = '';
      hint.style.display = 'none';
    } else if (ui === 'none') {
      hint.style.display = 'none';
      // 连按钮都没有了——字幕自动替你回答
      eggTimer = setTimeout(() => { eggTimer = 0; eggAdvance(true); }, 1900);
    } else {
      hint.style.display = '';
    }
  }
  function startEgg(which) {
    eggWhich = which || 'end2';
    eggIdx = 0; eggEnded = false;
    if (eggTimer) { clearTimeout(eggTimer); eggTimer = 0; }
    state = 'egg';
    showPanel('egg');
    eggShow();
  }
  function eggAdvance(viaUi) {
    if (state !== 'egg' || eggEnded) return;
    const seq = EGG_SEQS[eggWhich];
    const cur = seq[eggIdx];
    // 「只能回答是」：必须点按钮（或由字幕自动推进），点别处无效
    if (cur && cur.ui && !viaUi) return;
    if (eggTimer) { clearTimeout(eggTimer); eggTimer = 0; }
    eggIdx++;
    if (eggIdx < seq.length) { eggShow(); return; }
    // 终幕
    eggEnded = true;
    document.getElementById('egg-name').textContent = '';
    document.getElementById('egg-name').className = '';
    document.getElementById('egg-line').innerHTML =
      '<span style="color:#7a6f66">—— 完 ——</span><br>' + EGG_FINAL[eggWhich];
    document.getElementById('egg-hint').style.display = 'none';
    const againBtn = document.getElementById('btn-egg-again');
    againBtn.textContent = '再来一次';
    againBtn.style.display = '';
  }

  /* ---------------- 玩家更新 ---------------- */
  function updatePlayer(dt) {
    const run = ((K.ShiftLeft || K.ShiftRight) || P.touch.run) && P.stam > 0.02;
    const crouch = K.ControlLeft || K.ControlRight || P.touch.crouch;
    P.crouching = crouch;
    const base = crouch ? 1.15 : run ? 4.05 : 2.35;

    let f = 0, s = 0;
    if (K.KeyW || K.ArrowUp) f += 1;
    if (K.KeyS || K.ArrowDown) f -= 1;
    if (K.KeyA) s -= 1;
    if (K.KeyD) s += 1;
    if (K.ArrowLeft) P.a -= dt * 2.1;
    if (K.ArrowRight) P.a += dt * 2.1;
    // 触屏摇杆：模拟量，推多少走多快
    if (P.touch.vx || P.touch.vy) { f = -P.touch.vy; s = P.touch.vx; }

    const fx = Math.cos(P.a), fy = Math.sin(P.a);
    let mx = fx * f - fy * s * 0.82;
    let my = fy * f + fx * s * 0.82;
    const ml = Math.hypot(mx, my);
    const mag = Math.min(1, Math.hypot(f, s));   // 摇杆轻推 = 慢走
    if (ml > 0.001) { mx /= ml; my /= ml; mx *= mag; my *= mag; }

    const tvx = mx * base, tvy = my * base;
    const k = Math.min(1, dt * 12);
    P.vx += (tvx - P.vx) * k;
    P.vy += (tvy - P.vy) * k;
    P.moveSpeed = Math.hypot(P.vx, P.vy);

    // 分轴碰撞
    const nx = P.x + P.vx * dt, ny = P.y + P.vy * dt;
    let bumped = false;
    if (!World.solidAt(nx, P.y)) P.x = nx; else { P.vx = 0; bumped = true; }
    if (!World.solidAt(P.x, ny)) P.y = ny; else { P.vy = 0; bumped = true; }
    if (bumped && P.moveSpeed > 1.6) { P.bumpT = 0.6; Sfx.step(2); }
    P.bumpT = Math.max(0, P.bumpT - dt);
    P.pickT = Math.max(0, P.pickT - dt);

    // 体力
    if (run && P.moveSpeed > 0.6) P.stam = Math.max(0, P.stam - dt * 0.22);
    else P.stam = Math.min(1, P.stam + dt * (crouch ? 0.30 : 0.16));

    // 脚步 + 视角晃动
    P.bobT += dt * P.moveSpeed * (crouch ? 1.6 : 2.4);
    const stepT = crouch ? 0.78 : run ? 0.30 : 0.48;
    if (P.moveSpeed > 0.35) {
      P._st = (P._st || 0) - dt;
      if (P._st <= 0) {
        P._st = stepT;
        Sfx.step(crouch ? 0 : run ? 2 : 1);
      }
    }
    P.bob = Math.sin(P.bobT * 3.4) * (run ? 3.4 : 2.1) * Math.min(1, P.moveSpeed / 2);
  }

  /* ---------------- 主循环 ---------------- */
  let raf = 0, last = 0;
  /* 防崩溃：连续异常就停下来并把错误亮在屏幕上，而不是无声卡死 */
  let errCount = 0;
  function showFatal(e) {
    const el = document.getElementById('err');
    if (!el) return;
    const stack = (e && e.stack) ? String(e.stack).split('\n').slice(0, 3).join('\n') : '';
    el.textContent = '⚠ 运行错误：' + ((e && e.message) || e) + (stack ? '\n' + stack : '');
    el.classList.add('show');
  }
  /* 帧时间滑动平均，持续超时就降内部分辨率（画质换流畅） */
  let ftAvg = 16, ftClock = 0;
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (!last) last = ts;
    const rawDt = ts - last;
    let dt = rawDt / 1000;
    last = ts;
    if (!(dt > 0)) dt = 0;          // 时间戳异常时冻结，避免倒放
    if (dt > 0.05) dt = 0.05;

    // 自适应画质：平均帧时间连续 2 秒高于 40ms 就降一档
    ftAvg += (Math.min(80, rawDt) - ftAvg) * 0.04;
    ftClock += dt;
    if (ftClock > 2) {
      ftClock = 0;
      if (ftAvg > 40 && perfScale > 0.45) {
        perfScale = Math.max(0.45, perfScale * 0.82);
        fitCanvas();
        ftAvg = 16;
      }
    }

    try {
      if (state === 'play') {
        playT += dt;
        updatePlayer(dt);
        const dist = doctor.update(dt, P, onDoctorEvent);
        if (doctor.state === 'chase') spottedThisRun = true;   // 结局五：本局被发现过
        checkPickupsAndExit(dt);
        checkCatch(dist);
        atmosphere(dt, dist);
        checkLore();
        checkMirror(dt);
      }
      else if (mirrorActive) hideMirror();   // 任何非游玩状态（被抓/暂停/结局）都不留镜面
      draw(dt);
      if (subT > 0) { subT -= dt; if (subT <= 0) subEl.style.opacity = 0; }
      errCount = 0;
    } catch (e) {
      if (++errCount <= 3) showFatal(e);
      if (errCount > 120) cancelAnimationFrame(raf);  // 持续报错就止损
    }
  }

  function checkPickupsAndExit(dt) {
    // 出口判定
    const ex = World.EXIT_TILE.x + 0.5, ey = World.EXIT_TILE.y + 0.5;
    const d = Math.hypot(P.x - ex, P.y - ey);
    if (d < 1.9) {
      if (cards.every(c => c.got)) {
        if (permit && permit.got) { showStayChoice(); return; }   // 出口分岔：离开 or 撕掉许可单留下
        if (state === 'play') { failEscape(); return; }
      }
      if (subT <= 0) { say(kv(pickLine(LINE.locked)), 2.6); Sfx.locked(); }
    }
    else if (stayShown) hideStayChoice();
    // 门禁卡轻微音效提示
    for (const c of cards) {
      if (c.got) continue;
      const dc = Math.hypot(c.x - P.x, c.y - P.y);
      if (dc < 1.9 && subT <= 0 && Math.random() < dt * 2.2)
        say(kv('……地上有反光。按 <b>E</b> 捡起来。'), 2.2);
    }
    // 许可单提示：三张卡齐了但还没拿许可单时，指路值班室
    if (permit && !permit.got && cards.every(c => c.got) &&
        subT <= 0 && Math.random() < dt * 1.2)
      say(kv('卡是齐的。可是没有主治医师的签字，门不会放行——许可单在值班室。'), 3.4);

    // 第三张卡超时提示：集齐两张后每 3 分钟亮一次卡的位置（发亮几秒）
    const gotN = cards.filter(c => c.got).length;
    for (const c of cards) if (c.hintT > 0) c.hintT -= dt;
    if (gotN === 2) {
      twoCardT += dt;
      if (twoCardT >= 180) {
        twoCardT = 0;
        const c = cards.find(k => !k.got);
        if (c) {
          c.hintT = 6;
          say(kv('空气里有铁锈味……第三张门禁卡，就在<b>' + c.room + '</b>。'), 6);
        }
      }
    } else twoCardT = 0;
  }

  function checkCatch(dist) {
    if (dist < 0.62) {
      caughtCount++; totalCaught++;
      if (totalCaught >= 3) thirdStrike(); else lose();
    }
  }

  /* ---------------- 出口选择浮层（结局二 / 结局四分岔） ---------------- */
  const stayEl = document.getElementById('stay-choice');
  function showStayChoice() {
    if (stayShown) return;
    stayShown = true;
    stayEl.classList.add('show');
    if (subT <= 0) say(kv('绿灯亮了。走吧——<b>或者，还有别的选择。</b>'), 3.2);
  }
  function hideStayChoice() {
    stayShown = false;
    stayEl.classList.remove('show');
  }

  /* ---------------- 氛围：闪烁 / 停电 / 心跳 / 惊吓 ---------------- */
  function atmosphere(dt, dist) {
    // 紧张度
    let t = 0;
    if (doctor.state === 'chase') t = 1;
    else if (doctor.state === 'alert') t = 0.62;
    else if (doctor.state === 'search') t = 0.45;
    t = Math.max(t, Math.max(0, 1 - dist / 12) * 0.7);
    tension += (t - tension) * Math.min(1, dt * 1.6);
    Sfx.setTension(tension);

    // 灯管闪烁
    const f0 = 0.86 + 0.10 * Math.sin(playT * 7.3) + 0.06 * Math.sin(playT * 21.7);
    flicker += ((f0 - (doctor.state === 'chase' ? 0.10 : 0) - tension * 0.06) - flicker) * Math.min(1, dt * 8);

    // 随机停电
    if (blackout <= 0 && Math.random() < dt * (0.045 + tension * 0.10)) {
      blackout = 0.95; flashT = 0.9;
      Sfx.scare();
    }
    if (blackout > 0) blackout = Math.max(0, blackout - dt * 0.9);
    if (flashT > 0) flashT -= dt;

    // 心跳
    const beatInt = 0.25 + tension * 0.75;
    beatT -= dt * (0.7 + tension * 1.5);
    if (beatT <= 0) {
      beatT = 1.25 - tension * 0.62;
      if (tension > 0.12) Sfx.heartbeat(beatInt);
      pulseEl.style.opacity = (tension * 0.55 * (0.5 + 0.5 * Math.random())).toFixed(2);
      pulseEl.style.transition = 'opacity ' + (0.16 + 0.3 * (1 - tension)) + 's';
      setTimeout(() => { pulseEl.style.opacity = 0; }, 130);
    }

    // 随机环境惊吓
    scareT -= dt;
    if (scareT <= 0) {
      scareT = 22 + Math.random() * 26;
      Sfx.scare();
      if (subT <= 0) {
        const th = ['走廊里有拖行的声音。', '灯灭了一下。', '有人在念我的名字。',
                    '输液架自己晃了。', '……他在翻病历。'];
        say(kv(th[(Math.random() * th.length) | 0]), 2.6);
      }
    }

    // 近距离压迫感台词
    if (doctor.state !== 'chase' && dist < 5.2 && subT <= 0 && Math.random() < dt * 0.18)
      say(ea(pickLine(LINES.near)), 2.8);

    statusEl.classList.toggle('on', doctor.state === 'chase');
    if (doctor.state !== 'chase') statusEl.classList.remove('on');

    // HUD 体力刷新（updateHUD 内部有变化检测，内容没变是零成本）
    updateHUD();
  }

  /* ---------------- 绘制 ---------------- */
  /* 注意：这里没登记的装饰精灵会被 draw() 直接跳过 —— 场上「看不见的道具」。
     历史上穿衣镜就这么隐形过一次，所以下面加了 collectDecor() 的统一出口，
     并把「凡摆进场景的精灵都必须登记」写成了回归测试。 */
  const SPRITE_CFG = {
    bed: 0.72, iv: 0.92, cab: 0.86, wheel: 0.58, stain: 0.16,
    strap: 0.18, board: 0.78, sheet: 0.30,
    mirror: 0.95,                    // 穿衣镜：立起来差不多一人高
  };
  const SPRITE_ASPECT = { stain: 3.4, strap: 2.2, mirror: 48 / 74 };
  // 贴图 → 名字（精灵表启动时已固定，不必每帧反查）
  const SPR_NAME = new Map(Object.keys(World.SPR).map(k => [World.SPR[k], k]));
  /** 收集当前该被画出来的装饰精灵（顺便挡住未登记配置的隐形道具）。
      穿衣镜单独收紧到 4.2 格 —— 隔着走廊远远就看到一面亮镜子太出戏。 */
  const MIRROR_VIEW_DIST = 4.2;
  function collectDecor() {
    const out = [];
    for (const d of DECOS) {
      const key = SPR_NAME.get(d.spr);
      if (!key || !SPRITE_CFG[key]) continue;
      const lim = key === 'mirror' ? MIRROR_VIEW_DIST : 17;
      if (Math.hypot(d.x - P.x, d.y - P.y) > lim) continue;
      out.push({ d, key });
    }
    return out;
  }
  function draw(dt) {
    R.setLight({ flicker, blackout, pulse: tension });

    const dirX = Math.cos(P.a), dirY = Math.sin(P.a);
    const planeX = -dirY * FOV, planeY = dirX * FOV;

    // 组装精灵
    const sprites = [];
    for (const { d, key } of collectDecor()) {
      sprites.push({
        x: d.x, y: d.y, tex: d.spr, scale: SPRITE_CFG[key], yOff: 0,
        aspect: SPRITE_ASPECT[key] || 1,
        flat: key === 'stain' || key === 'strap',
        bright: key === 'mirror' ? 0.12 : 0,   // 镜面微微反光，黑暗中好认一点
      });
    }
    if (cards) for (const c of cards) {
      if (c.got) continue;
      if (Math.hypot(c.x - P.x, c.y - P.y) > 17) continue;
      sprites.push({
        x: c.x, y: c.y, tex: World.SPR.card, scale: 0.20,
        yOff: 0.42 + Math.sin(playT * 2.4 + c.bob) * 0.045,
        bright: 0.35 + (c.hintT > 0 ? 0.5 : 0),
      });
    }
    if (permit && !permit.got && Math.hypot(permit.x - P.x, permit.y - P.y) < 17) {
      sprites.push({
        x: permit.x, y: permit.y, tex: World.SPR.permit, scale: 0.26,
        yOff: 0.42 + Math.sin(playT * 2.1 + permit.bob) * 0.045,
        bright: 0.42,
      });
    }
    if (doctor && state !== 'title') {
      let mode = 0;
      if (doctor.state === 'chase') mode = 2;
      else if (doctor.speed > 1.6) mode = 1;
      else mode = (Math.floor(doctor.animT) % 2) ? 0 : 1;
      const frames = World.SPR.haitham[mode];
      const fi = Math.floor(doctor.animT) % frames.length;
      sprites.push({
        x: doctor.x, y: doctor.y, tex: frames[fi],
        // 48x64 立绘：贴图比例 0.75，scale 稍抬补偿底部留白
        scale: 1.12, aspect: 0.75, yOff: 0,
        bright: doctor.state === 'chase' ? 0.16 : 0,
      });
    }

    const pitch = (P.bob * (R.H / 200)) | 0;   // 分辨率变了，晃动幅度同步缩放
    // 活镜子：把镜子的位置/朝向/倒影贴图交给渲染器做空间镜像
    const gA = ghostAlpha();
    const mirrors = [];
    for (const m of mirrorItems) {
      if (Math.hypot(m.x - P.x, m.y - P.y) > MIRROR_VIEW_DIST) continue;
      mirrors.push({
        x: m.x, y: m.y, nx: m.nx, ny: m.ny,
        scale: SPRITE_CFG.mirror, aspect: SPRITE_ASPECT.mirror,
        tex: World.SPR.kaveh || World.SPR.hands,
        gtex: World.SPR.haitham[0] && World.SPR.haitham[0][0],
        ghost: gA,
      });
    }
    R.render(P.x, P.y, dirX, dirY, planeX, planeY, sprites, {
      pitch: pitch,
      cone: doctor && doctor.state === 'chase' ? 1.12 : 1.0,
      mirrors,
    });
    // 第一人称双手已按需求移除
  }

  /* ---------------- 调试钩子（不影响正常游玩） ---------------- */
  window.__GAME = {
    get P() { return P; }, get cards() { return cards; },
    get permit() { return permit; },
    get doctor() { return doctor; }, get state() { return state; },
    get tension() { return tension; },
    get totalCaught() { return totalCaught; },
    get spotted() { return spottedThisRun; },
    get stayShown() { return stayShown; },
    get loreItems() { return loreItems; },
    get mirrorItems() { return mirrorItems; },
    get mirrorShown() { return mirrorActive; },
    get mirrorSeen() { return mirrorSeen; },
    get mirrorLastGhost() { return mirrorLastGhost; },
    /** 点 (qx,qy) 关于镜点的中心对称（回归测试用：billboard 镜面的倒影几何） */
    mirrorRefl(qx, qy) {
      const m = mirrorItems[0];
      if (!m) return null;
      return { x: 2 * m.x - qx, y: 2 * m.y - qy, d: Math.hypot(qx - m.x, qy - m.y) };
    },
    resetMirror() { mirrorSeen = false; mirrorLastGhost = false; mirrorLock = false; hideMirror(); },
    get spriteCfg() { return SPRITE_CFG; },
    visibleDecos() { return collectDecor().map(o => o.key); },
    forceWin() { cards.forEach(c => c.got = true); if (permit) permit.got = true; },
    bumpCatch() { caughtCount++; totalCaught++; if (totalCaught >= 3) thirdStrike(); else lose(); },
    resetCaught() { totalCaught = 0; },
    patchSfx,
    /* —— 回归测试钩子 —— */
    setSeen(a) { seenEndings = Array.isArray(a) ? a.slice() : []; renderBadges(); },
  };

  /* ---------------- 启动 ---------------- */
  resetLevel();
  state = 'title';
  // 初始显示内容预警面板（HTML 里已带 .show），确认后才切到标题
  Object.keys(panels).forEach(k => panels[k].classList.toggle('show', k === 'warn'));
  renderBadges();
  raf = requestAnimationFrame(frame);
})();
