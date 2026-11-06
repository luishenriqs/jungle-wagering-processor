# AUDIT-D04-FIX-01 — Worker Metrics Export / Exportação de Métricas

**Language / Idioma:** [English](#english) | [Português](#português)

<a id="english"></a>

## English

### Scope and Baseline

Authorized by Luís Henrique Pereira. Implemented in isolated worktree `/tmp/jungle-d04-worktree`, branch `codex/audit-d04-fix-01`, initially based on `bb36cc104d7a56f45ff308004f0b8d84a6ede5ee`. D03 was independently published as `e2e9ba8f0857be9ed8a295805aa432478eda7874`; D04 was rebased onto that commit without conflicts before final regression. D03 production code, unit/integration tests and `IMP-04-CP-03-EVIDENCE.md` remain byte-identical to its published version. Its documentation changes were preserved.

### Architecture and Files

- `src/shared/infrastructure/worker-metrics-reporter.ts`: reusable Nest lifecycle reporter, closed snapshot projection, NDJSON envelope, bounded interval, deduplication and one outstanding native writer Promise.
- `src/modules/messaging/messaging.module.ts` and `src/modules/wagering/wagering.module.ts`: inject the existing graph collector into the three standalone reporters. No additional collector or HTTP reporter.
- `test/unit/worker-metrics-reporter.test.ts`: 12 unit tests covering configuration, envelope, deduplication, projection, serialization faults, throws/rejections, reentry, pending receipts and timer disposal.
- `test/integration/worker-metrics-reporter.test.ts`: 15 real PostgreSQL/LocalStack/OS-process tests; production entrypoints export directly to stderr, with no DI snapshot probe.
- `test/support/entrypoint-client.ts` and `test/support/worker-metrics-fault-preload.ts`: optional test-only preload for isolated writer failures; financial operations and production lifecycle remain real.
- `README.md`, `ARCHITECTURE.md` and this evidence: bilingual contract, configuration, verified results and operational limits.

Envelope: `{type:"OperationalMetricsSnapshot",version:1,component,executionId,pid,timestamp,snapshot}`. Components are restricted to `sqs-consumer`, `outbox-publisher`, `pending-reference-worker`; snapshot is the complete unchanged `OperationalMetricsSnapshot`. Interval: `WORKER_METRICS_INTERVAL_MS=10000`, allowed `50..3600000` ms.

Starts after Nest provider validation, emits initially and periodically, skips unchanged successfully written snapshots, and attempts a final changed snapshot on shutdown. No awaiting telemetry, sample queue, new metrics storage, services, endpoints or global aggregation. While one write is pending, sampling stops before reading the collector. Exceptions/rejections are contained. Counters accumulate since context startup and reset on restart; execution UUIDs distinguish runs. Lost export records are permitted under telemetry failure/backpressure, including final best-effort emission.

### RED / GREEN and Final Validation

RED command, before production implementation:

```sh
bun test test/integration/worker-metrics-reporter.test.ts --test-name-pattern D04-FIX-T01
```

Result: **0 pass, 3 fail**, all three real entrypoints started but timed out waiting for exported metrics. Resources were exclusively disposable and cleaned.

GREEN: 12 reporter unit tests passed; 15 reporter integration tests passed. Restart coverage was subsequently strengthened to perform measurable work in each worker before checking reset on restart. The strengthened cases passed in the final full integration suite.

Final regression on the D03-integrated baseline:

| Command | Verified result |
|---|---|
| `bun run typecheck` | Passed (`tsc --noEmit`) |
| `bun run test:unit` | **1,006 pass, 0 fail; 5,483 assertions; 28 files** |
| `bun run test:integration` | **268 pass, 0 fail; 3,089 assertions; 16 files** |
| `git diff --check` | Passed |

Consolidated **1,274 tests and 8,572 assertions**, from separate unit/integration executions, not an additional joint `bun test` run. Full integration includes existing financial, idempotency, schema, SQS, multiprocess, crash recovery and worker entrypoint regressions. Earlier runs on the initial baseline also passed (1,003 unit + 267 integration tests); those historical results are not added to final totals.

| Required case | Executed evidence |
|---|---|
| T01 | Three actual standalone scripts export complete NDJSON snapshots. |
| T02 | Real PostgreSQL `40001` rollback causes 3 conflicts, 2 UoW retries and 1 confirmed SQS visibility retry; later commit succeeds; malformed input confirms manual DLQ transfer. |
| T03 | Real Outbox publications export lag after SQL confirmation; deleting/recreating only the test-owned events queue proves send failure, persisted retry and recovery. |
| T04 | Missing reference reschedules, later BET resolves REFUND once; ledger reconciles. |
| T05 | Separate OS process PIDs and execution UUIDs; default graph isolation tests remain green. |
| T06 | Each worker performs measurable work, exits, restarts on the same schema, exports zeroed counters with a new execution ID and preserves financial reconciliation. |
| T07/T08/T09 | Every worker also executes real work with a writer that throws, rejects or never settles. |
| T10 | 50,000 flush attempts under a pending receipt cause exactly one snapshot read/write; no queued samples. Pending writer in actual entrypoints is invoked once. |
| T11 | Extra fields, accessors, non-finite counters and custom serialization are rejected; exported frames contain no financial payload or identifiers. |
| T12 | All three workers complete SIGTERM without forced termination for all writer fault modes; unit test confirms timer cancellation. |
| T13 | HTTP `/metrics` remains unchanged while a separate consumer records activity. |
| T14 | PostgreSQL rollback emits no committed wager result; failed Outbox SQL confirmation emits no publication-lag sample despite a successful send. |

### Integrity and Operational Limits

Verified PostgreSQL **16.6**, database/user `jungle_test`, port **5434**, separate from development port **5433**. Migrations ran only through the existing harness in owned `jungle_it_<uuid>` schemas. Test-only fault triggers were confined to those schemas. No production migration or migration file change.

Final read-only inventory: **no residual test schemas, no other client sessions, empty public schema**, and exactly the three pre-existing SQS queues. Test-owned processes were joined, pools/clients closed and queues removed. No development writes or shared queue traffic. Financial reconciliation is explicitly asserted after writer failures, retries and restarts. D01/D02 code, the existing metric catalog and HTTP metrics implementation are unchanged.

Raw execution logs and the 145-file code/test/config SHA-256 manifest are in `/tmp/jungle-d04-fix-evidence-Lzx6NP`; these local artifacts and environment/dependency links are excluded from the commit. Staging uses an explicit file inventory and is checked for secrets and unintended files before publication.

Export is best-effort. A permanently pending writer disables further exports from that reporter until restart; financial processing and shutdown continue. Consumers must compute deltas by execution rather than summing cumulative snapshots. No persistent metrics or exactly-once delivery guarantee is introduced.

<a id="português"></a>

## Português

### Escopo e Baseline

Autorizado por Luís Henrique Pereira. Implementado na worktree isolada `/tmp/jungle-d04-worktree`, branch `codex/audit-d04-fix-01`, inicialmente sobre `bb36cc104d7a56f45ff308004f0b8d84a6ede5ee`. D03 foi publicado independentemente como `e2e9ba8f0857be9ed8a295805aa432478eda7874`; D04 foi integrado sobre esse commit sem conflitos antes da regressão final. Código, testes unitários/de integração e `IMP-04-CP-03-EVIDENCE.md` de D03 permanecem idênticos aos publicados. Suas alterações documentais foram preservadas.

### Arquitetura e Arquivos

O novo `WorkerMetricsReporter` em `src/shared/infrastructure/worker-metrics-reporter.ts` exporta o coletor existente do grafo DI. `messaging.module.ts` integra consumidor e publisher; `wagering.module.ts` integra referências pendentes. Não cria segundo coletor nem altera HTTP `/metrics`.

Envelope NDJSON em stderr: `{type:"OperationalMetricsSnapshot",version:1,component,executionId,pid,timestamp,snapshot}`. O snapshot preserva o catálogo completo existente. `WORKER_METRICS_INTERVAL_MS` tem default de 10.000 ms e faixa de 50 a 3.600.000 ms. O reporter inicia após validação dos providers, emite inicialmente e periodicamente, omite snapshots idênticos já escritos e tenta uma amostra final alterada no shutdown.

No máximo uma Promise nativa de escrita fica pendente, sem fila de amostras nem espera por telemetria no fluxo financeiro. Sob backpressure, novas amostras são omitidas antes de ler o coletor. Projeção fechada rejeita campos extras, getters, serialização customizada e valores não finitos. Contadores cumulativos zeram no reinício; UUID da execução distingue resets. A entrega é best-effort e pode perder registros, sem armazenamento ou agregação global.

Os arquivos novos de testes unitários e de integração possuem 12 e 15 testes, respectivamente. `test/support/entrypoint-client.ts` aceita um preload opcional; `worker-metrics-fault-preload.ts` injeta falhas exclusivamente no writer de métricas dentro do isolamento comprovado. README, ARCHITECTURE e esta evidência mantêm English seguido de Português.

### RED / GREEN e Validação Final

Antes da implementação, os três entrypoints reais iniciaram, mas não exportaram snapshots: **RED com 0 aprovados e 3 falhas por timeout**. Após a implementação, passaram os 12 testes unitários e as 15 integrações específicas. A cobertura de reinício foi reforçada para comprovar reset após atividade não zero nos três workers e passou na regressão final.

| Comando | Resultado verificado após integração de D03 |
|---|---|
| `bun run typecheck` | Aprovado |
| `bun run test:unit` | **1.006 aprovados, 0 falhas; 5.483 asserções; 28 arquivos** |
| `bun run test:integration` | **268 aprovados, 0 falhas; 3.089 asserções; 16 arquivos** |
| `git diff --check` | Aprovado |

Consolidado de **1.274 testes e 8.572 asserções em execuções separadas** das suítes, sem afirmar uma execução conjunta adicional de `bun test`. As integrações completas incluem finanças, idempotência, schema, SQS, multiprocesso, recuperação de falhas e entrypoints. Resultados anteriores sobre a baseline inicial (1.003 unitários e 267 integrações) são históricos e não são somados.

Foram comprovados T01–T14: exportação pelos três scripts reais; retry SQS/DLQ; lag somente após confirmação SQL; reagendamento/resolução de referências; identificação por processo/execução; reset após atividade e reinício; writers que lançam, rejeitam ou nunca concluem; backpressure sem fila; ausência de dados sensíveis; SIGTERM sem bloqueio; HTTP independente; ausência de métricas de resultado/publicação confirmada em rollback. Uma trigger temporária `40001` produziu 3 conflitos, 2 retries da UoW e 1 retry SQS confirmado. Outra falha temporária impediu confirmação SQL da Outbox e manteve lag não contabilizado. A exclusão/recriação apenas da fila própria de eventos comprovou falha real de envio e recuperação.

### Integridade e Limites

PostgreSQL 16.6, usuário/banco `jungle_test`, porta 5434, separado de desenvolvimento na 5433. Migrations existentes somente em schemas próprios descartáveis; triggers de falha somente nesses schemas. Nenhuma migration criada ou alterada. Ao terminar: nenhum schema residual, nenhuma outra sessão, `public` vazio e somente as três filas SQS preexistentes. Processos próprios encerrados e aguardados, pools/clientes fechados e filas temporárias removidas. Nenhuma escrita em desenvolvimento nem tráfego experimental em filas compartilhadas.

Reconciliação financeira é assertada após falhas de escrita, retries e reinícios. D01/D02, catálogo de métricas e implementação HTTP permanecem preservados. Logs locais e manifesto SHA-256 de 145 arquivos estão em `/tmp/jungle-d04-fix-evidence-Lzx6NP`, fora do commit, assim como vínculos locais de ambiente/dependências. O staging é explícito e revisado para segredos e arquivos indevidos.

Uma escrita permanentemente pendente suprime novas exportações daquele reporter até reinício, preservando processamento financeiro e shutdown. Consumidores devem calcular diferenças por execução, não somar snapshots cumulativos. Não há garantia de persistência ou entrega exactly-once de métricas.
