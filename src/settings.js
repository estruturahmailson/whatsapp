import { db } from './db.js';

// Valores padrão. Tudo pode ser alterado pelo painel.
export const DEFAULTS = {
  // Regras de follow-up
  daysWithoutReply: 1,          // dias desde a sua última mensagem sem resposta do lead
  maxFollowups: 5,              // follow-ups seguidos sem resposta; o último é a mensagem de encerramento
  followupTag: 'Acompanhamento',
  coldTag: 'Frio',
  requireApproval: true,        // gera rascunhos para aprovação no painel antes de enviar

  // Agendamento
  runTime: '09:00',             // horário da análise diária (HH:MM)
  runDays: [1, 2, 3, 4, 5, 6],  // 0 = domingo ... 6 = sábado
  timezone: 'America/Sao_Paulo',

  // Envio
  sendDelayMinSec: 20,          // intervalo aleatório entre envios, para não parecer robô
  sendDelayMaxSec: 60,

  // Contexto para a IA
  businessDescription: '',
  toneOfVoice: 'Cordial, próximo e objetivo. Mensagens curtas, como uma pessoa real escreveria no WhatsApp.',
  extraInstructions: '',
  historyLimit: 60,             // quantas mensagens recentes enviar para a IA

  // Credenciais (opcional: podem vir de variáveis de ambiente)
  zapiInstanceId: '',
  zapiToken: '',
  zapiClientToken: '',
  anthropicApiKey: '',
  claudeModel: 'claude-opus-5-5',
};

export const SECRET_KEYS = ['zapiToken', 'zapiClientToken', 'anthropicApiKey'];

const ENV_MAP = {
  zapiInstanceId: 'ZAPI_INSTANCE_ID',
  zapiToken: 'ZAPI_TOKEN',
  zapiClientToken: 'ZAPI_CLIENT_TOKEN',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  const settings = { ...DEFAULTS, ...stored };
  for (const [key, env] of Object.entries(ENV_MAP)) {
    if (!settings[key] && process.env[env]) settings[key] = process.env[env];
  }
  return settings;
}

export function saveSettings(patch) {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) continue;
    // Campos secretos vazios no formulário significam "manter o valor atual"
    if (SECRET_KEYS.includes(key) && (value === '' || value == null)) continue;
    upsert.run(key, JSON.stringify(normalize(key, value)));
  }
  return getSettings();
}

function normalize(key, value) {
  const def = DEFAULTS[key];
  if (typeof def === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Valor inválido para ${key}`);
    return n;
  }
  if (typeof def === 'boolean') return Boolean(value);
  if (Array.isArray(def)) return (Array.isArray(value) ? value : []).map(Number);
  if (key === 'runTime' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) {
    throw new Error('Horário inválido, use HH:MM');
  }
  return String(value ?? '');
}

// Versão para o painel: segredos mascarados
export function getPublicSettings() {
  const s = getSettings();
  for (const key of SECRET_KEYS) s[key] = s[key] ? '••••' + String(s[key]).slice(-4) : '';
  return s;
}
