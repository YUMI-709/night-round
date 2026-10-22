/* =========================================================
   render.js —— 软件光线投射渲染器（像素恐怖风）
   ========================================================= */
const Renderer = (() => {
  let CW = 320, CH = 200;
  let buf = null, u32 = null, ctx2 = null;
  let zBuf = new Float32Array(CW);
  let sZBuf = new Float32Array(CW);      // 精灵深度：最近的家具/角色（防倒影穿模）
  const texCache = new WeakMap();
  const FOG = [6, 7, 10];

  function init(canvas) {
    CW = canvas.width; CH = canvas.height;
    ctx2 = canvas.getContext('2d', { alpha: false });
    buf = ctx2.createImageData(CW, CH);
    u32 = new Uint32Array(buf.data.buffer);
    zBuf = new Float32Array(CW);
    sZBuf = new Float32Array(CW);
  }

  function texPixels(cv) {
    let d = texCache.get(cv);
    if (d) return d;
    const tctx = cv.getContext('2d');
    const im = tctx.getImageData(0, 0, cv.width, cv.height);
    d = { w: cv.width, h: cv.height, p: new Uint32Array(im.data.buffer) };
    texCache.set(cv, d);
    return d;
  }

  const pack = (r, g, b) => (255 << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);

  /* ---------- 光照 ---------- */
  let flicker = 1, blackout = 0, lightPulse = 0;
  function setLight(opts) {
    flicker = opts.flicker;
    blackout = opts.blackout;
    lightPulse = opts.pulse || 0;
  }

  /* =========================================================
     主渲染
     px,py 位置 / dirX,dirY 朝向 / planeX,planeY 相机平面
     sprites: [{x,y,tex,scale,yOff,flat,bright}]
     ========================================================= */
  function render(px, py, dirX, dirY, planeX, planeY, sprites, opt) {
    opt = opt || {};
    const pitch = opt.pitch || 0;
    const horizon = (CH >> 1) + pitch;
    const coneTight = opt.cone !== undefined ? opt.cone : 1.0;

    /* ---------- 1. 天花 & 地面（逐行投射） ---------- */
    const ftex = texPixels(World.FLOOR_TEX), ctex = texPixels(World.CEIL_TEX);
    const rdx0 = dirX - planeX, rdy0 = dirY - planeY;
    const rdx1 = dirX + planeX, rdy1 = dirY + planeY;
    const fogR = FOG[0], fogG = FOG[1], fogB = FOG[2];

    for (let y = 0; y < CH; y++) {
      const isFloor = y > horizon;
      const dy = isFloor ? (y - horizon) : (horizon - y);
      if (dy <= 0) continue;
      const rowDist = (0.5 * CH) / dy;
      if (rowDist > 26) {
        // 太远 → 纯黑
        const base = y * CW;
        for (let x = 0; x < CW; x++) u32[base + x] = 0xff000000;
        continue;
      }
      const stepX = rowDist * (rdx1 - rdx0) / CW;
      const stepY = rowDist * (rdy1 - rdy0) / CW;
      let fx = px + rowDist * rdx0;
      let fy = py + rowDist * rdy0;
      const tex = isFloor ? ftex : ctex;
      const tw = tex.w, th = tex.h, tp = tex.p;
      const base = y * CW;
      const distFall = Math.pow(1 / (1 + rowDist * rowDist * 0.055), 1.35);
      const rowScale = isFloor ? 1 : 0.42;
      const emiss = isFloor ? 0 : 0.02;
      for (let x = 0; x < CW; x++) {
        const tx = ((fx * tw) | 0) & (tw - 1);
        const ty = ((fy * th) | 0) & (th - 1);
        const c = tp[ty * tw + tx];
        const ndc = (x - (CW >> 1)) / (CW >> 1);
        let cone = 1 - ndc * ndc * 1.25 * coneTight;
        if (cone < 0) cone = 0; else cone = cone * cone * (3 - 2 * cone);
        let L = (0.045 + cone * distFall * 0.98 + emiss) * rowScale;
        L *= flicker;
        if (L > 1.25) L = 1.25;
        const r = ((c & 255) * L + fogR) | 0;
        const g2 = (((c >> 8) & 255) * L + fogG) | 0;
        const b = (((c >> 16) & 255) * L + fogB) | 0;
        u32[base + x] = pack(r > 255 ? 255 : r, g2 > 255 ? 255 : g2, b > 255 ? 255 : b);
        fx += stepX; fy += stepY;
      }
    }

    /* ---------- 2. 墙面（DDA） ---------- */
    const T = World.T;
    for (let x = 0; x < CW; x++) {
      const camX = 2 * x / CW - 1;
      const rx = dirX + planeX * camX;
      const ry = dirY + planeY * camX;
      let mapX = px | 0, mapY = py | 0;
      const ddx = rx === 0 ? 1e30 : Math.abs(1 / rx);
      const ddy = ry === 0 ? 1e30 : Math.abs(1 / ry);
      let stepX, stepY, sdx, sdy;
      if (rx < 0) { stepX = -1; sdx = (px - mapX) * ddx; } else { stepX = 1; sdx = (mapX + 1 - px) * ddx; }
      if (ry < 0) { stepY = -1; sdy = (py - mapY) * ddy; } else { stepY = 1; sdy = (mapY + 1 - py) * ddy; }
      let side = 0, tile = 0, hit = false, guard = 0;
      while (!hit && guard++ < 60) {
        if (sdx < sdy) { sdx += ddx; mapX += stepX; side = 0; }
        else { sdy += ddy; mapY += stepY; side = 1; }
        tile = World.at(mapX, mapY);
        if (tile !== T.FLOOR) hit = true;
      }

      const perp = side === 0 ? (sdx - ddx) : (sdy - ddy);
      const dist = Math.max(0.02, perp);
      zBuf[x] = dist;
      const lineH = CH / dist;
      let dStart = Math.floor(-lineH / 2 + horizon);
      let dEnd = Math.floor(lineH / 2 + horizon);

      // 贴图 U
      let wallX = side === 0 ? py + perp * ry : px + perp * rx;
      wallX -= Math.floor(wallX);
      // 墙面贴图编号映射
      let ti = 0;
      if (tile === T.WALL) ti = 0;
      else if (tile === T.BLOOD) ti = 1;
      else if (tile === T.ROT) ti = 2;
      else if (tile === T.TILE_DARK) ti = 3;
      else if (tile === T.DOOR) ti = 4;
      else if (tile === T.EXIT) ti = 5;
      const texCv = World.TEXTURES[ti] || World.TEXTURES[0];
      const tex = texPixels(texCv);
      const tw = tex.w, th = tex.h, tp = tex.p;
      let tx = (wallX * tw) | 0;
      if ((side === 0 && rx > 0) || (side === 1 && ry < 0)) tx = tw - tx - 1;
      if (tx < 0) tx = 0; if (tx >= tw) tx = tw - 1;

      const distFall = Math.pow(1 / (1 + dist * dist * 0.05), 1.35);
      const ndc = (x - (CW >> 1)) / (CW >> 1);
      let cone = 1 - ndc * ndc * 1.25 * coneTight;
      if (cone < 0) cone = 0; else cone = cone * cone * (3 - 2 * cone);
      let L = (0.05 + cone * distFall * 1.05) * flicker;
      if (side === 1) L *= 0.68;
      if (tile === T.EXIT) L += 0.10 * Math.pow(1 - Math.min(1, dist / 8), 2); // 出口自发光
      if (L > 1.3) L = 1.3;

      const stepTex = th / lineH;
      const y0 = Math.max(0, dStart), y1 = Math.min(CH - 1, dEnd);
      let texPos = (y0 - horizon + lineH / 2) * stepTex;
      let colR = 0, colG = 0, colB = 0;
      const isExit = tile === T.EXIT;
      for (let y = y0; y <= y1; y++) {
        let ty = (texPos | 0);
        if (ty < 0) ty = 0; if (ty >= th) ty = th - 1;
        texPos += stepTex;
        const c = tp[ty * tw + tx];
        let ll = L;
        if (isExit) {
          // 出口门缝微光
          const cy = ty / th;
          if (cy > 0.42 && cy < 0.50) ll += 0.35;
        }
        let r = ((c & 255) * ll + fogR) | 0;
        let g2 = (((c >> 8) & 255) * ll + fogG) | 0;
        let b = (((c >> 16) & 255) * ll + fogB) | 0;
        u32[y * CW + x] = pack(r > 255 ? 255 : r, g2 > 255 ? 255 : g2, b > 255 ? 255 : b);
      }
      // 未覆盖区域补黑（极端近距离）
      for (let y = 0; y < y0; y++) u32[y * CW + x] = 0xff000000;
      for (let y = y1 + 1; y < CH; y++) u32[y * CW + x] = 0xff000000;
    }

    /* ---------- 3. 精灵（billboard） ---------- */
    const invDet = 1.0 / (planeX * dirY - dirX * planeY);
    sZBuf.fill(1e9);                       // 每帧重置：记录每列最近精灵的深度
    const order = [];
    for (let i = 0; i < sprites.length; i++) {
      const s = sprites[i];
      s._dx = s.x - px; s._dy = s.y - py;
      s._d2 = s._dx * s._dx + s._dy * s._dy;
      order.push(i);
    }
    order.sort((a, b) => sprites[b]._d2 - sprites[a]._d2);

    for (const si of order) {
      const s = sprites[si];
      const spriteX = s._dx, spriteY = s._dy;
      const transX = invDet * (dirY * spriteX - dirX * spriteY);
      const transY = invDet * (-planeY * spriteX + planeX * spriteY);
      if (transY < 0.12) continue;
      const scrX = Math.floor((CW / 2) * (1 + transX / transY));
      const lineH = CH / transY;
      const sh = lineH * (s.scale || 1);
      const sw = sh * (s.aspect || 1);
      const bottom = horizon + lineH * 0.5 - (s.yOff || 0) * lineH;
      const top = bottom - sh;
      let drawStartX = Math.floor(scrX - sw * 0.5), drawEndX = Math.floor(scrX + sw * 0.5);
      const startX = Math.max(0, drawStartX), endX = Math.min(CW - 1, drawEndX);
      const y0 = Math.max(0, Math.floor(top)), y1 = Math.min(CH - 1, Math.floor(bottom));
      if (endX < startX || y1 < y0) continue;

      const tex = texPixels(s.tex);
      const tw = tex.w, th = tex.h, tp = tex.p;
      const distFall = Math.pow(1 / (1 + transY * transY * 0.05), 1.3);
      const shade = s.flat ? 0.55 : 1;
      const bright = s.bright || 0;
      for (let x = startX; x <= endX; x++) {
        if (transY < sZBuf[x]) sZBuf[x] = transY;   // 记录该列最近精灵（防穿模用）
        if (transY >= zBuf[x]) continue;
        const texX = Math.floor((x - (scrX - sw * 0.5)) * tw / sw);
        if (texX < 0 || texX >= tw) continue;
        const ndc = (x - (CW >> 1)) / (CW >> 1);
        let cone = 1 - ndc * ndc * 1.25 * coneTight;
        if (cone < 0) cone = 0; else cone = cone * cone * (3 - 2 * cone);
        let L = (0.06 + (cone * 0.6 + 0.42) * distFall + bright) * flicker * shade;
        if (s.flat) L = (0.10 + cone * 0.5 * distFall) * flicker;
        if (L > 1.35) L = 1.35;
        for (let y = y0; y <= y1; y++) {
          const texY = Math.floor((y - top) * th / sh);
          if (texY < 0 || texY >= th) continue;
          const c = tp[texY * tw + texX];
          const a = (c >>> 24) & 255;
          if (a < 40) continue;
          const r = ((c & 255) * L + fogR) | 0;
          const g2 = (((c >> 8) & 255) * L + fogG) | 0;
          const b = (((c >> 16) & 255) * L + fogB) | 0;
          const idx = y * CW + x;
          if (a >= 248) {
            u32[idx] = pack(r > 255 ? 255 : r, g2 > 255 ? 255 : g2, b > 255 ? 255 : b);
          } else {
            const old = u32[idx];
            const k = a / 255;
            const or = old & 255, og = (old >> 8) & 255, ob = (old >> 16) & 255;
            u32[idx] = pack(
              (or + (r - or) * k) | 0,
              (og + (g2 - og) * k) | 0,
              (ob + (b - ob) * k) | 0);
          }
        }
      }
    }

    /* ---------- 3.5 镜面反射（活镜子） ----------
       镜框是 billboard（永远朝向玩家），所以镜面法线取「玩家 → 镜点」方向：
       倒影 = 玩家关于镜点的中心对称（2m − p），等价于以视线为法线的镜像。
       投影回屏幕后把水平位置**夹进玻璃区域** —— 任何角度看镜子都能看到
       自己；转身时倒影从玻璃中央滑向边缘贴边停住，横着走过时照常滑动。 */
    const mirrors = opt.mirrors || [];
    for (const mi of mirrors) {
      const mdx = mi.x - px, mdy = mi.y - py;
      const mTX = invDet * (dirY * mdx - dirX * mdy);
      const mTY = invDet * (-planeY * mdx + planeX * mdy);
      if (mTY < 0.15) continue;
      const mScrX = (CW / 2) * (1 + mTX / mTY);
      const mLineH = CH / mTY;
      const mSh = mLineH * (mi.scale || 0.95);
      const mSw = mSh * (mi.aspect || 48 / 74);
      const mBottom = horizon + mLineH * 0.5;
      const mTop = mBottom - mSh;
      if (mTop > CH || mBottom < 0) continue;
      /* 玻璃内沿（镜框贴图：左右框各约 1/3 全宽的一半，上下留出框条） */
      const glassL = mScrX - mSw * 0.31, glassR = mScrX + mSw * 0.31;
      const glassT = mTop + mSh * (7 / 74), glassB = mBottom - mSh * (11 / 74);

      /* 玩家的镜像：过镜点的中心对称（billboard 镜面永远朝向玩家） */
      const rx = 2 * mi.x - px, ry = 2 * mi.y - py;

      const stamp = (tex, wx, wy, sScale, sAspect, lite, tint, gAlpha, edgeBias) => {
        const tdx = wx - px, tdy = wy - py;
        const tTX = invDet * (dirY * tdx - dirX * tdy);
        const tTY = invDet * (-planeY * tdx + planeX * tdy);
        if (tTY < 0.15) return;
        let tScrX = (CW / 2) * (1 + tTX / tTY);
        const tLineH = CH / tTY;
        const tSh = tLineH * sScale;
        const tSw = tSh * sAspect;
        /* 水平夹进玻璃：倒影永远可见；edgeBias 让白大褂往余光那侧偏 */
        const lo = glassL + tSw * 0.5, hi = glassR - tSw * 0.5;
        if (lo < hi) {
          tScrX += (edgeBias || 0) * tSw;
          tScrX = Math.max(lo, Math.min(hi, tScrX));
        }
        const tBottom = horizon + tLineH * 0.5;
        const tTop = tBottom - tSh;
        const x0 = Math.max(0, Math.ceil(Math.max(glassL, tScrX - tSw * 0.5)));
        const x1 = Math.min(CW - 1, Math.floor(Math.min(glassR, tScrX + tSw * 0.5)));
        const y0 = Math.max(0, Math.ceil(Math.max(glassT, tTop)));
        const y1 = Math.min(CH - 1, Math.floor(Math.min(glassB, tBottom)));
        if (x1 < x0 || y1 < y0) return;
        const tp = texPixels(tex);
        const tw = tp.w, th = tp.h;
        const distFall = Math.pow(1 / (1 + tTY * tTY * 0.05), 1.3);
        const aMul = gAlpha === undefined ? 0.92 : Math.min(1, gAlpha * 1.1);
        const L0 = lite * (0.5 + 0.62 * distFall) * flicker *
                   (gAlpha === undefined ? 1 : gAlpha);
        for (let x = x0; x <= x1; x++) {
          /* 这一列被墙挡住、或被「真正更近」的家具/角色挡住 → 没有玻璃（防穿模）。
             注意必须用带容差的严格小于：镜框精灵自己的深度和 mTY 是同一个数，
             两条计算路径的浮点舍入方向随玩家位置逐帧变化 —— 若用 mTY >= sZBuf
             比较，倒影会随舍入方向整列忽隐忽现（「一闪一闪」的根源）。 */
          if (mTY >= zBuf[x] || sZBuf[x] < mTY - 0.02) continue;
          const u = (x - (tScrX - tSw * 0.5)) / tSw;
          let texX = ((1 - u) * tw) | 0;      // 镜像 → 左右翻转
          if (texX < 0) texX = 0; else if (texX >= tw) texX = tw - 1;
          for (let y = y0; y <= y1; y++) {
            let texY = (((y - tTop) / tSh) * th) | 0;
            if (texY < 0) texY = 0; else if (texY >= th) texY = th - 1;
            const c = tp.p[texY * tw + texX];
            const a = (c >>> 24) & 255;
            if (a < 40) continue;
            let r = ((c & 255) * L0) | 0;
            let g2 = (((c >> 8) & 255) * L0) | 0;
            let b = (((c >> 16) & 255) * L0) | 0;
            if (tint) { r = (r * tint[0]) | 0; g2 = (g2 * tint[1]) | 0; b = (b * tint[2]) | 0; }
            r += fogR * 0.4; g2 += fogG * 0.4; b += fogB * 0.55;   // 玻璃的冷灰底色
            const idx = y * CW + x;
            const old = u32[idx];
            const k = (a / 255) * aMul;
            u32[idx] = pack(
              ((old & 255) + (Math.min(255, r) - (old & 255)) * k) | 0,
              (((old >> 8) & 255) + (Math.min(255, g2) - ((old >> 8) & 255)) * k) | 0,
              (((old >> 16) & 255) + (Math.min(255, b) - ((old >> 16) & 255)) * k) | 0);
          }
        }
      };

      /* 镜中深处（仅第一次照镜）：白大褂一闪而过 —— 无声、纯幻觉。
         位置在倒影更深处（更小），并往镜子所在的屏幕边缘偏 —— 余光感 */
      if (mi.ghost > 0.01 && mi.gtex) {
        const gx = mi.x + (mi.x - px) * 0.5;
        const gy = mi.y + (mi.y - py) * 0.5;
        const side = mScrX > CW / 2 ? 1 : -1;
        stamp(mi.gtex, gx, gy, 0.9, 0.75, 0.62, [0.4, 0.4, 0.46], mi.ghost, side * 0.55);
      }
      /* 玩家自己的倒影：冷色调、压暗 —— 镜中的世界比现实暗一点 */
      stamp(mi.tex, rx, ry, 1.0, 0.75, 0.85, [0.66, 0.76, 0.94]);
    }

    /* ---------- 4. 输出 ---------- */
    ctx2.putImageData(buf, 0, 0);

    // 黑暗压顶 / 停电
    if (blackout > 0) {
      ctx2.fillStyle = 'rgba(0,0,0,' + Math.min(0.94, blackout) + ')';
      ctx2.fillRect(0, 0, CW, CH);
    }
    // 追逐时的红色压迫感
    if (lightPulse > 0) {
      ctx2.fillStyle = 'rgba(150,20,16,' + (lightPulse * 0.16).toFixed(3) + ')';
      ctx2.fillRect(0, 0, CW, CH);
    }
    return { ctx: ctx2, CW, CH };
  }

  function drawHands(ctx, bob, alpha, scale) {
    const img = World.SPR.hands;
    if (!img) return;
    const w = CW * 0.78 * (scale || 1);
    const h = w * (img.height / img.width);
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, (CW - w) / 2, CH - h + bob, w, h);
    ctx.globalAlpha = 1;
  }

  return {
    init, render, drawHands, texPixels, setLight,
    get ctx() { return ctx2; },
    get W() { return CW; }, get H() { return CH; },
    get dbgZBuf() { return zBuf; }, get dbgSZBuf() { return sZBuf; },  // 调试探针用
  };
})();
