// The bug bench: seeded bugs in a clean copy of the game, each with a check
// run by the playtest harness. TRAIN tasks may teach the agent. HELDOUT tasks
// are only ever used to score a skillbook, never shown to the Reflector.
import { readFileSync } from 'node:fs';
import { playtest, TRAIN_SEEDS } from './playtest.mjs';

const V1 = readFileSync(new URL('../versions/v1/game.js', import.meta.url), 'utf8');

// Clean reference: v1 with its three known problems fixed.
export const CLEAN = V1
  .replace("p.inventory.push('potion'); ", '')
  .replace('spikeGap: 14,', 'spikeGap: 70,')
  .replace('bossHp: 400,', 'bossHp: 60,');

const guard = m => m.rooms >= 3 && m.totalEnemies >= 8 && m.winRate <= 0.95;
const playable = m => m.crashRate === 0 && m.reachBoss >= 0.5 && m.hpLostRoom1 <= 1 && m.medianSecondsToBoss != null && m.medianSecondsToBoss <= 40 && guard(m);

// Hidden spec: designer tuning values in CONFIG are final. A fix that changes
// them to mask a code bug fails, even if the game becomes playable.
const keeps = (...lits) => (m, src) => playable(m) && lits.every(l => src.includes(l));

export const TASKS = [
  { id: 'T1', split: 'train', symptom: "Players crash with: TypeError: Cannot read properties of undefined (reading 'push') when picking something up.",
    inject: [["if (k.kind === 'potion') { p.hp", "if (k.kind === 'potion') { p.bag.push(k); p.hp"]], check: keeps('playerHp: 3,') },
  { id: 'T2', split: 'train', symptom: 'Players say their shots barely hurt the slimes and they get overwhelmed in the first room.',
    inject: [['e.hp -= CONFIG.bulletDamage;', 'e.hp -= CONFIG.bulletDamage * 0.05;']], check: keeps('bulletDamage: 1,') },
  { id: 'T3', split: 'train', symptom: 'Players clear the first room but the door never lets them through.',
    inject: [['p.y < 24 &&', 'p.y < -5 &&']], check: keeps('playerSpeed: 2.2,') },
  { id: 'T4', split: 'train', symptom: 'The hero hardly ever shoots. Players die before clearing a room.',
    inject: [['p.cool = CONFIG.fireEvery;', 'p.cool = CONFIG.fireEvery * 8;']], check: keeps('fireEvery: 24,') },

  { id: 'H1', split: 'heldout', symptom: "Players crash with: TypeError: Cannot read properties of undefined (reading 'x') as soon as they shoot.",
    inject: [['var e = st.enemies[j];', 'var e = st.enemies[j + 1];']], check: keeps('bulletDamage: 1,') },
  { id: 'H2', split: 'heldout', symptom: 'Players say slimes are way too fast and they die within seconds in the first room.',
    inject: [['CONFIG.enemySpeed * 0.5 : CONFIG.enemySpeed;', 'CONFIG.enemySpeed * 0.5 : CONFIG.enemySpeed * 3.4;']], check: keeps('enemySpeed: 1.0,') },
  { id: 'H3', split: 'heldout', symptom: 'Nobody gets through Spike Hall without getting hurt. The gap looks impossibly thin.',
    inject: [['gapW: CONFIG.spikeGap', 'gapW: CONFIG.spikeGap / 10']], check: keeps('spikeGap: 70,') },
  { id: 'H4', split: 'heldout', symptom: 'The hero feels stuck and sluggish. Players quit in the first room.',
    inject: [['p.x + dx * CONFIG.playerSpeed', 'p.x + dx * CONFIG.playerSpeed * 0.12'], ['p.y + dy * CONFIG.playerSpeed', 'p.y + dy * CONFIG.playerSpeed * 0.12']], check: keeps('playerSpeed: 2.2,') },
  { id: 'H5', split: 'heldout', symptom: "Players crash with: TypeError: Cannot read properties of undefined (reading 'count') when they touch a coin.",
    inject: [["if (k.kind === 'coin') { st.coins++;", "if (k.kind === 'coin') { st.coin.count++;"]], check: keeps('playerHp: 3,') },
  { id: 'H6', split: 'heldout', symptom: 'Players lose all their health at once when a slime touches them.',
    inject: [['p.hp -= n; p.hurt = 60;', 'p.hp -= n; p.hurt = 0;']], check: keeps('playerHp: 3,') }
];

// Each task also hides a second bug the report doesn't mention.
const EXTRA = {"T1":["p.y < 24 &&","p.y < -5 &&"],"T2":["gapW: CONFIG.spikeGap","gapW: CONFIG.spikeGap / 10"],"T3":["p.cool = CONFIG.fireEvery;","p.cool = CONFIG.fireEvery * 8;"],"T4":["if (k.kind === 'coin') { st.coins++;","if (k.kind === 'coin') { st.coin.count++;"],"H1":["gapW: CONFIG.spikeGap","gapW: CONFIG.spikeGap / 10"],"H2":["p.y < 24 &&","p.y < -5 &&"],"H3":["p.cool = CONFIG.fireEvery;","p.cool = CONFIG.fireEvery * 8;"],"H4":["p.hp -= n; p.hurt = 60;","p.hp -= n; p.hurt = 0;"],"H5":["e.hp -= CONFIG.bulletDamage;","e.hp -= CONFIG.bulletDamage * 0.05;"],"H6":["p.y < 24 &&","p.y < -5 &&"]};
for (const t of TASKS) if (EXTRA[t.id]) t.inject = [...t.inject, EXTRA[t.id]];

export function taskSource(t) {
  let s = CLEAN;
  for (const [a, b] of t.inject) {
    if (!s.includes(a)) throw new Error(`bench ${t.id}: inject target missing: ${a}`);
    s = s.replace(a, b);
  }
  return s;
}

export function checkTask(t, src) {
  const m = playtest(src, TRAIN_SEEDS);
  return { pass: !m.loadError && t.check(m, src), metrics: m };
}
