/**
 * 2D 俯视角足球 · 5v5
 * - 玩家用 W/A/S/D 控制蓝队 10 号，空格射门
 * - 其余 4 名队友 + 5 名对手（含守门员）由简单 AI 驱动
 * - 90 秒一局，结束后把比分 POST 到后端 /api/matches
 */
(function () {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // ---------- 场地常量（画布 1200×720，场地整体放大） ----------
  const F = { left: 60, right: W - 60, top: 40, bottom: H - 40 }; // 边线范围
  const GOAL_H = 180;
  const GOAL_TOP = (H - GOAL_H) / 2;
  const GOAL_BOTTOM = GOAL_TOP + GOAL_H;
  const GOAL_DEPTH = 30;
  const CX = (F.left + F.right) / 2, CY = (F.top + F.bottom) / 2;

  const PLAYER_R = 12, BALL_R = 7;
  const MATCH_SECONDS = 300; // 5 分钟一局
  const STEAL_PROTECT = 30; // 抢断后玩家的持球保护帧数（约 0.5 秒）
  // 移速整体放慢（v3 反馈：还要再慢一些）
  const AI_SPEED = 1.6, CHASE_SPEED = 1.9, GK_SPEED = 1.6, USER_SPEED = 2.0;

  // ---------- 状态 ----------
  let players = [], ball = null;
  let scoreBlue = 0, scoreRed = 0;
  let timeLeft = MATCH_SECONDS;
  let matchOver = false, resetTimer = 0, goalBanner = 0;
  let reported = false;
  let frameCount = 0;   // 用于高亮动画
  let stealCd = 0;      // 抢断后持球保护剩余帧数
  let releaseCd = 0;    // 踢球后解除吸附的帧数（让球飞出去）
  let ballOwner = null; // 当前持球球员（每帧按距离判定）
  let userPlayer = null;
  const keys = {};

  // ---------- 球员 ----------
  // role: 'GK' 守门员 | 'DF' 后卫 | 'MF' 中场 | 'FW' 前锋
  // home 为开球时的站位（0~1 相对坐标，blue 从左往右进攻）
  function makePlayer(team, role, fx, fy, isUser) {
    return {
      team, role, isUser: !!isUser,
      fx, fy,
      x: 0, y: 0, vx: 0, vy: 0,
      r: PLAYER_R,
      kickCd: 0, // 射门冷却（帧）
    };
  }

  function setupTeams() {
    players = [
      // 蓝队（玩家，防守左侧球门，进攻右侧）
      makePlayer('blue', 'GK', 0.04, 0.50),
      makePlayer('blue', 'DF', 0.20, 0.28),
      makePlayer('blue', 'DF', 0.20, 0.72),
      makePlayer('blue', 'MF', 0.40, 0.50),
      makePlayer('blue', 'FW', 0.55, 0.50, true), // 玩家控制的 10 号
      // 红队（全 AI，防守右侧球门，进攻左侧）
      makePlayer('red', 'GK', 0.96, 0.50),
      makePlayer('red', 'DF', 0.80, 0.28),
      makePlayer('red', 'DF', 0.80, 0.72),
      makePlayer('red', 'MF', 0.60, 0.50),
      makePlayer('red', 'FW', 0.45, 0.50),
    ];
    userPlayer = players.find((p) => p.isUser);
  }

  function homePos(p) {
    const fieldW = F.right - F.left;
    if (p.role === 'GK') {
      const gx = p.team === 'blue' ? F.left + 20 : F.right - 20;
      return { x: gx, y: CY };
    }
    return { x: F.left + p.fx * fieldW, y: F.top + p.fy * (F.bottom - F.top) };
  }

  function resetPositions() {
    for (const p of players) {
      const h = homePos(p);
      p.x = h.x; p.y = h.y; p.vx = 0; p.vy = 0; p.kickCd = 0;
    }
    ball = { x: CX, y: CY, vx: 0, vy: 0, r: BALL_R };
    stealCd = 0; releaseCd = 0; ballOwner = null;
  }

  function startMatch() {
    scoreBlue = 0; scoreRed = 0;
    timeLeft = MATCH_SECONDS;
    matchOver = false; reported = false;
    goalBanner = 0; resetTimer = 0;
    document.getElementById('overlay').classList.add('hidden');
    updateScoreboard();
    resetPositions();
  }

  // ---------- 输入 ----------
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', ' '].includes(k)) e.preventDefault();
    keys[k] = true;
  });
  window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
  document.getElementById('restartBtn').addEventListener('click', startMatch);

  // ---------- 工具 ----------
  function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function attackGoal(team) {
    return team === 'blue'
      ? { x: F.right + 4, y: (GOAL_TOP + GOAL_BOTTOM) / 2 }
      : { x: F.left - 4, y: (GOAL_TOP + GOAL_BOTTOM) / 2 };
  }

  // 踢球：给球一个朝目标方向的速度
  function kickBall(p, tx, ty, speed) {
    if (p.kickCd > 0) return;
    // 玩家持球时，其他 AI 不能直接踢玩家脚下的球（抢断只能靠贴身）
    if (userPlayer && p !== userPlayer &&
        (ballOwner === userPlayer || stealCd > 0)) return;
    const d = dist(p.x, p.y, tx, ty) || 1;
    ball.vx = ((tx - p.x) / d) * speed;
    ball.vy = ((ty - p.y) / d) * speed;
    p.kickCd = 30;
    if (p.isUser) releaseCd = 15; // 踢球后短暂解除吸附，让球飞出去
  }

  // 传球目标：优先找指定角色（中场优先找前锋），找不到再退回通用评估——
  // 位置更好（明显更靠前）、没被盯死、传球路线没被封堵的队友
  // 注意：玩家也在候选之列，队友看到你处在更好的位置就会传给你
  function findPassTarget(p, preferRole) {
    const dir = p.team === 'blue' ? 1 : -1; // 进攻方向

    const tryFind = (role, minAdv, maxDist) => {
      let best = null, bestAdv = 0;
      for (const m of players) {
        if (m.team !== p.team || m === p || m.role === 'GK') continue;
        if (role && m.role !== role) continue;
        const adv = (m.x - p.x) * dir; // 队友比持球者更靠前多少
        if (adv < minAdv) continue;                // 必须更靠前
        const d = dist(p.x, p.y, m.x, m.y);
        if (d < 60 || d > maxDist) continue;       // 传球距离要合适
        // 接球人身边不能贴着对方球员（32 以内视为被盯死）
        let marked = false;
        for (const o of players) {
          if (o.team === p.team) continue;
          if (dist(o.x, o.y, m.x, m.y) < 32) { marked = true; break; }
        }
        if (marked) continue;
        // 传球路线上不能有对方球员拦截
        if (passLaneBlocked(p, m)) continue;
        if (adv > bestAdv) { bestAdv = adv; best = m; }
      }
      return best;
    };

    // 中场拿球：尽量直接找前锋（位置要求和距离要求都放宽）
    if (preferRole) {
      const preferred = tryFind(preferRole, 20, 420);
      if (preferred) return preferred;
    }
    return tryFind(null, 50, 320);
  }

  // 对方球员是否站在 a→b 的传球路线上（点到线段距离 < 16）
  function passLaneBlocked(a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby || 1;
    for (const o of players) {
      if (o.team === a.team) continue;
      const t = clamp(((o.x - a.x) * abx + (o.y - a.y) * aby) / len2, 0, 1);
      if (dist(o.x, o.y, a.x + abx * t, a.y + aby * t) < 16) return true;
    }
    return false;
  }

  // 避球：非追球人离球太近时，向外避让（覆盖原目标点）
  function avoidBall(p, tx, ty, minDist) {
    const d = dist(p.x, p.y, ball.x, ball.y);
    if (d < minDist) {
      const ax = (p.x - ball.x) / (d || 1), ay = (p.y - ball.y) / (d || 1);
      tx = p.x + ax * (minDist - d + 30);
      ty = p.y + ay * (minDist - d + 30);
    }
    return [tx, ty];
  }

  // 粘性带球：球贴在玩家身前（移动方向，静止时朝进攻方向），速度与玩家一致
  function glueBallTo(p) {    let fx, fy;
    if (Math.hypot(p.vx, p.vy) > 0.5) { fx = p.vx; fy = p.vy; }
    else {
      const g = attackGoal(p.team);
      fx = g.x - p.x; fy = g.y - p.y;
    }
    const fl = Math.hypot(fx, fy) || 1;
    ball.x = p.x + (fx / fl) * (p.r + ball.r + 2);
    ball.y = p.y + (fy / fl) * (p.r + ball.r + 2);
    ball.vx = p.vx; ball.vy = p.vy;
  }

  // ---------- AI ----------
  // 按角色分配追球人：中场是第一拿球点（拿球推进），
  // 前锋在球到前场时接应，后卫只有球进入本方 1/3 区域时才上抢
  function assignChasers() {
    const fieldW = F.right - F.left;
    for (const team of ['blue', 'red']) {
      const cands = players.filter((p) => p.team === team && p.role !== 'GK' && !p.isUser);
      const mf = cands.find((p) => p.role === 'MF');
      const fw = cands.find((p) => p.role === 'FW');
      const d = (p) => dist(p.x, p.y, ball.x, ball.y);
      const inOwnThird = team === 'blue'
        ? ball.x < F.left + fieldW / 3
        : ball.x > F.right - fieldW / 3;

      let best = null;
      if (inOwnThird) {
        // 危险区域：离球最近的后卫/中场立刻上抢
        best = cands.reduce((a, b) => (d(a) <= d(b) ? a : b));
      } else if (mf && d(mf) <= 260) {
        best = mf; // 中场拿球推进
      } else if (fw && d(fw) <= 260) {
        best = fw; // 前锋回接
      } else {
        best = (mf && (!fw || d(mf) <= d(fw))) ? mf : fw;
      }
      for (const p of players) {
        if (p.team === team) p.isChaser = (p === best);
      }
    }
  }

  function moveAI(p) {
    let tx, ty, speed = AI_SPEED;
    const dir = p.team === 'blue' ? 1 : -1; // 进攻方向

    if (p.role === 'GK') {
      // 守门员（已削弱）：移动更慢、纵向只跟随球的一部分偏移、出击范围更小
      const gx = p.team === 'blue' ? F.left + 20 : F.right - 20;
      tx = gx;
      const maxY = GOAL_H / 2 - 10;
      ty = CY + clamp((ball.y - CY) * 0.55, -maxY, maxY);
      speed = GK_SPEED - 0.4;
      const ownGoal = attackGoal(p.team === 'blue' ? 'red' : 'blue');
      const inPenalty = dist(ball.x, ball.y, ownGoal.x, ownGoal.y) < 90;
      if (inPenalty && dist(p.x, p.y, ball.x, ball.y) < 70) {
        tx = ball.x; ty = ball.y; speed = GK_SPEED;
        // 拿到球就大脚解围（力度减弱、方向更随机）
        if (dist(p.x, p.y, ball.x, ball.y) < PLAYER_R + BALL_R + 4) {
          kickBall(p, CX + (p.team === 'blue' ? 200 : -200), (Math.random() - 0.5) * 400, 3.5);
        }
      }
    } else if (p.isChaser) {
      // 追球队员：奔向球，得球后带球推进，靠近球门就射门
      speed = CHASE_SPEED;
      const goal = attackGoal(p.team);
      const nearGoal = dist(p.x, p.y, goal.x, goal.y) < 210;
      if (dist(p.x, p.y, ball.x, ball.y) < PLAYER_R + BALL_R + 6) {
        if (p.role === 'DF') {
          // 后卫得球：不做多余处理，直接大脚解围向前场
          kickBall(p, CX + dir * 200, (Math.random() - 0.5) * 300, 4);
          tx = p.x; ty = p.y;
        } else if (nearGoal) {
          kickBall(p, goal.x, goal.y + (Math.random() - 0.5) * GOAL_H * 0.6, 4.5);
          tx = p.x; ty = p.y;
        } else {
          // 中场拿球尽量直接找前锋；其他角色用通用评估（包括玩家）
          const mate = findPassTarget(p, p.role === 'MF' ? 'FW' : null);
          if (mate) {
            kickBall(p, mate.x + mate.vx * 12, mate.y + mate.vy * 12, 5);
            tx = p.x; ty = p.y;
          } else {
            // 带球：目标点取球身后一点，形成“推着球走”的效果
            tx = ball.x + (p.x - ball.x) * 0.2;
            ty = ball.y + (p.y - ball.y) * 0.2;
            speed = CHASE_SPEED;
          }
        }
      } else {
        tx = ball.x; ty = ball.y;
      }
    } else if (p.role === 'DF') {
      // 后卫（防守职责）：卡在球与本方球门之间的封堵线附近，
      // 一般不越过中线、不贴着门将站，也绝不和队友挤在一起抢球
      const ownGoal = attackGoal(p.team === 'blue' ? 'red' : 'blue');
      const side = p.fy < 0.5 ? -1 : 1; // 上/下后卫各负责一侧
      const mateNearer = players.some((m) =>
        m !== p && m.team === p.team && m.role !== 'GK' &&
        dist(m.x, m.y, ball.x, ball.y) < 80);
      const ballInOwnHalf = p.team === 'blue' ? ball.x < CX : ball.x > CX;
      // 只有球在本方半场、且没有队友（追球人）已经贴住球时才上抢
      if (ballInOwnHalf && !mateNearer && dist(p.x, p.y, ball.x, ball.y) < 70) {
        tx = ball.x; ty = ball.y;
        speed = CHASE_SPEED * 0.95;
      } else {
        // 保持封堵线：站在球门一侧 70px 处，左右后卫各偏一侧
        const dBG = dist(ownGoal.x, ownGoal.y, ball.x, ball.y) || 1;
        tx = ball.x + ((ownGoal.x - ball.x) / dBG) * 70;
        ty = ball.y + ((ownGoal.y - ball.y) / dBG) * 70 + side * 60;
        speed = AI_SPEED * 0.95;
      }
      if (p.team === 'blue') tx = clamp(tx, F.left + 45, CX - 12);
      else tx = clamp(tx, CX + 12, F.right - 45);
      ty = clamp(ty, F.top + 20, F.bottom - 20);
      // 非追球人避球：与球保持 60px 以上距离
      [tx, ty] = avoidBall(p, tx, ty, 60);
    } else {
      // 中场/前锋（无球时）：站在自家位置附近，轻微随球平移，形成攻防阵型
      const h = homePos(p);
      const shiftX = (ball.x - CX) * 0.22;
      const shiftY = (ball.y - CY) * 0.18;
      tx = clamp(h.x + shiftX, F.left + 30, F.right - 30);
      ty = clamp(h.y + shiftY, F.top + 20, F.bottom - 20);
      speed = AI_SPEED * 0.85;
      // 非追球人避球：与球保持 85px 以上距离，绝不扎堆抢球
      [tx, ty] = avoidBall(p, tx, ty, 85);
    }

    // 朝目标点移动（简单的比例控制）
    const d = dist(p.x, p.y, tx, ty);
    if (d > 4) {
      p.vx = ((tx - p.x) / d) * speed;
      p.vy = ((ty - p.y) / d) * speed;
    } else {
      p.vx *= 0.6; p.vy *= 0.6;
    }
  }

  function moveUser(p) {
    let dx = (keys['d'] ? 1 : 0) - (keys['a'] ? 1 : 0);
    let dy = (keys['s'] ? 1 : 0) - (keys['w'] ? 1 : 0);
    const len = Math.hypot(dx, dy);
    // Shift 冲刺：速度提升 50%
    const speed = keys['shift'] ? USER_SPEED * 1.5 : USER_SPEED;
    if (len > 0) {
      p.vx = (dx / len) * speed;
      p.vy = (dy / len) * speed;
    } else {
      p.vx *= 0.6; p.vy *= 0.6;
    }
    // 空格射门：朝对方球门，带一点随机的纵向偏移
    if (keys[' '] && p.kickCd <= 0 &&
        dist(p.x, p.y, ball.x, ball.y) < PLAYER_R + BALL_R + 8) {
      const goal = attackGoal(p.team);
      kickBall(p, goal.x, goal.y + (Math.random() - 0.5) * GOAL_H * 0.5, 7.5);
    }
    // E 传球：把球传给位置最靠前的队友
    if (keys['e'] && p.kickCd <= 0 && releaseCd <= 0 &&
        dist(p.x, p.y, ball.x, ball.y) < p.r + ball.r + 6) {
      let target = null, bestX = -Infinity;
      for (const m of players) {
        if (m.team !== p.team || m === p) continue;
        if (m.x > bestX) { bestX = m.x; target = m; }
      }
      if (target) kickBall(p, target.x + 20, target.y, 5);
    }
  }

  // ---------- 物理与碰撞 ----------
  function physics() {
    // 球员移动
    for (const p of players) {
      if (p.kickCd > 0) p.kickCd--;
      p.x += p.vx; p.y += p.vy;
      p.x = clamp(p.x, F.left + 4, F.right - 4); // 球员不能跑到球门线后面
      p.y = clamp(p.y, F.top + PLAYER_R, F.bottom - PLAYER_R);
    }

    // 球员之间的碰撞分离（每帧完全推开，玩家有优先权，避免卡在一起）
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i], b = players[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d = Math.hypot(dx, dy);
        const min = a.r + b.r;
        if (d < min) {
          if (d < 0.01) { dx = 1; dy = 0; d = 1; } // 完全重合时强制左右弹开
          const nx = dx / d, ny = dy / d;
          const push = min - d;
          if (a.isUser && !b.isUser) {
            // 玩家不动，AI 完全让开
            b.x -= nx * push; b.y -= ny * push;
          } else if (b.isUser && !a.isUser) {
            a.x += nx * push; a.y += ny * push;
          } else {
            a.x += (nx * push) / 2; a.y += (ny * push) / 2;
            b.x -= (nx * push) / 2; b.y -= (ny * push) / 2;
          }
        }
      }
    }
    // 分离后重新夹回边界
    for (const p of players) {
      p.x = clamp(p.x, F.left + 4, F.right - 4);
      p.y = clamp(p.y, F.top + PLAYER_R, F.bottom - PLAYER_R);
    }

    // 社交距离：没有实际重叠时也轻轻互相推开，避免挤成一团
    const SOCIAL = PLAYER_R * 2 + 10;
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i], b = players[j];
        const d = dist(a.x, a.y, b.x, b.y);
        if (d > 0.01 && d < SOCIAL) {
          const nx = (a.x - b.x) / d, ny = (a.y - b.y) / d;
          const push = (SOCIAL - d) * 0.06;
          a.x += nx * push; a.y += ny * push;
          b.x -= nx * push; b.y -= ny * push;
        }
      }
    }

    // 球运动
    ball.x += ball.vx;
    ball.y += ball.vy;
    ball.vx *= 0.985; ball.vy *= 0.985; // 摩擦力

    if (stealCd > 0) stealCd--;
    if (releaseCd > 0) releaseCd--;

    // 球权判定：离球最近的球员（控制半径略大于接触距离）
    const user = userPlayer;
    ballOwner = null;
    let bestD = Infinity;
    for (const p of players) {
      const d = dist(p.x, p.y, ball.x, ball.y);
      if (d < p.r + ball.r + 4 && d < bestD) { bestD = d; ballOwner = p; }
    }

    const userHasBall = (ballOwner === user || stealCd > 0) && releaseCd <= 0;
    if (userHasBall) {
      // 玩家持球：粘性带球，球吸附在身前跟着走
      glueBallTo(user);
      // 对方抢断：保护期结束后，对方场上球员贴身可把球捅走
      if (stealCd <= 0) {
        for (const p of players) {
          if (p.team === user.team || p.role === 'GK') continue;
          const d = dist(p.x, p.y, user.x, user.y);
          if (d < PLAYER_R * 2 + 4) {
            const nx = (p.x - user.x) / (d || 1), ny = (p.y - user.y) / (d || 1);
            ball.x = user.x + nx * (user.r + ball.r + 3);
            ball.y = user.y + ny * (user.r + ball.r + 3);
            ball.vx = nx * 2.5; ball.vy = ny * 2.5;
            ballOwner = null;
            p.kickCd = 25; // 防止对方紧接着把球踢远
            break;
          }
        }
      }
    } else if (ballOwner && ballOwner.team !== user.team &&
               dist(user.x, user.y, ballOwner.x, ballOwner.y) < PLAYER_R * 2 + 6) {
      // 对方持球：玩家贴身即完成抢断，球权直接给玩家
      stealCd = STEAL_PROTECT;
      glueBallTo(user);
      ballOwner = user;
    }

    // 球员与球的碰撞（仅针对松散球）；玩家持球或球刚被踢出时跳过
    if (!userHasBall && releaseCd <= 0) {
      for (const p of players) {
        const d = dist(p.x, p.y, ball.x, ball.y);
        if (d > 0 && d < p.r + ball.r) {
          if (p.isUser && ballOwner && ballOwner.team !== user.team) {
            // 玩家直接追上对方脚下的球 → 抢断
            stealCd = STEAL_PROTECT;
            glueBallTo(user);
            ballOwner = user;
            break;
          }
          const nx = (ball.x - p.x) / d, ny = (ball.y - p.y) / d;
          ball.x = p.x + nx * (p.r + ball.r);
          ball.y = p.y + ny * (p.r + ball.r);
          if (p.isUser) {
            // 玩家碰到松散球：球速与玩家一致，保证玩家能追上并拿下球
            ball.vx = p.vx; ball.vy = p.vy;
          } else {
            ball.vx = nx * 1.2 + p.vx * 0.85;
            ball.vy = ny * 1.2 + p.vy * 0.85;
          }
        }
      }
    }

    // 边界：上下边反弹
    if (ball.y - ball.r < F.top) { ball.y = F.top + ball.r; ball.vy = Math.abs(ball.vy) * 0.8; }
    if (ball.y + ball.r > F.bottom) { ball.y = F.bottom - ball.r; ball.vy = -Math.abs(ball.vy) * 0.8; }

    // 左右：球门范围内可进入（进球），范围外反弹
    // 进球有效区比画出来的球门窄：贴着门柱/球门两侧挤进去的不算进球
    const mouthTop = GOAL_TOP + 14, mouthBottom = GOAL_BOTTOM - 14;
    const inGoalMouth = ball.y > mouthTop && ball.y < mouthBottom;
    if (!inGoalMouth) {
      if (ball.x - ball.r < F.left) { ball.x = F.left + ball.r; ball.vx = Math.abs(ball.vx) * 0.8; }
      if (ball.x + ball.r > F.right) { ball.x = F.right - ball.r; ball.vx = -Math.abs(ball.vx) * 0.8; }
    } else {
      // 球门内壁（后网）
      if (ball.x - ball.r < F.left - GOAL_DEPTH) { ball.x = F.left - GOAL_DEPTH + ball.r; ball.vx = Math.abs(ball.vx); }
      if (ball.x + ball.r > F.right + GOAL_DEPTH) { ball.x = F.right + GOAL_DEPTH - ball.r; ball.vx = -Math.abs(ball.vx); }
      // 球门内侧壁：球在门内不能从两侧滚出去
      if (ball.x < F.left || ball.x > F.right) {
        if (ball.y - ball.r < GOAL_TOP) { ball.y = GOAL_TOP + ball.r; ball.vy = Math.abs(ball.vy); }
        if (ball.y + ball.r > GOAL_BOTTOM) { ball.y = GOAL_BOTTOM - ball.r; ball.vy = -Math.abs(ball.vy); }
      }
      // 进球判定：整体越过门线
      if (ball.x + ball.r < F.left) goal('red');   // 打进左门（蓝队球门）→ 红队得分
      if (ball.x - ball.r > F.right) goal('blue'); // 打进右门（红队球门）→ 蓝队得分
    }
  }

  function goal(team) {
    if (resetTimer > 0 || matchOver) return;
    if (team === 'blue') scoreBlue++; else scoreRed++;
    goalBanner = 90; // 1.5 秒庆祝横幅
    resetTimer = 90;
    updateScoreboard();
  }

  // ---------- 计时 / 上报 ----------
  function updateScoreboard() {
    document.getElementById('scoreBlue').textContent = scoreBlue;
    document.getElementById('scoreRed').textContent = scoreRed;
    const m = Math.floor(Math.max(0, timeLeft) / 60);
    const s = Math.floor(Math.max(0, timeLeft) % 60);
    document.getElementById('clock').textContent =
      String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function endMatch() {
    matchOver = true;
    const overlay = document.getElementById('overlay');
    const title = document.getElementById('overlayTitle');
    const text = document.getElementById('overlayText');
    if (scoreBlue > scoreRed) title.textContent = '🏆 你赢了！';
    else if (scoreBlue < scoreRed) title.textContent = '😤 输了，再试试！';
    else title.textContent = '🤝 平局';
    text.textContent = `最终比分 蓝队 ${scoreBlue} : ${scoreRed} 红队`;
    overlay.classList.remove('hidden');
    reportResult();
  }

  // 把比分上报给后端
  function reportResult() {
    if (reported) return;
    reported = true;
    fetch('/api/matches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blue: scoreBlue,
        red: scoreRed,
        duration: MATCH_SECONDS,
      }),
    })
      .then((r) => r.json())
      .then(() => loadHistory())
      .catch((e) => console.error('比分上报失败:', e));
  }

  // ---------- 历史战绩 ----------
  function loadHistory() {
    fetch('/api/matches')
      .then((r) => r.json())
      .then((data) => {
        const tbody = document.querySelector('#history tbody');
        tbody.innerHTML = '';
        const matches = (data.matches || []).slice(0, 8);
        for (const m of matches) {
          const tr = document.createElement('tr');
          const t = new Date(m.time);
          const timeStr = `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
          const result = m.blue > m.red ? '胜' : m.blue < m.red ? '负' : '平';
          tr.innerHTML =
            `<td>${timeStr}</td>` +
            `<td class="blue">${m.blue}</td>` +
            `<td class="red">${m.red}</td>` +
            `<td>${result}</td>`;
          tbody.appendChild(tr);
        }
        if (!matches.length) {
          tbody.innerHTML = '<tr><td colspan="4">暂无记录，打完一场就有了</td></tr>';
        }
        return fetch('/api/stats').then((r) => r.json());
      })
      .then((stats) => {
        if (!stats) return;
        document.getElementById('stats').textContent =
          `共 ${stats.total} 场 ｜ 蓝队胜 ${stats.blueWins} · 红队胜 ${stats.redWins} · 平 ${stats.draws} ｜ 总进球 ${stats.totalGoals}`;
      })
      .catch(() => {
        document.getElementById('stats').textContent = '无法连接后端，请用 node server.js 启动';
      });
  }

  // ---------- 渲染 ----------
  function drawPitch() {
    // 草坪
    ctx.fillStyle = '#2e7d32';
    ctx.fillRect(0, 0, W, H);
    // 草坪条纹
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    const stripe = (F.right - F.left) / 10;
    for (let i = 0; i < 10; i += 2) {
      ctx.fillRect(F.left + i * stripe, F.top, stripe, F.bottom - F.top);
    }
    // 边界线
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.strokeRect(F.left, F.top, F.right - F.left, F.bottom - F.top);
    // 中线 / 中圈 / 中点
    ctx.beginPath();
    ctx.moveTo(CX, F.top); ctx.lineTo(CX, F.bottom);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(CX, CY, 75, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(CX, CY, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    // 禁区
    const boxW = 130, boxH = 300;
    ctx.strokeRect(F.left, CY - boxH / 2, boxW, boxH);
    ctx.strokeRect(F.right - boxW, CY - boxH / 2, boxW, boxH);
    // 球门
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(F.left - GOAL_DEPTH, GOAL_TOP, GOAL_DEPTH, GOAL_H);
    ctx.fillRect(F.right, GOAL_TOP, GOAL_DEPTH, GOAL_H);
    ctx.strokeRect(F.left - GOAL_DEPTH, GOAL_TOP, GOAL_DEPTH, GOAL_H);
    ctx.strokeRect(F.right, GOAL_TOP, GOAL_DEPTH, GOAL_H);
  }

  function drawPlayers() {
    for (const p of players) {
      // 影子
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.arc(p.x, p.y + 3, p.r, 0, Math.PI * 2);
      ctx.fill();
      // 身体
      ctx.fillStyle = p.team === 'blue' ? '#1e88e5' : '#e53935';
      if (p.role === 'GK') ctx.fillStyle = p.team === 'blue' ? '#7e57c2' : '#ffb300';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // 号码 / 角色
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px Consolas';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.role === 'GK' ? 'GK' : (p.team === 'blue' ? '10' : String(Math.round(p.fx * 100) % 90 + 2)), p.x, p.y);
      // 玩家标记：呼吸光圈 + 头顶箭头
      if (p.isUser) {
        const pulse = Math.sin(frameCount * 0.1) * 2;
        ctx.strokeStyle = '#ffeb3b';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + 7 + pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,235,59,0.4)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + 12 + pulse, 0, Math.PI * 2);
        ctx.stroke();
        const ay = p.y - p.r - 18 + Math.sin(frameCount * 0.15) * 2;
        ctx.fillStyle = '#ffeb3b';
        ctx.beginPath();
        ctx.moveTo(p.x, ay + 9);
        ctx.lineTo(p.x - 6, ay + 1);
        ctx.lineTo(p.x + 6, ay + 1);
        ctx.closePath();
        ctx.fill();
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('你', p.x, ay - 2);
      }
    }
  }

  function drawBall() {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.arc(ball.x, ball.y + 2, ball.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#333';
    ctx.fill();
  }

  function drawBanner() {
    if (goalBanner <= 0) return;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, CY - 46, W, 92);
    ctx.fillStyle = '#ffeb3b';
    ctx.font = 'bold 52px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚽ GOAL!', CX, CY);
  }

  // ---------- 主循环 ----------
  function tick() {
    frameCount++;
    if (!matchOver) {
      if (resetTimer > 0) {
        resetTimer--;
        if (resetTimer === 0) resetPositions();
      } else {
        assignChasers();
        for (const p of players) {
          if (p.isUser) moveUser(p);
          else moveAI(p);
        }
        physics();
        timeLeft -= 1 / 60;
        if (timeLeft <= 0) {
          timeLeft = 0;
          endMatch();
        }
      }
      updateScoreboard();
    }
    if (goalBanner > 0) goalBanner--;

    drawPitch();
    drawPlayers();
    drawBall();
    drawBanner();
    requestAnimationFrame(tick);
  }

  // ---------- 启动 ----------
  setupTeams();   // 先创建 10 名球员，再摆放初始阵型
  resetPositions();
  loadHistory();
  tick();
})();
