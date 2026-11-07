// The loops.
// Loop 1 (the game gets better): inbox (crashes, feedback, creator goals) ->
//   Fixer patch -> held-out playtests + guardrails -> canary -> promote or roll back.
// Look loop: look feedback + target art -> vision proposes a theme -> vision
//   judge in both orders -> new version or discard.
// Loop 2 (the agent gets better): failures -> Reflector writes a skill ->
//   new skill manifest -> held-out bug bench -> adopt only if the score rises.
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { chat, vision, MODELS, usage } from './meta.mjs';
import { playtest, TRAIN_SEEDS, HELDOUT_SEEDS } from './playtest.mjs';
import { TASKS, taskSource, checkTask } from './bench.mjs';

const ROOT = new URL('../', import.meta.url);
const VDIR = new URL('versions/', ROOT);
const SDIR = new URL('skills/', ROOT);
const DATA = new URL('data/', ROOT);
mkdirSync(DATA, { recursive: true }); mkdirSync(SDIR, { recursive: true });
const PROJECT = 'Patchwork Dungeon (browser game, ES5 JavaScript)';
const pct = x => Math.round(x * 100) + '%';
const now = () => new Date().toISOString();

// Processing budget per Fixer call. Fast is the hackathon default.
export const BUDGETS = { fast: { label: 'Fast (~10s)', maxTokens: 1800, timeoutMs: 30000 }, normal: { label: 'Normal (~25s)', maxTokens: 4000, timeoutMs: 60000 }, deep: { label: 'Deep (~60s)', maxTokens: 9000, timeoutMs: 120000 } };

// ---------- goals: free text, stacked, mapped to measurable signals ----------
export const SIGNALS = {
  crashFree: { label: 'no crashes', of: m => 1 - m.crashRate },
  reachBoss: { label: 'players reach the boss room', of: m => m.reachBoss },
  winRate: { label: 'players beat the boss', of: m => m.winRate },
  playTime: { label: 'longer sessions', of: m => Math.min(1, m.avgSeconds / 90) },
  coins: { label: 'coins collected per run', of: m => Math.min(1, m.avgCoins / 15) }
};
export function goalScore(m, goals) {
  if (m.loadError) return 0;
  const gs = goals.filter(g => g.measurable);
  if (!gs.length) return 1 - m.crashRate;
  let total = 0;
  for (const g of gs) {
    let s = 0, w = 0;
    for (const [k, v] of Object.entries(g.weights || {})) if (SIGNALS[k] && v > 0) { s += v * SIGNALS[k].of(m); w += v; }
    total += w ? s / w : 0;
  }
  return (1 - m.crashRate) * total / gs.length;
}

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

// ---------- state ----------
export const S = {
  versions: {}, stable: 'v1', canary: null, canaryShare: 0.5, canaryMs: 20000, canaryStart: 0,
  goals: [{ id: 'g1', text: 'Fewer crashes', weights: { crashFree: 1 }, measurable: true, note: 'default goal' }],
  inbox: [], skills: {}, manifests: [], manifest: null,
  schedule: { mode: 'manual', n: 2 }, budget: 'fast', since: { sessions: 0, feedback: 0, at: Date.now() },
  failures: [], log: [], tele: {}, hunters: {}, busy: null
};
let seq = 0; const nid = p => p + (++seq);

const listeners = new Set();
export function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(kind, msg, data = {}) {
  const e = { at: Date.now(), kind, msg, ...data };
  S.log.push(e); if (S.log.length > 400) S.log.shift();
  try { appendFileSync(new URL('log.jsonl', DATA), JSON.stringify(e) + '\n'); } catch {}
  for (const fn of listeners) try { fn(e); } catch {}
  console.log(`[${kind}] ${msg}`);
}

// ---------- versions: each one a self-contained folder ----------
export const src = id => readFileSync(new URL(`${id}/game.js`, VDIR), 'utf8');
export const themeOf = id => JSON.parse(readFileSync(new URL(`${id}/theme.json`, VDIR), 'utf8'));
function nextId() { let n = 1; while (existsSync(new URL(`v${n}/`, VDIR))) n++; return `v${n}`; }
function saveVersion(code, theme, meta) {
  const id = nextId();
  mkdirSync(new URL(`${id}/`, VDIR), { recursive: true });
  writeFileSync(new URL(`${id}/game.js`, VDIR), code);
  writeFileSync(new URL(`${id}/theme.json`, VDIR), JSON.stringify(theme, null, 2));
  S.versions[id] = { id, created: Date.now(), ...meta };
  persistMeta(id);
  return id;
}
function persistMeta(id) { try { writeFileSync(new URL(`${id}/meta.json`, VDIR), JSON.stringify(S.versions[id], null, 2)); } catch {} }
function setStatus(id, status, extra = {}) { Object.assign(S.versions[id], { status }, extra); persistMeta(id); }
S.versions.v1 = { id: 'v1', parent: null, status: 'stable', kind: 'code', summary: 'First draft from the brief (shipped with bugs)', created: Date.now(), goals: ['Fewer crashes'] };

// ---------- skills directory ----------
function skillFile(sk) {
  return `# ${sk.id}\n\n- created: ${sk.created}\n- project: ${PROJECT}\n- status: ${sk.status}\n- context: ${sk.context}\n\n## Skill\n\n${sk.text}\n\n## Why\n\n${sk.why || ''}\n`;
}
function manifestFile(m) {
  return `# skill_manifest_v${m.v}\n\n- created: ${m.created}\n- project: ${PROJECT}\n- parent: ${m.parent ? 'v' + m.parent : 'none'}\n- status: ${m.status}\n- held-out bug bench: ${m.heldout != null ? `${m.heldout}/${m.of}` : 'not run yet'}\n- guide: [README.md](README.md)\n\n## Confirmed skills for this kind of work\n\n${m.skills.map(id => `- [${id}](${id}.md): ${S.skills[id].text}`).join('\n')}\n`;
}
function writeSkill(sk) { writeFileSync(new URL(`${sk.id}.md`, SDIR), skillFile(sk)); }
function writeManifest(m) {
  writeFileSync(new URL(`skill_manifest_v${m.v}.md`, SDIR), manifestFile(m));
  writeFileSync(new URL('index.json', SDIR), JSON.stringify({ current: S.manifest, skills: S.skills, manifests: S.manifests }, null, 2));
}
function bootSkills() {
  try {
    const j = JSON.parse(readFileSync(new URL('index.json', SDIR), 'utf8'));
    S.skills = j.skills; S.manifests = j.manifests; S.manifest = j.current;
    for (const m of S.manifests) if (m.status === 'testing') m.status = 'discarded';
  } catch {
    const sk = { id: 'skill_001', created: now(), status: 'confirmed', context: 'starting rule', text: 'Make the smallest change that fixes the root cause.', why: 'baseline' };
    S.skills[sk.id] = sk; writeSkill(sk);
    const m = { v: 1, parent: null, created: now(), status: 'adopted', skills: [sk.id], heldout: null };
    S.manifests.push(m); S.manifest = 1; writeManifest(m);
  }
}
bootSkills();
const curManifest = () => S.manifests.find(m => m.v === S.manifest);
const rulesOf = m => m.skills.map(id => S.skills[id].text);

// ---------- inbox: crashes, feedback, look requests ----------
export function tele(v) {
  return S.tele[v] ||= { players: new Set(), sessions: 0, errors: {}, deaths: [], rooms: {}, wins: 0 };
}
const LOOK_WORDS = /\b(cute|ugly|pretty|color|colour|colors|look|looks|art|visual|style|bright|dark|beautiful|graphics|sprite|theme|vibe|aesthetic)\b/i;
export function ingest(ev) {
  const v = S.versions[ev.v] ? ev.v : S.stable, t = tele(v);
  if (ev.pid) t.players.add(ev.pid);
  if (ev.type === 'start') t.sessions++;
  if (ev.type === 'death' || ev.type === 'win') { S.since.sessions++; checkSchedule('a play session ended'); }
  if (ev.type === 'death') t.deaths.push({ room: ev.room, x: ev.x, y: ev.y });
  if (ev.type === 'room') t.rooms[ev.room] = (t.rooms[ev.room] || 0) + 1;
  if (ev.type === 'win') t.wins++;
  if (ev.type === 'error') {
    const k = String(ev.msg).slice(0, 140); t.errors[k] = (t.errors[k] || 0) + 1; credit(ev, 10);
    let item = S.inbox.find(i => i.kind === 'crash' && i.text === k && i.status !== 'shipped');
    if (item) { item.count++; item.v = v; } else { item = { id: nid('c'), kind: 'crash', text: k, count: 1, v, from: ev.name || 'anon', at: Date.now(), route: 'code', status: 'open' }; S.inbox.push(item); }
    emit('signal', `Crash reported by ${ev.name || 'anon'} on ${v}: ${k} (seen ${item.count}x)`, { item: item.id });
    S.since.sessions++; checkSchedule('a crash was reported');
  }
  if (ev.type === 'feedback') {
    const text = String(ev.text).slice(0, 300);
    const item = { id: nid('f'), kind: 'feedback', text, rating: ev.rating ?? null, v, from: ev.name || 'anon', at: Date.now(), route: LOOK_WORDS.test(text) ? 'look' : 'code', status: 'open' };
    S.inbox.push(item); credit(ev, 5);
    emit('signal', `Feedback ${item.id} from ${item.from} on ${v}${item.rating ? (item.rating > 3 ? ' 👍' : ' 👎') : ''}: "${text.slice(0, 120)}"`, { item: item.id });
    routeItem(item).finally(() => { S.since.feedback++; checkSchedule('new feedback'); });
  }
}
async function routeItem(item) {
  try {
    const r = await chat(MODELS.fast, [{ role: 'user', content: `Route this player feedback about a small browser dungeon game. "code" = gameplay, difficulty, controls, bugs, features, content. "look" = visual style, colors, cuteness, art. Feedback: "${item.text}". Reply JSON {"route":"code"|"look","why":"short"}` }], { temperature: 0, timeoutMs: 20000 });
    if (r.route === 'look' || r.route === 'code') item.route = r.route;
    emit('route', `${item.id} routed to ${item.route === 'look' ? 'the vision look loop' : 'the code Fixer'}: ${r.why || ''}`, { item: item.id });
  } catch { emit('route', `${item.id} routed to ${item.route} (keyword fallback)`); }
}
function credit(ev, pts) { const n = (ev.name || '').slice(0, 20); if (n) S.hunters[n] = (S.hunters[n] || 0) + pts; }
const openItems = route => S.inbox.filter(i => i.status === 'open' && i.route === route);

function realSignals(v) {
  const t = tele(v);
  return { players: t.players.size, sessions: t.sessions, wins: t.wins, deathsByRoom: t.deaths.reduce((a, d) => (a[d.room] = (a[d.room] || 0) + 1, a), {}), reachedRoom: t.rooms };
}

// ---------- schedule ----------
export function checkSchedule(why) {
  const sc = S.schedule;
  if (sc.mode === 'manual' || S.busy || S.canary) return;
  let go = false;
  if (sc.mode === 'continuous') go = true;
  if (sc.mode === 'sessions' && S.since.sessions >= sc.n) go = true;
  if (sc.mode === 'feedback' && S.since.feedback >= sc.n) go = true;
  if (sc.mode === 'minutes' && Date.now() - S.since.at >= sc.n * 60000) go = true;
  if (!go) return;
  emit('schedule', `Update triggered by schedule (${describeSchedule()}): ${why}.`);
  setTimeout(() => runCycle(), 300);
}
export function describeSchedule() {
  const { mode, n } = S.schedule;
  return { manual: 'manual only', continuous: 'continuous', sessions: `after every ${n} play session(s)`, feedback: `after every ${n} feedback item(s)`, minutes: `every ${n} minute(s)` }[mode];
}
async function runCycle() {
  S.since = { sessions: 0, feedback: 0, at: Date.now() };
  if (openItems('look').length) { S.lookWanted = true; emit('look', `${openItems('look').length} look request(s) waiting for the vision loop (runs from the control room).`); }
  await runGeneration();
}

// ---------- patches ----------
const BANNED = /\b(require|process|import|fetch|eval|Function|XMLHttpRequest|globalThis|localStorage|document|window)\b/;
export function applyEdits(code, edits) {
  if (!Array.isArray(edits) || !edits.length) throw new Error('no edits proposed');
  if (edits.length > 8) throw new Error('too many edits');
  for (const e of edits) {
    if (typeof e.find !== 'string' || typeof e.replace !== 'string' || !e.find) throw new Error('edit missing find/replace');
    const n = code.split(e.find).length - 1;
    if (n !== 1) throw new Error(`find text matched ${n} times: ${e.find.slice(0, 60)}`);
    if (BANNED.test(e.replace)) throw new Error('edit uses a banned API');
    code = code.replace(e.find, () => e.replace);
  }
  return code;
}

async function fixer({ goals, code, signals, rules, requests = [], recent = [] }) {
  const sys = `You maintain a small browser dungeon game (game.js, pure JavaScript, ES5 style, runs in browsers and in a sandbox with only Math available). You improve it by proposing small, exact text edits.
Confirmed skills from your skill manifest. Follow them:
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}
Reply with JSON only: {"diagnosis": "what is wrong and why", "edits": [{"find": "exact text copied from game.js, unique", "replace": "new text"}], "addressed": ["ids of requests this patch addresses"], "summary": "one short changelog line players will see"}`;
  const user = `CREATOR GOALS (optimize for all of these):
${goals.map(g => `- ${g.text}`).join('\n')}

OPEN REQUESTS FROM PLAYERS (crashes and feedback; address as many as you sensibly can without hurting the goals):
${requests.length ? requests.map(r => `[${r.id}] ${r.kind === 'crash' ? `CRASH x${r.count}` : r.rating ? (r.rating > 3 ? 'thumbs up' : 'THUMBS DOWN') : 'feedback'}: "${r.text}" (on ${r.v})`).join('\n') : '(none)'}

MEASURED SIGNALS:
${JSON.stringify(signals, null, 1).slice(0, 5000)}
${recent.length ? '\nRECENT ATTEMPTS THAT WERE REJECTED (do not repeat):\n' + recent.map(r => '- ' + r).join('\n') + '\n' : ''}
game.js:
\`\`\`js
${code}
\`\`\``;
  const B = BUDGETS[S.budget] || BUDGETS.fast;
  return chat(MODELS.coder, [{ role: 'system', content: sys }, { role: 'user', content: user + `

Budget: keep "diagnosis" under ${S.budget === 'fast' ? 40 : 120} words and edits minimal.` }], { temperature: 0.3, maxTokens: B.maxTokens, timeoutMs: B.timeoutMs });
}

// ---------- goals ----------
export async function addGoal(text) {
  text = String(text).slice(0, 200).trim(); if (!text) return null;
  const g = { id: nid('g'), text, weights: {}, measurable: false, note: 'mapping…' };
  S.goals.push(g);
  emit('goal', `New creator goal: "${text}". Mapping it to measurable signals...`);
  try {
    const r = await chat(MODELS.fast, [{ role: 'user', content: `A game creator gave this goal for a small dungeon game: "${text}".
Measurable signals available: ${Object.entries(SIGNALS).map(([k, s]) => `${k} (${s.label})`).join(', ')}.
Map the goal to weights 0-1 over these signals. If none of them can measure it, set measurable false and explain what we would need to log. If it is about visuals, set look true.
Reply JSON {"weights": {"signal": weight}, "measurable": true|false, "look": true|false, "note": "how this goal will be measured, one sentence"}` }], { temperature: 0, timeoutMs: 45000 });
    g.weights = r.weights || {}; g.measurable = !!r.measurable && Object.values(g.weights).some(w => w > 0); g.look = !!r.look; g.note = r.note || '';
  } catch (e) { Object.assign(g, keywordGoal(text)); g.note = 'mapped by keywords (model timed out)'; }
  if (g.look) { S.inbox.push({ id: nid('f'), kind: 'feedback', text: 'Creator goal: ' + text, v: S.stable, from: 'creator', at: Date.now(), route: 'look', status: 'open' }); }
  emit('goal', `Goal "${text}" ${g.measurable ? 'measured by ' + Object.entries(g.weights).filter(([, w]) => w > 0).map(([k, w]) => `${k}×${w}`).join(', ') : 'is not directly measurable yet'}. ${g.note}`);
  return g;
}
function keywordGoal(t) {
  const w = {};
  if (/long|time|engag|stay|retention/i.test(t)) w.playTime = 1;
  if (/boss|reach|progress|further|level/i.test(t)) w.reachBoss = 1;
  if (/beat|win|victor/i.test(t)) w.winRate = 1;
  if (/coin|collect|loot|buy|purchase|shop/i.test(t)) w.coins = 1;
  if (/crash|stable|bug/i.test(t)) w.crashFree = 1;
  return { weights: w, measurable: Object.keys(w).length > 0, look: LOOK_WORDS.test(t) || /3d|perspective/i.test(t) };
}
export function removeGoal(id) { S.goals = S.goals.filter(g => g.id !== id); emit('goal', `Goal removed. Optimizing for: ${S.goals.map(g => g.text).join('; ') || 'nothing'}`); }

// ---------- loop 1 ----------
export async function runGeneration({ forcedEdits, label } = {}) {
  if (S.busy) return { skipped: S.busy };
  S.busy = 'improving the game';
  let addressed = [];
  try {
    const base = src(S.stable), baseTheme = themeOf(S.stable);
    const train = playtest(base, TRAIN_SEEDS), baseHeld = playtest(base, HELDOUT_SEEDS);
    const requests = openItems('code').slice(-12);
    const signals = { botPlaytests: strip(train), realPlayers: realSignals(S.stable) };
    const goals = S.goals.slice();
    emit('observe', `Improving ${S.stable}. Goals: ${goals.map(g => g.text).join('; ')}. Bots: crash ${pct(train.crashRate)}, boss ${pct(train.reachBoss)}, win ${pct(train.winRate)}. Open requests: ${requests.length}.`);

    const man = curManifest();
    let prop;
    if (forcedEdits) prop = { edits: forcedEdits, summary: label, diagnosis: 'Injected by playbook (not written by the agent).', addressed: [] };
    else {
      emit('think', `Fixer (${MODELS.coder}, ${BUDGETS[S.budget].label} budget) with skill manifest v${man.v} (${man.skills.length} skills) is writing a patch...`);
      const recent = S.failures.filter(f => f.source === 'live').slice(-3).map(f => `${f.summary} -> ${f.reason}`);
      prop = await fixer({ goals, code: base, signals, rules: rulesOf(man), requests, recent });
    }
    addressed = (prop.addressed || []).filter(id => requests.some(r => r.id === id));
    emit('propose', `Patch: ${prop.summary || '(no summary)'}${addressed.length ? ` (addresses ${addressed.join(', ')})` : ''}`, { diagnosis: prop.diagnosis, edits: prop.edits });

    let cand;
    try { cand = applyEdits(base, prop.edits); }
    catch (e) { return reject(null, prop, `patch did not apply: ${e.message}`, addressed); }

    const held = playtest(cand, HELDOUT_SEEDS);
    const before = goalScore(baseHeld, goals), after = goalScore(held, goals);
    const viol = guardrails(held, baseHeld);
    const context = { goals: goals.map(g => ({ text: g.text, weights: g.weights })), requests: requests.map(r => ({ id: r.id, kind: r.kind, text: r.text, rating: r.rating })), signals, skillManifest: man.v, model: MODELS.coder };
    const id = saveVersion(cand, baseTheme, { kind: 'code', parent: S.stable, summary: prop.summary, diagnosis: prop.diagnosis, edits: prop.edits, addressed, addressedText: requests.filter(r => addressed.includes(r.id)).map(r => r.text), goals: goals.map(g => g.text), skillManifest: man.v, before, after, heldout: strip(held), baseHeldout: strip(baseHeld), injected: !!forcedEdits, status: 'testing', context });
    for (const r of S.inbox) if (addressed.includes(r.id)) { r.status = 'in test'; r.version = id; }
    emit('test', `${id} on ${HELDOUT_SEEDS.length} held-out bot runs: goal score ${before.toFixed(2)} -> ${after.toFixed(2)}. Crash ${pct(baseHeld.crashRate)} -> ${pct(held.crashRate)}, boss ${pct(baseHeld.reachBoss)} -> ${pct(held.reachBoss)}, avg run ${baseHeld.avgSeconds.toFixed(0)}s -> ${held.avgSeconds.toFixed(0)}s.`, { id });

    if (viol.length) return reject(id, prop, 'guardrail: ' + viol.join('; '), addressed);
    const gain = after > before + 0.005, holds = after >= before - 0.01;
    if (!gain && !(addressed.length && holds)) return reject(id, prop, `no held-out gain (${before.toFixed(2)} -> ${after.toFixed(2)})${addressed.length ? ' and it hurt the goals' : ''}`, addressed);
    const why = gain ? 'goal score rose on held-out runs' : `addresses ${addressed.length} request(s) without hurting the goals`;

    setStatus(id, 'canary', { why }); S.canary = id; S.canaryStart = Date.now();
    emit('canary', `${id} passed (${why}). Shipping to ${pct(S.canaryShare)} of real players for ${S.canaryMs / 1000}s.`, { id });
    setTimeout(() => decideCanary(id).catch(e => emit('error', e.message)), S.canaryMs);
    return { id, status: 'canary' };
  } catch (e) {
    for (const r of S.inbox) if (addressed.includes(r.id) && r.status === 'in test') r.status = 'open';
    emit('error', `Generation failed: ${e.message}`);
    return { error: e.message };
  } finally { S.busy = null; }
}

function reject(id, prop, reason, addressed = []) {
  if (id) setStatus(id, 'rejected', { reason });
  for (const r of S.inbox) if (addressed.includes(r.id)) { r.status = 'open'; r.tries = (r.tries || 0) + 1; }
  S.failures.push({ source: 'live', at: Date.now(), goal: S.goals.map(g => g.text).join('; '), summary: prop.summary || '', diagnosis: prop.diagnosis || '', edits: prop.edits, reason });
  emit('rollback', `${id || 'patch'} rejected, ${S.stable} stays live. Reason: ${reason}`, { id });
  return { id, status: 'rejected', reason };
}

async function decideCanary(id) {
  if (S.canary !== id) return;
  const c = tele(id), s = tele(S.stable);
  const errs = t => Object.values(t.errors).reduce((a, b) => a + b, 0);
  const cr = c.sessions ? errs(c) / c.sessions : 0, sr = s.sessions ? errs(s) / s.sessions : 0;
  S.canary = null;
  if (c.sessions >= 2 && cr > sr + 0.1) {
    setStatus(id, 'rolled back', { reason: `real players crashed more (${cr.toFixed(2)} vs ${sr.toFixed(2)} per session)` });
    for (const r of S.inbox) if (r.version === id && r.status === 'in test') r.status = 'open';
    S.failures.push({ source: 'live', at: Date.now(), summary: S.versions[id].summary, edits: S.versions[id].edits, reason: S.versions[id].reason });
    emit('rollback', `Canary ${id} rolled back: real players crashed more (${cr.toFixed(2)} vs ${sr.toFixed(2)} errors per session).`, { id });
    return;
  }
  promote(id, `canary: ${c.sessions} real sessions, ${cr.toFixed(2)} errors/session vs ${sr.toFixed(2)}`);
}
function promote(id, evidence) {
  const prev = S.stable;
  setStatus(prev, 'retired'); setStatus(id, 'stable', { evidence });
  S.stable = id;
  const shipped = S.inbox.filter(r => r.version === id && r.status === 'in test');
  for (const r of shipped) { r.status = 'shipped'; if (r.from && r.from !== 'anon' && r.from !== 'creator') S.hunters[r.from] = (S.hunters[r.from] || 0) + 20; }
  // crashes that no longer reproduce in bots are shipped too
  emit('promote', `${id} is live for everyone (${evidence}). "${S.versions[id].summary}"${shipped.length ? ` Shipped requests: ${shipped.map(r => r.id).join(', ')}.` : ''}`, { id });
  setTimeout(() => checkSchedule('the previous update finished'), 1500);
}

function strip(m) { const { deaths, ...r } = m; r.sampleDeaths = (deaths || []).slice(0, 6); return r; }
export function tick() { checkSchedule('timer'); }

// ---------- loop 2 ----------
async function fixTask(t, rules) {
  const code = taskSource(t);
  try {
    const prop = await fixer({ goals: [{ text: 'Fix the reported problem so the game plays as designed.' }], code, signals: {}, rules, requests: [{ id: 'r1', kind: 'feedback', text: t.symptom, v: 'bench' }] });
    let fixed;
    try { fixed = applyEdits(code, prop.edits); } catch (e) { return { id: t.id, pass: false, reason: 'patch did not apply: ' + e.message, prop }; }
    const r = checkTask(t, fixed);
    const viol = guardrails(r.metrics, { crashRate: 0 });
    return { id: t.id, pass: r.pass, reason: r.pass ? 'ok' : (viol.join('; ') || `hidden check failed: crash ${pct(r.metrics.crashRate)}, boss ${pct(r.metrics.reachBoss)}, tuning values changed or bug masked`), prop };
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
    const cur = curManifest();
    emit('learn', `Loop 2: running ${TASKS.filter(t => t.split === 'train').length} training bugs with skill manifest v${cur.v} to collect failures...`);
    const train = await benchScore(rulesOf(cur), 'train');
    const benchFails = train.res.filter(r => !r.pass).map(r => ({ source: 'bench', task: r.id, symptom: TASKS.find(t => t.id === r.id).symptom, summary: r.prop?.summary, diagnosis: r.prop?.diagnosis, edits: r.prop?.edits, reason: r.reason }));
    const fails = [...benchFails, ...S.failures.filter(f => f.source === 'live').slice(-4)];
    emit('learn', `Training bugs: ${train.score}/${train.of} fixed. ${fails.length} failure(s) to learn from (${benchFails.length} bench, ${fails.length - benchFails.length} live).`);
    if (!fails.length) { emit('learn', 'No failures to learn from. Skill manifest unchanged.'); return { unchanged: true }; }

    const refl = await chat(MODELS.coder, [{ role: 'system', content: 'You improve the skills of a code-fixing agent. Study its failures and write ONE new general skill that would have prevented them: advice on how to diagnose and patch, not specific numbers or this exact bug. Reply JSON: {"skill": "...", "why": "..."}' },
      { role: 'user', content: `CURRENT SKILLS:\n${rulesOf(cur).map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\nFAILURES:\n${JSON.stringify(fails.map(f => ({ task: f.symptom || f.goal, patch: f.summary, diagnosis: f.diagnosis, edits: (f.edits || []).slice(0, 3), why_it_failed: f.reason })), null, 1).slice(0, 7000)}` }], { temperature: 0.4 });
    const sid = `skill_${String(Object.keys(S.skills).length + 1).padStart(3, '0')}`;
    const sk = { id: sid, created: now(), status: 'testing', context: `learned from ${fails.length} failure(s): ${fails.slice(0, 3).map(f => f.task || f.summary).join('; ').slice(0, 200)}`, text: String(refl.skill || '').slice(0, 500), why: refl.why || '' };
    S.skills[sid] = sk; writeSkill(sk);
    const m = { v: Math.max(...S.manifests.map(x => x.v)) + 1, parent: cur.v, created: now(), status: 'testing', skills: [...cur.skills, sid], heldout: null };
    S.manifests.push(m); writeManifest(m);
    emit('learn', `Reflector wrote ${sid}: "${sk.text}" -> candidate skill_manifest_v${m.v}`);

    emit('learn', `Held-out check: manifest v${cur.v} vs v${m.v} on ${TASKS.filter(t => t.split === 'heldout').length} bugs never used for learning...`);
    const [a, b] = await Promise.all([benchScore(rulesOf(cur), 'heldout'), benchScore(rulesOf(m), 'heldout')]);
    cur.heldout = a.score; cur.of = a.of; m.heldout = b.score; m.of = b.of;
    m.detail = b.res.map(r => ({ id: r.id, pass: r.pass, reason: r.reason }));
    if (b.score > a.score) {
      cur.status = 'superseded'; m.status = 'adopted'; sk.status = 'confirmed'; S.manifest = m.v;
      emit('adopt', `skill_manifest_v${m.v} ADOPTED: held-out ${a.score}/${a.of} -> ${b.score}/${b.of}. ${sid} is now a confirmed skill.`);
    } else {
      m.status = 'discarded'; sk.status = 'discarded';
      emit('discard', `skill_manifest_v${m.v} DISCARDED: held-out ${a.score}/${a.of} -> ${b.score}/${b.of}. Keeping v${cur.v}.`);
    }
    writeSkill(sk); writeManifest(cur); writeManifest(m);
    return { v: m.v, before: a.score, after: b.score, of: b.of };
  } catch (e) { emit('error', 'Learning failed: ' + e.message); return { error: e.message }; }
  finally { S.busy = null; }
}

// ---------- look loop (vision) ----------
const THEME_KEYS = Object.keys(themeOf('v1')).filter(k => k !== 'font');
export async function proposeTheme(screenshots, target) {
  const notes = openItems('look').slice(-6);
  emit('look', `Vision (${MODELS.vision}) compares ${screenshots.length} game frame(s) with the target art${notes.length ? ` and ${notes.length} look request(s): ${notes.map(n => `"${n.text.slice(0, 60)}"`).join(', ')}` : ''}...`);
  const r = await vision(`Image 1 is the TARGET art style. The other image(s) are frames from our game. Propose new colors so the game looks more like the target while staying readable (player and enemies must stand out from the floor).${notes.length ? ` Also satisfy these requests from players and the creator: ${notes.map(n => `"${n.text}"`).join('; ')}.` : ''} Current theme: ${JSON.stringify(themeOf(S.stable))}. Reply JSON: {"theme": {${THEME_KEYS.map(k => `"${k}": ...`).join(', ')}}, "why": "..."}. Colors as #rrggbb, wallWidth a number 2-10.`, [target, ...screenshots], { temperature: 0.4 });
  const th = { ...themeOf(S.stable) };
  for (const k of THEME_KEYS) if (r.theme && r.theme[k] != null) th[k] = k === 'wallWidth' ? Math.max(2, Math.min(10, Number(r.theme[k]) || 4)) : String(r.theme[k]).slice(0, 9);
  return { theme: th, why: r.why, notes: notes.map(n => n.id) };
}
export async function judgeTheme(target, current, candidate, theme, why, noteIds = []) {
  const notes = S.inbox.filter(i => noteIds.includes(i.id));
  const q = `Image 1 is the TARGET art style.${notes.length ? ` Players also asked: ${notes.map(n => `"${n.text}"`).join('; ')}.` : ''} Which game screenshot better matches the target style${notes.length ? ' and those requests' : ''}: image 2 or image 3? Reply JSON {"closer": 2 or 3, "why": "..."}`;
  const ask = (a, b) => vision(q, [target, a, b], { temperature: 0 });
  const [x, y] = await Promise.all([ask(current, candidate), ask(candidate, current)]);
  const winsA = Number(x.closer) === 3, winsB = Number(y.closer) === 2;
  S.lookWanted = false;
  if (winsA && winsB) {
    const id = saveVersion(src(S.stable), theme, { kind: 'look', parent: S.stable, summary: 'New look: ' + String(why || '').slice(0, 140), addressed: noteIds, addressedText: notes.map(n => n.text), goals: S.goals.map(g => g.text), votes: [winsA, winsB], status: 'testing', context: { requests: notes.map(n => ({ id: n.id, text: n.text })), model: MODELS.vision, judge: 'both orders' } });
    for (const n of notes) { n.status = 'in test'; n.version = id; }
    emit('adopt', `Look ${id} ADOPTED: the vision judge preferred it in both orders. ${why || ''}`, { id });
    promote(id, 'vision judge 2/2');
    return { id, adopted: true };
  }
  for (const n of notes) n.tries = (n.tries || 0) + 1;
  emit('discard', `New look DISCARDED: judge votes ${winsA ? 'yes' : 'no'}/${winsB ? 'yes' : 'no'} (needs both). Keeping ${S.stable}.`);
  return { adopted: false };
}

export function versionList() {
  return Object.values(S.versions).sort((a, b) => a.created - b.created).map(v => ({ id: v.id, status: v.status, kind: v.kind, summary: v.summary, addressedText: v.addressedText || [], goals: v.goals || [], parent: v.parent, created: v.created }));
}
export function snapshot() {
  return {
    stable: S.stable, canary: S.canary, canaryShare: S.canaryShare, canaryMs: S.canaryMs, canaryStart: S.canaryStart,
    goals: S.goals, schedule: S.schedule, budget: S.budget, budgets: Object.fromEntries(Object.entries(BUDGETS).map(([k, b]) => [k, b.label])), scheduleText: describeSchedule(), lookWanted: !!S.lookWanted && !S.busy,
    versions: Object.values(S.versions).sort((a, b) => a.created - b.created),
    manifest: S.manifest, manifests: S.manifests, skills: S.skills,
    inbox: S.inbox.slice(-30).reverse(), failures: S.failures.slice(-10), busy: S.busy,
    hunters: Object.entries(S.hunters).sort((a, b) => b[1] - a[1]).slice(0, 10),
    usage, log: S.log.slice(-80)
  };
}
