import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { decide } = await import('../src/agent.js');

const DAY = 24 * 3600 * 1000;
const now = Date.UTC(2026, 9, 13, 12);
const base = { hasPendingDraft: false, daysWithoutReply: 1, maxFollowups: 5, now, sentFollowupTs: [], lastInboundTs: now - 3 * DAY };

test('ignora quando a última mensagem é do lead', () => {
  const r = decide({ ...base, lastMessage: { from_me: 0, ts: now - 2 * DAY } });
  assert.equal(r.action, 'skip');
});

test('ignora antes de completar o prazo sem resposta', () => {
  const r = decide({ ...base, lastMessage: { from_me: 1, ts: now - 0.5 * DAY } });
  assert.equal(r.action, 'skip');
});

test('primeiro follow-up depois de 1 dia sem resposta', () => {
  const r = decide({ ...base, lastMessage: { from_me: 1, ts: now - 1.2 * DAY } });
  assert.equal(r.action, 'followup');
  assert.equal(r.attempt, 1);
});

test('a 5ª tentativa é a mensagem de encerramento', () => {
  const sent = [4, 3, 2, 1].map((d) => now - d * DAY - 1000);
  const r = decide({ ...base, lastInboundTs: now - 5 * DAY, sentFollowupTs: sent, lastMessage: { from_me: 1, ts: now - 1.1 * DAY } });
  assert.equal(r.action, 'closing');
  assert.equal(r.attempt, 5);
});

test('resposta do lead zera a contagem', () => {
  const sent = [now - 10 * DAY, now - 9 * DAY, now - 8 * DAY];
  const r = decide({ ...base, lastInboundTs: now - 5 * DAY, sentFollowupTs: sent, lastMessage: { from_me: 1, ts: now - 2 * DAY } });
  assert.equal(r.attempt, 1);
});

test('não passa do limite', () => {
  const sent = [5, 4, 3, 2, 1].map((d) => now - d * DAY);
  const r = decide({ ...base, lastInboundTs: now - 6 * DAY, sentFollowupTs: sent, lastMessage: { from_me: 1, ts: now - DAY } });
  assert.equal(r.action, 'skip');
});

test('não gera outra mensagem se já houver uma pendente', () => {
  const r = decide({ ...base, hasPendingDraft: true, lastMessage: { from_me: 1, ts: now - 2 * DAY } });
  assert.equal(r.action, 'skip');
});

test('máximo de 1 follow-up: a única mensagem já é o encerramento', () => {
  const r = decide({ ...base, maxFollowups: 1, lastMessage: { from_me: 1, ts: now - 2 * DAY } });
  assert.equal(r.action, 'closing');
});
