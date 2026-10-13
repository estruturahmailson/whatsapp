import { db } from './db.js';
import { getSettings } from './settings.js';
import { zapi, findTagByName, describeMessage } from './zapi.js';
import { generateFollowup } from './ai.js';
import { enqueue } from './sender.js';

const HOUR = 3600 * 1000;

/**
 * Decide, sem IA, se um contato precisa de follow-up agora.
 * Função pura para facilitar testes.
 *
 * @param {object} p
 * @param {{from_me:number, ts:number}|undefined} p.lastMessage  última mensagem da conversa
 * @param {number|null} p.lastInboundTs  horário da última mensagem do lead
 * @param {number[]} p.sentFollowupTs    horários dos follow-ups já enviados pelo agente
 * @param {boolean} p.hasPendingDraft
 * @param {number} p.daysWithoutReply
 * @param {number} p.maxFollowups
 * @param {number} p.now
 */
export function decide({ lastMessage, lastInboundTs, sentFollowupTs, hasPendingDraft, daysWithoutReply, maxFollowups, now }) {
  if (hasPendingDraft) return { action: 'skip', reason: 'Já existe mensagem aguardando aprovação' };
  if (!lastMessage) return { action: 'skip', reason: 'Sem histórico de conversa (o webhook ainda não registrou mensagens)' };
  if (!lastMessage.from_me) return { action: 'skip', reason: 'A última mensagem é do lead (aguardando sua resposta)' };

  const hoursSilent = (now - lastMessage.ts) / HOUR;
  if (hoursSilent < daysWithoutReply * 24) {
    return { action: 'skip', reason: `Última mensagem há ${Math.round(hoursSilent)}h (mínimo ${daysWithoutReply * 24}h)` };
  }

  // Follow-ups seguidos: os enviados depois da última resposta do lead
  const sinceReply = sentFollowupTs.filter((ts) => lastInboundTs == null || ts > lastInboundTs).length;
  const max = Math.max(1, Math.floor(maxFollowups));
  if (sinceReply >= max) return { action: 'skip', reason: 'Limite de follow-ups atingido' };

  const attempt = sinceReply + 1;
  return { action: attempt === max ? 'closing' : 'followup', attempt, hoursSilent };
}

// ---------------------------------------------------------------------------
// Sincronização da etiqueta "Acompanhamento" com a Z-API
// ---------------------------------------------------------------------------

function chatHasTag(chat, tagId) {
  const tags = chat.tags ?? chat.labels ?? chat.tagsIds;
  if (!Array.isArray(tags)) return null; // campo ausente: não dá para saber
  return tags.some((t) => String(typeof t === 'object' ? t.id ?? t.tagId : t) === String(tagId));
}

export async function syncTaggedContacts(log = console.log) {
  const s = getSettings();
  const tag = await findTagByName(s.followupTag);
  if (!tag) {
    log(`Etiqueta "${s.followupTag}" não encontrada na Z-API. Ela existe no WhatsApp Business?`);
    return { supported: false, count: 0 };
  }

  const tagged = new Map();
  let sawTagField = false;
  for (let page = 1; page <= 50; page++) {
    const chats = await zapi.listChats(page);
    const list = Array.isArray(chats) ? chats : chats?.chats || [];
    if (list.length === 0) break;
    for (const chat of list) {
      if (chat.isGroup || String(chat.phone || '').includes('-')) continue;
      const has = chatHasTag(chat, tag.id);
      if (has !== null) sawTagField = true;
      if (has) tagged.set(String(chat.phone), chat.name || null);
    }
  }

  if (!sawTagField) {
    log('A listagem de chats da Z-API não retornou etiquetas. Adicione os contatos manualmente pelo painel.');
    return { supported: false, count: 0 };
  }

  const now = Date.now();
  const upsert = db.prepare(`
    INSERT INTO contacts (phone, name, in_followup, source, status, updated_at)
    VALUES (?, ?, 1, 'zapi', 'active', ?)
    ON CONFLICT(phone) DO UPDATE SET
      name = COALESCE(excluded.name, contacts.name),
      in_followup = CASE WHEN contacts.status = 'cold' THEN contacts.in_followup ELSE 1 END,
      source = CASE WHEN contacts.source = 'manual' THEN 'manual' ELSE 'zapi' END,
      updated_at = excluded.updated_at
  `);
  for (const [phone, name] of tagged) upsert.run(phone, name, now);

  // Quem perdeu a etiqueta no WhatsApp sai do acompanhamento (cadastros manuais ficam)
  const current = db.prepare("SELECT phone FROM contacts WHERE in_followup = 1 AND source = 'zapi'").all();
  const remove = db.prepare('UPDATE contacts SET in_followup = 0, updated_at = ? WHERE phone = ?');
  for (const { phone } of current) if (!tagged.has(phone)) remove.run(now, phone);

  log(`Sincronização: ${tagged.size} contato(s) com a etiqueta "${s.followupTag}".`);
  return { supported: true, count: tagged.size };
}

// Tenta importar o histórico pela API quando ainda não temos mensagens daquele contato
async function importHistory(phone, log) {
  try {
    const data = await zapi.chatMessages(phone, 50);
    const list = Array.isArray(data) ? data : data?.messages || [];
    let n = 0;
    for (const m of list) {
      const saved = saveMessage({ ...m, phone: m.phone || phone });
      if (saved) n++;
    }
    if (n) log(`  Histórico importado da Z-API: ${n} mensagem(ns).`);
  } catch (err) {
    log(`  Não foi possível importar histórico pela Z-API: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Mensagens (webhook)
// ---------------------------------------------------------------------------

export function saveMessage(m) {
  if (!m || m.isGroup || m.isNewsletter || m.broadcast) return false;
  const phone = String(m.phone || '').replace(/\D/g, '');
  const id = m.messageId || m.id;
  const text = describeMessage(m);
  if (!phone || !id || text == null) return false;
  const ts = Number(m.momment || m.moment || m.timestamp || Date.now());
  const result = db
    .prepare('INSERT OR IGNORE INTO messages (id, phone, from_me, text, ts) VALUES (?, ?, ?, ?, ?)')
    .run(String(id), phone, m.fromMe ? 1 : 0, text, ts < 1e12 ? ts * 1000 : ts);

  // Garante o contato na base e atualiza o nome
  const name = m.fromMe ? null : m.senderName || m.chatName || null;
  db.prepare(`
    INSERT INTO contacts (phone, name, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET name = COALESCE(excluded.name, contacts.name)
  `).run(phone, name, Date.now());
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Execução diária
// ---------------------------------------------------------------------------

let running = false;
export const isRunning = () => running;

export async function runAgent(trigger = 'manual') {
  if (running) throw new Error('O agente já está em execução.');
  running = true;
  const lines = [];
  const log = (msg) => {
    lines.push(`[${new Date().toISOString()}] ${msg}`);
    console.log(msg);
  };
  const runId = db.prepare('INSERT INTO runs (trigger, started_at) VALUES (?, ?)').run(trigger, Date.now()).lastInsertRowid;
  const summary = { analyzed: 0, drafts: 0, skippedByAi: 0, errors: 0 };

  try {
    const s = getSettings();
    try {
      await syncTaggedContacts(log);
    } catch (err) {
      log(`Falha ao sincronizar etiquetas: ${err.message}`);
    }

    const contacts = db.prepare("SELECT * FROM contacts WHERE in_followup = 1 AND status = 'active'").all();
    log(`${contacts.length} contato(s) em acompanhamento.`);

    for (const contact of contacts) {
      summary.analyzed++;
      try {
        await processContact(contact, s, log, summary);
      } catch (err) {
        summary.errors++;
        log(`${label(contact)}: erro — ${err.message}`);
      }
    }
  } finally {
    running = false;
    db.prepare('UPDATE runs SET finished_at = ?, summary = ?, log = ? WHERE id = ?').run(
      Date.now(),
      JSON.stringify(summary),
      lines.join('\n'),
      runId,
    );
  }
  log(`Fim: ${JSON.stringify(summary)}`);
  return summary;
}

function label(c) {
  return c.name ? `${c.name} (${c.phone})` : c.phone;
}

async function processContact(contact, s, log, summary) {
  const countMessages = () => db.prepare('SELECT COUNT(*) AS n FROM messages WHERE phone = ?').get(contact.phone).n;
  if (countMessages() === 0) await importHistory(contact.phone, log);

  const lastMessage = db.prepare('SELECT * FROM messages WHERE phone = ? ORDER BY ts DESC LIMIT 1').get(contact.phone);
  const lastInbound = db.prepare('SELECT MAX(ts) AS ts FROM messages WHERE phone = ? AND from_me = 0').get(contact.phone);
  const sent = db.prepare("SELECT sent_at FROM drafts WHERE phone = ? AND status = 'sent'").all(contact.phone);
  const pending = db
    .prepare("SELECT COUNT(*) AS n FROM drafts WHERE phone = ? AND status IN ('pending', 'queued')")
    .get(contact.phone);

  const decision = decide({
    lastMessage,
    lastInboundTs: lastInbound?.ts ?? null,
    sentFollowupTs: sent.map((d) => d.sent_at),
    hasPendingDraft: pending.n > 0,
    daysWithoutReply: s.daysWithoutReply,
    maxFollowups: s.maxFollowups,
    now: Date.now(),
  });

  if (decision.action === 'skip') {
    log(`${label(contact)}: ignorado — ${decision.reason}`);
    return;
  }

  const history = db
    .prepare('SELECT * FROM (SELECT * FROM messages WHERE phone = ? ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC')
    .all(contact.phone, Math.max(10, s.historyLimit));

  const isClosing = decision.action === 'closing';
  const result = await generateFollowup({
    contact,
    messages: history,
    attempt: decision.attempt,
    maxFollowups: Math.max(1, Math.floor(s.maxFollowups)),
    isClosing,
    hoursSilent: decision.hoursSilent,
  });

  const kind = isClosing ? 'closing' : 'followup';
  if (!result.send) {
    summary.skippedByAi++;
    db.prepare(
      "INSERT INTO drafts (phone, kind, attempt, message, ai_reason, status, created_at) VALUES (?, ?, ?, '', ?, 'skipped', ?)",
    ).run(contact.phone, kind, decision.attempt, result.reason, Date.now());
    log(`${label(contact)}: IA sugeriu não enviar — ${result.reason}`);
    return;
  }

  const status = s.requireApproval ? 'pending' : 'queued';
  const draftId = db
    .prepare('INSERT INTO drafts (phone, kind, attempt, message, ai_reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(contact.phone, kind, decision.attempt, result.message, result.reason, status, Date.now()).lastInsertRowid;
  summary.drafts++;
  log(`${label(contact)}: ${isClosing ? 'encerramento' : `follow-up ${decision.attempt}`} gerado (${status === 'pending' ? 'aguardando aprovação' : 'na fila de envio'}).`);
  if (status === 'queued') enqueue(Number(draftId));
}

// ---------------------------------------------------------------------------
// Pós-envio: mensagem de encerramento move o lead para "Frio"
// ---------------------------------------------------------------------------

export async function moveToCold(phone) {
  const s = getSettings();
  db.prepare("UPDATE contacts SET status = 'cold', in_followup = 0, updated_at = ? WHERE phone = ?").run(Date.now(), phone);

  const errors = [];
  try {
    const followTag = await findTagByName(s.followupTag);
    if (followTag) await zapi.removeTag(phone, followTag.id);
  } catch (err) {
    errors.push(`remover "${s.followupTag}": ${err.message}`);
  }
  try {
    const coldTag = await findTagByName(s.coldTag);
    if (!coldTag) throw new Error('etiqueta não encontrada');
    await zapi.addTag(phone, coldTag.id);
  } catch (err) {
    errors.push(`adicionar "${s.coldTag}": ${err.message}`);
  }
  if (errors.length) throw new Error(`Falha ao trocar etiquetas — ${errors.join('; ')}`);
}
