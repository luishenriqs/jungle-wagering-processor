# FINAL-DELIVERY-01 / FINAL-DELIVERY-REV-FIX-01 — Delivery Evidence / Evidência de Entrega

**Language / Idioma:** [English](#english) | [Português](#português)

---

<a id="english"></a>

## English

> **Post-Audit Consolidation Update (`FIX-D01-D02-FINAL`):** Current consolidated baseline is **991 unit tests + 252 integration tests; 1,243 passing tests in joint execution, 0 failures, and 8,253 assertions; `typecheck` passed** (published in commit `38bc68f`). The `FIX-D01` and `FIX-D02` fixes and recovery tests are consolidated in [`FIX-D01-D02-FINAL-EVIDENCE.md`](FIX-D01-D02-FINAL-EVIDENCE.md). The results below record the `IMP-04` (`FINAL-DELIVERY-01`) delivery checkpoint (published in commit `becd3d92ca2993d2349324f5ae59bd5e46ee3642`) and are not summed with the current validation.

- **Date:** 2026-11-06
- **Executors:** Codex and Antigravity
- **Authorization:** Luís Henrique Pereira authorized validation, `REV-FINAL-01..03` fixes, explicit staging, commit, and publication.
- **Audited Baseline:** `main`, initial `HEAD` at `c4e7527f9e84d8269b218ee8791303f4c3aa0a38`.

### 1. Verified Results (`FINAL-DELIVERY-01` Checkpoint)

| Validation Command | Result | Provenance |
|---|---|---|
| `bun run typecheck` | Passed; `tsc --noEmit` | Executed after `REV-FINAL-01..02` |
| `bun run test:unit` | `989 pass, 0 fail`; `5,382` assertions, `27` files | Executed after `REV-FINAL-01..02` |
| `bun test test/integration/operational-metrics.test.ts` | `20 pass, 0 fail`; `405` assertions (`18` `NO_MIGRATION` + `2` `MIGRATION_REQUIRED` without internal flags) | Executed after `REV-FINAL-01` |
| `bun run test:integration` | `216 pass, 0 fail`; `2,612` assertions, `14` files | Executed after `REV-FINAL-01..02` |
| `bun test` | `1,205 pass, 0 fail`; `7,994` assertions, `41` files | Executed after `REV-FINAL-01..02` |
| `git diff --check` / `git diff --cached --check` | Clean (no diagnostics) | Verified working tree delta and staged index prior to commit |

The `298` operational metrics unit tests are included in the `989` unit tests; the `20` operational metrics integration tests (`18` `G6A` `NO_MIGRATION` and `2` `G6B` `MIGRATION_REQUIRED`) are included in the `216` integration tests. Historical package results remain recorded in [`IMP-01-EVIDENCE.md`](IMP-01-EVIDENCE.md), [`IMP-02-EVIDENCE.md`](IMP-02-EVIDENCE.md), and [`IMP-03-EVIDENCE.md`](IMP-03-EVIDENCE.md). Tests that intentionally inject transport, connection, or watchdog errors expect those faults; diagnostic output emitted during those scenarios does not indicate suite failure.

#### Final Audit Commands

```sh
bun run typecheck
bun run test:unit
bun test test/integration/operational-metrics.test.ts
bun run test:integration
bun test
git diff --check
git diff --cached --check
```

In `REV-FINAL-01`, the dependency on internal governance environment variables (`JUNGLE_G6A_GATE`, `JUNGLE_G6A_E2_GO`, and `/proc/self/cmdline` `NO_MIGRATION` filter checks) was removed from `test/integration/operational-metrics.test.ts`, and `g6aMigrationBarrier()` was scoped per scenario inside `g6aScenario()`, preserving the strict `Migrator.prototype.up` block across all 18 `NO_MIGRATION` scenarios (`blockedCalls: 1, executed: 0`) while enabling joint execution alongside the 2 `MIGRATION_REQUIRED` scenarios in disposable `jungle_it_<uuid>` schemas.

### 2. Isolation and Resource Integrity

The read-only final audit confirmed PostgreSQL `16.6` on `jungle_test/public` (local port `5434`), `search_path=public,public`, read-only audit connection, zero objects in `public` (`publicObjects: []`), zero residual `jungle_it_*` schemas (`leftoverSchemas: []`), and zero other active database sessions upon completion (`otherSessions: []`). All three pre-existing SQS queues were preserved and no test-owned queues remained. Every child process spawned during testing exited and was joined. Audit database connections and SQS clients were closed.

`G6A` blocked the intentional migration call in negative test `X09` and executed zero migrations. Core integration suites and `G6B` applied migrations exclusively inside disposable `jungle_it_<uuid>` schemas; `test/integration/schema.test.ts` also verified reversible `down/up` cycles within that isolation. No development database migration was executed during this delivery audit.

Production `G1–G5` files and `test/unit/operational-metrics.test.ts` preserved their approved SHA-256 hashes at the `FINAL-DELIVERY-01` checkpoint:

| File | SHA-256 (at `FINAL-DELIVERY-01` / `becd3d92`) |
|---|---|
| `src/shared/application/operational-metrics.ts` | `e994d885d3c450f6803e7d8d76fb1a70c59164a5711d96bb0c4adde1635b422c` |
| `src/shared/infrastructure/metrics.controller.ts` | `0cabdf509e69e606e8db428e06444e294c6ae4a4ec4c0375a5a0b3f826479a25` |
| `test/unit/operational-metrics.test.ts` | `6d57201bea1e2f8fc4b4f33ef25f202d863cd4c748d42c8dd2e650df70a07b6d` |
| `test/integration/operational-metrics.test.ts` | `d1ccd6c7046a539213a93e1d93c20c98062013b5515596087dbb7daf9d74821c` |
| `src/database/migrations/Migration202611040001.ts` | `597fb0904a4575010b2a2d03e07e4bd046d7c80ae6346644fdd38fecc2d91aa9` |

*(Note: In subsequent package `FIX-D01`, `test/integration/operational-metrics.test.ts` was updated solely to include `Migration202611060001` in its strict migration inventory assertion; see [`FIX-D01-D02-FINAL-EVIDENCE.md`](FIX-D01-D02-FINAL-EVIDENCE.md).)*

All candidate files were inspected for private keys, tokens, AWS credentials, and local passwords. The synthetic AWS key pattern in the log-sanitization unit test is a pre-existing redaction fixture without a secret pair, not an operational credential. `.env`, dependencies, logs, backups, and temporary transfer directories are excluded from version control.

### 3. Challenge Requirements Coverage Matrix

| Challenge Requirement | Implementation and Verification Evidence |
|---|---|
| Exact monetary precision & encapsulated domain | Immutable `Money` with `decimal.js`, fixed 2-decimal string contracts, `NUMERIC(18,2)` + finite `CHECK`s; unit & schema/monetary-integrity suites |
| Non-negative balance & consistent/immutable ledger | `CHECK` constraints, append-only & deferred triggers, 1-to-1 ledger entry per balance movement, `REPEATABLE READ` reconciliation; schema/financial/HTTP suites |
| Persistent idempotency & multi-instance safety | SQL uniqueness (`uq_wager_idempotency`, `uq_wager_provider_external`), canonical SHA-256 hash, per-wallet `FOR UPDATE` locking; financial/multiprocess/SQS suites |
| Out-of-order references | Persisted `PENDING_REFERENCE`, shared exponential backoff/TTL policy, `PendingReferenceWorker`, and `FIX-D02` terminal overflow handling; pending-reference-worker suites |
| Transactional Inbox, post-commit ACK & DLQ | Atomic Inbox claim and post-commit `DeleteMessage`, confirmed manual DLQ transfer + native `RedrivePolicy`; sqs-consumer/`G6A` suites |
| Transactional Outbox & crash recovery | `FOR UPDATE SKIP LOCKED` claim with lease/token fencing, post-commit SQS publish, stable `eventId`; outbox-publisher/worker-resilience suites |
| Graceful shutdown & real OS processes | Signal draining, pool disposal coordination, watchdog timer; worker-entrypoints/worker-resilience/`G6A` suites |
| HTTP API, health probes & observability | Controllers, deterministic error mapping, readiness probes, sanitized JSON logs, process-scoped metrics; HTTP/unit/`G6A`/`G6B` suites |
| Versioned reversible migrations | `Migration202611040001` and `Migration202611060001` with verified `up/down/up` cycles in isolated schemas; schema/monetary-integrity/`G6B` suites |
| Documentation & optional authentication | Setup and API reference in [`README.md`](README.md); `ProviderIdentityGuard` no-op extension point and OIDC IdP design in [`ARCHITECTURE.md`](ARCHITECTURE.md) |

### 4. Operational Boundaries

No functional or security blockers were found in the audited scope. External authentication was intentionally left as an explicit no-op extension point (`ProviderIdentityGuard`) as permitted by Section 2 of the challenge specification; the local HTTP server is not an authenticated API. Metrics are process-local (`scope: "process"`), volatile, and without cross-process aggregation. Outbox delivery is at-least-once and requires consumer deduplication by `eventId`. DLQ retention requires operational monitoring. `skipLibCheck: true` is maintained per Bun's TypeScript recommendation.

---

<a id="português"></a>

## Português

> **Atualização de Consolidação Pós-Auditoria (`FIX-D01-D02-FINAL`):** A baseline consolidada atual é de **991 testes unitários + 252 testes de integração; 1.243 testes aprovados na execução conjunta, zero falhas e 8.253 asserções; `typecheck` aprovado** (publicado no commit `38bc68f`). As correções `FIX-D01` e `FIX-D02` e os complementos de recuperação estão consolidados em [`FIX-D01-D02-FINAL-EVIDENCE.md`](FIX-D01-D02-FINAL-EVIDENCE.md). Os resultados abaixo registram o checkpoint de entrega do `IMP-04` (`FINAL-DELIVERY-01`, publicado no commit `becd3d92ca2993d2349324f5ae59bd5e46ee3642`) e não são somados à validação atual.

- **Data:** 06/11/2026
- **Executores:** Codex e Antigravity
- **Autorização:** Luís Henrique Pereira autorizou validação, correções `REV-FINAL-01..03`, staging explícito, commit e publicação.
- **Base Auditada:** `main`, `HEAD` inicial em `c4e7527f9e84d8269b218ee8791303f4c3aa0a38`.

### 1. Resultados Verificados (Checkpoint `FINAL-DELIVERY-01`)

| Validação | Resultado | Proveniência |
|---|---|---|
| `bun run typecheck` | Aprovado; `tsc --noEmit` | Executado após `REV-FINAL-01..02` |
| `bun run test:unit` | `989 pass, 0 fail`; `5.382` asserções, `27` arquivos | Executado após `REV-FINAL-01..02` |
| `bun test test/integration/operational-metrics.test.ts` | `20 pass, 0 fail`; `405` asserções (`18` `NO_MIGRATION` + `2` `MIGRATION_REQUIRED` sem flags internas) | Executado após `REV-FINAL-01` |
| `bun run test:integration` | `216 pass, 0 fail`; `2.612` asserções, `14` arquivos | Executado após `REV-FINAL-01..02` |
| `bun test` | `1.205 pass, 0 fail`; `7.994` asserções, `41` arquivos | Executado após `REV-FINAL-01..02` |
| `git diff --check` / `git diff --cached --check` | Sem diagnósticos | Verificação do delta e do índice antes do commit |

Os `298` testes unitários de métricas estão incluídos nos `989`; os `20` testes de integração de métricas (`18` `G6A` `NO_MIGRATION` e `2` `G6B` `MIGRATION_REQUIRED`) estão incluídos nos `216` testes de integração. Os resultados históricos por pacote permanecem nas evidências [`IMP-01-EVIDENCE.md`](IMP-01-EVIDENCE.md), [`IMP-02-EVIDENCE.md`](IMP-02-EVIDENCE.md) e [`IMP-03-EVIDENCE.md`](IMP-03-EVIDENCE.md). Testes que provocam erros intencionais de transporte, conexão ou watchdog esperam essas falhas; mensagens de diagnóstico nesses cenários não representam falhas da suíte.

#### Comandos da Auditoria Final

```sh
bun run typecheck
bun run test:unit
bun test test/integration/operational-metrics.test.ts
bun run test:integration
bun test
git diff --check
git diff --cached --check
```

Em `REV-FINAL-01`, a dependência das variáveis internas de governança (`JUNGLE_G6A_GATE`, `JUNGLE_G6A_E2_GO` e exigência do filtro `NO_MIGRATION` via `/proc/self/cmdline`) foi removida de `test/integration/operational-metrics.test.ts`, e a barreira `g6aMigrationBarrier()` passou a ser escopada por cenário dentro de `g6aScenario()`, preservando integralmente o bloqueio de `Migrator.prototype.up` nos 18 cenários `NO_MIGRATION` (`blockedCalls: 1, executed: 0`) enquanto permite a execução conjunta dos 2 cenários `MIGRATION_REQUIRED` em schemas descartáveis `jungle_it_<uuid>`.

### 2. Isolamento e Integridade de Recursos

A auditoria final read-only confirmou PostgreSQL `16.6` em `jungle_test/public`, porta local `5434`, `search_path=public,public`, conexão de auditoria read-only, zero objetos em `public` (`publicObjects: []`), zero schemas `jungle_it_*` residuais (`leftoverSchemas: []`) e zero outras sessões no banco ao terminar (`otherSessions: []`). As três filas SQS preexistentes foram preservadas; nenhuma fila própria de testes permaneceu. Todos os processos filhos criados nos testes foram encerrados e aguardados. A conexão e o cliente da auditoria foram fechados.

`G6A` bloqueou a chamada intencional de migration do teste negativo `X09` e executou zero migrations. As integrações essenciais e `G6B` aplicaram migrations somente em schemas descartáveis exclusivos; a suíte de schema também validou `down/up` reversível nesse isolamento. Nenhuma migration de desenvolvimento foi executada nesta auditoria.

A implementação de produção `G1–G5` e a suíte unitária `test/unit/operational-metrics.test.ts` mantiveram seus hashes SHA-256 idênticos aos homologados no checkpoint `FINAL-DELIVERY-01`:

| Arquivo | SHA-256 (em `FINAL-DELIVERY-01` / `becd3d92`) |
|---|---|
| `src/shared/application/operational-metrics.ts` | `e994d885d3c450f6803e7d8d76fb1a70c59164a5711d96bb0c4adde1635b422c` |
| `src/shared/infrastructure/metrics.controller.ts` | `0cabdf509e69e606e8db428e06444e294c6ae4a4ec4c0375a5a0b3f826479a25` |
| `test/unit/operational-metrics.test.ts` | `6d57201bea1e2f8fc4b4f33ef25f202d863cd4c748d42c8dd2e650df70a07b6d` |
| `test/integration/operational-metrics.test.ts` | `d1ccd6c7046a539213a93e1d93c20c98062013b5515596087dbb7daf9d74821c` |
| `src/database/migrations/Migration202611040001.ts` | `597fb0904a4575010b2a2d03e07e4bd046d7c80ae6346644fdd38fecc2d91aa9` |

*(Nota: No pacote subsequente `FIX-D01`, `test/integration/operational-metrics.test.ts` foi atualizado exclusivamente para incluir `Migration202611060001` na sua guarda estrita de inventário de migrations; consulte [`FIX-D01-D02-FINAL-EVIDENCE.md`](FIX-D01-D02-FINAL-EVIDENCE.md).)*

Foi inspecionado o conteúdo candidato à publicação para chaves privadas, tokens, credenciais AWS e senhas locais conhecidas. A amostra de chave AWS no teste de sanitização de logs é sintética e preexistente, sem par secreto; não é credencial operacional. `.env`, dependências, logs, backups e diretórios auxiliares de transferência não fazem parte do controle de versão.

### 3. Matriz de Cobertura dos Requisitos do Desafio

| Requisito do Desafio | Implementação e Evidência de Verificação |
|---|---|
| Precisão monetária exata e domínio encapsulado | `Money` imutável com `decimal.js`, contratos string de 2 casas, `NUMERIC(18,2)` + `CHECK`s de finitude; suítes unitárias e schema/monetary-integrity |
| Saldo não negativo e ledger consistente/imutável | Constraints `CHECK`, triggers append-only e diferidos, lançamento 1:1 no ledger por movimento e reconciliação `REPEATABLE READ`; suítes schema/financial/HTTP |
| Idempotência persistente e múltiplas instâncias | Unicidade SQL (`uq_wager_idempotency`, `uq_wager_provider_external`), hash SHA-256 canônico e locks `FOR UPDATE` por carteira; suítes financial/multiprocess/SQS |
| Referências fora de ordem | `PENDING_REFERENCE` persistido, política compartilhada de backoff/TTL, `PendingReferenceWorker` e tratamento terminal de overflow `FIX-D02`; suítes pending-reference-worker |
| Transactional Inbox, ACK pós-commit e DLQ | Persistência atômica da Inbox e `DeleteMessage` pós-commit, transferência manual confirmada para DLQ + `RedrivePolicy` nativa; suítes sqs-consumer/`G6A` |
| Transactional Outbox e recuperação de falhas | Claim `FOR UPDATE SKIP LOCKED` com fencing de lease/token, publicação SQS pós-commit e `eventId` estável; suítes outbox-publisher/worker-resilience |
| Shutdown gracioso e processos reais | Drenagem de sinais, coordenação de fechamento do pool e watchdog timer; suítes worker-entrypoints/worker-resilience/`G6A` |
| API HTTP, health probes e observabilidade | Controllers, mapeamento determinístico de erros, sondas de readiness, logs JSON sanitizados e métricas de processo; suítes HTTP/unitárias/`G6A`/`G6B` |
| Migrations versionadas e reversíveis | `Migration202611040001` e `Migration202611060001` com ciclos `up/down/up` verificados em schemas isolados; suítes schema/monetary-integrity/`G6B` |
| Documentação e autenticação opcional | Setup e referência de API no [`README.md`](README.md); `ProviderIdentityGuard` no-op e desenho de IdP OIDC no [`ARCHITECTURE.md`](ARCHITECTURE.md) |

### 4. Limites Operacionais

Não foram encontrados bloqueantes funcionais ou de segurança no escopo auditado. Autenticação externa não foi implementada, permanecendo como ponto de extensão explícito no-op (`ProviderIdentityGuard`) conforme opção permitida pela Seção 2 do desafio; a API HTTP local não é autenticada. Métricas são locais ao processo (`scope: "process"`), voláteis e sem agregação distribuída. A Outbox possui entrega at-least-once e requer deduplicação por `eventId` pelos consumidores. A retenção de mensagens na DLQ exige acompanhamento operacional. `skipLibCheck: true` é mantido conforme recomendação oficial do Bun para TypeScript.
