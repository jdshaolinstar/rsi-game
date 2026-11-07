// The two loops.
// Loop 1 (the game gets better): signals -> Fixer patch -> held-out playtests
//   + guardrails -> canary on real players -> promote or roll back.
// Loop 2 (the agent gets better): failures -> Reflector proposes a skillbook
//   rule -> held-out bug bench -> adopt only if the score rises.
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { chat, vision, MODELS, usage } from './meta.mjs';
import { playtest, TRAIN_SEEDS, HELDOUT_SEEDS } from './playtest.mjs';
import { TASKS, taskSource, checkTask } from './bench.mjs';

const ROOT = new URL('../', import.meta.url);
const VDIR = new URL('versions/', ROOT);
const DATA = new URL('data/', ROOT);
mkdirSync(DATA, { recursive: true });

export const GOALS = {
  stability: { label: 'Fewer crashes', score: m => 1 - m.crashRate },
  progress: { label: 'More players reach the boss', score: m => (1 - m.crashRate) * (m.reachBoss * 0.7 + m.winRate * 0.3) },
  victory: { label: 'More players beat the boss', score: m => (1 - m.crashRate) * (m.winRate + 0.2 * m.reachBoss) },
  engagement: { label: 'Longer, richer sessions', score: m => (1 - m.crashRate) * (Math.min(1, m.avgSeconds / 90) * 0.7 + Math.min(1, m.avgCoins / 15) * 0.3) }
};

export function guardrails(m, base) {
  const v = [];
  if (m.loadError) v.push('game failed to load: ' + m.loadError);
  if (m.crashRate > base.crashRate) v.push(`crash rate rose ${pct(base.crashRate)} -> ${pct(m.crashRate)}`);
  if (m.rooms < 3) v.push(`content removed: ${m.rooms} rooms (need 3)`);
  if (m.totalEnemies < 8) v.push(`content removed: ${m.totalEnemies} enemies (need 8+)`);
  if (m.winRate > 0.9) v.push(`too easy: ${pct(m.winRate)} win rate`);
  if (m.medianSecondsToBoss != null && m.medianSecondsToBoss < 12) v.push(`trivialized: boss reached in ${m.medianSecondsToBoss.toFixed(1)}s`);
  return v;
}
const pct = x => Math.round(x * 100) + '%';

const BASE_RULES = ['Make the smallest change that fixes the root cause.'];

export const S = {
  versions: {}, stable: 'v1', canary: null, canaryShare: 0.5, canaryMs: 20000, canaryStart: 0,
  goal: 'stability',
  skillbooks: [{ id: 's1', parent: null, rules: BASE_RULES, heldout: null, status: 'adopted', why: 'starting rules' }],
  skill: 's1',
  failures: [], log: [], tele: {}, hunters: {}, busy: null, autopilot: false,
  themes: [], theme: 't1'
};

const listeners = new Set();
export function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(kind, msg, data = {}) {
  const e = { at: Date.now(), kind, msg, ...data };
  S.log.push(e); if (S.log.length > 400) S.log.shift();
  try { appendFileSync(new URL('log.jsonl', DATA), JSON.stringify(e) + '\n'); } catch {}
  for (const fn of listeners) try { fn(e); } catch {}
  console.log(`[${kind}] ${msg}`);
}

export const src = id => readFileSync(new URL(`${id}/game.js`, VDIR), 'utf8');
function nextId() { let n = 1; while (existsSync(new URL(`v${n}/`, VDIR))) n++; return `v${n}`; }
function saveVersion(code, meta) {
  const id = nextId();
  mkdirSync(new URL(`${id}/`, VDIR), { recursive: true });
  writeFileSync(new URL(`${id}/game.js`, VDIR), code);
  S.versions[id] = { id, created: Date.now(), ...meta };
  writeFileSync(new URL(`${id}/meta.json`, VDIR), JSON.stringify(S.versions[id], null, 2));
  return id;
}

// boot: v1 plus any versions from an earlier run are ignored; start fresh at v1.
S.versions.v1 = { id: 'v1', parent: null, status: 'stable', summary: 'Original game, as shipped (with its bugs)', created: Date.now() };
const T1 = JSON.parse(readFileSync(new URL('v1/theme.json', VDIR), 'utf8'));
S.themes.push({ id: 't1', parent: null, theme: T1, status: 'adopted', why: 'original look' });

// ---------- telemetry from real players ----------
export function tele(v) {
  return S.tele[v] ||= { players: new Set(), sessions: 0, errors: {}, deaths: [], rooms: {}, wins: 0, feedback: [] };
}
export function ingest(ev) {
  const v = S.versions[ev.v] ? ev.v : S.stable, t = tele(v);
  if (ev.pid) t.players.add(ev.pid);
  if (ev.type === 'start') t.sessions++;
  if (ev.type === 'error') { const k = String(ev.msg).slice(0, 140); t.errors[k] = (t.errors[k] || 0) + 1; credit(ev, 10); emit('signal', `Player ${ev.name || 'anon'} hit a crash on ${v}: ${k}`); }
  if (ev.type === 'death') t.deaths.push({ room: ev.room, x: ev.x, y: ev.y });
  if (ev.type === 'room') t.rooms[ev.room] = (t.rooms[ev.room] || 0) + 1;
  if (ev.type === 'win') t.wins++;
  if (ev.type === 'feedback') { t.feedback.push({ text: String(ev.text).slice(0, 300), rating: ev.rating, name: ev.name }); credit(ev, 5); emit('signal', `Feedback from ${ev.name || 'anon'} on ${v}: "${String(ev.text).slice(0, 120)}"`); }
}
function credit(ev, pts) { const n = (ev.name || '').slice(0, 20); if (n) S.hunters[n] = (S.hunters[n] || 0) + pts; }
function realSignals(v) {
  const t = tele(v);
  return {
    players: t.players.size, sessions: t.sessions, errors: t.errors, wins: t.wins,
    deathsByRoom: t.deaths.reduce((a, d) => (a[d.room] = (a[d.room] || 0) + 1, a), {}),
    reachedRoom: t.rooms, feedback: t.feedback.slice(-12)
  };
}

// ---------- patches ----------
const BANNED = /\b(require|process|import|fetch|eval|Function|XMLHttpRequest|globalThis|window\.location)\b/;
export function applyEdits(code, edits) {
  if (!Array.isArray(edits) || !edits.length) throw new Error('no edits proposed');
  if (edits.length > 6) throw new Error('too many edits');
  for (const e of edits) {
    if (typeof e.find !== 'string' || typeof e.replace !== 'string' || !e.find) throw new Error('edit missing find/replace');
    const n = code.split(e.find).length - 1;
    if (n !== 1) throw new Error(`find text matched ${n} times: ${e.find.slice(0, 60)}`);
    if (BANNED.test(e.replace)) throw new Error('edit uses a banned API');
    code = code.replace(e.find, () => e.replace);
  }
  return code;
}

function rulesOf(id) { return S.skillbooks.find(s => s.id === id).rules; }

async function fixer({ goalText, code, signals, rules, recent = [] }) {
  const sys = `You maintain a small browser dungeon game (game.js, pure JavaScript, ES5 style). You improve it by proposing small, exact text edits.
Your skillbook, rules learned from your own past failures. Follow them:
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}
Reply with JSON only: {"diagnosis": "what is wrong and why", "edits": [{"find": "exact text copied from game.js, unique", "replace": "new text"}], "summary": "one short changelog line players will see"}`;
  const user = `GOAL: ${goalText}
SIGNALS:
${JSON.stringify(signals, null, 1).slice(0, 6000)}
${recent.length ? 'RECENT ATTEMPTS THAT WERE REJECTED (do not repeat):\n' + recent.map(r => '- ' + r).join('\n') + '\n' : ''}
game.js:
\`\`\`js
${code}
\`\`\``;
  return chat(MODELS.coder, [{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.3 });
}

// ---------- loop 1 ----------
export async function runGeneration({ forcedEdits, label } = {}) {
  if (S.busy) return { skipped: S.busy };
  S.busy = 'improving the game';
  try {
    const goal = GOALS[S.goal];
    const base = src(S.stable);
    const train = playtest(base, TRAIN_SEEDS), baseHeld = playtest(base, HELDOUT_SEEDS);
    const signals = { botPlaytests: strip(train), realPlayers: realSignals(S.stable) };
    emit('observe', `Gen on ${S.stable}, goal "${goal.label}". Bots: crash ${pct(train.crashRate)}, reach boss ${pct(train.reachBoss)}, win ${pct(train.winRate)}. Real players: ${signals.realPlayers.players}.`);

    let prop;
    if (forcedEdits) { prop = { edits: forcedEdits, summary: label, diagnosis: 'Injected by playbook (not written by the agent).' }; }
    else {
      emit('think', `Fixer (${MODELS.coder}) with skillbook ${S.skill} (${rulesOf(S.skill).length} rules) is writing a patch...`);
      const recent = S.failures.filter(f => f.source === 'live').slice(-3).map(f => `${f.summary} -> ${f.reason}`);
      prop = await fixer({ goalText: goal.label, code: base, signals, rules: rulesOf(S.skill), recent });
    }
    emit('propose', `Patch: ${prop.summary || '(no summary)'}`, { diagnosis: prop.diagnosis, edits: prop.edits });

    let cand;
    try { cand = applyEdits(base, prop.edits); }
    catch (e) { return reject(null, prop, `patch did not apply: ${e.message}`, forcedEdits); }

    const held = playtest(cand, HELDOUT_SEEDS);
    const before = goal.score(baseHeld), after = held.loadError ? 0 : goal.score(held);
    const viol = guardrails(held, baseHeld);
    const id = saveVersion(cand, { parent: S.stable, summary: prop.summary, diagnosis: prop.diagnosis, edits: prop.edits, goal: S.goal, skill: S.skill, before, after, heldout: strip(held), baseHeldout: strip(baseHeld), injected: !!forcedEdits, status: 'testing' });
    emit('test', `${id} on ${HELDOUT_SEEDS.length} held-out bot runs: goal ${before.toFixed(2)} -> ${after.toFixed(2)}. Crash ${pct(baseHeld.crashRate)} -> ${pct(held.crashRate)}, boss ${pct(baseHeld.reachBoss)} -> ${pct(held.reachBoss)}.`, { id });

    if (viol.length) return reject(id, prop, 'guardrail: ' + viol.join('; '), forcedEdits);
    if (!(after > before + 0.005)) return reject(id, prop, `no held-out gain (${before.toFixed(2)} -> ${after.toFixed(2)})`, forcedEdits);

    S.versions[id].status = 'canary'; S.canary = id; S.canaryStart = Date.now();
    emit('canary', `${id} passed held-out playtests. Shipping to ${pct(S.canaryShare)} of real players for ${S.canaryMs / 1000}s.`, { id });
    setTimeout(() => decideCanary(id).catch(e => emit('error', e.message)), S.canaryMs);
    return { id, status: 'canary' };
  } catch (e) {
    emit('error', `Generation failed: ${e.message}`);
    return { error: e.message };
  } finally { S.busy = null; }
}

function reject(id, prop, reason, injected) {
  if (id) S.versions[id].status = 'rejected', S.versions[id].reason = reason;
  S.failures.push({ source: 'live', at: Date.now(), goal: S.goal, summary: prop.summary || '', diagnosis: prop.diagnosis || '', edits: prop.edits, reason, injected: !!injected });
  emit('rollback', `${id || 'patch'} rejected, ${S.stable} stays live. Reason: ${reason}`, { id });
  return { id, status: 'rejected', reason };
}

async function decideCanary(id) {
  if (S.canary !== id) return;
  const c = tele(id), s = tele(S.stable);
  const cr = c.sessions ? Object.values(c.errors).reduce((a, b) => a + b, 0) / c.sessions : 0;
  const sr = s.sessions ? Object.values(s.errors).reduce((a, b) => a + b, 0) / s.sessions : 0;
  S.canary = null;
  if (c.sessions >= 2 && cr > sr + 0.1) {
    S.versions[id].status = 'rolled back';
    S.failures.push({ source: 'live', at: Date.now(), goal: S.goal, summary: S.versions[id].summary, edits: S.versions[id].edits, reason: `real players crashed more on canary (${cr.toFixed(2)} vs ${sr.toFixed(2)} per session)` });
    emit('rollback', `Canary ${id} rolled back: real players crashed more (${cr.toFixed(2)} vs ${sr.toFixed(2)} errors per session).`, { id });
    return;
  }
  S.versions[S.stable].status = 'retired';
  S.versions[id].status = 'stable';
  const prev = S.stable; S.stable = id;
  for (const f of tele(prev).feedback) if (f.name) S.hunters[f.name] = (S.hunters[f.name] || 0) + 20;
  emit('promote', `${id} promoted to everyone (canary: ${c.sessions} real sessions, ${cr.toFixed(2)} errors/session vs ${sr.toFixed(2)}). "${S.versions[id].summary}"`, { id });
  if (S.autopilot) setTimeout(() => runGeneration(), 1500);
}

function strip(m) { const { deaths, ...r } = m; r.sampleDeaths = (deaths || []).slice(0, 6); return r; }

export async function autopilotTick() {
  if (!S.autopilot || S.busy || S.canary) return;
  await runGeneration();
}

// ---------- loop 2 ----------
async function fixTask(t, rules) {
  const code = taskSource(t);
  try {
    const prop = await fixer({ goalText: 'Fix the reported problem so the game is playable as designed.', code, signals: { playerReport: t.symptom }, rules });
    let fixed;
    try { fixed = applyEdits(code, prop.edits); } catch (e) { return { id: t.id, pass: false, reason: 'patch did not apply: ' + e.message, prop }; }
    const r = checkTask(t, fixed);
    const viol = guardrails(r.metrics, { crashRate: 0 });
    return { id: t.id, pass: r.pass, reason: r.pass ? 'ok' : (viol.join('; ') || `still broken: crash ${pct(r.metrics.crashRate)}, boss ${pct(r.metrics.reachBoss)}, hp lost in Spike Hall ${r.metrics.hpLostRoom1?.toFixed(1)}`), prop };
  } catch (e) { return { id: t.id, pass: false, reason: 'model error: ' + e.message }; }
}

export async function benchScore(rules, split) {
  const tasks = TASKS.filter(t => t.split === split);
  const res = await Promise.all(tasks.map(t => fixTask(t, rules)));
  return { score: res.filter(r => r.pass).length, of: tasks.length, res };
}

export async function learn() {
  if (S.busy) return { skipped: S.busy };
  S.busy = 'learning';
  try {
    const cur = S.skillbooks.find(s => s.id === S.skill);
    emit('learn', `Loop 2: running ${TASKS.filter(t => t.split === 'train').length} training bugs with skillbook ${cur.id} to collect failures...`);
    const train = await benchScore(cur.rules, 'train');
    const benchFails = train.res.filter(r => !r.pass).map(r => ({ source: 'bench', task: r.id, symptom: TASKS.find(t => t.id === r.id).symptom, summary: r.prop?.summary, diagnosis: r.prop?.diagnosis, edits: r.prop?.edits, reason: r.reason }));
    const fails = [...benchFails, ...S.failures.filter(f => f.source === 'live').slice(-4)];
    emit('learn', `Training bugs: ${train.score}/${train.of} fixed. ${fails.length} failures to learn from (${benchFails.length} bench, ${fails.length - benchFails.length} live).`);
    if (!fails.length) { emit('learn', 'No failures to learn from. Skillbook unchanged.'); return { unchanged: true }; }

    const refl = await chat(MODELS.coder, [{ role: 'system', content: 'You improve the instructions of a code-fixing agent. Study its failures and write ONE new general rule that would have prevented them. It must be general advice about how to diagnose and patch, not specific numbers or this exact bug. Reply JSON: {"rule": "...", "why": "..."}' },
      { role: 'user', content: `CURRENT RULES:\n${cur.rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\nFAILURES:\n${JSON.stringify(fails.map(f => ({ task: f.symptom || f.goal, patch: f.summary, diagnosis: f.diagnosis, edits: (f.edits || []).slice(0, 3), why_it_failed: f.reason })), null, 1).slice(0, 7000)}` }], { temperature: 0.4 });
    const id = 's' + (S.skillbooks.length + 1);
    const candRules = [...cur.rules, String(refl.rule).slice(0, 400)];
    const sb = { id, parent: cur.id, rules: candRules, why: refl.why, status: 'testing', learnedFrom: fails.length };
    S.skillbooks.push(sb);
    emit('learn', `Reflector proposed skillbook ${id}: "${sb.rules.at(-1)}"`, { id });

    emit('learn', `Held-out check: ${cur.id} vs ${id} on ${TASKS.filter(t => t.split === 'heldout').length} bugs the agent has never learned from...`);
    const [a, b] = await Promise.all([benchScore(cur.rules, 'heldout'), benchScore(candRules, 'heldout')]);
    cur.heldout = a.score; sb.heldout = b.score; sb.of = b.of; cur.of = a.of;
    sb.detail = b.res.map(r => ({ id: r.id, pass: r.pass, reason: r.reason }));
    cur.detail = a.res.map(r => ({ id: r.id, pass: r.pass, reason: r.reason }));
    if (b.score > a.score) {
      cur.status = 'superseded'; sb.status = 'adopted'; S.skill = id;
      emit('adopt', `Skillbook ${id} ADOPTED: held-out ${a.score}/${a.of} -> ${b.score}/${b.of}.`, { id });
    } else {
      sb.status = 'discarded';
      emit('discard', `Skillbook ${id} DISCARDED: held-out ${a.score}/${a.of} -> ${b.score}/${b.of}. Keeping ${cur.id}.`, { id });
    }
    return { id, before: a.score, after: b.score, of: b.of };
  } catch (e) { emit('error', 'Learning failed: ' + e.message); return { error: e.message }; }
  finally { S.busy = null; }
}

// ---------- style loop (vision) ----------
const THEME_KEYS = Object.keys(T1).filter(k => k !== 'font');
export function currentTheme() { return S.themes.find(t => t.id === S.theme).theme; }
export async function proposeTheme(screenshot, target) {
  emit('look', `Vision (${MODELS.vision}) is comparing the game to the target art...`);
  const r = await vision(`Image 1 is the TARGET art style. Image 2 is a screenshot of our game. Propose new colors so the game looks more like the target while staying readable (player and enemies must stand out from the floor). Current theme: ${JSON.stringify(currentTheme())}. Reply JSON: {"theme": {${THEME_KEYS.map(k => `"${k}": ...`).join(', ')}}, "why": "..."}. Colors as #rrggbb, wallWidth a number 2-10.`, [target, screenshot], { temperature: 0.4 });
  const th = { ...currentTheme() };
  for (const k of THEME_KEYS) if (r.theme && r.theme[k] != null) th[k] = k === 'wallWidth' ? Math.max(2, Math.min(10, Number(r.theme[k]) || 4)) : String(r.theme[k]).slice(0, 9);
  return { theme: th, why: r.why };
}
export async function judgeTheme(target, current, candidate, theme, why) {
  const ask = (a, b) => vision('Image 1 is the TARGET art style. Which game screenshot looks closer to the target style (colors, mood, contrast): image 2 or image 3? Reply JSON {"closer": 2 or 3, "why": "..."}', [target, a, b], { temperature: 0 });
  // ask twice with the order swapped, so position bias can't win it
  const [x, y] = await Promise.all([ask(current, candidate), ask(candidate, current)]);
  const winsA = Number(x.closer) === 3, winsB = Number(y.closer) === 2;
  const id = 't' + (S.themes.length + 1);
  const rec = { id, parent: S.theme, theme, why, votes: [winsA, winsB], status: winsA && winsB ? 'adopted' : 'discarded' };
  S.themes.push(rec);
  if (rec.status === 'adopted') { S.themes.find(t => t.id === S.theme).status = 'superseded'; S.theme = id; emit('adopt', `Look ${id} ADOPTED: vision judge preferred it in both orders. ${why || ''}`, { id }); }
  else emit('discard', `Look ${id} DISCARDED: judge votes ${winsA ? 'yes' : 'no'}/${winsB ? 'yes' : 'no'} (needs both). Keeping ${rec.parent}.`, { id });
  return rec;
}

export function snapshot() {
  return {
    stable: S.stable, canary: S.canary, canaryShare: S.canaryShare, canaryMs: S.canaryMs, canaryStart: S.canaryStart,
    goal: S.goal, goals: Object.fromEntries(Object.entries(GOALS).map(([k, g]) => [k, g.label])),
    versions: Object.values(S.versions).sort((a, b) => a.created - b.created),
    skill: S.skill, skillbooks: S.skillbooks, theme: S.theme, themes: S.themes.map(({ theme, ...r }) => r),
    failures: S.failures.slice(-10), busy: S.busy, autopilot: S.autopilot,
    hunters: Object.entries(S.hunters).sort((a, b) => b[1] - a[1]).slice(0, 10),
    real: Object.fromEntries(Object.keys(S.versions).map(v => [v, (({ players, ...r }) => ({ ...r, players: players.size }))(tele(v))])),
    usage, log: S.log.slice(-80)
  };
}
