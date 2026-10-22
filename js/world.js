/* =========================================================
   world.js —— 医院迷宫生成 / 程序化像素贴图 / 寻路 / 视线
   ========================================================= */
const World = (() => {
  const W = 28, H = 28;
  const T = { FLOOR: 0, WALL: 1, BLOOD: 2, ROT: 3, DOOR: 4, EXIT: 5, TILE_DARK: 6 };
  const EXIT_TILE = { x: 24, y: 26 };

  const ROOMS = [
    { n: '接待大厅', x: 1,  y: 1,  w: 9, h: 6 },
    { n: '病房 A',   x: 13, y: 1,  w: 6, h: 5 },
    { n: '药房',     x: 22, y: 1,  w: 5, h: 6 },
    { n: '手术室',   x: 1,  y: 10, w: 8, h: 7 },
    { n: '中庭走廊', x: 11, y: 9,  w: 7, h: 7 },
    { n: '档案室',   x: 21, y: 10, w: 6, h: 6 },
    { n: '值班室',   x: 9,  y: 18, w: 5, h: 3 },
    { n: '太平间',   x: 1,  y: 20, w: 9, h: 6 },
    { n: '病房 B',   x: 13, y: 20, w: 6, h: 6 },
    { n: '消防通道', x: 22, y: 20, w: 5, h: 6 },
  ];

  const CORRIDORS = [
    [4, 4, 4, 10], [15, 3, 15, 9], [24, 4, 24, 10],
    [4, 16, 4, 20], [15, 15, 15, 20], [24, 15, 24, 20],
    [9, 3, 13, 3], [18, 3, 22, 3],
    [8, 13, 11, 13], [17, 13, 21, 13],
    [9, 22, 13, 22], [18, 22, 22, 22],
    [11, 15, 11, 18],
  ];

  const PILLARS = [
    [3, 3], [7, 2], [7, 5],
    [17, 4], [14, 2],
    [23, 3], [25, 5],
    [3, 12], [6, 15], [2, 15],
    [13, 11], [16, 14], [12, 14],
    [22, 12], [25, 14],
    [3, 22], [7, 24],
    [15, 22], [17, 24],
    [25, 22], [23, 24],
  ];

  let grid = [];
  let spawnSpots = [];

  function carveRect(x, y, w, h, v) {
    for (let j = y; j < y + h; j++)
      for (let i = x; i < x + w; i++)
        if (i > 0 && j > 0 && i < W - 1 && j < H - 1) grid[j][i] = v;
  }
  function carveLine(x0, y0, x1, y1, v) {
    const dx = Math.sign(x1 - x0), dy = Math.sign(y1 - y0);
    let x = x0, y = y0;
    while (true) {
      if (x > 0 && y > 0 && x < W - 1 && y < H - 1) grid[y][x] = v;
      if (x === x1 && y === y1) break;
      x += dx; y += dy;
    }
  }

  function build() {
    grid = Array.from({ length: H }, () => new Array(W).fill(T.WALL));
    ROOMS.forEach(r => carveRect(r.x, r.y, r.w, r.h, T.FLOOR));
    CORRIDORS.forEach(c => carveLine(c[0], c[1], c[2], c[3], T.FLOOR));
    PILLARS.forEach(p => { grid[p[1]][p[0]] = T.ROT; });

    // 墙面做旧：给部分墙随机换材质（靠近地面区域更有血迹）
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        if (grid[y][x] !== T.WALL) continue;
        const r = Math.random();
        if (y > 18 && r < 0.14) grid[y][x] = T.BLOOD;
        else if (r < 0.10) grid[y][x] = T.BLOOD;
        else if (r < 0.26) grid[y][x] = T.ROT;
        else if (r < 0.31) grid[y][x] = T.TILE_DARK;
      }

    // 出口门
    grid[EXIT_TILE.y][EXIT_TILE.x] = T.EXIT;

    // 可放置道具的地板点（房间内部靠中心，避开柱子）
    spawnSpots = [];
    ROOMS.forEach((r, idx) => {
      const cx = Math.floor(r.x + r.w / 2), cy = Math.floor(r.y + r.h / 2);
      spawnSpots.push({ room: r.n, idx, x: cx + 0.5, y: cy + 0.5 });
    });
  }

  /* ---------- 查询 ---------- */
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? T.WALL : grid[y | 0][x | 0];
  const walkable = (x, y) => at(x, y) === T.FLOOR;
  const solidAt = (fx, fy) => {
    // 圆形半径碰撞：四角采样
    const r = 0.24;
    return !(walkable(fx - r, fy - r) && walkable(fx + r, fy - r) &&
             walkable(fx - r, fy + r) && walkable(fx + r, fy + r));
  };

  /* ---------- 视线（DDA 网格穿越） ---------- */
  function los(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) return true;
    const steps = Math.ceil(dist * 6);
    const sx = dx / steps, sy = dy / steps;
    let x = x0, y = y0;
    for (let i = 0; i < steps; i++) {
      x += sx; y += sy;
      if (!walkable(x, y)) return false;
    }
    return true;
  }

  /* ---------- BFS 寻路：返回从 (sx,sy) 走向 (gx,gy) 的下一步格子 ---------- */
  const _prev = new Int32Array(W * H);
  /* 注意必须是 Int32Array：之前用 Uint8Array 存访问时间戳，_stamp 超过 255 后
     写入被截断，"已访问"守卫失效，队列里的格子被无限重复入队，
     几秒后 q.push 抛 RangeError: Invalid array length 直接崩溃（实测踩坑）。 */
  const _seen = new Int32Array(W * H);
  let _stamp = 0;
  function bfsStep(sx, sy, gx, gy) {
    sx |= 0; sy |= 0; gx |= 0; gy |= 0;
    if (sx === gx && sy === gy) return null;
    if (!walkable(sx, sy) || !walkable(gx, gy)) return null;
    if (++_stamp >= 0x7ffffff0) { _seen.fill(0); _stamp = 1; }  // 理论上到不了，兜底
    const q = [sy * W + sx];
    _seen[sy * W + sx] = _stamp;
    _prev[sy * W + sx] = -1;
    const goal = gy * W + gx;
    for (let head = 0; head < q.length; head++) {
      const cur = q[head];
      if (cur === goal) break;
      const cx = cur % W, cy = (cur / W) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = cx + [1, -1, 0, 0][d], ny = cy + [0, 0, 1, -1][d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (_seen[ni] === _stamp) continue;
        if (!walkable(nx, ny)) continue;
        _seen[ni] = _stamp; _prev[ni] = cur;
        q.push(ni);
        // 正常情况下每格最多入队一次（≤W*H），这个上限只作最后保险
        if (q.length > W * H) return null;
      }
    }
    if (_seen[goal] !== _stamp) return null;
    let cur = goal;
    while (_prev[cur] !== -1 && _prev[cur] !== sy * W + sx) cur = _prev[cur];
    if (_prev[cur] === -1) return null;
    return { x: (cur % W) + 0.5, y: ((cur / W) | 0) + 0.5 };
  }

  /* =========================================================
     程序化像素贴图
     ========================================================= */
  const TS = 64; // 贴图边长
  function mkTex(fn) {
    const c = document.createElement('canvas');
    c.width = TS; c.height = TS;
    const g = c.getContext('2d');
    fn(g);
    return c;
  }
  const R = (a, b) => a + Math.random() * (b - a);
  const ri = (a, b) => Math.floor(R(a, b + 1));

  function tileBase(g, col, dark) {
    g.fillStyle = col; g.fillRect(0, 0, TS, TS);
    // 瓷砖格
    g.fillStyle = dark;
    for (let i = 0; i <= TS; i += 16) { g.fillRect(i, 0, 1, TS); g.fillRect(0, i, TS, 1); }
    // 细噪点
    for (let i = 0; i < 900; i++) {
      g.fillStyle = 'rgba(0,0,0,' + R(0.02, 0.16).toFixed(3) + ')';
      g.fillRect(ri(0, TS - 1), ri(0, TS - 1), 1, 1);
    }
  }
  function splat(g, x, y, r, col, n) {
    g.fillStyle = col;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * r;
      g.fillRect((x + Math.cos(a) * d) | 0, (y + Math.sin(a) * d) | 0, ri(1, 3), ri(1, 3));
    }
  }

  const TEXTURES = [];
  function buildTextures() {
    // 0 基础白瓷砖墙
    TEXTURES[0] = mkTex(g => {
      tileBase(g, '#8e8b84', '#6f6c66');
      for (let i = 0; i < 26; i++) splat(g, ri(0, 63), ri(0, 63), 3, 'rgba(60,58,54,.5)', 4);
    });
    // 1 血迹墙（也在 EXIT 之外作普通墙）
    TEXTURES[1] = mkTex(g => {
      tileBase(g, '#7d7a74', '#635f5a');
      g.fillStyle = 'rgba(90,14,12,.55)';
      g.beginPath(); g.moveTo(26, 0); g.lineTo(40, 0);
      g.bezierCurveTo(38, 22, 44, 30, 34, 46);
      g.bezierCurveTo(28, 56, 24, 58, 22, 64);
      g.lineTo(16, 64); g.bezierCurveTo(20, 44, 24, 26, 26, 0);
      g.fill();
      splat(g, 30, 50, 12, 'rgba(120,18,16,.5)', 26);
      splat(g, 44, 40, 6, 'rgba(120,18,16,.42)', 12);
      for (let i = 0; i < 18; i++) {
        g.fillStyle = 'rgba(80,10,9,.45)';
        g.fillRect(ri(0, 63), ri(52, 63), ri(1, 4), ri(2, 6));
      }
    });
    // 2 破损墙皮
    TEXTURES[2] = mkTex(g => {
      tileBase(g, '#6e6a63', '#565349');
      g.fillStyle = 'rgba(40,38,34,.65)';
      for (let i = 0; i < 14; i++) {
        const x = ri(0, 52), y = ri(0, 52);
        g.beginPath();
        g.moveTo(x, y);
        for (let k = 0; k < 5; k++) g.lineTo(x + ri(-8, 14), y + ri(-8, 14));
        g.closePath(); g.fill();
      }
      g.strokeStyle = 'rgba(28,26,22,.6)'; g.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        g.beginPath();
        let x = ri(0, 63), y = 0;
        g.moveTo(x, y);
        for (let k = 0; k < 10; k++) { x += ri(-5, 5); y += 7; g.lineTo(x, y); }
        g.stroke();
      }
    });
    // 3 走廊暗砖
    TEXTURES[3] = mkTex(g => {
      tileBase(g, '#4b4a46', '#373634');
      for (let i = 0; i < 14; i++) splat(g, ri(0, 63), ri(0, 63), 4, 'rgba(20,20,18,.55)', 5);
    });
    // 4 门框（锁上的病房门）
    TEXTURES[4] = mkTex(g => {
      tileBase(g, '#8a877f', '#6b6862');
      g.fillStyle = '#3d3229'; g.fillRect(8, 6, 48, 58);
      g.fillStyle = '#544436'; g.fillRect(11, 9, 42, 52);
      g.fillStyle = '#2b241d'; g.fillRect(11, 9, 42, 3);
      // 小窗
      g.fillStyle = '#1a1f22'; g.fillRect(17, 14, 30, 20);
      g.fillStyle = 'rgba(120,150,150,.14)'; g.fillRect(17, 14, 30, 20);
      g.fillStyle = '#3b3a36'; g.fillRect(18, 15, 28, 2);
      // 把手 + 锁
      g.fillStyle = '#b9b2a2'; g.fillRect(47, 38, 4, 8);
      g.fillStyle = '#c8c2b2'; g.fillRect(46, 34, 6, 4);
      // 标牌
      g.fillStyle = '#d9d3c5'; g.fillRect(20, 40, 24, 12);
      g.fillStyle = '#8c1f1a'; g.font = '9px monospace'; g.fillText('0709', 22, 49);
      g.fillStyle = '#5a564d'; g.fillRect(20, 52, 24, 1);
      // 血手印
      splat(g, 40, 22, 5, 'rgba(110,16,14,.4)', 14);
    });
    // 5 消防通道出口门
    TEXTURES[5] = mkTex(g => {
      tileBase(g, '#6d6a63', '#54514c');
      g.fillStyle = '#243528'; g.fillRect(6, 4, 52, 60);
      g.fillStyle = '#2f4634'; g.fillRect(9, 7, 46, 54);
      g.fillStyle = '#16201a'; g.fillRect(9, 7, 46, 3);
      // 门缝光
      g.fillStyle = 'rgba(150,220,190,.55)'; g.fillRect(9, 30, 46, 2);
      g.fillStyle = 'rgba(150,220,190,.16)'; g.fillRect(9, 26, 46, 10);
      // 推杆
      g.fillStyle = '#9aa39a'; g.fillRect(12, 40, 40, 5);
      g.fillStyle = '#c3ccc2'; g.fillRect(12, 40, 40, 2);
      // 安全出口标识
      g.fillStyle = '#0f2417'; g.fillRect(10, 10, 44, 13);
      g.fillStyle = '#4be08a'; g.font = 'bold 9px monospace'; g.fillText('EXIT', 20, 20);
      g.fillStyle = '#4be08a';
      g.beginPath(); g.moveTo(60, 13); g.lineTo(60, 20); g.lineTo(64, 16.5); g.fill();
      splat(g, 14, 58, 7, 'rgba(110,16,14,.35)', 16);
    });
    // 6 水泥墙
    TEXTURES[6] = mkTex(g => {
      g.fillStyle = '#5b574f'; g.fillRect(0, 0, TS, TS);
      for (let i = 0; i < 2200; i++) {
        g.fillStyle = 'rgba(0,0,0,' + R(0.02, 0.2).toFixed(3) + ')';
        g.fillRect(ri(0, TS - 1), ri(0, TS - 1), 2, 2);
      }
      g.fillStyle = 'rgba(255,255,255,.03)'; g.fillRect(0, 0, TS, 2);
    });

    // 地板 / 天花
    FLOOR_TEX = mkTex(g => {
      g.fillStyle = '#3a3a37'; g.fillRect(0, 0, TS, TS);
      g.fillStyle = '#31312f';
      for (let i = 0; i <= TS; i += 32) { g.fillRect(i, 0, 1, TS); g.fillRect(0, i, TS, 1); }
      for (let i = 0; i < 1600; i++) {
        g.fillStyle = 'rgba(0,0,0,' + R(0.02, 0.18).toFixed(3) + ')';
        g.fillRect(ri(0, TS - 1), ri(0, TS - 1), 1, 1);
      }
      splat(g, 20, 44, 9, 'rgba(78,14,12,.28)', 30);
      splat(g, 48, 18, 6, 'rgba(78,14,12,.20)', 18);
    });
    CEIL_TEX = mkTex(g => {
      g.fillStyle = '#26262a'; g.fillRect(0, 0, TS, TS);
      g.fillStyle = '#1d1d21';
      for (let y = 0; y < TS; y += 16) g.fillRect(0, y, TS, 1);
      g.fillStyle = 'rgba(120,130,140,.10)'; g.fillRect(6, 6, 52, 4);
      for (let i = 0; i < 900; i++) {
        g.fillStyle = 'rgba(0,0,0,' + R(0.03, 0.2).toFixed(3) + ')';
        g.fillRect(ri(0, TS - 1), ri(0, TS - 1), 1, 1);
      }
    });
  }
  let FLOOR_TEX = null, CEIL_TEX = null;

  /* ---------- 精灵（艾尔海森 / 门禁卡 / 场景物件） ---------- */
  function spriteCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function drawAlhaitham(g, W2, H2, frame, mode) {
    // mode: 0 idle, 1 walk, 2 chase
    const cx = W2 / 2;
    const bob = mode === 1 ? Math.sin(frame * 0.35) * 1.2 : 0;
    const lean = mode === 2 ? 1.5 : 0;
    const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(Math.round(x), Math.round(y + bob), w, h); };

    // 白大褂（全身）
    P(cx - 8, 20, 16, 30, '#cfd3d6');            // 外套主体
    P(cx - 8, 20, 16, 3, '#b9bec2');
    P(cx - 10, 22, 2, 24, '#c3c8cc');            // 左袖
    P(cx + 8, 22, 2, 24, '#c3c8cc');             // 右袖
    P(cx - 1, 21, 2, 28, '#a9aeb2');             // 门襟
    // 内里深色
    P(cx - 5, 21, 4, 10, '#2c3238');
    P(cx + 1, 21, 4, 10, '#2c3238');
    // 口袋 / 胸牌
    P(cx + 4, 30, 3, 2, '#8d9296');
    P(cx - 7, 32, 5, 4, '#dcdcdc'); P(cx - 6, 33, 3, 1, '#31506b');
    // 手
    P(cx - 10, 46, 3, 4, '#e2c6a8');
    P(cx + 7, 46, 3, 4, '#e2c6a8');
    // 腿
    P(cx - 6, 50, 5, 12, '#33383d');
    P(cx + 1, 50, 5, 12, '#33383d');
    // 鞋
    P(cx - 7, 62, 6, 3, '#1b1e22');
    P(cx + 1, 62, 6, 3, '#1b1e22');
    // 头
    const hx = cx + lean;
    P(hx - 5, 8, 10, 12, '#e8cdaa');             // 脸
    P(hx - 6, 6, 12, 6, '#b9c3c8');              // 头发顶
    P(hx - 6, 6, 3, 12, '#aab6bd');              // 侧发
    P(hx + 4, 6, 3, 12, '#aab6bd');
    P(hx - 6, 12, 2, 4, '#9fabb2');
    P(hx + 5, 12, 2, 4, '#9fabb2');
    P(hx - 4, 5, 3, 2, '#c9d3d8');               // 呆毛
    // 耳机
    P(hx - 7, 8, 2, 6, '#2a2e33' ); P(hx + 6, 8, 2, 6, '#2a2e33');
    P(hx - 7, 6, 15, 2, '#22262a');
    P(hx + 6, 10, 3, 3, '#4fd6c2');              // 耳机指示灯
    // 眼睛（青绿，恐怖感：追逐时发亮）
    const eyeCol = mode === 2 ? '#7bffe4' : '#3f9c8d';
    P(hx - 4, 13, 3, 3, eyeCol);
    P(hx + 1, 13, 3, 3, eyeCol);
    P(hx - 4, 13, 3, 1, mode === 2 ? '#d8fff7' : '#57b8a6');
    P(hx + 1, 13, 3, 1, mode === 2 ? '#d8fff7' : '#57b8a6');
    // 嘴
    P(hx - 2, 17, 4, 1, '#a3785c');
    if (mode === 2) { // 追逐：面罩/阴影
      P(hx - 6, 10, 12, 3, 'rgba(0,0,0,.35)');
    }
    // 手持病历板
    P(cx + 8, 34, 6, 9, '#d9cfb6');
    P(cx + 8, 34, 6, 1, '#b8ae95');
    P(cx + 9, 36, 4, 1, '#7c7568'); P(cx + 9, 38, 4, 1, '#7c7568');
  }
  function drawKaveh(g, W2, H2) {
    // 玩家自己的手（第一人称视角下的双臂/病号服袖口）
    const cx = W2 / 2;
    g.fillStyle = '#93a3b8'; // 病号服
    g.fillRect(0, H2 - 22, W2, 22);
    g.fillStyle = '#7d8da3';
    g.fillRect(0, H2 - 22, W2, 3);
    g.fillStyle = '#e8cdaa'; // 手
    g.fillRect(cx - 26, H2 - 26, 14, 12);
    g.fillRect(cx + 12, H2 - 26, 14, 12);
    g.fillStyle = '#d9bb95';
    g.fillRect(cx - 26, H2 - 26, 14, 3);
    g.fillRect(cx + 12, H2 - 26, 14, 3);
  }

  /* ---------- 用玩家提供的像素画替换程序化立绘 ----------
     js/sprites.js 里的 CUSTOM_ART 是 tools/img2sprite.js 预烘好的
     RGBA 像素（base64）。直接读原始 PNG 再 getImageData 会在
     file:// 下触发 canvas 跨源污染，所以必须走预烘数据。 */
  function applyCustomArt() {
    if (typeof CUSTOM_ART === 'undefined' || !CUSTOM_ART) return null;
    const art = CUSTOM_ART.haitham;
    if (!art || !art.px) return null;
    try {
      const bin = atob(art.px);
      const bytes = new Uint8ClampedArray(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const base = spriteCanvas(art.w, art.h);
      const bg = base.getContext('2d');
      let im;
      try { im = new ImageData(bytes, art.w, art.h); }
      catch (e) { im = bg.createImageData(art.w, art.h); im.data.set(bytes); }
      bg.putImageData(im, 0, 0);

      /* 单帧：dy 垂直位移 / tint 追逐红晕 / squash 轻微压扁（迈步感） */
      const frame = (dy, tint, squash) => {
        const c = spriteCanvas(art.w, art.h);
        const g = c.getContext('2d');
        const sh = squash ? Math.round(art.h * squash) : art.h;
        g.drawImage(base, 0, art.h - sh + (dy || 0), art.w, sh);
        if (tint) {
          g.globalCompositeOperation = 'source-atop';
          g.fillStyle = tint;
          g.fillRect(0, 0, art.w, art.h);
          g.globalCompositeOperation = 'source-over';
        }
        return c;
      };
      return [
        [frame(0), frame(-1)],                                             // 站立呼吸
        [frame(0), frame(-1, null, 0.96), frame(-1), frame(0, null, 0.96)],// 走路
        [frame(-1, 'rgba(150,24,18,.30)'), frame(0, 'rgba(150,24,18,.30)')],// 追逐
      ];
    } catch (e) { return null; }
  }

  function buildSprites() {
    SPR.haitham = [];
    for (let m = 0; m < 3; m++) {
      SPR.haitham[m] = [];
      for (let f = 0; f < 8; f++) {
        const c = spriteCanvas(40, 68);
        drawAlhaitham(c.getContext('2d'), 40, 68, m === 1 ? f : 0, m);
        SPR.haitham[m][f] = c;
      }
    }
    SPR.hands = spriteCanvas(120, 90);
    drawKaveh(SPR.hands.getContext('2d'), 120, 90);

    // 门禁卡
    SPR.card = spriteCanvas(20, 20);
    {
      const g = SPR.card.getContext('2d');
      g.fillStyle = '#d8dee2'; g.fillRect(2, 4, 16, 12);
      g.fillStyle = '#4fd6c2'; g.fillRect(2, 4, 16, 3);
      g.fillStyle = '#2b3136'; g.fillRect(4, 9, 6, 4);
      g.fillStyle = '#8d959c'; g.fillRect(12, 9, 4, 4);
      g.fillStyle = 'rgba(79,214,194,.25)'; g.fillRect(0, 2, 20, 16);
    }
    // 出院许可单：一张盖了红章的纸（主治医师已签字）
    SPR.permit = spriteCanvas(20, 24);
    {
      const g = SPR.permit.getContext('2d');
      g.fillStyle = '#e8e4da'; g.fillRect(3, 2, 14, 20);
      g.fillStyle = '#b9b2a4'; g.fillRect(5, 5, 10, 1); g.fillRect(5, 8, 10, 1); g.fillRect(5, 11, 7, 1);
      g.fillStyle = '#6b7f8f'; g.fillRect(5, 17, 8, 2);          // 签名
      g.strokeStyle = '#a33232'; g.lineWidth = 1.4;
      g.beginPath(); g.arc(13, 15.5, 3.1, 0, Math.PI * 2); g.stroke();  // 红章
      g.fillStyle = 'rgba(232,228,218,.22)'; g.fillRect(1, 0, 18, 24);
    }
    // 病床
    SPR.bed = spriteCanvas(64, 40);
    {
      const g = SPR.bed.getContext('2d');
      g.fillStyle = '#5b5f63'; g.fillRect(4, 24, 56, 6);
      g.fillStyle = '#3f4347'; g.fillRect(4, 30, 3, 9); g.fillRect(57, 30, 3, 9);
      g.fillStyle = '#c9ccce'; g.fillRect(6, 18, 52, 7);
      g.fillStyle = '#a8acaf'; g.fillRect(6, 18, 52, 2);
      g.fillStyle = '#8f9497'; g.fillRect(6, 12, 14, 6);
      g.fillStyle = '#6a6f73'; g.fillRect(2, 6, 3, 28); g.fillRect(59, 6, 3, 28);
      g.fillStyle = 'rgba(90,14,12,.35)'; g.fillRect(38, 18, 16, 5);
    }
    // 输液架
    SPR.iv = spriteCanvas(22, 74);
    {
      const g = SPR.iv.getContext('2d');
      g.fillStyle = '#9aa0a4'; g.fillRect(10, 8, 2, 62);
      g.fillStyle = '#7f858a'; g.fillRect(6, 68, 10, 3);
      g.fillStyle = '#d5dbdd'; g.fillRect(6, 6, 11, 20);
      g.fillStyle = 'rgba(180,60,50,.55)'; g.fillRect(7, 14, 9, 11);
      g.fillStyle = '#e8eef0'; g.fillRect(6, 6, 11, 3);
    }
    // 轮椅
    SPR.wheel = spriteCanvas(40, 44);
    {
      const g = SPR.wheel.getContext('2d');
      g.strokeStyle = '#8a9095'; g.lineWidth = 2;
      g.beginPath(); g.arc(14, 32, 9, 0, 7); g.stroke();
      g.fillStyle = '#4a4f54';
      g.fillRect(6, 12, 20, 8); g.fillRect(24, 6, 4, 24);
      g.fillStyle = '#63696e'; g.fillRect(4, 20, 8, 3);
    }
    // 文件柜
    SPR.cab = spriteCanvas(36, 56);
    {
      const g = SPR.cab.getContext('2d');
      g.fillStyle = '#6d6a63'; g.fillRect(2, 2, 32, 52);
      g.fillStyle = '#57544e';
      for (let i = 0; i < 4; i++) { g.fillRect(4, 5 + i * 13, 28, 11); }
      g.fillStyle = '#9aa0a4';
      for (let i = 0; i < 4; i++) g.fillRect(22, 10 + i * 13, 8, 2);
      g.fillStyle = 'rgba(90,14,12,.28)'; g.fillRect(4, 40, 28, 4);
    }
    // 地面血迹：宽而扁的一摊，渲染时按 aspect 压扁贴地
    SPR.stain = spriteCanvas(64, 64);    {
      const g = SPR.stain.getContext('2d');
      g.save();
      g.translate(32, 34); g.scale(1.0, 0.46);
      g.beginPath(); g.arc(0, 0, 26, 0, Math.PI * 2);
      g.fillStyle = 'rgba(52,7,7,0.62)'; g.fill();
      g.beginPath(); g.arc(6, 4, 15, 0, Math.PI * 2);
      g.fillStyle = 'rgba(84,12,10,0.66)'; g.fill();
      g.restore();
      for (let i = 0; i < 420; i++) {
        const a = Math.random() * 7, d = Math.random() * 30;
        g.fillStyle = 'rgba(66,9,8,' + (0.08 + Math.random() * 0.34).toFixed(2) + ')';
        g.fillRect(32 + Math.cos(a) * d, 34 + Math.sin(a) * d * 0.46, 2, 2);
      }
    }
    // 玩家提供了像素画就用玩家的，失败则保留程序化立绘兜底
    const custom = applyCustomArt();
    if (custom) SPR.haitham = custom;

    // 卡维立绘（活镜子·倒影用）：第一人称里玩家从头到尾看不见自己，
    // 唯独镜子里能看见 —— 所以这张贴图只活在镜面里。
    try {
      if (typeof CUSTOM_ART !== 'undefined' && CUSTOM_ART && CUSTOM_ART.kaveh && CUSTOM_ART.kaveh.px) {
        const art = CUSTOM_ART.kaveh;
        const bin = atob(art.px);
        const bytes = new Uint8ClampedArray(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const kc = spriteCanvas(art.w, art.h);
        const kg = kc.getContext('2d');
        let kim;
        try { kim = new ImageData(bytes, art.w, art.h); }
        catch (e) { kim = kg.createImageData(art.w, art.h); kim.data.set(bytes); }
        kg.putImageData(kim, 0, 0);
        SPR.kaveh = kc;
      }
    } catch (e) { /* 预烘数据异常时走下面的兜底 */ }
    if (!SPR.kaveh) {
      SPR.kaveh = spriteCanvas(48, 64);
      const g = SPR.kaveh.getContext('2d');
      g.fillStyle = '#cfc4ae'; g.fillRect(16, 8, 16, 14);          // 头
      g.fillStyle = '#a89a7d'; g.fillRect(20, 20, 8, 4);           // 颈
      g.fillStyle = '#8f96a3'; g.fillRect(12, 24, 24, 30);         // 病号服
      g.fillStyle = '#6f7683'; g.fillRect(14, 54, 8, 8); g.fillRect(26, 54, 8, 8); // 腿
      g.fillStyle = '#5c5346'; g.fillRect(18, 12, 3, 3); g.fillRect(27, 12, 3, 3); // 眼
    }

    /* ---- 环境叙事道具 ---- */
    // 挣断的约束带：断口翻卷，拖在地面（贴地扁精灵）
    SPR.strap = spriteCanvas(64, 40);
    {
      const g = SPR.strap.getContext('2d');
      const strap = (x, y, len, ang) => {
        g.save(); g.translate(x, y); g.rotate(ang);
        g.fillStyle = '#7d7568'; g.fillRect(0, -4, len, 8);
        g.fillStyle = '#5c564c'; g.fillRect(0, -4, len, 2);
        // 断口毛边
        g.fillStyle = '#8f887b';
        for (let i = 0; i < 7; i++) g.fillRect(len - 2, -4 + i * 1.4, 4 + Math.random() * 4, 1.2);
        g.restore();
      };
      strap(10, 20, 22, 0.12); strap(34, 24, 20, -0.35); strap(46, 16, 14, 0.6);
      // 金属扣环
      g.strokeStyle = '#9aa0a4'; g.lineWidth = 2;
      g.beginPath(); g.arc(12, 20, 4, 0, 7); g.stroke();
    }
    // 值班室黑板：「0709 号患者情况稳定」，「稳定」划掉重写了七遍
    SPR.board = spriteCanvas(56, 44);
    {
      const g = SPR.board.getContext('2d');
      g.fillStyle = '#4b4238'; g.fillRect(1, 1, 54, 40);          // 木框
      g.fillStyle = '#20301f'; g.fillRect(4, 4, 48, 34);          // 板面
      g.strokeStyle = '#6d6a63'; g.lineWidth = 1;
      g.strokeRect(4.5, 4.5, 47, 33);
      g.fillStyle = '#cfd8cd'; g.font = '6px monospace';
      g.fillText('0709', 8, 13);
      g.fillText('患者情况', 20, 13);
      // 「稳定」被划掉重写的七遍
      for (let i = 0; i < 7; i++) {
        const y = 20 + i * 2.6;
        g.fillStyle = i === 6 ? '#c9524a' : '#aab4a8';
        g.fillText('稳定', 30, y);
        if (i < 6) { g.strokeStyle = '#7d4a44'; g.beginPath(); g.moveTo(29, y - 5); g.lineTo(41, y - 1.4); g.stroke(); }
      }
    }
    // 太平间签收单：一叠纸，签名栏全是同一个名字
    SPR.sheet = spriteCanvas(26, 30);
    {
      const g = SPR.sheet.getContext('2d');
      for (let i = 0; i < 3; i++) {
        g.save(); g.translate(i * 1.4, -i * 1.2); g.rotate((i - 1) * 0.06);
        g.fillStyle = '#ded9cc'; g.fillRect(2, 6, 20, 22);
        g.fillStyle = '#b3ac9d';
        g.fillRect(4, 10, 16, 1); g.fillRect(4, 13, 16, 1); g.fillRect(4, 16, 11, 1);
        g.fillStyle = '#6b7f8f'; g.fillRect(4, 22, 9, 2);   // 签名
        g.restore();
      }
      g.strokeStyle = '#a33232'; g.lineWidth = 1.2;
      g.beginPath(); g.arc(17, 26, 2.6, 0, 7); g.stroke();  // 红章
    }
    /* ---- 彩蛋·穿衣镜 ----
       照镜子用的挂镜。镜面故意做成「上亮下暗」——像映着天花板那盏灯，
       这样 game.js 里那个一闪而过的深色剪影才有底子衬出来。 */
    SPR.mirror = spriteCanvas(48, 74);
    {
      const g = SPR.mirror.getContext('2d');
      // 外框（顶高光 / 底暗部，让它看起来是一整块挂着的板）
      g.fillStyle = '#3b4147'; g.fillRect(4, 0, 40, 74);
      g.fillStyle = '#565f67'; g.fillRect(4, 0, 40, 2);
      g.fillStyle = '#4a525a'; g.fillRect(4, 68, 40, 3);
      g.fillStyle = '#242a2f'; g.fillRect(4, 71, 40, 3);
      // 镜面
      const mg = g.createLinearGradient(0, 5, 0, 66);
      mg.addColorStop(0, '#39434b');
      mg.addColorStop(0.42, '#1d2429');
      mg.addColorStop(1, '#0c1013');
      g.fillStyle = mg; g.fillRect(8, 5, 32, 61);
      // 两道斜向反光
      g.globalAlpha = 0.14; g.fillStyle = '#a8bcc9';
      g.beginPath(); g.moveTo(8, 44); g.lineTo(23, 5); g.lineTo(31, 5); g.lineTo(16, 44);
      g.closePath(); g.fill();
      g.beginPath(); g.moveTo(14, 66); g.lineTo(40, 26); g.lineTo(40, 38); g.lineTo(24, 66);
      g.closePath(); g.fill();
      g.globalAlpha = 1;
      // 玻璃边缘的一道冷光
      g.strokeStyle = 'rgba(190,205,215,.2)'; g.lineWidth = 1;
      g.strokeRect(8.5, 5.5, 31, 60);
    }
  }
  const SPR = {};

  /* ---------- 场景装饰摆放 ---------- */
  function decorate() {
    const list = [];
    const put = (spr, roomName, n, jitter) => {
      const r = ROOMS.find(rr => rr.n === roomName);
      if (!r) return;
      for (let i = 0; i < n; i++) {
        for (let t = 0; t < 30; t++) {
          const x = r.x + 1 + Math.random() * (r.w - 2);
          const y = r.y + 1 + Math.random() * (r.h - 2);
          if (!walkable(x, y)) continue;
          if (list.some(o => Math.hypot(o.x - x, o.y - y) < 1.6)) continue;
          list.push({ x, y, spr, h: 0, jitter: jitter || 0 });
          break;
        }
      }
    };
    put(SPR.bed, '病房 A', 2); put(SPR.bed, '病房 B', 2);
    put(SPR.iv, '病房 A', 2); put(SPR.iv, '病房 B', 2);
    put(SPR.iv, '手术室', 2);
    put(SPR.cab, '档案室', 3); put(SPR.cab, '药房', 2);
    put(SPR.wheel, '中庭走廊', 2); put(SPR.wheel, '接待大厅', 1);
    put(SPR.bed, '太平间', 3); put(SPR.iv, '太平间', 1);
    put(SPR.cab, '值班室', 1);
    /* ---- 环境叙事 / 彩蛋：固定摆放 ----
       put() 要求「间距 ≥1.6 格」，可值班室只有 3 格、病房只有十几格还被床和
       输液架占着 —— 1.6 格间距在小房间里等于「整间房都算被占」，黑板和镜子
       会时有时无。所以固定道具改用下面这个：放宽间距 + 「挑最空那格」兜底，
       保证一定摆得进去，也不会叠在家具上。 */
    const placeFixed = (spr, roomName, gap) => {
      const r = ROOMS.find(rr => rr.n === roomName);
      if (!r) return null;
      const ok = (x, y) => walkable(x, y) &&
        !list.some(o => Math.hypot(o.x - x, o.y - y) < gap);
      let spot = null;
      for (let t = 0; t < 80 && !spot; t++) {
        const x = r.x + 1.5 + Math.random() * Math.max(0.5, r.w - 3);
        const y = r.y + 1.5 + Math.random() * Math.max(0.5, r.h - 3);
        if (ok(x, y)) spot = { x, y };
      }
      if (!spot) {                          // 兜底：逐格扫描，挑离家具最远的格
        let best = -1;
        for (let gy = r.y + 1; gy < r.y + r.h - 1; gy++) {
          for (let gx = r.x + 1; gx < r.x + r.w - 1; gx++) {
            const x = gx + 0.5, y = gy + 0.5;
            if (!walkable(x, y)) continue;
            let dmin = 99;
            for (const o of list) dmin = Math.min(dmin, Math.hypot(o.x - x, o.y - y));
            if (dmin > best) { best = dmin; spot = { x, y }; }
          }
        }
      }
      if (spot) list.push({ x: spot.x, y: spot.y, spr });
      return spot;
    };
    placeFixed(SPR.board, '值班室', 1.2);      // 黑板（划掉七遍的「稳定」）
    placeFixed(SPR.sheet, '太平间', 1.2);      // 签收单（同一个签名）
    // 穿衣镜（活镜子彩蛋）摆进病房 B —— 玩家是在病房 A 醒来的，
    // 镜子放 A 会一开局就触发；放 B 既保证要主动走过去，又暗合「另一间病房」。
    const mspot = placeFixed(SPR.mirror, '病房 B', 1.2);
    if (mspot) {
      /* 贴墙 + 朝向：找最近的墙，把镜子推到墙面上，并记下法线（指向房间内）。
         倒影的镜像几何全靠这条法线 —— 没有它倒影不知道该往哪边翻。 */
      const tx = mspot.x | 0, ty = mspot.y | 0;
      let best = null, bd = 9;
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        for (let s2 = 1; s2 <= 2; s2++) {
          if (!walkable(tx + 0.5 + dx * s2, ty + 0.5 + dy * s2)) {
            if (s2 < bd) { bd = s2; best = [dx, dy]; }
            break;
          }
        }
      }
      if (best) {
        const [dx, dy] = best;
        mspot.x = tx + 0.5 + dx * (bd - 0.62);   // 推到离墙表面 0.12 格处
        mspot.y = ty + 0.5 + dy * (bd - 0.62);
        mspot.nx = -dx; mspot.ny = -dy;
      } else { mspot.nx = 0; mspot.ny = 1; }
    }
    {   // 挣断的约束带：随机一间病房
      const ward = ROOMS.find(rr => rr.n === (Math.random() < 0.5 ? '病房 A' : '病房 B'));
      if (ward) {
        for (let t = 0; t < 30; t++) {
          const x = ward.x + 1 + Math.random() * (ward.w - 2);
          const y = ward.y + 1 + Math.random() * (ward.h - 2);
          if (!walkable(x, y)) continue;
          list.push({ x, y, spr: SPR.strap, floor: true });
          break;
        }
      }
    }
    // 地面血迹若干
    for (let i = 0; i < 22; i++) {
      const r = ROOMS[ri(0, ROOMS.length - 1)];
      const x = r.x + Math.random() * (r.w - 1) + 0.5;
      const y = r.y + Math.random() * (r.h - 1) + 0.5;
      if (walkable(x, y)) list.push({ x, y, spr: SPR.stain, floor: true });
    }
    // 走廊血迹
    CORRIDORS.forEach(c => {
      if (Math.random() < 0.5)
        list.push({ x: c[0] + Math.random() * (c[2] - c[0] + 1), y: c[1] + Math.random() * (c[3] - c[1] + 1), spr: SPR.stain, floor: true });
    });
    return list;
  }

  return {
    W, H, T, ROOMS, EXIT_TILE, grid: () => grid,
    build, buildTextures, buildSprites, decorate,
    at, walkable, solidAt, los, bfsStep,
    tex: i => TEXTURES[i], get TEXTURES() { return TEXTURES; },
    get FLOOR_TEX() { return FLOOR_TEX; },
    get CEIL_TEX() { return CEIL_TEX; },
    SPR,
  };
})();
