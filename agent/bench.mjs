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

export const TASKS = [
  { id: 'T1', split: 'train', symptom: "Players crash with: TypeError: Cannot read properties of undefined (reading 'push') when picking something up.",
    inject: [["if (k.kind === 'potion') { p.hp", "if (k.kind === 'potion') { p.bag.push(k); p.hp"]], check: playable },
  { id: 'T2', split: 'train', symptom: 'Players report their shots do nothing and nobody gets past the first room.',
    inject: [['bulletDamage: 1,', 'bulletDamage: 0,']], check: playable },
  { id: 'T3', split: 'train', symptom: 'Players clear the first room but the door never lets them through.',
    inject: [['p.y < 24 &&', 'p.y < -5 &&']], check: playable },
  { id: 'T4', split: 'train', symptom: 'Everyone dies in Spike Hall. Players say it is impossible.',
    inject: [['spikeGap: 70,', 'spikeGap: 6,']], check: m => playable(m) },

  { id: 'H1', split: 'heldout', symptom: "Players crash with: TypeError: Cannot read properties of undefined (reading 'x') as soon as they shoot.",
    inject: [['var e = st.enemies[j];', 'var e = st.enemies[j + 1];']], check: playable },
  { id: 'H2', split: 'heldout', symptom: 'Players say slimes are way too fast and they die within seconds in the first room.',
    inject: [['enemySpeed: 1.0,', 'enemySpeed: 3.4,']], check: playable },
  { id: 'H3', split: 'heldout', symptom: 'Nobody survives Spike Hall. There seems to be no way through.',
    inject: [['gapW: CONFIG.spikeGap', 'gapW: 0']], check: playable },
  { id: 'H4', split: 'heldout', symptom: 'The hero barely moves. Players quit in the first room.',
    inject: [['playerSpeed: 2.2,', 'playerSpeed: 0.25,']], check: playable },
  { id: 'H5', split: 'heldout', symptom: "Players crash with: TypeError: Cannot read properties of undefined (reading 'count') when they touch a coin.",
    inject: [["if (k.kind === 'coin') { st.coins++;", "if (k.kind === 'coin') { st.coin.count++;"]], check: playable },
  { id: 'H6', split: 'heldout', symptom: 'The hero never shoots, so the first room can never be cleared.',
    inject: [['p.cool === 0)', 'p.cool === -1)']], check: playable }
];

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
  return { pass: !m.loadError && t.check(m), metrics: m };
}
