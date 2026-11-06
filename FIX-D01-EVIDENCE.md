# FIX-D01 — PostgreSQL Monetary Integrity / Integridade Monetária PostgreSQL

**Language / Idioma:** [English](#english) | [Português](#português)

---

<a id="english"></a>

## English

- **Date:** 2026-11-06
- **Executor:** Codex
- **Authorization:** Luís Henrique Pereira
- **Baseline:** `main`, `becd3d92ca2993d2349324f5ae59bd5e46ee3642` (working tree initially clean).
- **Checkpoint Status:** `D01` implementation and targeted validation completed. Independent review `FIX-D01-REV-01` by Antigravity subsequently **APPROVED** with zero findings (`0` blockers, `0` non-blockers). Consolidated publication and stable global validation are recorded in [`FIX-D01-D02-FINAL-EVIDENCE.md`](FIX-D01-D02-FINAL-EVIDENCE.md) (published in commit `38bc68f`). The notes below regarding concurrent `D02` edits preserve the historical record of the `D01` implementation checkpoint.

---

### 1. Root Cause and Monetary Column Inventory

PostgreSQL permits `'NaN'::numeric` inside `NUMERIC(18,2)` columns. In PostgreSQL, comparisons involving `NaN` behave such that `'NaN'::numeric >= 0`, `'NaN'::numeric > 0`, and `'NaN'::numeric = 'NaN'::numeric` evaluate to `TRUE`. Consequently, a direct SQL write inserting a coordinated `'NaN'::numeric` bundle across `wallets`, `wager_transactions` (`OPENING`), and `wallet_ledger_entries` previously satisfied both immediate `CHECK` constraints (`>= 0`, `> 0`) and `DEFERRABLE INITIALLY DEFERRED` balance-reconciliation triggers at transaction commit. The TypeScript `Money` value object already rejected `NaN` at public application boundaries and required no modification.

All persisted `NUMERIC` columns in the financial schema are monetary and use precision `18`, scale `2`:

| Table | Monetary `NUMERIC(18,2)` Columns |
|---|---|
| `wallets` | `balance` |
| `wager_transactions` | `amount`, `recorded_balance_amount` (nullable) |
| `wallet_ledger_entries` | `amount`, `balance_before`, `balance_after` |

The schema inventory test in [`test/integration/monetary-integrity.test.ts`](test/integration/monetary-integrity.test.ts) queries `information_schema.columns` and asserts that the schema contains these exact six `numeric(18,2)` columns.

---

### 2. RED Execution Prior to New Migration

- **Command:** `bun test test/integration/monetary-integrity.test.ts`
- **Result:** **`17 pass, 6 fail, 71 assertions, 23 tests`**.
  - Reproducing the coordinated `NaN` commit across all six monetary columns succeeded on the legacy schema (`Migration202611040001` only), proving the vulnerability.
  - All six per-column finiteness `CHECK` tests failed because the finiteness constraints did not yet exist. (Individual tests assert the exact new constraint name `ck_wallet_all_finite`, `ck_wager_all_finite`, or `ck_ledger_all_finite` so pre-existing arithmetic/deferred checks are never mistaken for finiteness enforcement.)
  - All twelve `Infinity`/`-Infinity` checks passed even in RED because PostgreSQL's `NUMERIC(18,2)` typmod rejects infinite values at cast/assignment time with `SQLSTATE 22003` before `CHECK` constraints run.
  - The historical reproduction remains executable in `FIX-D01 legacy schema confirms NaN in all six monetary columns at commit`, which reverts only `Migration202611060001` inside its own isolated `jungle_it_<uuid>` schema, proves the legacy commit, and drops the disposable schema.

---

### 3. Implementation and Modified Files

- [`src/database/migrations/Migration202611060001.ts`](src/database/migrations/Migration202611060001.ts): New versioned migration adding `ck_wallet_all_finite`, `ck_wager_all_finite`, and `ck_ledger_all_finite`. Each `CHECK` explicitly excludes `'NaN'::numeric`, `'Infinity'::numeric`, and `'-Infinity'::numeric` from the table's monetary columns while preserving `NULL` on `wager_transactions.recorded_balance_amount`. `down()` drops exclusively these three `CHECK` constraints.
- [`src/database/config.ts`](src/database/config.ts): Registers `[Migration202611040001, Migration202611060001]` in order with `transactional: true, allOrNothing: true`.
- [`test/integration/monetary-integrity.test.ts`](test/integration/monetary-integrity.test.ts): 31 real PostgreSQL integration tests covering column inventory, legacy reproduction, `NaN` rejection per column, `±Infinity` rejection per column, `UPDATE` rejection, valid boundary values (`0.00`, `0.01`, `9999999999999999.99`), nullable snapshots, idempotent replay, reconciliation, `UP/DOWN/UP` reversibility, and atomic rejection of invalid legacy data across all three tables.
- [`test/integration/operational-metrics.test.ts`](test/integration/operational-metrics.test.ts): Updated the strict migration inventory guard to assert `[Migration202611040001, Migration202611060001]`.
- [`test/integration/structured-logging.test.ts`](test/integration/structured-logging.test.ts): Updated the strict migration inventory guard and diagnostic assertion to `[Migration202611040001, Migration202611060001]`.
- [`FIX-D01-EVIDENCE.md`](FIX-D01-EVIDENCE.md): Evidence and rollback procedure for `FIX-D01`.

No changes were made to `Money`, `PendingReferenceWorker`, retry policies, `WIN`/`REFUND` rules, SQS/Outbox adapters, CLI scripts, or shared test harnesses.

#### Preserved and New Migration Hashes (SHA-256)

```text
Migration202611040001.ts (unchanged)
597fb0904a4575010b2a2d03e07e4bd046d7c80ae6346644fdd38fecc2d91aa9

Migration202611060001.ts (new)
bcb5d7f02024ccf3903a75aa3347e33c330cd83372907f0e6bfe03a266395377
```

---

### 4. GREEN and Regression Executions

| Command | Result |
|---|---|
| `bun test test/integration/monetary-integrity.test.ts test/integration/schema.test.ts test/integration/financial.test.ts` | **`64 pass, 0 fail; 329 assertions; 3 files`** |
| `bun run typecheck` | Passed (`tsc --noEmit`) |
| `bun test` (at `D01` checkpoint) | **`1,236 pass, 0 fail; 8,140 assertions; 42 files`** |
| `git diff --check` | Clean (no diagnostics) |

*(During final checkpoint verification, concurrent `FIX-D02` work by Antigravity was observed in `src/modules/wagering/application/pending-reference-worker.ts`, `test/unit/pending-reference-worker.test.ts`, and `test/integration/pending-reference-worker.test.ts`, and was preserved without modification. Once both `D01` and `D02` stabilized and passed independent reviews, the joint suite reached **`1,243 pass, 0 fail; 8,253 assertions`** as recorded in [`FIX-D01-D02-FINAL-EVIDENCE.md`](FIX-D01-D02-FINAL-EVIDENCE.md).)*

---

### 5. Test Isolation Verification

Before and after integration runs, a read-only audit connection (`default_transaction_read_only=on`) against PostgreSQL `16.6` (`server_version_num=160006`) on `127.0.0.1:5434/jungle_test` (role `jungle_test`) confirmed:

- `publicObjects = []` (zero tables or objects in `jungle_test.public`)
- `leftoverSchemas = []` (zero residual `jungle_it_*` schemas)
- `otherSessions = []` (zero leaked client connections)
- Only the three pre-existing SQS FIFO queues (`wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wagering-events.fifo`) remained in LocalStack `4.10.0` (`127.0.0.1:4566`).

All `UP`/`DOWN` migrations executed exclusively inside per-test `jungle_it_<uuid>` schemas in `jungle_test` and were dropped upon test completion. No migrations were executed against `public` or `jungle_dev`.

---

### 6. Residual Risks and Rollback Procedure

- **Immediate Validation of Legacy Data:** `Migration202611060001.up()` adds constraints without `NOT VALID` and without modifying existing rows. If legacy `NaN` corruption exists in `wallets`, `wager_transactions`, or `wallet_ledger_entries`, the entire `UP` migration fails and rolls back atomically (`0` partial `CHECK` constraints, `0` migration log entries, and untouched historical data).
- **Table Lock Cost:** `ALTER TABLE ... ADD CONSTRAINT` without `NOT VALID` acquires locks and scans existing table rows; execution time on large production datasets has not been benchmarked.
- **Surgical Rollback Procedure (in an authorized disposable schema):**

```ts
await orm.getMigrator().down({ migrations: ['Migration202611060001'] });
// Verify data, ledger immutability, and wallet reconciliation; only the three new CHECK constraints are removed.
await orm.getMigrator().up();
```

> **Warning:** Do **not** invoke `down({ to: 'Migration202611040001' })`, as MikroORM's `to` boundary is inclusive and would also revert the initial schema migration. Passing `{ migrations: ['Migration202611060001'] }` reverts exclusively `Migration202611060001`, preserving all tables and data while temporarily reopening `D01` until `up()` is re-applied.

---

<a id="português"></a>

## Português

- **Data:** 06/11/2026
- **Executor:** Codex
- **Autorização:** Luís Henrique Pereira
- **Baseline:** `main`, `becd3d92ca2993d2349324f5ae59bd5e46ee3642` (working tree inicialmente limpa).
- **Estado deste Checkpoint:** Implementação `D01` e validação do recorte concluídas. Revisão independente `FIX-D01-REV-01` pelo Antigravity posteriormente **APROVADA**, zero achados (`0` bloqueantes, `0` não bloqueantes). Publicação e validação global estável consolidadas em [`FIX-D01-D02-FINAL-EVIDENCE.md`](FIX-D01-D02-FINAL-EVIDENCE.md) (publicado no commit `38bc68f`). As notas abaixo sobre edições concorrentes de `D02` preservam o registro histórico do checkpoint `D01`.

---

### 1. Causa Raiz e Inventário de Colunas Monetárias

O PostgreSQL admite `'NaN'::numeric` em colunas `NUMERIC(18,2)`. Comparações anteriores como `>= 0`, `> 0` e igualdade aritmética (`=`) avaliam para `TRUE` quando os operandos são `'NaN'::numeric`. Por isso, um bundle SQL coordenado contendo `NaN` em `wallets`, `wager_transactions` (`OPENING`) e `wallet_ledger_entries` satisfazia tanto os `CHECK`s imediatos quanto os triggers diferidos de reconciliação no commit. A classe de domínio `Money` já rejeitava `NaN` nas entradas públicas da aplicação e não precisou ser alterada.

Todas as colunas `NUMERIC` persistidas no schema financeiro são monetárias e possuem precisão `18` e escala `2`:

| Tabela | Colunas Monetárias `NUMERIC(18,2)` |
|---|---|
| `wallets` | `balance` |
| `wager_transactions` | `amount`, `recorded_balance_amount` (nullable) |
| `wallet_ledger_entries` | `amount`, `balance_before`, `balance_after` |

O teste de inventário em [`test/integration/monetary-integrity.test.ts`](test/integration/monetary-integrity.test.ts) consulta `information_schema.columns` e exige exatamente essas seis colunas/tipos.

---

### 2. Execução RED Antes da Nova Migration

- **Comando:** `bun test test/integration/monetary-integrity.test.ts`
- **Resultado:** **`17 pass, 6 fail, 71 asserções, 23 testes`**.
  - A reprodução do commit com `NaN` nas seis colunas passou no schema legado (apenas `Migration202611040001`), comprovando a brecha.
  - Os seis testes de rejeição pela proteção de finitude falharam. Como alguns valores isolados já eram barrados por checks aritméticos/diferidos, cada teste exige o nome exato da nova constraint (`ck_wallet_all_finite`, `ck_wager_all_finite` ou `ck_ledger_all_finite`), sem confundir outro erro com prova de finitude.
  - As doze verificações de `Infinity`/`-Infinity` passaram já no RED: o typmod `NUMERIC(18,2)` rejeita essas entradas com `SQLSTATE 22003` antes dos checks.
  - A reprodução histórica permanece executável no teste `FIX-D01 legacy schema confirms NaN in all six monetary columns at commit`, que reverte exclusivamente a `Migration202611060001` em um schema próprio `jungle_it_<uuid>`, comprova o commit legado e descarta esse schema ao final.

---

### 3. Implementação e Arquivos Modificados

- [`src/database/migrations/Migration202611060001.ts`](src/database/migrations/Migration202611060001.ts): Nova migration adicionando `ck_wallet_all_finite`, `ck_wager_all_finite` e `ck_ledger_all_finite`. Cada `CHECK` exclui explicitamente `NaN`, `Infinity` e `-Infinity` das colunas monetárias da tabela, mantendo `NULL` permitido no snapshot opcional `recorded_balance_amount`. O `down()` remove exclusivamente esses três `CHECK`s.
- [`src/database/config.ts`](src/database/config.ts): Registro ordenado das duas migrations (`[Migration202611040001, Migration202611060001]`) com `transactional: true, allOrNothing: true`.
- [`test/integration/monetary-integrity.test.ts`](test/integration/monetary-integrity.test.ts): 31 testes em PostgreSQL real cobrindo inventário, reprodução legada, `NaN` por coluna, infinidades por coluna, `UPDATE`, valores finitos/limite (`0.00`, `0.01`, `9999999999999999.99`), snapshots nulos, replay, reconciliação, `UP/DOWN/UP` e rejeição atômica de dados legados inválidos nas três tabelas.
- [`test/integration/operational-metrics.test.ts`](test/integration/operational-metrics.test.ts): Atualização exclusiva da guarda de inventário de migrations para exigir as duas classes exatas, em ordem.
- [`test/integration/structured-logging.test.ts`](test/integration/structured-logging.test.ts): Mesma atualização da guarda e do diagnóstico de inventário de migrations.
- [`FIX-D01-EVIDENCE.md`](FIX-D01-EVIDENCE.md): Evidência e procedimento de rollback deste pacote.

Nenhuma alteração foi feita em `Money`, `PendingReferenceWorker`, políticas de retry, regras `WIN`/`REFUND`, SQS/Outbox, scripts CLI ou harnesses compartilhados.

#### Hashes SHA-256 das Migrations (Original Preservada e Nova)

```text
Migration202611040001.ts (preservada sem alterações)
597fb0904a4575010b2a2d03e07e4bd046d7c80ae6346644fdd38fecc2d91aa9

Migration202611060001.ts (nova)
bcb5d7f02024ccf3903a75aa3347e33c330cd83372907f0e6bfe03a266395377
```

---

### 4. Execuções GREEN e Regressões

| Comando | Resultado |
|---|---|
| `bun test test/integration/monetary-integrity.test.ts test/integration/schema.test.ts test/integration/financial.test.ts` | **`64 pass, 0 fail; 329 asserções; 3 arquivos`** |
| `bun run typecheck` | Aprovado (`tsc --noEmit`) |
| `bun test` (no checkpoint `D01`) | **`1.236 pass, 0 fail; 8.140 asserções; 42 arquivos`** |
| `git diff --check` | Sem diagnósticos |

*(Durante a conferência final do checkpoint, foram observadas alterações concorrentes do pacote `FIX-D02` pelo Antigravity em `src/modules/wagering/application/pending-reference-worker.ts`, `test/unit/pending-reference-worker.test.ts` e `test/integration/pending-reference-worker.test.ts`, preservadas sem edição. Após a estabilização e aprovação nas revisões independentes de `D01` e `D02`, a execução conjunta atingiu **`1.243 pass, 0 fail; 8.253 asserções`**, conforme consolidado em [`FIX-D01-D02-FINAL-EVIDENCE.md`](FIX-D01-D02-FINAL-EVIDENCE.md).)*

---

### 5. Verificação de Isolamento

Antes e depois das integrações, uma consulta de auditoria read-only (`default_transaction_read_only=on`) no PostgreSQL `16.6` (`server_version_num=160006`), banco/role `jungle_test` em `127.0.0.1:5434`, confirmou:

- `publicObjects = []` (nenhum objeto em `jungle_test.public`)
- `leftoverSchemas = []` (nenhum schema `jungle_it_*` residual)
- `otherSessions = []` (nenhuma outra sessão cliente aberta)
- Somente as três filas SQS FIFO preexistentes (`wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wagering-events.fifo`) permaneciam no LocalStack `4.10.0` (`127.0.0.1:4566`).

As migrations `UP`/`DOWN` foram executadas exclusivamente pelos harnesses em schemas próprios `jungle_it_<uuid>` de `jungle_test`, removidos após cada cenário. Nenhuma migration foi aplicada em `public` ou `jungle_dev`.

---

### 6. Riscos Residuais e Procedimento de Rollback

- **Validação Imediata de Dados Legados:** O `UP` da `Migration202611060001` valida imediatamente os dados existentes, sem `NOT VALID` e sem reparos automáticos. A presença de `NaN` legado em `wallets`, `wager_transactions` ou `wallet_ledger_entries` causa falha e rollback da migration inteira (`0` `CHECK`s parciais, `0` registros de migration aplicada e preservação integral do histórico).
- **Custo de Lock:** `ALTER TABLE ... ADD CONSTRAINT` com validação exige locks e leitura das tabelas; o custo/tempo em bases históricas grandes não foi medido.
- **Procedimento de Rollback Cirúrgico (em destino descartável autorizado):**

```ts
await orm.getMigrator().down({ migrations: ['Migration202611060001'] });
// Conferir dados, imutabilidade do ledger e reconciliação; somente os três CHECKs novos são removidos.
await orm.getMigrator().up();
```

> **Atenção:** Não utilize `down({ to: 'Migration202611040001' })`, pois essa seleção no MikroORM é inclusiva e também reverte a migration inicial. O `down({ migrations: ['Migration202611060001'] })` reverte exclusivamente a `Migration202611060001`, preservando tabelas e dados, mas reabrindo a brecha `D01` até o `up()` seguinte.
