// One Node server, no dependencies: serves the game, routes players to
// stable or canary versions, collects telemetry, and drives the agent.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import * as A from './agent/evolve.mjs';

const PORT = Number(process.env.PORT || 8080);
const ADMIN = process.env.ADMIN_TOKEN || '';
const root = new URL('./', import.meta.url);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.css': 'text/css', '.svg': 'image/svg+xml' };

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
    req.on('data', c => { n += c.length; if (n > 8e6) { bad(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { bad(e); } });
  });
}
function hash(s) { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; }

let target = null;
const targetPath = new URL('public/target.webp', root);
function targetDataUrl() { return target ||= 'data:image/webp;base64,' + readFileSync(targetPath).toString('base64'); }

const PLAYBOOKS = {
  crash: { label: 'Bad deploy: coin pickup crashes', run: () => injectBug(/if \(k\.kind === 'coin'\) \{ st\.coins\+\+;/, "if (k.kind === 'coin') { st.coin.count++;", 'Bad deploy (injected by playbook): coin pickup crashes') },
  annoy: { label: 'Annoying: slimes way too fast', run: () => injectBug(/enemySpeed: [\d.]+,/, 'enemySpeed: 3.2,', 'Bad tuning (injected by playbook): slimes are far too fast') },
  sabotage: { label: 'Cheating fix: delete Spike Hall', run: () => {
    const code = A.src(A.S.stable); const m = code.match(/[ \t]*\{ name: 'Spike Hall'[^\n]*\n/);
    if (!m) return { error: 'Spike Hall not found in stable' };
    return A.runGeneration({ forcedEdits: [{ find: m[0], replace: '' }], label: 'Remove Spike Hall so more players reach the boss (injected cheating patch)' });
  } },
  reset: { label: 'Reset game to v1', run: () => { A.S.versions[A.S.stable].status = 'retired'; A.S.stable = 'v1'; A.S.versions.v1.status = 'stable'; A.S.canary = null; A.emit('reset', 'Game reset to v1 by playbook.'); return { ok: true }; } }
};
function injectBug(re, replacement, label) {
  const code = A.src(A.S.stable); const m = code.match(re);
  if (!m) return { error: 'injection point not found in ' + A.S.stable };
  return A.runGeneration({ forcedEdits: [{ find: m[0], replace: replacement }], label }).then(r => r);
}
// Bug injections bypass the gate on purpose: they simulate a bad deploy that already shipped.
const _run = A.runGeneration;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  try {
    if (req.method === 'GET') {
      if (p === '/' || p === '/play') return file(res, new URL('public/play.html', root));
      if (p === '/control') return file(res, new URL('public/control.html', root));
      if (p === '/api/assign') {
        const pid = u.searchParams.get('pid') || Math.random();
        const v = A.S.canary && hash(pid) < A.S.canaryShare ? A.S.canary : A.S.stable;
        return send(res, 200, { v, theme: A.currentTheme(), themeId: A.S.theme, summary: A.S.versions[v]?.summary || '' });
      }
      let m = p.match(/^\/v\/(v\d+)\/game\.js$/);
      if (m) return file(res, new URL(`versions/${m[1]}/game.js`, root));
      if (p === '/api/state') return send(res, 200, A.snapshot());
      if (p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        const off = A.onEvent(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => { off(); clearInterval(ping); });
        return;
      }
      if (p.startsWith('/public/') || p === '/target.webp') return file(res, new URL('public/' + p.replace(/^\/(public\/)?/, '').replace(/\.\./g, ''), root));
      return send(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST') {
      const b = await body(req);
      if (p === '/api/t') { for (const ev of [].concat(b)) A.ingest(ev); return send(res, 200, { ok: true }); }
      if (ADMIN && b.admin !== ADMIN) return send(res, 403, { error: 'admin only' });
      if (p === '/api/goal') { if (A.GOALS[b.goal]) { A.S.goal = b.goal; A.emit('goal', `Goal set: ${A.GOALS[b.goal].label}`); } return send(res, 200, { goal: A.S.goal }); }
      if (p === '/api/gen') { A.runGeneration(); return send(res, 200, { started: true }); }
      if (p === '/api/learn') { A.learn(); return send(res, 200, { started: true }); }
      if (p === '/api/autopilot') { A.S.autopilot = !!b.on; A.emit('goal', `Autopilot ${A.S.autopilot ? 'ON' : 'OFF'}`); if (A.S.autopilot) A.autopilotTick(); return send(res, 200, { autopilot: A.S.autopilot }); }
      if (p === '/api/canary') { if (b.share != null) A.S.canaryShare = Math.max(0, Math.min(1, b.share)); if (b.ms) A.S.canaryMs = Math.max(3000, Math.min(120000, b.ms)); return send(res, 200, { share: A.S.canaryShare, ms: A.S.canaryMs }); }
      let m = p.match(/^\/api\/playbook\/(\w+)$/);
      if (m && PLAYBOOKS[m[1]]) {
        const pb = PLAYBOOKS[m[1]];
        A.emit('playbook', `Playbook: ${pb.label}`);
        if (m[1] === 'crash' || m[1] === 'annoy') return send(res, 200, await shipBad(m[1]));
        const r = await pb.run(); return send(res, 200, r || { ok: true });
      }
      if (p === '/api/style/propose') { const r = await A.proposeTheme(b.screenshot, targetDataUrl()); return send(res, 200, r); }
      if (p === '/api/style/judge') { const r = await A.judgeTheme(targetDataUrl(), b.current, b.candidate, b.theme, b.why); return send(res, 200, r); }
      return send(res, 404, { error: 'not found' });
    }
    send(res, 405, { error: 'method' });
  } catch (e) { A.emit('error', `${p}: ${e.message}`); send(res, 500, { error: e.message }); }
});

// A "bad deploy" ships straight to stable, skipping the gate, to give the agent something real to fix.
async function shipBad(kind) {
  const code = A.src(A.S.stable);
  const spec = kind === 'crash'
    ? [/if \(k\.kind === 'coin'\) \{ st\.coins\+\+;/, "if (k.kind === 'coin') { st.coin.count++;", 'Bad deploy: coin pickup crashes (injected by playbook)']
    : [/enemySpeed: [\d.]+,/, 'enemySpeed: 3.2,', 'Bad tuning: slimes far too fast (injected by playbook)'];
  const m = code.match(spec[0]); if (!m) return { error: 'injection point not found' };
  const bad = A.applyEdits(code, [{ find: m[0], replace: spec[1] }]);
  const { writeFileSync, mkdirSync } = await import('node:fs');
  let n = 1; while (existsSync(new URL(`versions/v${n}/`, root))) n++;
  const id = `v${n}`; mkdirSync(new URL(`versions/${id}/`, root), { recursive: true });
  writeFileSync(new URL(`versions/${id}/game.js`, root), bad);
  A.S.versions[A.S.stable].status = 'retired';
  A.S.versions[id] = { id, parent: A.S.stable, created: Date.now(), status: 'stable', summary: spec[2], injected: true };
  A.S.stable = id; A.S.canary = null;
  A.emit('deploy', `${id} shipped to everyone: ${spec[2]}`, { id });
  return { id };
}

setInterval(() => A.autopilotTick().catch(() => {}), 5000);
server.listen(PORT, () => console.log(`Patchwork on http://localhost:${PORT}  (control room: /control)`));
