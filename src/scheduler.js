import cron from 'node-cron';
import { getSettings } from './settings.js';
import { runAgent } from './agent.js';

let task = null;

export function cronExpression(s = getSettings()) {
  const [hour, minute] = s.runTime.split(':').map(Number);
  const days = s.runDays.length ? [...s.runDays].sort().join(',') : '*';
  return `${minute} ${hour} * * ${days}`;
}

export function reschedule() {
  task?.stop();
  const s = getSettings();
  if (!s.runDays.length) {
    task = null;
    console.log('Agendamento desativado (nenhum dia selecionado).');
    return;
  }
  const expr = cronExpression(s);
  task = cron.schedule(
    expr,
    () => {
      runAgent('agendado').catch((err) => console.error('Execução agendada falhou:', err.message));
    },
    { timezone: s.timezone },
  );
  console.log(`Agente agendado: "${expr}" (${s.timezone})`);
}
