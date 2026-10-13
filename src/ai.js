import Anthropic from '@anthropic-ai/sdk';
import { getSettings } from './settings.js';

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    acao: { type: 'string', enum: ['enviar', 'nao_enviar'] },
    mensagem: { type: 'string' },
    motivo: { type: 'string' },
  },
  required: ['acao', 'mensagem', 'motivo'],
  additionalProperties: false,
};

function buildSystemPrompt(s) {
  return `Você escreve mensagens de follow-up no WhatsApp em nome de uma empresa, para reativar leads que pararam de responder.

## Sobre a empresa
${s.businessDescription || '(não informado)'}

## Tom de voz
${s.toneOfVoice || '(não informado)'}

## Como escrever
- Leia o histórico e retome o ponto exato onde a conversa parou (proposta, orçamento, dúvida, agendamento etc.).
- Escreva como uma pessoa real no WhatsApp: curta (1 a 3 frases), natural, em português do Brasil, sem formalidade excessiva.
- Não repita nem parafraseie follow-ups anteriores; varie a abordagem (uma pergunta simples, uma novidade útil, uma alternativa, facilitar o próximo passo).
- Não invente preços, prazos, promoções ou informações que não estejam no histórico ou na descrição da empresa.
- Não mencione que a mensagem é automática nem que o lead "sumiu" ou "não respondeu" de forma acusatória.
- Use o primeiro nome do lead quando souber. Emojis com moderação, só se combinar com o tom da conversa.
- Mensagem de encerramento: avise com gentileza que vai parar de entrar em contato e deixe a porta aberta para o lead chamar quando quiser.

## Quando não enviar
Responda com acao "nao_enviar" (e mensagem vazia) se o histórico mostrar que o lead já recusou, pediu para não ser contatado, já fechou negócio, ou se outra mensagem agora seria inadequada. Explique o motivo em "motivo".
${s.extraInstructions ? `\n## Instruções adicionais\n${s.extraInstructions}\n` : ''}`;
}

function formatTranscript(messages, leadName) {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: getSettings().timezone,
  });
  return messages
    .map((m) => `[${fmt.format(new Date(m.ts))}] ${m.from_me ? 'Empresa' : leadName || 'Lead'}: ${m.text || '[mensagem]'}`)
    .join('\n');
}

export async function generateFollowup({ contact, messages, attempt, maxFollowups, isClosing, hoursSilent }) {
  const s = getSettings();
  const apiKey = s.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Chave da API da Anthropic não configurada.');
  const client = new Anthropic({ apiKey });

  const days = Math.floor(hoursSilent / 24);
  const silence = days >= 1 ? `${days} dia(s)` : `${Math.round(hoursSilent)} hora(s)`;
  const task = isClosing
    ? `Esta é a mensagem de ENCERRAMENTO (tentativa ${attempt} de ${maxFollowups}). Escreva uma mensagem educada avisando que você não vai mais entrar em contato por enquanto, retomando brevemente o assunto da conversa e deixando claro que o lead pode chamar quando quiser.`
    : `Esta é a tentativa de reativação ${attempt} de ${maxFollowups} (a última será uma mensagem de encerramento). Escreva a próxima mensagem de follow-up.`;

  const userContent = `Lead: ${contact.name || '(nome desconhecido)'} — telefone ${contact.phone}
A última mensagem da empresa foi enviada há ${silence}, sem resposta do lead.

${task}

<historico>
${formatTranscript(messages, contact.name)}
</historico>`;

  const response = await client.beta.messages.create({
    model: s.claudeModel || 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
    system: buildSystemPrompt(s),
    messages: [{ role: 'user', content: userContent }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`A IA recusou gerar a mensagem (${response.stop_details?.category || 'sem categoria'}).`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Resposta da IA cortada (max_tokens).');
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = JSON.parse(text);
  return {
    send: parsed.acao === 'enviar' && parsed.mensagem.trim() !== '',
    message: parsed.mensagem.trim(),
    reason: parsed.motivo,
  };
}
