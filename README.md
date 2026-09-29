# Cog Dev — orçamentos, atendimento e pagamento

Aplicação completa para captar briefings, atender clientes por chat, fechar propostas e disponibilizar o pagamento do sinal. O frontend é React; a API roda em um Cloudflare Worker; os dados ficam em D1; o tempo real usa Durable Objects.

## O que está pronto

- formulário conversacional adaptativo com salvamento por etapa, revisão e consentimento;
- chat humano persistente, WebSocket com reconexão exponencial e fallback HTTP;
- painel `/admin` com caixa de entrada, filtros, busca, atribuição, estados, notas internas e permissões;
- ação **Fechar orçamento**, versionamento de propostas e envio automático no chat;
- revisão do escopo, valores, prazo, condições, validade e aceite explícito pelo cliente;
- pagamento manual por link C6, liberado somente depois do aceite;
- abstração `PaymentProvider` preparada para uma integração futura por API;
- migrations incrementais, auditoria, rate limit, CSP, cookies seguros, CSRF e Cloudflare Access;
- layouts responsivos para desktop e celular.

## Pagamento C6 sem API

O modo padrão é `manual_payment_link`. Ele foi feito para o cenário atual, no qual cada valor é gerado diretamente no C6:

1. no C6, gere um link com o valor exato do sinal;
2. abra a conversa no painel administrativo;
3. clique em **Fechar orçamento**;
4. informe o valor total, o sinal e os demais termos;
5. cole o link no campo **Link de pagamento C6** e envie a proposta;
6. o cliente revisa a proposta e marca o aceite, que começa desmarcado;
7. somente então o botão **Aprovar e pagar sinal** libera o redirecionamento para o checkout hospedado pelo C6;
8. após conferir o recebimento no ambiente oficial do C6, use **Confirmar após conferência** no painel.

Cada proposta aceita fica imutável. Para mudar valor ou escopo, envie uma nova versão. Um link vencido pode ser substituído no cartão da proposta pelo campo **Substituir link C6**.

O servidor aceita somente URLs HTTPS cujo host seja exatamente `checkout2.c6pay.com.br`. O link fornecido como exemplo pelo projeto não fica gravado no código. Como não há API contratada, o sistema não tenta deduzir o valor contido no link e não confirma pagamento pelo retorno do navegador; a conferência manual no C6 é obrigatória.

## Execução local

Requisitos: Node.js 22+ e uma conta Cloudflare para publicar.

```bash
npm install
npm run build
npm run db:migrate:local
npx wrangler dev
```

A aplicação fica em `http://127.0.0.1:8787` e o painel em `http://127.0.0.1:8787/admin`. Somente em `ENVIRONMENT=development`, e apenas em `localhost`/`127.0.0.1`, o Worker provisiona um administrador local com papel `owner`.

Para desenvolver o frontend com recarga automática, mantenha `npx wrangler dev` aberto e, em outro terminal, execute `npm run dev`.

## Testes

```bash
npm test
npm run typecheck
npm run build
npx playwright install chromium
npm run test:e2e
```

Os testes cobrem validação e mass assignment, regras de acesso, host C6 malicioso, cookies/CSP, cursores entre conversas, preços calculados no servidor, aceite explícito, idempotência do checkout e o formulário administrativo em desktop e celular.

## Publicação na Cloudflare

1. Crie o banco e copie o `database_id` para `wrangler.jsonc`:

   ```bash
   npx wrangler d1 create cogdev-quotes
   ```

2. Configure em `wrangler.jsonc`:
   - `ENVIRONMENT`: `production`;
   - `ALLOWED_ORIGINS`: domínio público exato, com `https://`;
   - `TURNSTILE_SITE_KEY`;
   - `WHATSAPP_NUMBER`, se desejar o atalho;
   - `ADMIN_BOOTSTRAP_EMAILS`: e-mail inicial do proprietário;
   - `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` e, opcionalmente, `CF_ACCESS_ALLOWED_DOMAIN`;
   - mantenha `C6_ALLOWED_PAYMENT_HOSTS` como `checkout2.c6pay.com.br`.

3. Grave os segredos. Nunca coloque os valores no repositório ou no `wrangler.jsonc`:

   ```bash
   npx wrangler secret put TURNSTILE_SECRET_KEY
   npx wrangler secret put RATE_LIMIT_SALT
   ```

4. Aplique as migrations e publique:

   ```bash
   npm run db:migrate:remote
   npm run deploy
   ```

5. No Cloudflare Zero Trust, crie uma aplicação Access protegendo `/admin*` e `/api/admin/*`. Use o Application Audience (`AUD`) dessa aplicação em `CF_ACCESS_AUD`. Depois do primeiro acesso do proprietário, remova o e-mail de `ADMIN_BOOTSTRAP_EMAILS` e publique novamente.

`CF_ACCESS_TEAM_DOMAIN` deve ser a origem completa da equipe, por exemplo `https://sua-equipe.cloudflareaccess.com`, sem barra final.

### Bindings

O `wrangler.jsonc` já declara os bindings usados pelo Worker:

- `DB`: banco D1 `cogdev-quotes`;
- `ASSETS`: arquivos do build em `dist/`;
- `CONVERSATIONS`: Durable Object SQLite `ConversationRoom`, um canal por conversa;
- `ADMIN_INBOX`: Durable Object SQLite `AdminInbox`, usado para atualizações da caixa administrativa.

As classes dos Durable Objects estão declaradas em `exports`, portanto o Wrangler cria as migrations de classe exigidas pela configuração atual. As migrations relacionais ficam separadas em `migrations/` e são aplicadas pelo comando D1.

Para testar o atendimento local, abra a página pública em uma janela, solicite um especialista e abra `/admin` em outra. Assuma a conversa no painel e envie mensagens nos dois sentidos; a persistência pode ser verificada após atualizar ambas as páginas.

O cron diário expira sessões/propostas e remove dados conforme `RETENTION_DAYS` (padrão: 180 dias).

## Integração C6 por API no futuro

O modo `c6_checkout_api` existe, mas falha de forma segura até haver contrato, documentação e credenciais oficiais. `PaymentProvider` expõe `createCheckout`, `getPaymentStatus`, `expireCheckout`, `verifyWebhookSignature` e `processWebhook`. A comunicação acontece exclusivamente no Worker.

Quando a API estiver disponível, configure o adaptador server-to-server por HTTPS e grave as credenciais com Cloudflare Secrets:

```bash
npx wrangler secret put C6_CLIENT_ID
npx wrangler secret put C6_CLIENT_SECRET
npx wrangler secret put C6_WEBHOOK_SECRET
```

O valor enviado ao provedor sempre vem da proposta aceita no D1. O navegador não fornece valor, status nem identificador de pagamento. Webhooks são verificados antes do processamento, eventos repetidos são deduplicados e a volta para uma página de sucesso nunca confirma uma cobrança.

## Estrutura

- `src/`: interface pública, chat, revisão da proposta e painel administrativo;
- `worker/`: API, autenticação, segurança, Durable Objects e pagamentos;
- `shared/`: contratos Zod compartilhados;
- `migrations/`: esquema D1 incremental;
- `tests/unit/` e `tests/e2e/`: testes unitários e de navegador.

## Observações de segurança

- valores monetários são inteiros em centavos;
- nenhum dado de cartão é coletado ou armazenado;
- o cliente acessa somente a conversa vinculada ao cookie opaco da própria sessão;
- valores, estados e identificadores vindos do navegador não são confiados;
- todas as queries usam bindings parametrizados;
- tokens e credenciais não fazem parte do bundle público;
- links C6 são cadastrados somente por administradores `owner` ou `admin` e ficam associados à versão da proposta;
- payloads sensíveis não são gravados nos logs.
