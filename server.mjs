// One Node server, no dependencies: serves every game version, routes players
// to stable or canary, collects telemetry and feedback, and drives the agent.
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { extname } from 'node:path';
import * as A from './agent/evolve.mjs';

const PORT = Number(process.env.PORT || 8080);
const ADMIN = process.env.ADMIN_TOKEN || '';
const root = new URL('./', import.meta.url);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.css': 'text/css', '.md': 'text/markdown; charset=utf-8' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function file(res, url) {
  if (!existsSync(url)) return send(res, 404, { error: 'not found' });
  send(res, 200, readFileSync(url), TYPES[extname(url.pathname)] || 'application/octet-stream');
}
function body(req) {
  return new Promise((ok, bad) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 12e6) { bad(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { bad(e); } });
  });
}
function hash(s) { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; }

let target = null;
function targetDataUrl() { return target ||= 'data:image/webp;base64,' + readFileSync(new URL('public/target.webp', root)).toString('base64'); }

// A "bad deploy" ships straight to everyone, skipping the gate, so the agent has something real to fix.
function shipBad(kind) {
  const code = A.src(A.S.stable);
  const spec = kind === 'crash'
    ? [/if \(k\.kind === 'coin'\) \{ st\.coins\+\+;/, "if (k.kind === 'coin') { st.coin.count++;", 'Bad deploy: coin pickup crashes (injected by playbook)']
    : [/enemySpeed: [\d.]+,/, 'enemySpeed: 3.2,', 'Bad tuning: slimes far too fast (injected by playbook)'];
  const m = code.match(spec[0]); if (!m) return { error: 'injection point not found' };
  const bad = A.applyEdits(code, [{ find: m[0], replace: spec[1] }]);
  let n = 1; while (existsSync(new URL(`versions/v${n}/`, root))) n++;
  const id = `v${n}`; mkdirSync(new URL(`versions/${id}/`, root), { recursive: true });
  writeFileSync(new URL(`versions/${id}/game.js`, root), bad);
  writeFileSync(new URL(`versions/${id}/theme.json`, root), JSON.stringify(A.themeOf(A.S.stable), null, 2));
  A.S.versions[A.S.stable].status = 'retired';
  A.S.versions[id] = { id, parent: A.S.stable, created: Date.now(), status: 'stable', kind: 'code', summary: spec[2], injected: true, goals: A.S.goals.map(g => g.text) };
  A.S.stable = id; A.S.canary = null;
  A.emit('deploy', `${id} shipped to everyone: ${spec[2]}`, { id });
  return { id };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  try {
    if (req.method === 'GET') {
      if (p === '/' || p === '/play') return file(res, new URL('public/play.html', root));
      if (p === '/control') return file(res, new URL('public/control.html', root));
      if (p === '/api/assign') {
        const pid = u.searchParams.get('pid') || Math.random(); const want = u.searchParams.get('v');
        const v = want && A.S.versions[want] ? want : (A.S.canary && hash(pid) < A.S.canaryShare ? A.S.canary : A.S.stable);
        const meta = A.S.versions[v];
        return send(res, 200, { v, game: meta?.game || 'Patchwork Dungeon', theme: A.themeOf(v), summary: meta?.summary || '', status: meta?.status, addressed: meta?.addressedText || [], goals: meta?.goals || [], stable: A.S.stable });
      }
      if (p === '/api/versions') return send(res, 200, { stable: A.S.stable, canary: A.S.canary, versions: A.versionList() });
      let m = p.match(/^\/v\/(v\d+)\/(game\.js|theme\.json|meta\.json)$/);
      if (m) return file(res, new URL(`versions/${m[1]}/${m[2]}`, root));
      m = p.match(/^\/skills\/([\w.-]+\.(md|json))$/);
      if (m) return file(res, new URL(`skills/${m[1]}`, root));
      if (p === '/api/state') return send(res, 200, A.snapshot());
      if (p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        const off = A.onEvent(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => { off(); clearInterval(ping); });
        return;
      }
      if (p === '/target.webp') return file(res, new URL('public/target.webp', root));
      return send(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST') {
      const b = await body(req);
      if (p === '/api/t') { for (const ev of [].concat(b)) A.ingest(ev); return send(res, 200, { ok: true }); }
      if (ADMIN && b.admin !== ADMIN) return send(res, 403, { error: 'admin only' });
      if (p === '/api/goal') { const g = await A.addGoal(b.text); return send(res, 200, { goal: g }); }
      if (p === '/api/goal/remove') { A.removeGoal(b.id); return send(res, 200, { ok: true }); }
      if (p === '/api/schedule') {
        if (['manual', 'continuous', 'sessions', 'feedback', 'minutes'].includes(b.mode)) A.S.schedule.mode = b.mode;
        if (b.n) A.S.schedule.n = Math.max(1, Math.min(120, Number(b.n) || 1));
        A.S.since = { sessions: 0, feedback: 0, at: Date.now() };
        A.emit('schedule', `Update schedule: ${A.describeSchedule()}.`);
        A.checkSchedule('schedule changed');
        return send(res, 200, A.S.schedule);
      }
      if (p === '/api/budget') { if (A.BUDGETS[b.budget]) { A.S.budget = b.budget; A.emit('schedule', `Fixer budget: ${A.BUDGETS[b.budget].label}`); } return send(res, 200, { budget: A.S.budget }); }
      if (p === '/api/newgame') { A.newGame(String(b.brief || '').slice(0, 400)); return send(res, 200, { started: true }); }
      if (p === '/api/gen') { A.runGeneration(); return send(res, 200, { started: true }); }
      if (p === '/api/learn') { A.learn(); return send(res, 200, { started: true }); }
      if (p === '/api/canary') { if (b.share != null) A.S.canaryShare = Math.max(0, Math.min(1, b.share)); if (b.ms) A.S.canaryMs = Math.max(3000, Math.min(120000, b.ms)); return send(res, 200, { share: A.S.canaryShare, ms: A.S.canaryMs }); }
      const m = p.match(/^\/api\/playbook\/(\w+)$/);
      if (m) {
        const k = m[1];
        if (k === 'crash' || k === 'annoy') { A.emit('playbook', k === 'crash' ? 'Playbook: bad deploy (crash)' : 'Playbook: annoying tuning'); return send(res, 200, shipBad(k)); }
        if (k === 'sabotage') {
          A.emit('playbook', 'Playbook: a patch that cheats the goal by deleting Spike Hall');
          const code = A.src(A.S.stable); const mm = code.match(/[ \t]*\{ name: 'Spike Hall'[^\n]*\n/);
          if (!mm) return send(res, 200, { error: 'Spike Hall not found' });
          return send(res, 200, await A.runGeneration({ forcedEdits: [{ find: mm[0], replace: '' }], label: 'Remove Spike Hall so more players reach the boss (injected cheating patch)' }));
        }
        if (k === 'reset') {
          for (const v of Object.values(A.S.versions)) if (v.status === 'stable' || v.status === 'canary') v.status = 'retired';
          A.S.stable = 'v1'; A.S.versions.v1.status = 'stable'; A.S.canary = null;
          A.emit('reset', 'Game reset to v1 by playbook.');
          return send(res, 200, { ok: true });
        }
      }
      if (p === '/api/style/propose') { const shots = [].concat(b.screenshots || b.screenshot).filter(Boolean).slice(0, 3); return send(res, 200, await A.proposeTheme(shots, targetDataUrl())); }
      if (p === '/api/style/judge') return send(res, 200, await A.judgeTheme(targetDataUrl(), b.current, b.candidate, b.theme, b.why, b.notes || []));
      return send(res, 404, { error: 'not found' });
    }
    send(res, 405, { error: 'method' });
  } catch (e) { A.emit('error', `${p}: ${e.message}`); send(res, 500, { error: e.message }); }
});

setInterval(() => { try { A.tick(); } catch {} }, 5000);
server.listen(PORT, () => console.log(`Patchwork on http://localhost:${PORT}  (control room: /control)`));
