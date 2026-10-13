// Fila de envio: manda uma mensagem por vez, com intervalo aleatório entre elas.
import { db } from './db.js';
import { getSettings } from './settings.js';
import { zapi } from './zapi.js';

const queue = [];
let busy = false;

export function enqueue(draftId) {
  if (!queue.includes(draftId)) queue.push(draftId);
  processQueue();
}

// Ao iniciar o servidor, retoma o que ficou na fila
export function resumeQueue() {
  for (const { id } of db.prepare("SELECT id FROM drafts WHERE status = 'queued' ORDER BY id").all()) enqueue(id);
}

export function queueSize() {
  return queue.length + (busy ? 1 : 0);
}

async function processQueue() {
  if (busy) return;
  busy = true;
  try {
    let first = true;
    while (queue.length) {
      const id = queue.shift();
      if (!first) await sleep(randomDelayMs());
      first = false;
      await sendDraft(id);
    }
  } finally {
    busy = false;
  }
}

async function sendDraft(id) {
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
  if (!draft || draft.status !== 'queued') return;

  // Se o lead respondeu depois que a mensagem foi gerada, não envia
  const reply = db.prepare('SELECT MAX(ts) AS ts FROM messages WHERE phone = ? AND from_me = 0').get(draft.phone);
  if (reply?.ts && reply.ts > draft.created_at) {
    db.prepare("UPDATE drafts SET status = 'rejected', error = ? WHERE id = ?").run('O lead respondeu antes do envio', id);
    return;
  }

  try {
    const res = await zapi.sendText(draft.phone, draft.message);
    const messageId = res?.messageId || res?.zaapId || res?.id || `agent-${id}`;
    const now = Date.now();
    db.prepare("UPDATE drafts SET status = 'sent', sent_at = ?, zapi_message_id = ?, error = NULL WHERE id = ?").run(now, String(messageId), id);
    // Registra no histórico (o webhook pode trazer a mesma mensagem depois; o ID evita duplicar)
    db.prepare('INSERT OR IGNORE INTO messages (id, phone, from_me, text, ts) VALUES (?, ?, 1, ?, ?)').run(
      String(messageId),
      draft.phone,
      draft.message,
      now,
    );

    if (draft.kind === 'closing') {
      const { moveToCold } = await import('./agent.js');
      try {
        await moveToCold(draft.phone);
      } catch (err) {
        db.prepare('UPDATE drafts SET error = ? WHERE id = ?').run(err.message, id);
      }
    }
  } catch (err) {
    db.prepare("UPDATE drafts SET status = 'error', error = ? WHERE id = ?").run(err.message, id);
  }
}

function randomDelayMs() {
  const s = getSettings();
  const min = Math.max(0, Number(s.sendDelayMinSec) || 0);
  const max = Math.max(min, Number(s.sendDelayMaxSec) || 0);
  return (min + Math.random() * (max - min)) * 1000;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
