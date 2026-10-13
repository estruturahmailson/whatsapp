// Cliente mínimo da Z-API.
// Documentação: https://developer.z-api.io
import { getSettings } from './settings.js';

function credentials() {
  const s = getSettings();
  if (!s.zapiInstanceId || !s.zapiToken) {
    throw new Error('Credenciais da Z-API não configuradas (ID da instância e token).');
  }
  return s;
}

async function request(method, path, body) {
  const s = credentials();
  const base = process.env.ZAPI_BASE_URL || 'https://api.z-api.io';
  const url = `${base}/instances/${s.zapiInstanceId}/token/${s.zapiToken}/${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (s.zapiClientToken) headers['Client-Token'] = s.zapiClientToken;

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail = typeof data === 'string' ? data : JSON.stringify(data);
    throw new Error(`Z-API ${method} /${path} falhou (${res.status}): ${detail}`);
  }
  return data;
}

export const zapi = {
  status: () => request('GET', 'status'),

  sendText: (phone, message) => request('POST', 'send-text', { phone, message }),

  // Etiquetas (somente WhatsApp Business)
  listTags: () => request('GET', 'tags'),
  addTag: (phone, tagId) => request('PUT', `chats/${phone}/tags/${tagId}/add`),
  removeTag: (phone, tagId) => request('PUT', `chats/${phone}/tags/${tagId}/remove`),

  listChats: (page, pageSize = 100) => request('GET', `chats?page=${page}&pageSize=${pageSize}`),

  // Histórico de mensagens de um chat. Pode não estar disponível para todas as
  // conexões; por isso o histórico principal vem do webhook.
  chatMessages: (phone, amount = 50) => request('GET', `chat-messages/${phone}?amount=${amount}`),
};

export async function findTagByName(name) {
  const tags = await zapi.listTags();
  const list = Array.isArray(tags) ? tags : tags?.tags || [];
  const wanted = name.trim().toLowerCase();
  return list.find((t) => String(t.name || '').trim().toLowerCase() === wanted) || null;
}

// Extrai o texto de um payload de mensagem da Z-API (webhook ou histórico)
export function describeMessage(m) {
  if (m.text?.message) return m.text.message;
  if (typeof m.body === 'string' && m.body) return m.body;
  if (m.image) return `[imagem]${m.image.caption ? ' ' + m.image.caption : ''}`;
  if (m.video) return `[vídeo]${m.video.caption ? ' ' + m.video.caption : ''}`;
  if (m.audio) return '[áudio]';
  if (m.document) return `[documento] ${m.document.fileName || m.document.title || ''}`.trim();
  if (m.sticker) return '[figurinha]';
  if (m.location) return '[localização]';
  if (m.contact) return '[contato]';
  if (m.reaction) return `[reação ${m.reaction.value || ''}]`.trim();
  if (m.buttonsResponseMessage) return m.buttonsResponseMessage.message || '[resposta de botão]';
  if (m.listResponseMessage) return m.listResponseMessage.title || '[resposta de lista]';
  return null;
}
