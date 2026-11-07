// Minimal Meta Model API client (OpenAI-compatible). Key stays server-side.
import { readFileSync } from 'node:fs';

function loadEnv() {
  try {
    const txt = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const l of txt.split(/\r?\n/)) {
      const i = l.indexOf('='); if (i < 1) continue;
      const k = l.slice(0, i).trim(); if (!process.env[k]) process.env[k] = l.slice(i + 1).trim();
    }
  } catch {}
}
loadEnv();

const BASE = 'https://api.meta.ai/v1';
export const MODELS = {
  coder: process.env.CODER_MODEL || 'muse-wonder-1.0',
  fast: process.env.FAST_MODEL || 'muse-spark-1.3-contributor',
  vision: process.env.VISION_MODEL || 'muse-spark-1.3-contributor',
  image: 'muse-image-1.0'
};

export const usage = { calls: 0, inTok: 0, outTok: 0, ms: 0, byModel: {} };
const DAILY_CALL_CAP = Number(process.env.CALL_CAP || 3000);

export async function chat(model, messages, { json = true, temperature, timeoutMs = 90000, maxTokens } = {}) {
  if (usage.calls >= DAILY_CALL_CAP) throw new Error('call cap reached');
  const t = Date.now();
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const body = { model, messages };
    if (json) body.response_format = { type: 'json_object' };
    if (temperature != null) body.temperature = temperature;
    if (maxTokens) body.max_tokens = maxTokens;
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${model} ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    usage.calls++; usage.ms += Date.now() - t;
    usage.inTok += j.usage?.prompt_tokens || 0; usage.outTok += j.usage?.completion_tokens || 0;
    usage.byModel[model] = (usage.byModel[model] || 0) + 1;
    const txt = j.choices?.[0]?.message?.content ?? '';
    if (!json) return txt;
    return parseJson(txt);
  } finally { clearTimeout(to); }
}

export function parseJson(txt) {
  try { return JSON.parse(txt); } catch {}
  const m = String(txt).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw new Error('bad JSON from model: ' + String(txt).slice(0, 200));
}

// Vision: compare images. Images are data URLs.
export async function vision(prompt, images, opts) {
  const content = [{ type: 'text', text: prompt }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))];
  return chat(MODELS.vision, [{ role: 'user', content }], opts);
}

export async function generateImage(prompt) {
  const r = await fetch(`${BASE}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODELS.image, prompt, n: 1, size: '1024x1024' })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`image ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  const d = j.data?.[0];
  if (d?.b64_json) return 'data:image/png;base64,' + d.b64_json;
  if (d?.url) return d.url;
  throw new Error('no image in response');
}
