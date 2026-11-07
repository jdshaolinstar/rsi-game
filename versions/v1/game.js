// Dungeon game. Pure logic (create/step) is separate from drawing (render),
// so the same file runs in the browser and in the headless playtest harness.
// The agent edits this file. Each edit becomes a new version.
var GAME = (function () {
  var CONFIG = {
    W: 360, H: 560,
    playerSpeed: 2.2,
    playerHp: 3,
    fireEvery: 24,        // frames between auto-shots
    bulletSpeed: 6,
    bulletDamage: 1,
    range: 230,
    enemySpeed: 1.0,
    potionChance: 0.3,
    spikeGap: 14,         // width of the safe gap through the spikes
    bossHp: 400,
    bossFireEvery: 40,
    rooms: [
      { name: 'Slime Cellar', enemies: 4 },
      { name: 'Spike Hall', enemies: 5, spikes: true },
      { name: 'Boss Lair', enemies: 0, boss: true }
    ]
  };

  function rng(seed) {
    var s = seed >>> 0 || 1;
    return function () { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  function create(seed) {
    var st = {
      rand: rng(seed || 1), frame: 0, room: 0, score: 0, coins: 0, over: false, won: false,
      player: { x: CONFIG.W / 2, y: CONFIG.H - 50, r: 10, hp: CONFIG.playerHp, cool: 0, hurt: 0 },
      enemies: [], bullets: [], shots: [], pickups: [], spikes: null, events: []
    };
    enterRoom(st, 0);
    return st;
  }

  function enterRoom(st, i) {
    st.room = i;
    var room = CONFIG.rooms[i];
    st.player.x = CONFIG.W / 2; st.player.y = CONFIG.H - 50;
    st.enemies = []; st.bullets = []; st.shots = []; st.pickups = [];
    for (var k = 0; k < room.enemies; k++) {
      st.enemies.push({ x: 30 + st.rand() * (CONFIG.W - 60), y: 60 + st.rand() * (CONFIG.H - 120), r: 11, hp: 3, kind: 'slime' });
    }
    if (room.boss) st.enemies.push({ x: CONFIG.W / 2, y: 120, r: 30, hp: CONFIG.bossHp, max: CONFIG.bossHp, kind: 'boss', cool: 0 });
    st.spikes = null;
    if (room.spikes) {
      var gx = 40 + st.rand() * (CONFIG.W - 80);
      st.spikes = { y: CONFIG.H / 2 - 20, h: 40, gapX: gx, gapW: CONFIG.spikeGap };
    }
    st.events.push({ t: 'room', room: i, frame: st.frame });
  }

  function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }

  function hurt(st, n) {
    var p = st.player;
    if (p.hurt > 0) return;
    p.hp -= n; p.hurt = 60;
    if (p.hp <= 0) { st.over = true; st.events.push({ t: 'death', room: st.room, x: p.x, y: p.y, frame: st.frame }); }
  }

  function step(st, input) {
    if (st.over) return st;
    st.frame++;
    var p = st.player, W = CONFIG.W, H = CONFIG.H;
    var dx = input.dx || 0, dy = input.dy || 0;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len > 1) { dx /= len; dy /= len; }
    p.x = Math.max(p.r, Math.min(W - p.r, p.x + dx * CONFIG.playerSpeed));
    p.y = Math.max(p.r, Math.min(H - p.r, p.y + dy * CONFIG.playerSpeed));
    if (p.hurt > 0) p.hurt--;

    // spikes: touching them hurts unless inside the gap
    var sp = st.spikes;
    if (sp && p.y + p.r > sp.y && p.y - p.r < sp.y + sp.h) {
      if (p.x - p.r < sp.gapX - sp.gapW / 2 || p.x + p.r > sp.gapX + sp.gapW / 2) hurt(st, 1);
    }

    // auto-fire at nearest enemy
    if (p.cool > 0) p.cool--;
    var near = null, nd = 1e9;
    for (var i = 0; i < st.enemies.length; i++) { var d = dist(p, st.enemies[i]); if (d < nd) { nd = d; near = st.enemies[i]; } }
    if (near && nd < CONFIG.range && p.cool === 0) {
      var ax = (near.x - p.x) / nd, ay = (near.y - p.y) / nd;
      st.shots.push({ x: p.x, y: p.y, vx: ax * CONFIG.bulletSpeed, vy: ay * CONFIG.bulletSpeed });
      p.cool = CONFIG.fireEvery;
    }

    // player shots
    for (i = st.shots.length - 1; i >= 0; i--) {
      var s = st.shots[i]; s.x += s.vx; s.y += s.vy;
      var hit = false;
      for (var j = 0; j < st.enemies.length; j++) {
        var e = st.enemies[j];
        if (dist(s, e) < e.r + 3) { e.hp -= CONFIG.bulletDamage; hit = true; break; }
      }
      if (hit || s.x < 0 || s.y < 0 || s.x > W || s.y > H) st.shots.splice(i, 1);
    }

    // enemies
    for (i = st.enemies.length - 1; i >= 0; i--) {
      e = st.enemies[i];
      if (e.hp <= 0) {
        st.enemies.splice(i, 1);
        st.score += e.kind === 'boss' ? 500 : 50;
        if (e.kind === 'boss') { st.won = true; st.over = true; st.events.push({ t: 'win', frame: st.frame }); return st; }
        if (st.rand() < CONFIG.potionChance) st.pickups.push({ x: e.x, y: e.y, kind: 'potion' });
        else st.pickups.push({ x: e.x, y: e.y, kind: 'coin' });
        continue;
      }
      var ed = dist(p, e) || 1;
      var spd = e.kind === 'boss' ? CONFIG.enemySpeed * 0.5 : CONFIG.enemySpeed;
      e.x += (p.x - e.x) / ed * spd; e.y += (p.y - e.y) / ed * spd;
      if (ed < e.r + p.r) hurt(st, 1);
      if (e.kind === 'boss') {
        e.cool = (e.cool || 0) + 1;
        if (e.cool >= CONFIG.bossFireEvery) {
          e.cool = 0;
          for (var a = 0; a < 8; a++) st.bullets.push({ x: e.x, y: e.y, vx: Math.cos(a * Math.PI / 4) * 2.5, vy: Math.sin(a * Math.PI / 4) * 2.5 });
        }
      }
    }

    // boss bullets
    for (i = st.bullets.length - 1; i >= 0; i--) {
      var b = st.bullets[i]; b.x += b.vx; b.y += b.vy;
      if (dist(b, p) < p.r + 4) { hurt(st, 1); st.bullets.splice(i, 1); continue; }
      if (b.x < 0 || b.y < 0 || b.x > W || b.y > H) st.bullets.splice(i, 1);
    }

    // pickups
    for (i = st.pickups.length - 1; i >= 0; i--) {
      var k = st.pickups[i];
      if (dist(k, p) < p.r + 8) {
        if (k.kind === 'coin') { st.coins++; st.score += 10; }
        if (k.kind === 'potion') { p.inventory.push('potion'); p.hp = Math.min(CONFIG.playerHp, p.hp + 1); }
        st.pickups.splice(i, 1);
      }
    }

    // door opens when the room is clear
    if (st.enemies.length === 0 && p.y < 24 && Math.abs(p.x - W / 2) < 40 && st.room < CONFIG.rooms.length - 1) {
      enterRoom(st, st.room + 1);
    }
    return st;
  }

  function render(ctx, st, T) {
    var W = CONFIG.W, H = CONFIG.H;
    ctx.fillStyle = T.floor; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = T.wall; ctx.lineWidth = T.wallWidth; ctx.strokeRect(0, 0, W, H);
    // door
    ctx.fillStyle = st.enemies.length === 0 ? T.doorOpen : T.doorClosed;
    ctx.fillRect(W / 2 - 40, 0, 80, 14);
    if (st.spikes) {
      var sp = st.spikes;
      ctx.fillStyle = T.spikes;
      ctx.fillRect(0, sp.y, sp.gapX - sp.gapW / 2, sp.h);
      ctx.fillRect(sp.gapX + sp.gapW / 2, sp.y, W - sp.gapX - sp.gapW / 2, sp.h);
    }
    for (var i = 0; i < st.pickups.length; i++) {
      var k = st.pickups[i];
      ctx.fillStyle = k.kind === 'coin' ? T.coin : T.potion;
      ctx.beginPath(); ctx.arc(k.x, k.y, 6, 0, 7); ctx.fill();
    }
    for (i = 0; i < st.enemies.length; i++) {
      var e = st.enemies[i];
      ctx.fillStyle = e.kind === 'boss' ? T.boss : T.enemy;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r, 0, 7); ctx.fill();
      if (e.kind === 'boss') { ctx.fillStyle = T.text; ctx.fillRect(40, 40, (W - 80) * e.hp / e.max, 6); }
    }
    ctx.fillStyle = T.shot;
    for (i = 0; i < st.shots.length; i++) ctx.fillRect(st.shots[i].x - 2, st.shots[i].y - 2, 4, 4);
    ctx.fillStyle = T.bullet;
    for (i = 0; i < st.bullets.length; i++) { ctx.beginPath(); ctx.arc(st.bullets[i].x, st.bullets[i].y, 4, 0, 7); ctx.fill(); }
    var p = st.player;
    if (!(p.hurt > 0 && Math.floor(p.hurt / 6) % 2)) {
      ctx.fillStyle = T.player; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
    }
    ctx.fillStyle = T.text; ctx.font = T.font;
    ctx.fillText(CONFIG.rooms[st.room].name + '   HP ' + p.hp + '   Score ' + st.score, 10, H - 12);
  }

  return { CONFIG: CONFIG, create: create, step: step, render: render };
})();
if (typeof module !== 'undefined') module.exports = GAME;
