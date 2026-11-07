import { readFileSync } from 'node:fs';
import { playtest, HELDOUT_SEEDS } from '../agent/playtest.mjs';
const f = process.argv[2] || 'versions/v1/game.js';
let src = readFileSync(f, 'utf8');
for (const [a, b] of (JSON.parse(process.argv[3] || '[]'))) src = src.replace(a, b);
const t = Date.now(); const m = playtest(src, HELDOUT_SEEDS); delete m.deaths;
console.log(Date.now() - t, 'ms', JSON.stringify(m));
