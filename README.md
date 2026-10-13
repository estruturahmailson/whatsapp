# Agente de follow-up no WhatsApp (Z-API + Claude)

Todos os dias o agente analisa as conversas com a etiqueta **Acompanhamento**. Para cada lead que parou de responder, ele usa o Claude para escrever uma mensagem de reativação baseada no histórico da conversa. Você aprova as mensagens num painel web e elas são enviadas pela Z-API.

## Como funciona

1. **Webhook:** a Z-API envia ao servidor cada mensagem recebida e enviada. O servidor guarda o histórico num banco SQLite.
2. **Análise diária (horário configurável):**
   - sincroniza os contatos com a etiqueta "Acompanhamento" (também dá para adicionar contatos pelo painel);
   - para cada contato, verifica se **a última mensagem é sua** e se já passou o **prazo sem resposta** (padrão: 1 dia);
   - conta os follow-ups seguidos sem resposta. Quando o lead responde, a contagem volta a zero;
   - o Claude lê o histórico e escreve a próxima mensagem. Ele também pode sugerir **não enviar**, por exemplo se o lead já recusou ou pediu para não ser contatado.
3. **Aprovação:** as mensagens aparecem no painel. Você pode editar, aprovar, descartar ou aprovar todas de uma vez.
4. **Envio:** as mensagens saem uma por vez, com intervalo aleatório entre elas. Se o lead responder antes do envio, a mensagem é cancelada.
5. **Encerramento:** a última tentativa (padrão: a 5ª) é uma mensagem avisando que você vai parar de entrar em contato. Depois que ela é enviada, o contato perde a etiqueta "Acompanhamento" e recebe a etiqueta **Frio**.

## Painel

- **Aprovações:** mensagens pendentes, conversa do lead, edição do texto e histórico de envios.
- **Contatos:** quem está em acompanhamento, quantos follow-ups já recebeu, sincronização das etiquetas, cadastro manual e reativação de contatos frios.
- **Configurações:** descrição do negócio, tom de voz, instruções extras, prazo sem resposta, máximo de follow-ups, nomes das etiquetas, horário e dias da análise, intervalo entre envios e credenciais.
- **Execuções:** log de cada análise, com o motivo de cada contato ter sido ignorado ou não.

## Instalação

Requisitos: Node.js 22.13 ou mais recente.

```bash
npm install
cp .env.example .env   # preencha os valores
npm start              # lê o .env automaticamente; abra http://localhost:3000
```

Variáveis obrigatórias: `PANEL_PASSWORD` e `WEBHOOK_SECRET`. As credenciais da Z-API e da Anthropic podem ser definidas no `.env` ou no painel.

### Hospedagem

Funciona em qualquer serviço que rode Node.js e tenha **URL pública**, para receber o webhook, e **disco persistente**, para o SQLite. Exemplos: Railway com volume, Render com disco ou uma VPS. Defina `DATA_DIR` apontando para o disco persistente e `PUBLIC_URL` com o endereço do app.

## Configuração na Z-API

1. No painel da Z-API, abra a instância e configure o webhook **"Ao receber"** com a URL mostrada em *Configurações → Integrações* do painel do agente (`https://seu-app/webhook/<WEBHOOK_SECRET>`).
2. Ative **"Notificar as enviadas por mim"**. Assim, as mensagens que você manda pelo celular também entram no histórico. Sem isso, o agente não sabe que você respondeu.
3. Copie o **ID da instância**, o **token** e o **Client-Token** (token de segurança da conta) para o painel.
4. Use **WhatsApp Business** e crie as etiquetas **Acompanhamento** e **Frio**.

### Observações importantes

- **Histórico:** o agente só conhece as mensagens que passaram pelo webhook depois que ele foi configurado. Para contatos sem histórico, ele tenta importar as mensagens pela API da Z-API (`chat-messages`). Se a sua conexão não permitir, o contato é ignorado até haver mensagens registradas.
- **Etiquetas:** a sincronização lê as etiquetas pela listagem de chats da Z-API. Se a sua instância não retornar as etiquetas nessa listagem, o log da execução avisa, e você pode adicionar os contatos manualmente na aba *Contatos*. A troca para "Frio" usa os endpoints de etiquetas da Z-API.
- **Boas práticas:** mantenha intervalos entre envios e mensagens personalizadas. Envios em massa e repetitivos aumentam o risco de bloqueio do número.

## Testes

```bash
npm test
```

## Estrutura

```
src/
  server.js     servidor web, login, API do painel e webhook
  agent.js      regras de follow-up, sincronização de etiquetas e execução diária
  ai.js         geração da mensagem com Claude (saída em JSON estruturado)
  zapi.js       cliente da Z-API
  sender.js     fila de envio com intervalo aleatório
  scheduler.js  agendamento diário (node-cron)
  settings.js   configurações (salvas no banco)
  db.js         banco SQLite (node:sqlite)
public/         painel web (HTML/CSS/JS, sem build)
```
