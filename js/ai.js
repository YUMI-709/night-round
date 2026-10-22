/* =========================================================
   ai.js —— 艾尔海森（主治医师）状态机 + 台词库
   ========================================================= */
const LINES = {
  patrol: [
    '体温、脉搏、瞳孔反射 —— 都正常。你没有理由离开。',
    '第三根灯管又在闪。明天要报修。',
    '如果你醒了，就回床上去。夜里地板很凉。',
    '值班记录写完了。接下来是查房。',
    '观察期七十二小时。现在才过了一半。',
  ],
  spotted: [
    '卡维。',
    '果然。约束带被你解开了。',
    '凌晨三点十二分。你打算去哪？',
    '站住。',
    '我说过，走廊是封的。',
  ],
  chase: [
    '别跑。你的心率已经过速了。',
    '你比谁都清楚，这里只有一条出口。',
    '观察期结束前，不许外出。这是我写的医嘱。',
    '你在喘。停下来，对心脏好一点。',
    '跑动会让伤口裂开。你不在乎，我在乎。',
  ],
  search: [
    '……躲起来是没用的。',
    '我可以等。我最擅长的就是等。',
    '你的脚步声很响，卡维。',
    '这层楼只有我们两个人。',
  ],
  near: [
    '我知道你在那边。',
    '屏住呼吸也没用。我看着你的病历。',
    '出来。我不会记你逃院。',
  ],
  caught: [
    '抓到了。回床上去。',
    '评估结束。你输了。',
    '约束带我会换新的。这次是加强款。',
    '别这样看我。这是为你好。',
  ],
  // 查房仪式：他在病房门口停下，翻着病历低声念
  chart: [
    '0709 号。睡眠四小时。反复惊醒。想走。',
    '病程记录：今夜第三次确认门窗。有进步。',
    '用药没有异常。逃跑记录有。',
    '他小时候也怕黑。这一点，病历治不好。',
  ],
};

/* =========================================================
   被抓住的结束语 —— 分档随机池
   tier 1：本局第 1 次被抓（还带着「温柔」的威胁）
   tier 2：本局第 2 次被抓（惩罚落地，明显变狠）
   每条 = { line: 艾尔海森的台词, note: 下方那行旁白/惩罚描述 }
   ========================================================= */
const CAUGHT_TIERS = {
  1: [
    {
      line: '「别找出口了。」他侧过头，瞳孔里没有灯的反光，「医院的出口只有一个方向——朝我这边。」',
      note: '你身后的灯一盏一盏灭下去。顺序整齐，像有人提前数好了。',
    },
    {
      line: '「观测记录：逃跑耗时四分钟，代价是膝盖擦伤。卡维，你在用自己的身体，为错误付费。」',
      note: '他捏着你的下巴检查瞳孔。手很稳，也很冷。今晚的镇静剂，加了剂量。',
    },
    {
      line: '「门禁卡在我口袋里。别找了——我比你先到。我永远比你先到。」',
      note: '床头柜上多了一杯温水和你的病历本。翻到今天那页，写着：「情绪不稳，加强看护。」',
    },
    {
      line: '「我不生气。医生不对病人的病情生气。」他顿了顿，「但我很失望。失望，是要记进病程的。」',
      note: '天快亮了。你在睡眠监测仪的滴答声里闭眼，听见他坐回椅子的声音——他不走了。',
    },
  ],
  2: [
    {
      line: '「逃跑消耗的体力，得补回来。这几杯营养剂，喝完才能睡。」',
      note: '三杯。不苦，是甜的，甜得让人眼皮发沉。你不知道里面有什么，你只知道他看着你喝完。',
    },
    {
      line: '「第二次了。看来是这间病房对你太宽容。」他翻开新的一页，「那就换个地方——没有窗，没有门缝，也没有白天。」',
      note: '推床的轮子在地砖上走了很久。新病房只有一张床、一盏灯，和墙角一个摄像头，红灯一直亮着。',
    },
    {
      line: '「我调整过剂量。痛感留着，别的都关掉。」他按住你乱动的手腕，「这叫让你清楚地知道，自己是谁的东西。」',
      note: '一整夜，你听得见自己的心跳，看得见天花板上晃动的残影——意识一点一点，沉了下去。',
    },
    {
      line: '「你哭着叫我名字的时候，声音很好听。」他替你把额发拨开，「所以以后每天，我都要听一次。不用真的哭——你可以学着哭。」',
      note: '那晚他的目光始终没有离开你。你在他眼里看见模糊的自己，看见衣衫凌乱、满身狼狈的自己。',
    },
  ],
};

const KAVEH = {
  title: ['我醒了。', '这针扎得不对。', '……又是这家医院。'],
};

const LINE = {
  pick: ['门禁卡。还差 {n} 张。', '找到了。手在抖。', '这个卡……你的抽屉里也有一张。'],
  locked: ['门锁着。需要三张门禁卡。', '打不开。数字锁还差几位。'],
  escape: [],
};

function pickLine(arr) { return arr[(Math.random() * arr.length) | 0]; }

/* =========================================================
   Doctor —— 艾尔海森
   ========================================================= */
class Doctor {
  constructor(x, y) {
    this.x = x; this.y = y;
    this.dx = 0; this.dy = 1;
    this.fx = 0; this.fy = 1;
    this.state = 'patrol';
    this.path = null;
    this.tx = x; this.ty = y;
    this.speed = 1.30;
    this.animT = 0;
    this.repathT = 0;
    this.waitT = 0;
    this.lastSeen = { x: x, y: y };
    this.loseT = 0;
    this.stepT = 0;
    this.lineT = 0;
    this.spotAnnounced = false;
    this.scanT = 0;
    this.trail = [];
    /* ---- 查房仪式：每隔一阵，他会走到一扇病房门前，敲三下，照一照 ---- */
    this.ritualCd = 26 + Math.random() * 22;   // 距下次查房的秒数
    this.ritualT = 0;                          // 仪式进行中的剩余时间
    this.knocked = false;
  }

  get moving() { return Math.hypot(this.dx, this.dy); }

  /** 侦测玩家 */
  sense(player, dt) {
    const dx = player.x - this.x, dy = player.y - this.y;
    const dist = Math.hypot(dx, dy);
    const nx = dx / (dist || 1), ny = dy / (dist || 1);
    const fx = this.fx, fy = this.fy;
    const dot = fx * nx + fy * ny;
    const fov = this.state === 'chase' ? -0.25 : 0.30;  // cos 阈值
    const range = this.state === 'chase' ? 13.5 : 9.5;
    // 蹲在病床/器械后面时，远距离基本看不见
    const hide = player.crouching && dist > 5.2;
    const seen = !hide && dist < range && dot > fov &&
                 World.los(this.x, this.y, player.x, player.y);

    // 听觉：奔跑很吵，潜行几乎无声
    const noise = player.moveSpeed;
    const hearR = noise > 3.0 ? 8.5 : noise > 1.2 ? 5.0 : 2.0;
    let heard = dist < hearR;
    if (player.bumpT > 0 && dist < 9) heard = true;
    if (player.pickT > 0 && dist < 7) heard = true;

    return { seen, heard, dist, nx, ny };
  }

  update(dt, player, onEvent) {
    const s = this.sense(player, dt);
    this.lineT -= dt;
    this.spotAnnounced = this.spotAnnounced && this.state === 'chase';

    /* ---- 状态迁移 ---- */
    if (s.seen) {
      this.lastSeen.x = player.x; this.lastSeen.y = player.y;
      this.loseT = 0;
      if (this.state !== 'chase') {
        this.state = 'chase';
        this.repathT = 0;
        onEvent('spotted');
      }
    } else if (this.state === 'chase') {
      this.loseT += dt;
      if (this.loseT > 3.2) {
        this.state = 'search';
        this.waitT = 0;
        this.repathT = 0;
        onEvent('lost');
      }
    } else if (this.state === 'search') {
      this.loseT += dt;
      if (this.loseT > 14) {
        this.state = 'patrol';
        this.repathT = 0;
        onEvent('gaveup');
      }
    } else if (s.heard && this.state === 'patrol') {
      this.state = 'alert';
      this.lastSeen.x = player.x; this.lastSeen.y = player.y;
      this.repathT = 0;
      this.waitT = 0;
    }

    /* ---- 查房仪式状态迁移 ---- */
    if (this.state === 'patrol') {
      this.ritualCd -= dt;
      if (this.ritualCd <= 0) {
        // 找一扇最近的病房门走过去
        const door = this.findDoor();
        if (door) {
          this.state = 'ritual-go';
          this.tx = door.x + 0.5; this.ty = door.y + 0.5;
          this.knocked = false;
          this.repathT = 0;
        } else {
          this.ritualCd = 20;
        }
      }
    } else if (this.state === 'ritual-go') {
      if (Math.hypot(this.x - this.tx, this.y - this.ty) < 0.9) {
        this.state = 'ritual';
        this.ritualT = 3.4;
      }
    } else if (this.state === 'ritual') {
      this.ritualT -= dt;
      if (!this.knocked) {
        this.knocked = true;
        onEvent('knock');                       // 咚、咚、咚
        if (s.dist < 7) onEvent('line', 'chart');  // 低声念病历
      }
      if (this.ritualT <= 0) {
        // 门后的证据：玩家在附近弄出过动静 → 起疑搜索
        if (s.dist < 5.5 && (player.moveSpeed > 1.2 || player.bumpT > 0 || player.pickT > 0)) {
          this.lastSeen.x = player.x; this.lastSeen.y = player.y;
          this.state = 'alert';
          this.waitT = 0;
          this.repathT = 0;
        } else {
          this.state = 'patrol';
        }
        this.ritualCd = 40 + Math.random() * 35;
        this.repathT = 0;
      }
    }

    /* ---- 目标点 ---- */
    this.speed = this.state === 'chase' ? 2.62 : this.state === 'alert' ? 2.0
               : this.state === 'search' ? 1.85
               : this.state === 'ritual-go' ? 1.25 : 1.25;

    if (this.state === 'chase') {
      this.tx = player.x; this.ty = player.y;
      this.repathT -= dt;
      if (this.repathT <= 0) { this.repathT = 0.22; this.recompute(); }
    } else if (this.state === 'alert' || this.state === 'search') {
      this.waitT -= dt;
      const near = Math.hypot(this.x - this.tx, this.y - this.ty) < 0.7;
      if (near || (this.state === 'alert' && !this.path)) {
        if (this.state === 'alert') { this.state = 'search'; this.loseT = 0; }
        if (this.waitT <= 0) {
          // 在最后已知位置附近随机游走
          for (let i = 0; i < 24; i++) {
            const a = Math.random() * Math.PI * 2, d = 1 + Math.random() * 5;
            const cx = this.lastSeen.x + Math.cos(a) * d, cy = this.lastSeen.y + Math.sin(a) * d;
            if (World.walkable(cx, cy)) { this.tx = cx; this.ty = cy; break; }
          }
          this.waitT = 1.6 + Math.random() * 2.4;
          this.recompute();
        }
      }
    } else {
      // 巡逻：随机房间
      this.waitT -= dt;
      const near = Math.hypot(this.x - this.tx, this.y - this.ty) < 0.8;
      if ((near && this.waitT <= 0) || !this.path) {
        const rooms = World.ROOMS;
        const r = rooms[(Math.random() * rooms.length) | 0];
        this.tx = r.x + 0.5 + Math.random() * (r.w - 1);
        this.ty = r.y + 0.5 + Math.random() * (r.h - 1);
        this.waitT = 1.2 + Math.random() * 3.5;
        this.recompute();
        if (this.lineT <= 0 && Math.random() < 0.6) onEvent('line', 'patrol');
      }
    }

    /* ---- 沿路径移动（逐格 BFS，每帧取下一步格中心） ---- */
    let mvx = 0, mvy = 0;
    const standing = (this.waitT > 0 && this.state === 'patrol') || this.state === 'ritual';
    if (!standing) {
      const goal = this.follow();
      if (goal) {
        const dx = goal.x - this.x, dy = goal.y - this.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.04) { mvx = dx / d; mvy = dy / d; }
      }
    }

    // 平滑转向
    if (mvx || mvy) {
      const k = Math.min(1, dt * 6);
      this.dx += (mvx - this.dx) * k;
      this.dy += (mvy - this.dy) * k;
    }
    const dl = Math.hypot(this.dx, this.dy) || 1;
    this.fx = this.dx / dl; this.fy = this.dy / dl;

    const spd = this.speed;
    const nx = this.x + this.fx * spd * dt;
    const ny = this.y + this.fy * spd * dt;
    const moved = Math.hypot(this.fx * spd * dt, this.fy * spd * dt);
    if (!World.solidAt(nx, this.y)) this.x = nx;
    if (!World.solidAt(this.x, ny)) this.y = ny;

    if (moved > 0.0005) this.animT += dt * (this.state === 'chase' ? 11 : 6);
    else this.animT += dt * 1.2;

    // 脚步声（由外部根据距离播放）
    const dist = Math.hypot(player.x - this.x, player.y - this.y);
    this.stepT -= dt * (this.speed / 1.25);
    if (this.stepT <= 0 && moved > 0.0005) {
      this.stepT = 0.52;
      onEvent('step', Math.max(0, 1 - dist / 14) * Math.max(0.35, 1 - dist / 14));
    }

    // 记录足迹（用于搜索时的“他刚走过这里”氛围）
    if (this.trail.length === 0 || Math.hypot(this.x - this.trail[0].x, this.y - this.trail[0].y) > 1.2) {
      this.trail.unshift({ x: this.x, y: this.y });
      if (this.trail.length > 14) this.trail.pop();
    }

    return s.dist;
  }

  recompute() { /* BFS 每帧按需计算，此处保留接口占位 */ }

  /** 找一扇离自己最近的病房门（ ritual 查房用） */
  findDoor() {
    const g = World.grid(), W = World.W, H = World.H;
    const cx = Math.floor(this.x), cy = Math.floor(this.y);
    let best = null, bd = 1e9;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (g[y][x] !== World.T.DOOR) continue;
        const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d < bd && d > 4) { bd = d; best = { x, y }; }
      }
    }
    return best;
  }
}

/* 逐格寻路：目标同格时直奔，否则走 BFS 的下一步格中心 */
Doctor.prototype.follow = function () {
  const gx = this.tx, gy = this.ty;
  const cx = Math.floor(this.x), cy = Math.floor(this.y);
  const gcx = Math.floor(gx), gcy = Math.floor(gy);
  if (cx === gcx && cy === gcy) return { x: gx, y: gy };
  const step = World.bfsStep(this.x, this.y, gx, gy);
  if (!step) return { x: gx, y: gy };
  this.goal = step;
  return step;
};
