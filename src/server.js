import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { getPublicSettings, saveSettings } from './settings.js';
import { runAgent, isRunning, saveMessage, syncTaggedContacts } from './agent.js';
import { enqueue, resumeQueue, queueSize } from './sender.js';
import { reschedule, cronExpression } from './scheduler.js';
import { zapi } from './zapi.js';

const PORT = Number(process.env.PORT || 3000);
const PANEL_PASSWORD = process.env.PANEL_PASSWORD;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!PANEL_PASSWORD || !WEBHOOK_SECRET) {
  console.error('Defina PANEL_PASSWORD e WEBHOOK_SECRET nas variáveis de ambiente (veja .env.example).');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------------------
// Webhook da Z-API (mensagens recebidas e enviadas)
// ---------------------------------------------------------------------------
app.post('/webhook/:secret', (req, res) => {
  if (!safeEqual(req.params.secret, WEBHOOK_SECRET)) return res.sendStatus(404);
  try {
    saveMessage(req.body);
  } catch (err) {
    console.error('Webhook: erro ao salvar mensagem:', err.message);
  }
  res.sendStatus(200);
});

// ---------------------------------------------------------------------------
// Autenticação do painel (cookie assinado)
// ---------------------------------------------------------------------------
const SESSION_KEY = crypto.createHash('sha256').update('session:' + PANEL_PASSWORD).digest();
const sessionToken = () => crypto.createHmac('sha256', SESSION_KEY).update('painel').digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function isLogged(req) {
  const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('session='));
  return cookie ? safeEqual(cookie.slice(8), sessionToken()) : false;
}

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (!safeEqual(req.body?.password || '', PANEL_PASSWORD)) return res.redirect('/login.html?erro=1');
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `session=${sessionToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`);
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.redirect('/login.html');
});

app.get('/login.html', (req, res) => res.sendFile(path.join(here, '../public/login.html')));

app.use((req, res, next) => {
  if (isLogged(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado' });
  res.redirect('/login.html');
});

app.use(express.static(path.join(here, '../public')));

// ---------------------------------------------------------------------------
// API do painel
// ---------------------------------------------------------------------------
const api = express.Router();
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => res.status(400).json({ error: err.message }));

api.get('/status', (req, res) => {
  const lastRun = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get();
  const counts = db.prepare("SELECT status, COUNT(*) AS n FROM drafts GROUP BY status").all();
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    webhookUrl: `${base.replace(/\/$/, '')}/webhook/${WEBHOOK_SECRET}`,
    cron: cronExpression(),
    lastRun,
    running: isRunning(),
    queue: queueSize(),
    drafts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    contactsInFollowup: db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE in_followup = 1 AND status = 'active'").get().n,
    messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
  });
});

api.get('/settings', (req, res) => res.json(getPublicSettings()));
api.put('/settings', wrap((req, res) => {
  saveSettings(req.body || {});
  reschedule();
  res.json(getPublicSettings());
}));

api.post('/test-zapi', wrap(async (req, res) => res.json(await zapi.status())));

api.post('/run', wrap(async (req, res) => {
  if (isRunning()) throw new Error('O agente já está em execução.');
  // Executa em segundo plano; o painel acompanha pelo histórico de execuções
  runAgent('manual').catch((err) => console.error(err));
  res.json({ ok: true });
}));

api.post('/sync', wrap(async (req, res) => {
  const lines = [];
  const result = await syncTaggedContacts((m) => lines.push(m));
  res.json({ ...result, log: lines });
}));

api.get('/runs', (req, res) => {
  res.json(db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 30').all());
});

// Rascunhos / aprovações
const DRAFT_SELECT = `
  SELECT d.*, c.name AS contact_name FROM drafts d LEFT JOIN contacts c ON c.phone = d.phone`;

api.get('/drafts', (req, res) => {
  const status = String(req.query.status || 'pending').split(',');
  const marks = status.map(() => '?').join(',');
  res.json(db.prepare(`${DRAFT_SELECT} WHERE d.status IN (${marks}) ORDER BY d.id DESC LIMIT 200`).all(...status));
});

function getPendingDraft(id) {
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(id));
  if (!draft) throw new Error('Mensagem não encontrada');
  if (draft.status !== 'pending') throw new Error('Esta mensagem não está mais pendente');
  return draft;
}

api.put('/drafts/:id', wrap((req, res) => {
  const draft = getPendingDraft(req.params.id);
  const message = String(req.body?.message || '').trim();
  if (!message) throw new Error('A mensagem não pode ficar vazia');
  db.prepare('UPDATE drafts SET message = ? WHERE id = ?').run(message, draft.id);
  res.json({ ok: true });
}));

function approve(draft, message) {
  const text = String(message ?? draft.message).trim();
  if (!text) throw new Error('A mensagem não pode ficar vazia');
  db.prepare("UPDATE drafts SET status = 'queued', message = ?, decided_at = ? WHERE id = ?").run(text, Date.now(), draft.id);
  enqueue(draft.id);
}

api.post('/drafts/:id/approve', wrap((req, res) => {
  approve(getPendingDraft(req.params.id), req.body?.message);
  res.json({ ok: true });
}));

api.post('/drafts/:id/reject', wrap((req, res) => {
  const draft = getPendingDraft(req.params.id);
  db.prepare("UPDATE drafts SET status = 'rejected', decided_at = ? WHERE id = ?").run(Date.now(), draft.id);
  res.json({ ok: true });
}));

api.post('/drafts/approve-all', wrap((req, res) => {
  const pending = db.prepare("SELECT * FROM drafts WHERE status = 'pending' ORDER BY id").all();
  for (const draft of pending) approve(draft);
  res.json({ ok: true, count: pending.length });
}));

api.post('/drafts/:id/retry', wrap((req, res) => {
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(req.params.id));
  if (!draft || draft.status !== 'error') throw new Error('Só é possível reenviar mensagens com erro');
  db.prepare("UPDATE drafts SET status = 'queued', error = NULL WHERE id = ?").run(draft.id);
  enqueue(draft.id);
  res.json({ ok: true });
}));

// Contatos
api.get('/contacts', (req, res) => {
  res.json(
    db.prepare(`
      SELECT c.*,
        (SELECT MAX(ts) FROM messages m WHERE m.phone = c.phone) AS last_ts,
        (SELECT from_me FROM messages m WHERE m.phone = c.phone ORDER BY ts DESC LIMIT 1) AS last_from_me,
        (SELECT COUNT(*) FROM drafts d WHERE d.phone = c.phone AND d.status = 'sent'
           AND d.sent_at > COALESCE((SELECT MAX(ts) FROM messages m WHERE m.phone = c.phone AND m.from_me = 0), 0)) AS followups
      FROM contacts c
      WHERE c.in_followup = 1 OR c.status = 'cold'
      ORDER BY c.status, last_ts DESC
    `).all(),
  );
});

api.post('/contacts', wrap((req, res) => {
  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  if (phone.length < 10) throw new Error('Informe o telefone com DDI e DDD, ex.: 5511999999999');
  const name = String(req.body?.name || '').trim() || null;
  db.prepare(`
    INSERT INTO contacts (phone, name, in_followup, source, status, updated_at) VALUES (?, ?, 1, 'manual', 'active', ?)
    ON CONFLICT(phone) DO UPDATE SET in_followup = 1, source = 'manual', status = 'active',
      name = COALESCE(excluded.name, contacts.name), updated_at = excluded.updated_at
  `).run(phone, name, Date.now());
  res.json({ ok: true });
}));

api.post('/contacts/:phone/reactivate', wrap((req, res) => {
  db.prepare("UPDATE contacts SET status = 'active', in_followup = 1, source = 'manual', updated_at = ? WHERE phone = ?").run(
    Date.now(),
    req.params.phone,
  );
  res.json({ ok: true });
}));

api.delete('/contacts/:phone', wrap((req, res) => {
  db.prepare('UPDATE contacts SET in_followup = 0, updated_at = ? WHERE phone = ?').run(Date.now(), req.params.phone);
  res.json({ ok: true });
}));

api.get('/contacts/:phone/messages', (req, res) => {
  res.json(
    db.prepare('SELECT * FROM (SELECT * FROM messages WHERE phone = ? ORDER BY ts DESC LIMIT 100) ORDER BY ts ASC').all(
      req.params.phone,
    ),
  );
});

app.use('/api', api);

app.listen(PORT, () => {
  console.log(`Painel em http://localhost:${PORT}`);
  reschedule();
  resumeQueue();
});
