import { TASKS, taskSource, checkTask, CLEAN } from '../agent/bench.mjs';
import { playtest, TRAIN_SEEDS } from '../agent/playtest.mjs';
const m = playtest(CLEAN, TRAIN_SEEDS); delete m.deaths; console.log('CLEAN', JSON.stringify(m));
for (const t of TASKS) { const r = checkTask(t, taskSource(t)); console.log(t.id, 'bugged pass=', r.pass, r.metrics.crashRate, r.metrics.reachBoss); }
