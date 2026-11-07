// Go/no-go spike: list models, time a text call and a JSON call.
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const KEY = env.MODEL_API_KEY;
const BASE = 'https://api.meta.ai/v1';
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const m = await fetch(`${BASE}/models`, { headers: H });
const mj = await m.json().catch(() => ({}));
console.log('models', m.status, (mj.data || []).map(x => x.id).join(', ') || JSON.stringify(mj).slice(0, 300));

for (const model of process.argv.slice(2)) {
  const t = Date.now();
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      model, response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: 'Return JSON {"patch":{"find":"speed = 2","replace":"speed = 3"},"why":"short"} for making a player faster.' }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  console.log(model, r.status, Date.now() - t, 'ms', JSON.stringify(j.choices?.[0]?.message?.content ?? j).slice(0, 200));
}
