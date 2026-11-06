# Distributed Wagering Processor

Serviço financeiro distribuído do desafio Jungle Gaming: HTTP e SQS usam o mesmo processamento transacional, com idempotência persistente, ledger imutável, referências fora de ordem e Transactional Outbox.

Implementação IMP-01–IMP-04 concluída. A validação de observabilidade cobre tanto G6A (18 casos sem migrations, incluindo quatro composições NestJS reais) quanto G6B (dois casos com PostgreSQL em schemas exclusivos `jungle_it_<uuid>`). Resultados e limites estão em [FINAL-DELIVERY-EVIDENCE.md](FINAL-DELIVERY-EVIDENCE.md); decisões e arquitetura consolidada estão em [ARCHITECTURE.md](ARCHITECTURE.md); os relatórios [IMP-01-EVIDENCE.md](IMP-01-EVIDENCE.md), [IMP-02-EVIDENCE.md](IMP-02-EVIDENCE.md) e [IMP-03-EVIDENCE.md](IMP-03-EVIDENCE.md) preservam o histórico das etapas anteriores.

## Preparação

Requer Bun **1.4.4**, Docker e Docker Compose. Dependências fixadas: TypeScript strict, NestJS 11.1.6, MikroORM 6.6.8, PostgreSQL 16.6, LocalStack 4.10.0 e decimal.js 10.6.0.

```sh
bun install --frozen-lockfile
```

Configure no shell ou em `.env` local ignorado pelo Git, substituindo os valores entre `<...>`. Codifique caracteres especiais das senhas nas URLs; nunca versione credenciais.

```dotenv
JUNGLE_DB_PASSWORD=<senha-dev>
JUNGLE_TEST_DB_PASSWORD=<senha-teste>
DATABASE_URL=postgresql://jungle:<senha-dev>@127.0.0.1:5433/jungle_dev
TEST_DATABASE_URL=postgresql://jungle_test:<senha-teste>@127.0.0.1:5434/jungle_test
SQS_ENDPOINT=http://127.0.0.1:4566
AWS_REGION=us-east-1
```

```sh
docker compose --profile test up -d --wait postgres postgres-test localstack
bun run db:migrate
bun scripts/check-sqs.ts
```

`db:migrate` aplica a migration versionada no destino de `DATABASE_URL`; confira essa URL antes de executar. Os processos da aplicação não aplicam migrations automaticamente. Desenvolvimento usa volume persistente; `postgres-test` usa tmpfs e porta 5434. Não execute migration manual em `public` de `jungle_test`: G6A exige esse schema vazio. Os testes que precisam de tabelas criam e removem seus próprios schemas `jungle_it_<uuid>`.

## Execução

Abra quatro terminais com o mesmo ambiente:

```sh
bun run start
bun scripts/consume-wagers.ts
bun scripts/publish-outbox.ts
bun scripts/resolve-pending-references.ts
```

HTTP escuta em `127.0.0.1:3000` (`PORT` configurável). `bun run dev` habilita watch. O Compose provisiona `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wagering-events.fifo`. Credenciais SQS são sintéticas para o emulador local; não são necessárias credenciais AWS reais.

| Configuração | Default / contrato |
|---|---|
| `SQS_INPUT_QUEUE_NAME` / `SQS_DLQ_QUEUE_NAME` | `wager-transactions.fifo` / `wager-transactions-dlq.fifo` |
| `SQS_EVENTS_QUEUE_NAME` | `wagering-events.fifo` |
| `SQS_CONSUMER_NAME` | `wager-transactions-consumer`; igual entre instâncias |
| `SQS_MAX_RECEIVE_COUNT` | `5`; deve coincidir com RedrivePolicy |
| `SQS_WAIT_SECONDS` / `SQS_VISIBILITY_TIMEOUT_SECONDS` | `20` / `120` |
| `OUTBOX_POLL_INTERVAL_MS` / `OUTBOX_LEASE_MS` | `250` / `10000` |
| `SQS_SEND_TIMEOUT_MS` | `3000`; lease deve excedê-lo com margem de 1000 ms |
| `PENDING_REF_BASE_DELAY_MS` / `PENDING_REF_MAX_ATTEMPTS` | `1000` / `10` |
| `PENDING_REF_TTL_MS` / `PENDING_REF_POLL_INTERVAL_MS` | `86400000` / `250` |
| `PENDING_REF_BATCH_SIZE` | `100` |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | `60000`; cobre drain e fechamento |

Mantenha a política de referência consistente entre instâncias e relógios sincronizados em UTC. SIGTERM/SIGINT interrompem polls, drenam trabalho e fecham ORM/SQS. Para contextos worker criados programaticamente, use `closeWorkerApplication`; `app.close()` sozinho não completa o watchdog. SIGKILL ou timeout exigem recuperação por visibilidade, idempotência e leases persistidos.

## API

| Método e rota | Uso |
|---|---|
| `POST /wallets` | Criar wallet; retorna 201 |
| `GET /wallets/:walletId` | Consultar saldo e versão |
| `GET /wallets/:walletId/ledger?limit=20&cursor=...` | Ledger paginado por cursor |
| `POST /wallets/:walletId/reconciliation` | Conferir saldo versus ledger; corpo vazio |
| `POST /wagering/transactions` | Processar operação; exige `Idempotency-Key` |
| `GET /wagering/transactions/:transactionId` | Consultar transação |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consultar por identidade externa |
| `GET /health/live` / `GET /health/ready` | Liveness / readiness |
| `GET /metrics` | Snapshot JSON de métricas do processo HTTP |

```sh
curl -sS http://127.0.0.1:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"player-demo","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# Substitua <wallet-id> pelo id retornado acima.
curl -sS http://127.0.0.1:3000/wagering/transactions \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: provider-demo:bet-1' \
  -d '{"providerId":"provider-demo","externalTransactionId":"bet-1","playerId":"player-demo","walletId":"<wallet-id>","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"10.00","currency":"BRL"}}'
```

Valores monetários são strings com duas casas. BET debita, WIN credita, LOSS não movimenta saldo, REFUND/ROLLBACK exigem referência. `OPENING` e provider `SYSTEM` são internos. Resultado processado retorna 200, referência pendente 202, rejeição de negócio 422, conflito de identidade/payload 409. Replay preserva o snapshot persistido; não executa novo movimento. Erros de contrato retornam 400 e indisponibilidade transitória esgotada retorna 503.

A autenticação foi deliberadamente deixada como extensão aceita pelo desafio: `ProviderIdentityGuard` é no-op. O desenho de integração futura com IdP está em ARCHITECTURE.md. A aplicação local não deve ser tratada como API autenticada.

## Testes

```sh
bun run typecheck
bun run test:unit
bun run test:integration
bun test
git diff --check
```

As suítes de integração exigem `jungle_test` local na porta **5434** (`public` vazio) e LocalStack na porta **4566**. Cada suíte que utiliza schema relacional cria e remove exclusivamente seu próprio schema `jungle_it_<uuid>` em `jungle_test`; os cenários `NO_MIGRATION` em `test/integration/operational-metrics.test.ts` validam identidade/configuração efetiva, vacuidade de `public`, bloqueio de `Migrator.up`, exclusividade de filas SQS e cleanup determinístico.

As suítes também podem ser executadas por categoria ou filtro:

```sh
bun test test/integration/operational-metrics.test.ts
bun test test/integration/operational-metrics.test.ts --test-name-pattern NO_MIGRATION
bun test test/integration/operational-metrics.test.ts --test-name-pattern MIGRATION_REQUIRED
bun test test/integration/schema.test.ts test/integration/financial.test.ts test/integration/multiprocess.test.ts
bun test test/integration/sqs-consumer.test.ts test/integration/outbox-publisher.test.ts test/integration/pending-reference-worker.test.ts
bun test test/integration/worker-resilience.test.ts test/integration/worker-entrypoints.test.ts
bun test test/integration/wallet-http.test.ts test/integration/wager-http.test.ts test/integration/observability-http.test.ts
```

Indisponibilidade de infraestrutura é falha ambiental explícita, não aprovação com testes omitidos. Filas/schemas próprios são removidos; recursos preexistentes são preservados. Não use `down -v`, purge de filas compartilhadas ou rollback de schema para preparar testes. `db:rollback` é destrutivo e exige `JUNGLE_ALLOW_SCHEMA_ROLLBACK=yes` em destino descartável.

## Garantias e limites

PostgreSQL é a autoridade para idempotência e concorrência: locks por wallet, constraints únicas, checks de saldo e triggers de imutabilidade. Wallet, wager, ledger, Inbox e Outbox são confirmados juntos; ACK e publicação respeitam a confirmação transacional. FIFO otimiza ordenação, sem substituir essas garantias.

Outbox entrega **at-least-once**; consumidores externos devem deduplicar por `eventId`. A DLQ pode conter tanto diagnóstico sanitizado quanto envelope original recuperado por redrive: nunca reenvie diagnóstico como operação financeira. Retenção SQS é finita e exige acompanhamento operacional.

Métricas têm `scope: process`, cardinalidade fixa, saturação segura e reiniciam com o processo. `/metrics` não agrega workers de outros processos; `confirmedTransfers` conta transferências confirmadas para DLQ, não o backlog da fila. Logs são JSON sanitizado. Não há IdP, agregação distribuída de métricas ou frontend nesta entrega.
