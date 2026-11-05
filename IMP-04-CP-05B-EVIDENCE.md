# IMP-04/CP-05.B — Evidências de Logging Estruturado e Correlação Operacional

## A. Identificação

- **Projeto:** Jungle Gaming — Distributed Wagering Processor
- **Checkpoint:** IMP-04/CP-05.B — Logging Estruturado e Correlação Operacional
- **Baseline:** `213803f99c8bdaef10f26bc2660ace12cb6668b0`
- **Branch:** `main`
- **Data da evidência:** 2026-11-05
- **Responsável técnico:** Luís Henrique Pereira
- **Executor:** Codex
- **Revisor independente:** Antigravity
- **Estado:** tecnicamente homologado; pacote de encerramento preparado para aprovação humana

Este documento registra evidências obtidas em etapas distintas de RED, GREEN, correções adversariais e regressão final. Os resultados históricos estão identificados como tais; o preflight deste documento foi somente leitura.

## B. Escopo implementado

O CP-05.B acrescenta logging operacional estruturado e correlação, sem alterar a semântica financeira ou os protocolos dos workers.

O escopo inclui:

- Catálogo fechado de eventos operacionais.
- Projeção de registros por allowlist e validação de valores.
- Adapter de logging JSON de linha única.
- Isolamento de falhas dos sinks.
- Eventos financeiros emitidos após a conclusão efetiva do UoW e do ciclo de retries.
- Uso dos identificadores reais disponíveis em cada contexto.
- Eventos operacionais de Consumer SQS, Outbox Publisher e PendingReferenceWorker.
- Integração com a reconciliação do CP-04, preservando seus emissores legados.
- Registro sanitizado de erros HTTP operacionais.

## C. Inventário implementado

### Novos arquivos de produção

1. `src/shared/application/operational-logging.ts` — catálogo de eventos, allowlist, projeção e isolamento de sinks.
2. `src/shared/infrastructure/structured-logger.ts` — adapter NDJSON e writer para `Bun.stderr`.

### Arquivos existentes de produção modificados

3. `src/modules/wallets/application/create-wallet.use-case.ts` — evento de criação após confirmação do UoW.
4. `src/modules/wagering/application/process-wager-transaction.use-case.ts` — eventos terminais, replay e conflito após resolução do processamento e retries.
5. `src/modules/wallets/application/wallet-queries.ts` — integração opcional com logging de divergência, preservando a telemetria do CP-04.
6. `src/modules/messaging/application/sqs-wager-consumer.ts` — eventos distintos para recebimento, ACK, retry e DLQ.
7. `src/modules/messaging/application/outbox-publisher.ts` — eventos distintos para envio, confirmação, retry e perda de lease.
8. `src/modules/wagering/application/pending-reference-worker.ts` — eventos de resolução e reagendamento, mantendo `noop` silencioso.
9. `src/shared/infrastructure/http-exception.filter.ts` — evento sanitizado `operational_error` para erros de servidor.
10. `src/database/database.module.ts` — composição opcional dos sinks sem alterar o comportamento padrão da reconciliação.
11. `src/modules/messaging/messaging.module.ts` — conexão dos sinks operacionais aos providers de mensageria.
12. `src/modules/wagering/wagering.module.ts` — conexão do sink ao PendingReferenceWorker.
13. `src/app.module.ts` — configuração do sink HTTP preservando o provider `HttpExceptionFilter` registrado por classe.

### Novos testes

14. `test/unit/structured-logging.test.ts` — contratos, sanitização, isolamento, eventos e correlação em testes unitários.
15. `test/integration/structured-logging.test.ts` — persistência, replay, retries, workers, protocolos e integração com infraestrutura real.

O preflight de encerramento encontrou exatamente esses 15 caminhos de implementação e testes: 11 arquivos rastreados modificados e quatro novos não rastreados. O único arquivo adicional desta etapa é este relatório.

## D. Contratos e decisões homologadas

A implementação segue CP05-B-DEC-01 a DEC-07 e GREEN-B-COND-01 a COND-04:

- Catálogo fechado de eventos e allowlist de campos.
- Projeção de valores controlados; objetos arbitrários e mensagens brutas de erro não são serializados.
- Ausência de sink operacional mantém chamadas diretas silenciosas.
- Falhas síncronas e assíncronas de observabilidade não alteram resultados financeiros, ACK, retry ou confirmação da Outbox.
- Eventos financeiros definitivos são emitidos depois da confirmação transacional e da resolução do ciclo de retries.
- Replay emite somente `wager_replayed`, usando o identificador histórico.
- Conflito de idempotência não registra UUID candidato, chave ou hash do payload.
- Protocolos NDJSON e diagnósticos legados dos processos filhos são preservados.
- Na reconciliação, a precedência é `telemetry.log` → sink estruturado → `console.warn`; uma falha do emissor selecionado não aciona outro fallback.

O catálogo contém os eventos aprovados para Wallet, Wagering, Consumer SQS, Outbox Publisher, PendingReferenceWorker, reconciliação e HTTP, incluindo `HTTP_ERROR` como código operacional fechado.

## E. Evidências RED/GREEN

### RED original

O Gate RED original adicionou **66 testes**: 60 unitários e seis de integração. Os cenários cobriram as lacunas de estrutura, segurança, isolamento, protocolos e correlação. As falhas RED funcionais foram registradas separadamente de invariantes que já passavam.

### GREEN original e correções de regressão

Durante a validação GREEN foram identificadas duas regressões legadas, corrigidas em autorizações pontuais:

- **T21:** a composição alterou a identidade estrutural do `HttpExceptionFilter`. A correção preservou `useClass`, a identidade de metatype exigida e a injeção opcional do sink.
- **CP-04 VAL02-01:** a composição padrão passou a desviar o fallback histórico esperado. A correção deixou de injetar automaticamente o sink estruturado no `ReconcileWalletUseCase`, preservando a opção explícita e a precedência homologada.

Os testes CP-04 e T21 não foram modificados.

### RED corretivo REV-06/07 e GREEN corretivo

Os testes corretivos demonstraram:

- **CP05B-REV-06 — HIGH:** o writer assíncrono podia manter o emissor ocupado e descartar emissões consecutivas ou concorrentes legítimas.
- **CP05B-REV-07 — LOW:** faltava `HTTP_ERROR` no catálogo de códigos operacionais.

Após a correção, os 13 testes corretivos passaram. O adapter observa a conclusão do writer sem aguardar sua I/O no caminho financeiro; o uso de `WeakSet` evita observar repetidamente a mesma receipt e não introduz fila, timer ou retry. Throws síncronos, rejeições e thenables defeituosos permanecem isolados. `HTTP_ERROR` foi acrescentado ao catálogo fechado, sem alterar o envelope HTTP nem expor mensagens sensíveis.

## F. Regressão final

Resultado da execução final autorizada, registrado em `/tmp/jungle-b-green-post-rev0607.log`:

| Indicador | Resultado |
|---|---:|
| Testes unitários | 691 |
| Testes de integração | 196 |
| Total de testes | 887 |
| Testes CP-05.B | 114 |
| Testes unitários CP-05.B | 102 |
| Testes de integração CP-05.B | 12 |
| Asserções | 5.837 |
| Falhas | 0 |
| Arquivos de teste | 39 |

Typecheck foi executado como validação distinta da regressão:

```text
bun run typecheck — aprovado
```

Comando da regressão:

```text
bun test --preload /tmp/jungle-cp05b-regression-guard.mjs --bail
```

A guarda temporária de migrations estava fora do repositório e não foi incluída no inventário versionável.

Os 114 testes CP-05.B incluem os 13 testes corretivos REV-06/07. As contagens específicas fazem parte da regressão total e não devem ser somadas novamente.

T21 e os três cenários de integração CP-04 VAL02-01 passaram. Também passaram as suítes financeiras, HTTP, SQS, Outbox, PendingReferenceWorker, multiprocessos, shutdown, entrypoints e recuperação distribuída.

## G. Migrations e infraestrutura de teste

A execução autorizada utilizou o banco `jungle_test`, PostgreSQL 16.6, e exclusivamente a migration `Migration202611040001`.

A guarda externa ao repositório registrou:

- 116 chamadas `up` e uma chamada `down`.
- 115 schemas descartáveis exclusivos `jungle_it_<uuid>`.
- Verificação do banco, de `current_schema()` e de `search_path` antes das operações.
- Comparação dos inventários PostgreSQL e SQS antes e depois.
- Inventários final e inicial idênticos.
- Nenhum schema ou recurso descartável residual.
- Recursos preexistentes preservados.

## H. Revisão adversarial

A primeira revisão adversarial resultou em **REPROVAR** e identificou:

- `CP05B-REV-06` — HIGH, perda de emissões consecutivas/concorrentes.
- `CP05B-REV-07` — LOW, ausência de `HTTP_ERROR`.

Ambos foram corrigidos e revalidados com testes corretivos. A segunda revisão adversarial emitiu **APROVAR**, sem novos achados. A revisão examinou especificamente o comportamento do `WeakSet` no adapter do writer.

## I. Riscos residuais aceitos

1. Logging é best-effort; não há garantia de persistência durável dos registros enviados a stderr.
2. O `PendingReferenceWorker` não possui correlação histórica persistida para transações cuja correlação original não foi armazenada.

Essas limitações foram aceitas e não representam defeitos bloqueantes pendentes do CP-05.B.

## J. Integridade Git e conclusão

No preflight somente leitura de 2026-11-05:

- HEAD e `origin/main`: `213803f99c8bdaef10f26bc2660ace12cb6668b0`.
- Branch: `main`.
- Índice vazio antes da criação deste documento; nenhum staging foi realizado.
- Working tree contém os 15 caminhos homologados e este relatório.
- `git diff --check`: aprovado após a criação.
- Nenhum arquivo fora do inventário foi identificado.
- Nenhum commit ou push foi realizado nesta etapa.

O CP-05.B está tecnicamente homologado e este pacote documental foi preparado para aprovação humana. A criação do relatório não realizou staging, commit ou push.
