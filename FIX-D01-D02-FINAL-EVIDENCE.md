# FIX-D01-D02-FINAL — Consolidation and Publication Evidence / Evidência de Consolidação e Publicação

**Language / Idioma:** [English](#english) | [Português](#português)

---

<a id="english"></a>

## English

- **Date:** 2026-11-06
- **Consolidation Executor:** Codex (implementations by Codex for `D01` and Antigravity for `D02`)
- **Authorization:** Luís Henrique Pereira (including `REV-D02-01/02` test additions, explicit staging, commit, and publication to `origin/main`)
- **Audited Baseline:** `main`, `becd3d92ca2993d2349324f5ae59bd5e46ee3642`
- **Published Code Commit (`FIX-D01-D02-FINAL`):** `38bc68f` (`fix: enforce finite money and terminalize pending overflows`)

---

### 1. Independent Reviews and Consolidated Scope

Per authorization from Luís Henrique Pereira:
- **`FIX-D01-REV-01` (reviewed by Antigravity):** **APPROVED**, zero findings (`0` blockers, `0` non-blockers).
- **`FIX-D02-REV-01` (reviewed by Codex):** **APPROVED**, zero blockers and two non-blocking test coverage recommendations (`REV-D02-01` and `REV-D02-02`).

`FIX-D01` was implemented by Codex and `FIX-D02` was implemented by Antigravity. The consolidation preserved both implementations intact and added exclusively the four `REV-D02-01/02` integration tests and updated documentation; no additional production code changes were required.

- **`FIX-D01` Summary:** Adds [`Migration202611060001.ts`](src/database/migrations/Migration202611060001.ts) with three immediate validated `CHECK` constraints (`ck_wallet_all_finite`, `ck_wager_all_finite`, `ck_ledger_all_finite`) covering all six monetary `NUMERIC(18,2)` columns, explicitly rejecting `'NaN'::numeric`, `'Infinity'::numeric`, and `'-Infinity'::numeric` while preserving `NULL` on the optional `recorded_balance_amount` snapshot. [`Migration202611040001.ts`](src/database/migrations/Migration202611040001.ts) remains untouched. Historical RED/GREEN evidence and rollback procedures are documented in [`FIX-D01-EVIDENCE.md`](FIX-D01-EVIDENCE.md).
- **`FIX-D02` Summary:** Handles [`MoneyOverflowError`](src/shared/domain/domain-errors.ts) thrown when calculating a balance credit during [`PendingReferenceWorker`](src/modules/wagering/application/pending-reference-worker.ts) resolution: transitions the wager `PENDING_REFERENCE -> FAILED` with `FailureCode.InfrastructurePermanent` (`INFRASTRUCTURE_PERMANENT`), records the observed wallet balance snapshot, and clears `nextRetryAt`/`expiresAt` inside the same transaction under `Wallet -> Wager` locks without altering `wallets.balance`, `wallets.version`, or `wallet_ledger_entries`, and without enqueuing financial Outbox events. Operational logs and metrics execute after commit; all other errors continue to propagate; reversal insufficient funds and TTL Option A preserve their existing semantics.

---

### 2. Additional Recovery Tests (`REV-D02-01` and `REV-D02-02`)

Four integration tests were added to [`test/integration/pending-reference-worker.test.ts`](test/integration/pending-reference-worker.test.ts) reusing existing test harnesses:

1. **PostgreSQL `AFTER UPDATE` Trigger Abort (`REV-D02-01`):** A test-schema-only `AFTER UPDATE` trigger inserts a marker row after `UPDATE wager_transactions SET status = 'FAILED'` and raises PostgreSQL error `P0001`. Both the `FAILED` transition and the marker row roll back atomically, leaving `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages`, and `outbox_messages` unchanged. Once the trigger fault is disarmed, the retry commits a single terminal `FAILED` transition; subsequent worker passes are no-ops and discovery returns empty.
2. **Failure at `wager` Checkpoint (`REV-D02-01`):** Injecting a fault at the `wager` checkpoint (immediately after `updatePendingWager`) proves full transaction rollback followed by clean single terminalization on retry without financial side effects.
3. **Failure at `beforeCommit` Checkpoint (`REV-D02-01`):** Injecting a fault at the `beforeCommit` boundary confirms the same atomic rollback guarantee right before commit.
4. **Independent Multi-Process Restart & Replay (`REV-D02-02`):** An independent `bun` child process commits the `FAILED` overflow terminalization and closes its ORM and OS process. After a subsequent `25.00 BRL` debit lowers the wallet balance enough that the original credit would now fit within `NUMERIC(18,2)`, separate processes connected to the same schema verify empty pending discovery, explicit worker no-op, and idempotent HTTP/use-case replay returning the historical `FAILED` snapshot (`9999999999999999.99 BRL`), with verified distinct OS/PostgreSQL backend PIDs and final ledger reconciliation.

- **Targeted Execution:** `bun test test/integration/pending-reference-worker.test.ts --test-name-pattern REV-D02` -> **`4 pass, 0 fail; 53 assertions`**. (These 4 tests are included in the global totals below.)

---

### 3. Stable Global Validation

| Command | Executed Result |
|---|---|
| `bun run typecheck` | Passed (`tsc --noEmit`) |
| `bun run test:unit` | **`991 pass, 0 fail; 5,425 assertions; 27 files`** |
| `bun run test:integration` | **`252 pass, 0 fail; 2,828 assertions; 15 files`** |
| `bun test` | **`1,243 pass, 0 fail; 8,253 assertions; 42 files`** |
| `git diff --check` | Clean (no diagnostics) |

A per-file SHA-256 manifest of all 143 source, test, script, and configuration files was captured before running the validation commands and compared afterward; zero code or test files changed during the run. Strict migration inventory guards in `test/integration/operational-metrics.test.ts` and `test/integration/structured-logging.test.ts` enforce `[Migration202611040001, Migration202611060001]` in exact order.

---

### 4. Migrations and Resource Integrity

- **Verified Environment:** Bun `1.4.4`, PostgreSQL `16.6` (`5433` dev, `5434` test), LocalStack `4.10.0` (`4566`).
- **Database & Queue Isolation:** Before and after integration suites, a read-only audit connection (`default_transaction_read_only=on`) on `127.0.0.1:5434/jungle_test` confirmed `publicObjects = []`, `leftoverSchemas = []`, and `otherSessions = []`. All test migrations ran exclusively inside disposable `jungle_it_<uuid>` schemas in `jungle_test`. Only the three baseline SQS queues (`wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wagering-events.fifo`) remained after execution. No migrations were executed on `jungle_test.public` or `jungle_dev`.

#### Preserved Implementation Hashes (SHA-256)

| File | SHA-256 |
|---|---|
| [`src/database/migrations/Migration202611040001.ts`](src/database/migrations/Migration202611040001.ts) | `597fb0904a4575010b2a2d03e07e4bd046d7c80ae6346644fdd38fecc2d91aa9` |
| [`src/database/migrations/Migration202611060001.ts`](src/database/migrations/Migration202611060001.ts) | `bcb5d7f02024ccf3903a75aa3347e33c330cd83372907f0e6bfe03a266395377` |
| [`src/modules/wagering/application/pending-reference-worker.ts`](src/modules/wagering/application/pending-reference-worker.ts) | `fbe284f52ff583e28d8491012cea42fbefce408b98be24d422883744cc508da3` |

---

### 5. Published File Inventory (`FIX-D01-D02-FINAL` / `38bc68f`)

1. `src/database/config.ts` — ordered registration of `Migration202611040001` and `Migration202611060001`.
2. `src/database/migrations/Migration202611060001.ts` — PostgreSQL monetary finiteness `CHECK` constraints (`FIX-D01`).
3. `src/modules/wagering/application/pending-reference-worker.ts` — terminal `FAILED` overflow handling (`FIX-D02`).
4. `test/integration/monetary-integrity.test.ts` — `FIX-D01` PostgreSQL integration suite (31 tests).
5. `test/integration/pending-reference-worker.test.ts` — `FIX-D02` integration scenario plus four `REV-D02-01/02` recovery tests.
6. `test/unit/pending-reference-worker.test.ts` — `FIX-D02` unit test coverage.
7. `test/integration/operational-metrics.test.ts` — strict migration inventory update.
8. `test/integration/structured-logging.test.ts` — strict migration inventory update.
9. `README.md` — updated documentation.
10. `ARCHITECTURE.md` — updated architectural documentation.
11. `FINAL-DELIVERY-EVIDENCE.md` — cross-reference to `FIX-D01-D02-FINAL`.
12. `FIX-D01-EVIDENCE.md` — `FIX-D01` evidence and rollback documentation.
13. `FIX-D01-D02-FINAL-EVIDENCE.md` — this consolidated evidence record.

---

### 6. Residual Considerations and Rollback

`REV-D02-01` and `REV-D02-02` are fully covered and verified; no open functional items remain in `FIX-D01` or `FIX-D02`. Applying `Migration202611060001` acquires table locks and validates existing rows immediately (failing atomically if legacy corruption exists). Reverting `Migration202611060001` via `down({ migrations: ['Migration202611060001'] })` removes only the three finiteness `CHECK`s and preserves all data. Do not run `down({ to: 'Migration202611040001' })`, as that selection also reverts the baseline schema migration.

---

<a id="português"></a>

## Português

- **Data:** 06/11/2026
- **Executor da Consolidação:** Codex (implementações por Codex em `D01` e Antigravity em `D02`)
- **Autorização:** Luís Henrique Pereira (incluindo complementos de teste `REV-D02-01/02`, staging explícito, commit e push para `origin/main`)
- **Baseline Auditada:** `main`, `becd3d92ca2993d2349324f5ae59bd5e46ee3642`
- **Commit de Código Publicado (`FIX-D01-D02-FINAL`):** `38bc68f` (`fix: enforce finite money and terminalize pending overflows`)

---

### 1. Revisões Independentes e Escopo Consolidado

Conforme autorização de Luís Henrique Pereira:
- **`FIX-D01-REV-01` (revisado pelo Antigravity):** **APROVADO**, zero achados (`0` bloqueantes, `0` não bloqueantes).
- **`FIX-D02-REV-01` (revisado pelo Codex):** **APROVADO**, zero bloqueantes e duas recomendações não bloqueantes de cobertura de testes (`REV-D02-01` e `REV-D02-02`).

`FIX-D01` foi implementado pelo Codex e `FIX-D02` pelo Antigravity. A consolidação preservou os dois trabalhos intactos e acrescentou exclusivamente os quatro testes de integração `REV-D02-01/02` e a documentação atualizada; nenhuma alteração adicional em código de produção foi necessária.

- **Resumo do `FIX-D01`:** Adiciona [`Migration202611060001.ts`](src/database/migrations/Migration202611060001.ts) com três constraints `CHECK` validadas (`ck_wallet_all_finite`, `ck_wager_all_finite`, `ck_ledger_all_finite`) sobre as seis colunas monetárias `NUMERIC(18,2)`, excluindo explicitamente `'NaN'::numeric`, `'Infinity'::numeric` e `'-Infinity'::numeric` e preservando `NULL` no snapshot opcional `recorded_balance_amount`. A [`Migration202611040001.ts`](src/database/migrations/Migration202611040001.ts) permanece intacta. As evidências históricas RED/GREEN e o procedimento de rollback estão em [`FIX-D01-EVIDENCE.md`](FIX-D01-EVIDENCE.md).
- **Resumo do `FIX-D02`:** Trata [`MoneyOverflowError`](src/shared/domain/domain-errors.ts) durante o cálculo do movimento na resolução do [`PendingReferenceWorker`](src/modules/wagering/application/pending-reference-worker.ts): transiciona `PENDING_REFERENCE -> FAILED` com `FailureCode.InfrastructurePermanent` (`INFRASTRUCTURE_PERMANENT`), registra o saldo observado no snapshot e limpa `nextRetryAt`/`expiresAt` na mesma transação sob locks `Wallet -> Wager`, sem alterar `wallets.balance`, `wallets.version` ou `wallet_ledger_entries` e sem enfileirar eventos financeiros na Outbox. Logs e métricas ocorrem após o commit; os demais erros continuam propagados; insuficiência de saldo em reversões e TTL Opção A preservam suas regras anteriores.

---

### 2. Complementos de Teste (`REV-D02-01` e `REV-D02-02`)

Quatro testes de integração foram adicionados em [`test/integration/pending-reference-worker.test.ts`](test/integration/pending-reference-worker.test.ts), reutilizando os helpers existentes:

1. **Abort por Trigger PostgreSQL `AFTER UPDATE` (`REV-D02-01`):** Um trigger `AFTER UPDATE` exclusivo do schema de teste insere um marcador após `UPDATE wager_transactions SET status = 'FAILED'` e provoca erro PostgreSQL `P0001`. A aposta inteira volta ao estado `PENDING_REFERENCE` anterior e o marcador desaparece por rollback, mantendo todas as linhas de `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages` e `outbox_messages` idênticas. Desarmada a falha, a tentativa seguinte confirma exatamente uma transição `FAILED`; novas resoluções são no-op e a descoberta fica vazia.
2. **Falha no Checkpoint `wager` (`REV-D02-01`):** Falha injetada no checkpoint `wager`, imediatamente após `updatePendingWager`, confirma rollback real e posterior terminalização limpa sem efeitos financeiros.
3. **Falha no Checkpoint `beforeCommit` (`REV-D02-01`):** Falha injetada na fronteira `beforeCommit` confirma a mesma garantia de rollback atômico imediatamente antes do commit.
4. **Reinício Multiprocesso e Replay Independente (`REV-D02-02`):** Um processo filho `bun` independente confirma `FAILED` e encerra seu ORM e processo. Após um débito posterior de `25.00 BRL` (que permitiria acomodar o crédito original dentro de `NUMERIC(18,2)`), outros processos independentes no mesmo schema confirmam descoberta vazia, no-op explícito no worker e replay idempotente devolvendo o saldo histórico observado (`9999999999999999.99 BRL`), com verificação de PIDs distintos de processo/backend PostgreSQL e reconciliação final do ledger.

- **Execução Específica:** `bun test test/integration/pending-reference-worker.test.ts --test-name-pattern REV-D02` -> **`4 pass, 0 fail; 53 asserções`**. (Esses 4 testes estão incluídos nas execuções globais abaixo.)

---

### 3. Validação Global Estável

| Comando | Resultado Efetivamente Executado |
|---|---|
| `bun run typecheck` | Aprovado (`tsc --noEmit`) |
| `bun run test:unit` | **`991 pass, 0 fail; 5.425 asserções; 27 arquivos`** |
| `bun run test:integration` | **`252 pass, 0 fail; 2.828 asserções; 15 arquivos`** |
| `bun test` | **`1.243 pass, 0 fail; 8.253 asserções; 42 arquivos`** |
| `git diff --check` | Sem diagnósticos |

Um manifesto SHA-256 por arquivo de 143 fontes, testes, scripts e configurações foi capturado antes dos comandos e comparado depois; nenhum arquivo mudou durante a validação. As guardas de inventário de migrations em `test/integration/operational-metrics.test.ts` e `test/integration/structured-logging.test.ts` continuam exigindo `[Migration202611040001, Migration202611060001]` na ordem exata.

---

### 4. Migrations e Integridade dos Recursos

- **Ambiente Confirmado:** Bun `1.4.4`, PostgreSQL `16.6` (`5433` dev, `5434` teste), LocalStack `4.10.0` (`4566`).
- **Isolamento de Banco e Filas:** Antes e depois das suítes de integração, uma conexão de auditoria com `default_transaction_read_only=on` em `127.0.0.1:5434/jungle_test` confirmou `publicObjects = []`, `leftoverSchemas = []` e `otherSessions = []`. As suítes aplicaram migrations exclusivamente em schemas próprios `jungle_it_<uuid>` de `jungle_test`. Na listagem final do SQS permaneceram apenas as três filas base (`wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wagering-events.fifo`). Nenhuma migration foi executada em `jungle_test.public` ou `jungle_dev`.

#### Hashes SHA-256 Preservados das Implementações Aprovadas

| Arquivo | SHA-256 |
|---|---|
| [`src/database/migrations/Migration202611040001.ts`](src/database/migrations/Migration202611040001.ts) | `597fb0904a4575010b2a2d03e07e4bd046d7c80ae6346644fdd38fecc2d91aa9` |
| [`src/database/migrations/Migration202611060001.ts`](src/database/migrations/Migration202611060001.ts) | `bcb5d7f02024ccf3903a75aa3347e33c330cd83372907f0e6bfe03a266395377` |
| [`src/modules/wagering/application/pending-reference-worker.ts`](src/modules/wagering/application/pending-reference-worker.ts) | `fbe284f52ff583e28d8491012cea42fbefce408b98be24d422883744cc508da3` |

---

### 5. Inventário de Arquivos Publicados (`FIX-D01-D02-FINAL` / `38bc68f`)

1. `src/database/config.ts` — registro ordenado de `Migration202611040001` e `Migration202611060001`.
2. `src/database/migrations/Migration202611060001.ts` — constraints `CHECK` de finitude monetária no PostgreSQL (`FIX-D01`).
3. `src/modules/wagering/application/pending-reference-worker.ts` — tratamento terminal `FAILED` em overflow (`FIX-D02`).
4. `test/integration/monetary-integrity.test.ts` — suíte de integração PostgreSQL de `FIX-D01` (31 testes).
5. `test/integration/pending-reference-worker.test.ts` — cenário `FIX-D02` original e quatro complementos `REV-D02-01/02`.
6. `test/unit/pending-reference-worker.test.ts` — cobertura unitária de `FIX-D02`.
7. `test/integration/operational-metrics.test.ts` — atualização do inventário estrito de migrations.
8. `test/integration/structured-logging.test.ts` — atualização do inventário estrito de migrations.
9. `README.md` — documentação atualizada.
10. `ARCHITECTURE.md` — documentação arquitetural atualizada.
11. `FINAL-DELIVERY-EVIDENCE.md` — referência cruzada para `FIX-D01-D02-FINAL`.
12. `FIX-D01-EVIDENCE.md` — registro de evidência e rollback de `FIX-D01`.
13. `FIX-D01-D02-FINAL-EVIDENCE.md` — este registro consolidado.

---

### 6. Considerações Residuais e Rollback

`REV-D02-01` e `REV-D02-02` estão cobertos e executados; não há pendências funcionais em `FIX-D01` ou `FIX-D02`. O `UP` da `Migration202611060001` exige locks e varredura das tabelas existentes (abortando atomicamente caso haja corrupção legada). O `DOWN` explícito via `down({ migrations: ['Migration202611060001'] })` remove somente os três `CHECK`s de finitude e preserva os dados. Não utilize `down({ to: 'Migration202611040001' })`, pois essa seleção inclui a reversão da migration inicial.
