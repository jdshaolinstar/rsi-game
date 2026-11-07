// Headless playtest harness. Runs scripted bot players against a game version
// inside a vm sandbox (no require, no process, no API key) and returns metrics.
// The agent never edits this file.
import vm from 'node:vm';

export const TRAIN_SEEDS = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
export const HELDOUT_SEEDS = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112];

export function loadGame(src) {
  const sandbox = { Math, module: undefined };
  vm.createContext(sandbox);
  new vm.Script(src + '\n;GAME', { filename: 'game.js' }).runInContext(sandbox, { timeout: 1000 });
  return sandbox.GAME;
}

// A fair, slightly noisy player: kites enemies, collects pickups, heads for the
// door, and aims for the spike gap. Same bot for every version.
function bot(st, G, r, skill) {
  const p = st.player, C = G.CONFIG;
  let tx = C.W / 2, ty = 10;
  if (st.enemies.length) {
    let e = st.enemies[0], best = 1e9;
    for (const q of st.enemies) { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < best) { best = d; e = q; } }
    const want = e.kind === 'boss' ? 170 : 110;
    const ang = Math.atan2(p.y - e.y, p.x - e.x) + 0.6;
    tx = e.x + Math.cos(ang) * want; ty = e.y + Math.sin(ang) * want;
    for (const b of st.bullets) {
      if (Math.hypot(b.x - p.x, b.y - p.y) < 40) { tx = p.x + (p.x - b.x) * 2; ty = p.y + (p.y - b.y) * 2; }
    }
  } else if (st.pickups.length) {
    tx = st.pickups[0].x; ty = st.pickups[0].y;
  }
  const sp = st.spikes;
  if (sp) {
    const above = p.y < sp.y, targetAbove = ty < sp.y;
    if (above !== targetAbove) { tx = sp.gapX; if (Math.abs(p.x - sp.gapX) > 4) ty = above ? sp.y - 20 : sp.y + sp.h + 20; }
  }
  tx += (r() - 0.5) * 60 * (1 - skill); ty += (r() - 0.5) * 60 * (1 - skill);
  return { dx: Math.sign(tx - p.x) * Math.min(1, Math.abs(tx - p.x) / 10), dy: Math.sign(ty - p.y) * Math.min(1, Math.abs(ty - p.y) / 10) };
}

export function playtest(src, seeds = TRAIN_SEEDS, maxFrames = 60 * 120) {
  let G;
  try { G = loadGame(src); } catch (e) { return { loadError: String(e.message || e), crashRate: 1, runs: 0 }; }
  const runs = [];
  for (const seed of seeds) {
    let s = seed * 7919 >>> 0; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const skill = 0.55 + r() * 0.4;
    const run = { seed, crashed: null, maxRoom: 0, won: false, died: false, frames: 0, coins: 0, deathRoom: null, deathAt: null, bossFrame: null, hpLost: {} };
    try {
      const st = G.create(seed); let lastRoom = st.room, hpAt = st.player.hp;
      for (let f = 0; f < maxFrames && !st.over; f++) {
        G.step(st, bot(st, G, r, skill));
        if (st.room !== lastRoom || st.over) { run.hpLost[lastRoom] = (run.hpLost[lastRoom] || 0) + Math.max(0, hpAt - Math.max(0, st.player.hp)); lastRoom = st.room; hpAt = st.player.hp; }
        if (st.room > run.maxRoom) { run.maxRoom = st.room; if (st.room === G.CONFIG.rooms.length - 1) run.bossFrame = st.frame; }
      }
      run.frames = st.frame; run.won = st.won; run.coins = st.coins;
      const d = st.events.find(e => e.t === 'death');
      if (d) { run.died = true; run.deathRoom = d.room; run.deathAt = [Math.round(d.x), Math.round(d.y)]; }
    } catch (e) {
      run.crashed = String(e && e.message || e).slice(0, 160);
    }
    runs.push(run);
  }
  const n = runs.length, lastRoom = (G.CONFIG.rooms.length || 3) - 1;
  const crashes = {};
  for (const r of runs) if (r.crashed) crashes[r.crashed] = (crashes[r.crashed] || 0) + 1;
  const deathsByRoom = {};
  for (const r of runs) if (r.died) deathsByRoom[r.deathRoom] = (deathsByRoom[r.deathRoom] || 0) + 1;
  const bossTimes = runs.filter(r => r.bossFrame).map(r => r.bossFrame / 60).sort((a, b) => a - b);
  return {
    runs: n,
    crashRate: runs.filter(r => r.crashed).length / n,
    reachBoss: runs.filter(r => r.maxRoom >= lastRoom).length / n,
    winRate: runs.filter(r => r.won).length / n,
    avgSeconds: runs.reduce((a, r) => a + r.frames, 0) / n / 60,
    avgCoins: runs.reduce((a, r) => a + r.coins, 0) / n,
    medianSecondsToBoss: bossTimes.length ? bossTimes[Math.floor(bossTimes.length / 2)] : null,
    rooms: G.CONFIG.rooms.length,
    totalEnemies: G.CONFIG.rooms.reduce((a, r) => a + (r.enemies || 0) + (r.boss ? 1 : 0), 0),
    hpLostRoom1: runs.reduce((a, r) => a + (r.hpLost[1] || 0), 0) / n,
    crashes, deathsByRoom,
    deaths: runs.filter(r => r.died).map(r => ({ room: r.deathRoom, at: r.deathAt }))
  };
}
