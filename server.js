import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  PORT = 8787,
  MODEL = 'gpt-5-mini',
  SYSTEM_PROMPT = 'You are a concise assistant.',
  OPENAI_BASE_URL = 'https://oa.api2d.net',
  OPENAI_API_PATH = '/v1/chat/completions',
  OPENAI_API_KEY,
  API_KEY_HEADER = 'Authorization',
  API_KEY_PREFIX = 'Bearer'
} = process.env;

const isResponsesApi = /\/responses\b/i.test(OPENAI_API_PATH);

if (!OPENAI_API_KEY) {
  console.error('[FATAL] OPENAI_API_KEY is required.');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');

const app = express();
app.use(express.json());
app.use(express.static(distDir));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.post('/api/chat', async (req, res) => {
  try {
    const userText = (req.body?.text ?? '').toString();
    const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];

    const normalizeMessage = (msg) => {
      if (!msg || typeof msg !== 'object') return undefined;
      const roleInput = typeof msg.role === 'string' ? msg.role.toLowerCase() : 'user';
      const role = roleInput === 'assistant' || roleInput === 'system' ? roleInput : 'user';
      const content = msg.content;
      if (Array.isArray(content)) {
        return { role, content };
      }
      if (typeof content === 'string') {
        return { role, content };
      }
      if (content === null || typeof content === 'undefined') {
        return { role, content: '' };
      }
      try {
        return { role, content: JSON.stringify(content) };
      } catch {
        return { role, content: String(content) };
      }
    };

    const sanitizedHistory = rawHistory.map(normalizeMessage).filter(Boolean);

    const conversation = sanitizedHistory.length
      ? sanitizedHistory
      : userText
      ? [normalizeMessage({ role: 'user', content: userText })]
      : [];

    const systemEntry = normalizeMessage({ role: 'system', content: SYSTEM_PROMPT });
    const requestMessages = systemEntry ? [systemEntry, ...conversation] : conversation;

    const toResponsesMessage = (msg) => {
      if (!msg) return undefined;
      if (Array.isArray(msg.content)) {
        return { role: msg.role, content: msg.content };
      }
      return { role: msg.role, content: msg.content ?? '' };
    };

    const toChatMessage = (msg) => {
      if (!msg) return undefined;
      if (Array.isArray(msg.content)) {
        return { role: msg.role, content: msg.content };
      }
      return {
        role: msg.role,
        content: [{ type: 'text', text: msg.content ?? '' }]
      };
    };

    const formattedMessages = requestMessages
      .map(isResponsesApi ? toResponsesMessage : toChatMessage)
      .filter(Boolean);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const body = isResponsesApi
      ? {
          model: MODEL,
          input: formattedMessages,
          stream: true
        }
      : {
          model: MODEL,
          messages: formattedMessages,
          stream: true
        };

    const url = `${OPENAI_BASE_URL.replace(/\/+$/, '')}${OPENAI_API_PATH}`;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      [API_KEY_HEADER]: `${API_KEY_PREFIX ? `${API_KEY_PREFIX} ` : ''}${OPENAI_API_KEY}`
    };

    const upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!upstream.ok || !upstream.body) {
      const txt = await upstream.text().catch(() => '');
      res.write(`data: ${JSON.stringify({ error: { status: upstream.status, body: txt } })}\n\n`);
      return res.end();
    }

    const reader = upstream.body.getReader();

    const heartbeat = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch {
        /* ignored */
      }
    }, 30000);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }

    clearInterval(heartbeat);
    res.end();
  } catch (err) {
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
