// Pocket Survival AI relay (Cloudflare Worker)
// Keeps your Groq API key secret and lets the game on GitHub Pages use it.
// Setup: paste this whole file into a Cloudflare Worker, then add a secret
// named GROQ_KEY (Settings > Variables and Secrets) with your Groq API key.

const ALLOWED_ORIGINS = [
  'https://bonesk8er5-lab.github.io',
];
// Best model first. If one is out of free quota, the next one is tried.
const MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
const MAX_PROMPT = 6000;          // characters
const PER_IP_PER_MINUTE = 8;      // soft limit per player

const hits = new Map(); // per-instance soft rate limit

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const okOrigin = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return new Response('Pocket Survival AI relay is running.', { headers: cors });
    if (!okOrigin) return json({ error: 'forbidden' }, 403);
    if (!env.GROQ_KEY) return json({ error: 'GROQ_KEY secret is not set' }, 500);

    // soft per-IP limit
    const ip = req.headers.get('CF-Connecting-IP') || 'x';
    const now = Date.now();
    const list = (hits.get(ip) || []).filter(t => now - t < 60000);
    if (list.length >= PER_IP_PER_MINUTE) return json({ error: 'slow down' }, 429);
    list.push(now); hits.set(ip, list);
    if (hits.size > 5000) hits.clear();

    let body;
    try { body = await req.json(); } catch { return json({ error: 'bad request' }, 400); }
    const prompt = String(body.prompt || '').slice(0, MAX_PROMPT);
    const wantJson = !!body.json;
    if (!prompt) return json({ error: 'empty prompt' }, 400);

    for (const model of MODELS) {
      try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + env.GROQ_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: wantJson ? 450 : 200,
            temperature: 0.85,
            ...(wantJson ? { response_format: { type: 'json_object' } } : {}),
          }),
        });
        if (r.ok) {
          const j = await r.json();
          const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
          if (text) return json({ text, model });
        } else if (r.status !== 429 && r.status < 500 && r.status !== 404 && r.status !== 400) {
          break; // auth or other hard error: don't keep trying
        }
      } catch (e) { /* try next model */ }
    }
    return json({ error: 'busy' }, 503);
  },
};
