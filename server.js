import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  PORT = 8787,
  MODEL = 'gemini-2.5-pro',
  SYSTEM_PROMPT = 'You are a concise assistant.',
  OPENAI_API_KEY
} = process.env;

const OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com';
const OPENAI_API_PATH = `/v1beta/models/${MODEL}:streamGenerateContent`;

if (!OPENAI_API_KEY) {
  console.error('[FATAL] OPENAI_API_KEY is required.');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');
const soulPath = path.join(__dirname, 'SOUL.md');

const effectiveSystemPrompt = (() => {
  try {
    return fs.readFileSync(soulPath, 'utf8').trim();
  } catch {
    return SYSTEM_PROMPT;
  }
})();

const app = express();
app.use(express.json());
app.use(express.static(distDir));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.post('/api/chat', async (req, res) => {
  try {
    const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
    
    const contents = rawHistory.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content || '' }],
    }));

    const body = {
      contents,
      systemInstruction: { parts: [{ text: effectiveSystemPrompt }] },
    };

    const url = `${OPENAI_BASE_URL}${OPENAI_API_PATH}?key=${OPENAI_API_KEY}&alt=sse`;
    const headers = { 'Content-Type': 'application/json' };

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const upstream = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

    if (!upstream.ok || !upstream.body) {
      const txt = await upstream.text().catch(() => '');
      console.error(`Upstream API Error: ${upstream.status}`, txt);
      res.write(`data: ${JSON.stringify({ error: { status: upstream.status, body: txt } })}\n\n`);
      return res.end();
    }
    
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const geminiChunk = JSON.parse(line.substring(6));
          const text = geminiChunk?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            // This is the crucial translation step.
            const openAiChunk = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: MODEL,
              choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(openAiChunk)}\n\n`);
          }
        } catch (e) {
          console.warn('Could not parse JSON from stream, skipping line:', line);
        }
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    console.error('Error in /api/chat proxy:', err);
    res.write(`data: ${JSON.stringify({ error: { message: err?.message || 'proxy error' } })}\n\n`);
    res.end();
  }
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(distDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Mini Chat running: http://0.0.0.0:${PORT}`);
});
