const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) location.href = '/login.html';
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro inesperado');
  return data;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function action(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
  } catch (err) {
    toast(err.message);
  }
}

// --- Abas -------------------------------------------------------------------
const loaders = { aprovacoes: loadApprovals, contatos: loadContacts, config: loadSettings, execucoes: loadRuns };
document.querySelectorAll('nav button').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('main > section').forEach((s) => (s.hidden = s.id !== 'tab-' + btn.dataset.tab));
    loaders[btn.dataset.tab]();
  }),
);

// --- Aprovações -------------------------------------------------------------
async function loadApprovals() {
  const [status, drafts, history] = await Promise.all([
    api('/status'),
    api('/drafts?status=pending'),
    api('/drafts?status=sent,queued,rejected,skipped,error'),
  ]);

  const [min, hour, , , days] = status.cron.split(' ');
  const dayNames = days === '*' ? 'todos os dias' : days.split(',').map((d) => DAYS[d]).join(', ');
  $('#schedule-info').textContent =
    `Análise automática às ${hour.padStart(2, '0')}:${min.padStart(2, '0')} (${dayNames}).` +
    (status.running ? ' Executando agora…' : status.lastRun ? ` Última: ${fmtDate(status.lastRun.started_at)}.` : '');

  $('#stats').innerHTML = [
    ['Aguardando aprovação', status.drafts.pending || 0],
    ['Na fila de envio', status.queue],
    ['Contatos em acompanhamento', status.contactsInFollowup],
    ['Mensagens registradas', status.messages],
  ]
    .map(([label, n]) => `<div class="card stat"><span class="muted small">${label}</span><strong>${n}</strong></div>`)
    .join('');

  const warn = status.messages === 0
    ? `<div class="card warn">Nenhuma mensagem registrada ainda. Configure o webhook da Z-API (aba Configurações) para o agente conseguir ler o histórico das conversas.</div>`
    : '';

  $('#drafts').innerHTML =
    warn +
    (drafts.length
      ? drafts.map(draftCard).join('')
      : '<div class="card muted">Nenhuma mensagem pendente. Clique em "Analisar agora" ou aguarde a análise diária.</div>');
  $('#btn-approve-all').disabled = drafts.length === 0;

  $('#history').innerHTML = history.length
    ? `<table><tr><th>Data</th><th>Contato</th><th>Tipo</th><th>Status</th><th>Mensagem</th></tr>${history
        .map(
          (d) => `<tr>
            <td>${fmtDate(d.sent_at || d.decided_at || d.created_at)}</td>
            <td>${esc(d.contact_name || d.phone)}</td>
            <td>${d.kind === 'closing' ? 'Encerramento' : `Follow-up ${d.attempt}`}</td>
            <td>${statusLabel(d)}${d.status === 'error' ? ` <button data-retry="${d.id}">Reenviar</button>` : ''}</td>
            <td>${esc(d.message || d.ai_reason)}${d.error ? `<div class="error small">${esc(d.error)}</div>` : ''}</td>
          </tr>`,
        )
        .join('')}</table>`
    : '<p class="muted">Nada por aqui ainda.</p>';
}

function statusLabel(d) {
  return { sent: 'Enviada', queued: 'Na fila', rejected: 'Descartada', skipped: 'IA não enviou', error: 'Erro', pending: 'Pendente' }[d.status] || d.status;
}

function draftCard(d) {
  const kind = d.kind === 'closing'
    ? `<span class="chip">Encerramento · move para a etiqueta de encerramento</span>`
    : `<span class="chip">Follow-up ${d.attempt}</span>`;
  return `<div class="card" data-draft="${d.id}">
    <div class="row spread">
      <div><strong>${esc(d.contact_name || d.phone)}</strong> <span class="muted small">${esc(d.phone)}</span></div>
      ${kind}
    </div>
    <details data-chat="${esc(d.phone)}"><summary class="muted small">Ver conversa</summary><div class="chat"></div></details>
    <label>Mensagem
      <textarea rows="3">${esc(d.message)}</textarea>
    </label>
    <p class="muted small">Por que esta mensagem: ${esc(d.ai_reason)}</p>
    <div class="row" style="justify-content:flex-end">
      <button class="danger" data-reject="${d.id}">Descartar</button>
      <button class="primary" data-approve="${d.id}">Aprovar e enviar</button>
    </div>
  </div>`;
}

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.dataset.approve) {
    const message = t.closest('[data-draft]').querySelector('textarea').value;
    await action(() => api(`/drafts/${t.dataset.approve}/approve`, { method: 'POST', body: { message } }), 'Mensagem na fila de envio');
    loadApprovals();
  } else if (t.dataset.reject) {
    await action(() => api(`/drafts/${t.dataset.reject}/reject`, { method: 'POST' }), 'Mensagem descartada');
    loadApprovals();
  } else if (t.dataset.retry) {
    await action(() => api(`/drafts/${t.dataset.retry}/retry`, { method: 'POST' }), 'Reenviando');
    loadApprovals();
  } else if (t.dataset.remove) {
    if (!confirm('Tirar este contato do acompanhamento? Se ele ainda tiver a etiqueta no WhatsApp, volta na próxima sincronização.')) return;
    await action(() => api(`/contacts/${t.dataset.remove}`, { method: 'DELETE' }), 'Contato removido');
    loadContacts();
  } else if (t.dataset.reactivate) {
    await action(() => api(`/contacts/${t.dataset.reactivate}/reactivate`, { method: 'POST' }), 'Contato reativado');
    loadContacts();
  }
});

// Carrega a conversa ao abrir "Ver conversa"
document.addEventListener('toggle', async (e) => {
  const el = e.target;
  if (!el.dataset?.chat || !el.open) return;
  const messages = await api(`/contacts/${el.dataset.chat}/messages`);
  el.querySelector('.chat').innerHTML = messages.length
    ? messages
        .map((m) => `<div class="bubble ${m.from_me ? 'me' : 'lead'}">${esc(m.text)}<time>${fmtDate(m.ts)}</time></div>`)
        .join('')
    : '<p class="muted small">Sem mensagens registradas.</p>';
  const chat = el.querySelector('.chat');
  chat.scrollTop = chat.scrollHeight;
}, true);

$('#btn-approve-all').addEventListener('click', async () => {
  // Salva as edições feitas nos textos antes de aprovar todas
  const cards = [...document.querySelectorAll('[data-draft]')];
  if (!confirm(`Aprovar e enviar ${cards.length} mensagem(ns)?`)) return;
  await action(async () => {
    for (const card of cards) {
      await api(`/drafts/${card.dataset.draft}`, { method: 'PUT', body: { message: card.querySelector('textarea').value } });
    }
    await api('/drafts/approve-all', { method: 'POST' });
  }, 'Mensagens na fila de envio');
  loadApprovals();
});

$('#btn-run').addEventListener('click', async () => {
  await action(() => api('/run', { method: 'POST' }), 'Análise iniciada. Os rascunhos aparecem aqui em instantes.');
  setTimeout(loadApprovals, 1500);
});

// --- Contatos ---------------------------------------------------------------
async function loadContacts() {
  const contacts = await api('/contacts');
  $('#contacts').innerHTML = contacts.length
    ? `<table><tr><th>Contato</th><th>Origem</th><th>Última mensagem</th><th>Follow-ups seguidos</th><th></th></tr>${contacts
        .map(
          (c) => `<tr>
            <td><strong>${esc(c.name || '—')}</strong><div class="muted small">${esc(c.phone)}</div></td>
            <td>${c.status === 'cold' ? '<span class="chip">Frio</span>' : c.source === 'manual' ? 'Manual' : 'Etiqueta'}</td>
            <td>${c.last_ts ? `${fmtDate(c.last_ts)}<div class="muted small">${c.last_from_me ? 'Enviada por você' : 'Enviada pelo lead'}</div>` : '<span class="muted">Sem histórico</span>'}</td>
            <td>${c.followups}</td>
            <td>${c.status === 'cold'
              ? `<button data-reactivate="${esc(c.phone)}">Reativar</button>`
              : `<button class="danger" data-remove="${esc(c.phone)}">Remover</button>`}</td>
          </tr>`,
        )
        .join('')}</table>`
    : '<p class="muted">Nenhum contato em acompanhamento.</p>';
}

$('#form-contact').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  await action(() => api('/contacts', { method: 'POST', body: { phone: form.phone.value, name: form.name.value } }), 'Contato adicionado');
  form.reset();
  loadContacts();
});

$('#btn-sync').addEventListener('click', () =>
  action(async () => {
    const r = await api('/sync', { method: 'POST' });
    toast(r.log.join(' '));
    loadContacts();
  }),
);

// --- Configurações ----------------------------------------------------------
$('#run-days').innerHTML = DAYS.map(
  (d, i) => `<label><input type="checkbox" name="runDays" value="${i}"> ${d}</label>`,
).join('');

async function loadSettings() {
  const [s, status] = await Promise.all([api('/settings'), api('/status')]);
  const form = $('#form-settings');
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.name === 'runDays') el.checked = s.runDays.includes(Number(el.value));
    else if (el.type === 'checkbox') el.checked = !!s[el.name];
    else if (el.type === 'password') {
      el.value = '';
      el.placeholder = s[el.name] || 'não configurado';
    } else el.value = s[el.name] ?? '';
  }
  $('#webhook-url').textContent = status.webhookUrl;
}

$('#form-settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = { runDays: [] };
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.name === 'runDays') {
      if (el.checked) body.runDays.push(Number(el.value));
    } else if (el.type === 'checkbox') body[el.name] = el.checked;
    else body[el.name] = el.value;
  }
  await action(() => api('/settings', { method: 'PUT', body }), 'Configurações salvas');
  loadSettings();
});

$('#btn-test-zapi').addEventListener('click', () =>
  action(async () => {
    const r = await api('/test-zapi', { method: 'POST' });
    toast(r.connected ? 'Z-API conectada ao WhatsApp' : `Resposta da Z-API: ${JSON.stringify(r)}`);
  }),
);

// --- Execuções --------------------------------------------------------------
async function loadRuns() {
  const runs = await api('/runs');
  $('#runs').innerHTML = runs.length
    ? runs
        .map((r) => {
          const s = r.summary ? JSON.parse(r.summary) : null;
          return `<div class="card">
            <div class="row spread">
              <strong>${fmtDate(r.started_at)} <span class="chip">${esc(r.trigger)}</span></strong>
              <span class="muted small">${s ? `${s.analyzed} analisados · ${s.drafts} mensagens · ${s.skippedByAi} sem envio (IA) · ${s.errors} erros` : 'em andamento…'}</span>
            </div>
            <details><summary class="muted small">Ver log</summary><pre class="log">${esc(r.log || '')}</pre></details>
          </div>`;
        })
        .join('')
    : '<div class="card muted">Nenhuma execução ainda.</div>';
}

loadApprovals();
