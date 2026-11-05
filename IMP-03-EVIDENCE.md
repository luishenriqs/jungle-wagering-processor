# JUNGLE-IMP-03 — Mensageria, workers e resiliência distribuída

**Estado atual — IMP-03-CLOSE: IMP-03 TECNICAMENTE APROVADO. VERSIONAMENTO PENDENTE DE AUTORIZAÇÃO HUMANA de Luís Henrique Pereira.** Parecer complementar Antigravity informado por Luís: APROVAR REV3-FIX-01, sem bloqueantes; identificação exibida Gemini 4 Argon — medium. O fechamento ao final registra proveniência, riscos, encaminhamentos e inventário de 61 arquivos candidatos ao futuro commit. Nenhum git add/commit/push executado. IMP-04 não iniciado.

A revisão REV3 inicial reprovou temporariamente o pacote. REV3-FIX-01 corrigiu REV3-01 e cobriu REV3-02 com RED/GREEN e regressão própria do Codex. O parecer complementar agora recebido encerra a pendência de revisão técnica. Os resultados funcionais anteriores, falhas e estados de aprovação abaixo são preservados como histórico, sem atribuí-los à sessão documental atual.

## Histórico da consolidação funcional anterior à revisão REV3

**IMP-03 IMPLEMENTADO E VALIDADO FUNCIONALMENTE. CP-01 a CP-05 funcionalmente validados por execução externa de Luís Henrique Pereira. AGUARDANDO REVISÃO CRÍTICA INDEPENDENTE DO ANTIGRAVITY E APROVAÇÃO HUMANA. IMP-04 NÃO INICIADO.**

Esta consolidação documental substitui as pendências de execução funcional mencionadas no histórico abaixo. Não representa revisão independente concluída, aceite final humano ou publicação Git. Nenhum commit/push foi executado.

### Regressão externa final — responsável técnico

Luís Henrique Pereira informou execução no Ubuntu com PostgreSQL e LocalStack reais (ambiente anteriormente confirmado: PostgreSQL 16.6 e LocalStack 4.10.0):

| Comando | Resultado externo informado por Luís |
|---|---|
| `bun run typecheck` | APROVADO |
| `bun test` | **345 aprovados, 0 falhas, 2500 asserções, 29 arquivos de teste** |
| `bun run check:bootstrap` | APROVADO; NestJS e MikroORM inicializados corretamente |
| `git diff --check` | APROVADO |

Esses comandos de validação funcional **não foram executados pelo Codex nesta sessão**. A origem é o relato explícito do responsável técnico; não foram fornecidos nesta consolidação novos logs individuais por cenário, PIDs ou contagens isoladas do CP-05. Os totais são da suíte completa, incluem regressão de pacotes anteriores e não devem ser somados aos resultados intermediários.

### Estado dos checkpoints

| Checkpoint | Evidência externa e estado funcional |
|---|---|
| CP-01 — infraestrutura/persistência | VALIDADO. SDK 3.922.0, frozen install, typecheck, cinco testes PostgreSQL/31 asserções e três filas FIFO verificadas; redrive para DLQ com maxReceiveCount=5 |
| CP-02 — Consumer/Inbox/ACK/retry/DLQ | VALIDADO. 14 testes/87 asserções no PostgreSQL e LocalStack reais |
| CP-03 — Outbox Publisher | VALIDADO. 10 testes/412 asserções; três processos Bun/backends distintos, 100 eventos sem perda nos cenários testados |
| CP-04 — PendingReferenceWorker | VALIDADO. 20 testes/171 asserções; três processos/backends independentes, referências encadeadas, política e atomicidade |
| CP-05 — shutdown/recuperação | VALIDADO FUNCIONALMENTE pela confirmação de Luís e regressão completa final acima. A execução intermediária de 13 aprovados/1 falha/208 asserções é histórica, anterior à correção do teste de long polling |

Os 345 testes sem falhas substituem o estado de integração pendente. A causa exata da falha antiga não passa a ser retroativamente comprovada: faltava identificação da fase no erro original. Foram corrigidos o orçamento de visibilidade do harness e os diagnósticos; produção financeira permaneceu intacta nessa correção. Nenhuma contagem isolada final do CP-05 foi inferida.

### TTL — decisão aprovada

Luís aprovou formalmente a **Opção A**: TTL limita a espera por referência indisponível. Uma referência já válida pode ser processada no momento da avaliação transacional, mesmo após o prazo de espera originalmente registrado. O teste de referência válida após scan atrasado corresponde à decisão. ARCHITECTURE.md registra o aceite; nenhum comportamento financeiro foi alterado nesta consolidação.

### Resumo técnico para revisão independente do Antigravity

- **Componentes:** LocalStack e provisionamento reproduzível de três filas FIFO/redrive; SDK SQS; Consumer standalone e Inbox transacional; Outbox Publisher com leases/fencing; PendingReferenceWorker e política compartilhada; ClockPort; coordenação de sinais, drenagem e recuperação; testes reais isolados com processos independentes.
- **Contratos financeiros:** Money decimal exato; saldo não negativo; ledger imutável e consistente com Wallet; version controlada pelo domínio; regras de referência/reversão do IMP-02 preservadas. Envelope messageId, SQS MessageId, idempotencyKey e ReceiptHandle mantêm funções distintas.
- **Idempotência/transações:** caso de uso financeiro único; hash canônico e unicidades persistentes; Inbox, estado financeiro, ledger e Outbox no mesmo commit. ACK somente após commit confirmado. Replay não repete efeito financeiro; conflito de hash é permanente. Redrive/retry não dependem de cache ou deduplicação FIFO para segurança financeira.
- **Concorrência:** Wallet → Wager na resolução (Wallet → Inbox → Wager na entrada aplicável); revalidação após locks; nenhum lock global ou financeiro cruzado entre Wallets. Claim de um evento por transação com FOR UPDATE SKIP LOCKED; envio SQS após commit, fora dessa transação. Confirmação/retry condicionados a owner/token e lease válido.
- **Recuperação:** eventId estável em reenvios; at-least-once com possíveis eventos duplicados. SIGTERM cancela polls e drena antes de fechar o ORM; ACK continua após commit. Receipt desconhecido depende de expiração de visibilidade. SIGKILL depende de rollback/Inbox, visibilidade e leases persistentes, sem invocar shutdown gracioso.
- **Testes:** regressão final externa de 345/0/2500 em 29 arquivos, typecheck e bootstrap aprovados; evidências específicas de três processos/backends nos CP-03/04, sinais/reinícios e reconciliação no CP-05. As verificações unitárias anteriores do Codex e tentativas bloqueadas estão preservadas no histórico e não substituem a evidência real externa.
- **Foco de revisão:** interleavings de commit/ACK e send/confirmação, fencing de owner antigo, relógios/leases, cadeia BET → REFUND → ROLLBACK, limites TTL/backoff, shutdown com pool utilizável e recuperação de receipt desconhecido; confirmar alcance dos testes contra os contratos, sem assumir exactly-once.

### Riscos residuais e limites de evidência

1. Revisão independente Antigravity e aprovação humana final ainda pendentes; não há novo parecer independente nesta tarefa.
2. At-least-once permite republicação após envio aceito sem confirmação SQL; consumidores de eventos precisam deduplicar por eventId inclusive fora da janela FIFO. Não se promete ordenação global entre publishers/retries.
3. Relógios UTC devem estar sincronizados; configuração de timeout/lease/visibilidade e prazo do supervisor precisa de margem consistente. Usar o coordenador documentado para fechamento programático de workers.
4. Receives abortados com receipt desconhecido dependem da expiração de visibilidade; o cancelamento cliente não garante cancelamento remoto imediato. A causa específica da falha antiga não foi reconstruída por trace.
5. Falhas/pausas injetadas com serviços reais não demonstram todas as partições físicas de rede ou o comportamento de AWS SQS em produção; LocalStack é o emulador validado. Não se afirma cobertura universal de falhas.
6. VAL02-01 permanece destinado ao IMP-04: divergência real na reconciliação e soma negativa. VAL02-02 foi atendido no CP-04; a semântica TTL foi formalmente aprovada. IMP-04 não iniciado.
7. Busca automatizada por segredos é limitada aos padrões e valores locais examinados; não é garantia absoluta contra todos os formatos de credencial.

## Histórico de implementação e validações intermediárias

As seções seguintes registram o estado **na respectiva etapa**, incluindo bloqueios do sandbox e gates então pendentes. Para o estado atual e a proveniência da regressão final, prevalece a consolidação acima. Preservam-se as falhas anteriores sem apresentá-las como falhas atuais ou novas execuções.

## CP-05 — implementação preparada para validação completa

**Gate externo CP-05 pendente.** CP-01 a CP-04 foram aprovados com evidências externas; a implementação completa do IMP-03 ainda exige integração CP-05, regressão completa, revisão Antigravity e aceite humano. IMP-04 não iniciado.

### Componentes e arquivos desta etapa

- src/shared/application/worker-shutdown.ts: deadline configurado, cancelamento de polls, drenagem idempotente e guarda até fechamento dos recursos. Timeout/falha fatal pede exit 1 e preserva mecanismos persistentes de recuperação.
- src/shared/application/worker-signals.ts: SIGTERM/SIGINT e fechamento coordenado por API pública Nest app.close; completeShutdown somente após todos os hooks/recurso fechados.
- Lifecycles Consumer/Publisher em src/modules/messaging/infrastructure e Pending em src/modules/wagering/infrastructure: usam o protocolo compartilhado, mantendo operações in-flight independentes do cancelamento de poll.
- scripts/consume-wagers.ts, publish-outbox.ts e resolve-pending-references.ts: usam o coordenador de sinais, substituindo o handler automático Nest.
- src/modules/messaging/application/sqs-wager-consumer.ts: sinal opcional de parada; falha concluída devolve visibilidade imediatamente durante shutdown, sem ACK. Rotina financeira intacta.
- test/unit/worker-shutdown.test.ts e caso adicional em sqs-consumer.test.ts: ordem, deadlines, falhas, close, liberação de receipt e proibição de ACK indevido.
- test/support/resilience-child.ts e resilience-client.ts: contexto Nest/ORM/SDK reais, barreiras, sinais OS, observadores de pool e estágios, sem expor receipt/payload/credenciais.
- test/support/sqs.ts: argumentos opcionais de groupId/dedupId para testar 50 entregas sem mascarar concorrência por FIFO; defaults anteriores preservados.
- test/integration/worker-resilience.test.ts: 14 cenários PostgreSQL/LocalStack reais.
- ARCHITECTURE.md, README.md e este relatório: aceites CP-04, protocolo, evidências e limitações.

Nenhuma dependência, migration, Docker/.env ou domínio financeiro alterado nesta etapa. Política de TTL e comportamento financeiro do CP-04 preservados; Opção A de TTL formalmente aprovada por Luís, conforme atualização abaixo.

### Inspeção dos hooks e protocolo

MikroOrmCoreModule instalado fecha ORM em onApplicationShutdown. Nest 11.1.6 espera beforeApplicationShutdown antes dessa fase, mas a ordem final de módulos pode chamar o lifecycle raiz antes do MikroORM importado. A inspeção foi feita nos arquivos instalados, não presumida pela ordem de providers.

A coordenação implementada nos scripts é: receber SIGTERM/SIGINT → cancelar novos polls → aguardar loop/in-flight com deadline → app.close(signal), com o before hook repetido idempotentemente → SDK/ORM encerrados → completeShutdown/stopped. O watchdog continua armado até app.close terminar; não é desarmado num hook local antes do fechamento real do pool. Para fechamento programático, usar closeWorkerApplication em vez de app.close isolado. Não combinar enableWorkerSignals com app.enableShutdownHooks no mesmo worker standalone.

WORKER_SHUTDOWN_TIMEOUT_MS default 60000, faixa 1..300000ms; supervisor precisa de margem adicional antes de SIGKILL. Se expira, processo termina com exit 1; não se segue com fechamento gracioso de pool sob operação desconhecida e não se fabrica ACK. Falha inesperada do loop também pede reinício. Encerramento forçado não é reportado como stopped/gracioso. Os testes podem substituir forceExit para verificar protocolo; produção usa process.exit, e esse seam não é carregado de mensagens.

Consumer cancela receive ocioso. Receipt conhecido sem processamento é liberado com visibility=0; falha de tentativa já encerrada durante parada também devolve imediatamente. Operação financeira em andamento conserva seu próprio ciclo: somente retorno confirmado do caso de uso autoriza DeleteMessage. Commit incerto nunca autoriza ACK. Se o timeout interrompe operação ativa, usa-se término OS + rollback/replay persistente e visibilidade SQS. Uma resposta de receive abortada sem receipt conhecido depende da expiração natural da visibilidade.

Publisher termina envio/confirmação corrente ou deixa lease/retry recuperável; PendingWorker termina candidato corrente e não inicia outro após parada. SIGKILL ignora hooks: a recuperação usa estado persistente, e não logs ou callbacks em memória. Não há alteração das regras financeiras.

### Testes preparados — execução real pendente

1–2. SIGTERM antes de commit e após commit/antes de ACK; query SQL antes de DeleteMessage demonstra pool utilizável e estado financeiro final.
3. SIGTERM com long polling de 20s cancela rapidamente; reinício processa novo trabalho.
4. Receipt recebido e ainda não processado devolve visibility=0 sem commit/ACK; processamento posterior é único.
5–6. SIGKILL antes do commit e após commit/antes do ACK: ausência de hooks graciosos, rollback/replay após reinício e um débito.
7. Deadline de shutdown expira durante transação; exit 1 sem ACK/fechamento gracioso e recuperação após reinício.
8. Cinquenta mensagens lógicas duplicadas, dedupIds distintos e grupos FIFO distintos, três processos/backends: uma execução e 49 replays; um efeito financeiro e reconciliação. Evita usar FIFO como serializador único.
9–10. SIGKILL do Publisher após claim commitado e após SendMessage confirmado; lease sobrevive, expira e reinício publica sem perda, mantendo eventIds.
11. SIGTERM após envio do Publisher conserva pool até confirmação SQL e reinício publica os restantes.
12. SIGTERM do PendingWorker confirma somente candidato in-flight, preserva pool, reinício resolve candidato restante sem repetição financeira.
13. Deduplicação FIFO dentro da janela é verificada separadamente da idempotência persistente.
14. Rollback encerrado durante SIGTERM devolve receipt sem ACK/efeito parcial e reinício aplica uma vez.

Contexto do harness usa MikroOrmModule real com banco jungle_test/schema descartável e filas jungle_it_<uuid>. Barreiras/observadores apenas pausam fases; não substituem PostgreSQL/SQS. Testes usam sinais reais via child_process.kill; não simulam SIGKILL com callbacks. Pool close e consulta pré-ACK delegam operações reais. Nenhum recurso de outro projeto, fila compartilhada ou volume é removido. Reconciliação é exigida nos cenários financeiros.

### Evidências realmente executadas pelo Codex

| Verificação | Resultado |
|---|---|
| Primeiros testes de shutdown | 9 pass, 0 fail, 32 asserções na etapa inicial |
| Typecheck inicial do harness | Falhou: cast genérico OutboxClaim e array implícito; corrigidos com guarda instanceof e tipagem explícita |
| Testes finais isolados worker-shutdown | **14 pass, 0 fail, 43 asserções** |
| bun run typecheck final | Exit 0 |
| bun test test/unit final | **243 pass, 0 fail, 1348 asserções, 20 arquivos** |
| bun test test/integration/worker-resilience.test.ts | **Exit 1: 0 pass, 14 fail**, ECONNREFUSED 127.0.0.1:5434 no setup |
| bun test final | **Exit 1: 243 pass, 66 fail, 1348 asserções, 28 arquivos**; falhas de preparação PostgreSQL/LocalStack, sem aprovação dos cenários reais |
| bun run check:bootstrap | Exit 1, ECONNREFUSED 127.0.0.1:5433; não aprovado nesta sessão |
| git diff --check | Aprovado |
| Normativos/IMP-01/02-EVIDENCE/domínios financeiros/Wallets/migrations vs HEAD | Preservados |

Nenhum corpo dos 14 cenários CP-05 executou no sandbox. Nenhum processo filho, sinal real, commit financeiro, ACK, criação de filas ou migration do harness foi executado nessa tentativa bloqueada. Não há novos PIDs/evidências SQL/SQS para reportar. Os unitários verificam protocolo, não recuperação distribuída. Não foram contornadas permissões.

### Rastreabilidade T01–T24

| Cenário original | Suíte/estado |
|---|---|
| T01 — 50 duplicadas | CP-05 worker-resilience, externo pendente |
| T02 — publishers concorrentes | CP-03 aprovado externamente (três processos/100 eventos) |
| T03 — crash commit/ACK | CP-05 SIGKILL, externo pendente; falha ACK injetada já aprovada CP-02 |
| T04/T05 — crash claim/publish | Encerramento abrupto CP-03 aprovado; SIGKILL CP-05 pendente |
| T06/T17 — lease expirado/owner antigo | CP-01/CP-03 aprovados externamente |
| T07/T08 — ordem/expiração referência | CP-04 aprovado externamente |
| T09/T19 — inválidas/JSON DLQ | CP-02 aprovado externamente |
| T10 — falhas transitórias PG/SQS | CP-02/CP-03: erros PostgreSQL e perda de confirmação/timeout injetados com serviços reais aprovados; partição física de rede não alegada |
| T11 — SIGTERM | CP-05 externo pendente |
| T12 — restart workers | CP-05 externo pendente |
| T13 — Wallets independentes | IMP-02 multiprocessos/CP-04 aprovados externamente |
| T14 — reconciliação | Asserções nos cenários financeiros; novos CP-05 pendentes |
| T15/T16 — backoff/Clock | CP-03/CP-04 aprovados externamente |
| T18 — timeout após aceite SQS | CP-03 envio real + perda de confirmação injetada aprovado |
| T20 — cadeia/três workers | CP-04 aprovado externamente |
| T21 — pool preservado | CP-05 Nest/ORM reais, externo pendente |
| T22 — dedup FIFO | CP-05 teste específico, externo pendente |
| T23 — IDs distintos/mesma key | CP-02 aprovado externamente |
| T24 — DLQ falha/sem ACK | CP-02 aprovado externamente |

### Comandos externos para validar CP-05 e regressão completa

Executar no Ubuntu com serviços existentes healthy e URLs somente no .env local ignorado/ambiente:

```sh
cd /home/luishenriqs/projects/Jungle
export PATH="$HOME/.bun/bin:$PATH"
bun install --frozen-lockfile
bun scripts/check-sqs.ts
bun run typecheck
bun test test/unit
bun test test/integration/worker-resilience.test.ts
bun test test/integration/pending-reference-worker.test.ts
bun test test/integration/outbox-publisher.test.ts
bun test test/integration/sqs-consumer.test.ts
bun test test/integration/worker-persistence.test.ts
bun test test/integration/schema.test.ts
bun test test/integration/financial.test.ts
bun test test/integration/multiprocess.test.ts
bun test
bun run check:bootstrap
git diff --check
git status --short --untracked-files=all
```

Enviar saídas sanitizadas/códigos de retorno, incluindo identidades de processo/backend impressas. Não usar app/consumidor/publisher nas filas compartilhadas como substituto dos testes isolados. Não executar reset, rollback manual ou down -v. O harness remove somente seus schemas/filas.

**Riscos/pendências:** integração externa CP-05 e regressão final ainda não aprovadas; semântica TTL aprovada na Opção A, sem alteração financeira; clock/configuração/supervisor precisam de orçamento consistente; partição de rede física não foi comprovada; fechamento programático deve usar coordenador; revisão Antigravity e aprovação humana pendentes. **IMP-03: implementação preparada para validação completa. IMP-04 não iniciado. Nenhum commit/push.**

## Encerramento CP-04 — execução externa de Luís

Luís Henrique Pereira confirmou `bun test test/integration/pending-reference-worker.test.ts`: **20 testes aprovados, 0 falhas, 171 asserções**, PostgreSQL 16.6 real, três processos Bun e backends independentes. Evidência externa inclui referências fora de ordem/cadeia BET → REFUND → ROLLBACK, concorrência/replays, TTL/backoff, não duplicação, atomicidade, retry 40P01 e independência entre Wallets. **Gate CP-04 validado.** Não são execuções do Codex nesta sessão. CP-05 iniciado; IMP-04 não autorizado.

### Conferência explícita da semântica TTL

A seção 5 da arquitetura normativa, linha 199, diz que vale o primeiro limite de tentativas/TTL; a linha 201 especifica “ausência após tentativas/TTL”. O teste aprovado `available valid reference is processed even when worker scan was delayed beyond the waiting TTL` aplica a segunda leitura: limite de espera por referência ainda indisponível, mantendo avaliação financeira quando a referência já está válida. A formulação geral admite leitura alternativa de prazo absoluto. A ambiguidade foi apresentada ao responsável para definição explícita; **nenhuma alteração financeira será feita sem orientação**. O comportamento validado do CP-04 foi preservado, e a implementação independente de shutdown pode prosseguir. Atualização: Luís aprovou formalmente a Opção A na ordem de diagnóstico CP-05: TTL limita espera por referência indisponível; referência já válida pode processar após o prazo. Rastreabilidade semântica encerrada, sem alteração do comportamento financeiro. Ver ARCHITECTURE.md.

## CP-04 — implementação/tentativas locais (histórico anterior ao aceite externo)

### Arquivos criados/alterados nesta etapa

| Arquivos | Finalidade |
|---|---|
| src/modules/wagering/application/pending-reference-policy.ts | Política única validada de TTL, delay e tentativas; inicialização e cálculo seguro de próximo retry |
| src/modules/wagering/application/pending-reference-worker.ts | Descoberta, locks, revalidação, regras originais, transação financeira e retry infra |
| src/modules/wagering/application/process-wager-transaction.use-case.ts | Substitui somente constantes de agendamento por política compartilhada; override opcional preserva compatibilidade |
| src/modules/messaging/application/worker-config.ts | Delega configuração de referência à fonte compartilhada |
| src/modules/wagering/wagering.module.ts; infrastructure/pending-reference-lifecycle.ts | Composição standalone explícita e drenagem inicial antes do fechamento ORM |
| scripts/resolve-pending-references.ts | Entrada operacional Nest; não aplica migrations/SQS |
| test/unit/pending-reference-policy.test.ts; pending-reference-worker.test.ts | Política, limites, ordem de locks, transições, eventos, snapshots, guardas e inicialização |
| test/integration/pending-reference-worker.test.ts | 20 cenários reais PostgreSQL, incluindo falhas atômicas, cadeias e concorrência |
| test/support/pending-worker-child.ts; pending-worker-client.ts | Processos independentes, readiness/barreira, pool de uma conexão e PIDs reais quando executados |
| ARCHITECTURE.md; README.md; este relatório | Gate CP-03 externo, decisões e instruções CP-04 |

Infrastructure acima relativa a src/modules/wagering. Preservados domínio financeiro, migrations, contratos/implementação SQL CP-01, dependências, lockfile, Compose e componentes CP-02/03. Nenhum novo FailureCode/regra financeira introduzido. **VAL02-02 implementado**; aceite final condicionado à validação real CP-04.

### Comportamento e decisões

- Política única PENDING_REF_BASE_DELAY_MS=1000, PENDING_REF_MAX_ATTEMPTS=10 e PENDING_REF_TTL_MS=86400000; defaults anteriores preservados. Aceitação, worker e WorkerConfig compartilham validação. Prazo persistido é autoridade e não é estendido ao reagendar/reiniciar; base/limite atuais devem ser iguais entre processos.
- Descoberta usa findDuePendingWagers com ClockPort explícito e sem lock. Cada candidato abre transação; Wallet FOR UPDATE é o primeiro lock financeiro. Leitura de associação sem lock previne bloquear wager de outra Wallet por candidato incorreto; depois Wager FOR UPDATE e revalidação de status/vencimento com horário pós-lock. Referências de outra Wallet ficam somente leitura.
- Avaliação usa evaluateWager, Wallet, WagerTransaction e factories de eventos existentes. Referência PROCESSED válida resolve; referência terminal inválida preserva código original; referência temporariamente pendente espera. TTL limita espera por referência ainda indisponível; referência disponível é avaliada mesmo se o scan atrasou além do prazo. Não se cria nova regra de invalidade financeira por atraso do worker.
- attempts é o número de reagendamentos. A checagem atual tem número attempts+1; se referência segue indisponível, o limite impede nova checagem além do máximo. Primeiro retry agendado no aceite usa base; próximo vencimento usa base*2, depois base*4 etc. Antes de construir Date/chamar reschedulePendingReference, verifica tentativas, deadline e next < expiresAt. Se não couber, rejeita REFERENCE_NOT_FOUND_TIMEOUT; nenhum clamp ou data inválida é passado ao domínio.
- Reagendamento só altera tentativa/próxima data, preserva snapshot e prazo, e não repete evento PendingReference. Terminalização registra saldo observado na resolução, atualiza status, grava ledger/movimento e eventos juntos. updatePendingWager usa condição de origem PENDING_REFERENCE e quantidade afetada obrigatória; zero inesperado aborta a transação inteira.
- Worker não altera Inbox já processada no aceite. Eventos terminais preservam contrato v1; correlationId/causationId usam transactionId estável, pois a correlação original não é coluna do Wager. Eventos de aceite continuam intactos. Não se inventa correlação original ou altera schema para isso.
- Infra transitória recebe retry da transação inteira em contexto limpo; não consome tentativa de referência. Falhas não transitórias são diagnosticadas sem erro/payload bruto e mantêm estado para investigação/retry, sem terminalizar arbitrariamente.
- Composição inicial interrompe novos candidatos e drena operações antes de ORM fechar. Configuração de timeout de shutdown, SIGTERM real e prova completa do pool continuam no CP-05, não iniciado.

### Verificações executadas pelo Codex

| Verificação | Resultado real |
|---|---|
| Git inicial | main, HEAD 013f151470b688b4f13469f73332ac4acf43f8fd; alterações CP-01/02/03 esperadas preservadas |
| Política nova + configuração anterior | 28 pass, 0 fail, 115 asserções em dois arquivos naquela etapa |
| Primeira suíte isolada do worker | 16 pass, 0 fail, 126 asserções antes dos casos adicionais/revisão de guardas |
| bun run typecheck | Exit 0, fontes/scripts/testes strict |
| bun test test/unit final | **228 pass, 0 fail, 1302 asserções, 19 arquivos** |
| Primeira integração preparada, 19 cenários | Exit 1: 0 pass, 19 fail por ECONNREFUSED no setup PostgreSQL |
| bun test test/integration/pending-reference-worker.test.ts, suíte final | **Exit 1: 0 pass, 20 fail**, ECONNREFUSED 127.0.0.1:5434 em setup |
| bun run check:bootstrap | Exit 1: ECONNREFUSED 127.0.0.1:5433; bootstrap não aprovado nesta sessão |
| git diff --check | Aprovado |
| Diff dos normativos, IMP-01/02-EVIDENCE, domínios Wager/Wallet, código wallets e migrations | Sem alterações contra HEAD |

Nenhum corpo dos 20 cenários de integração foi executado nesta sessão; nenhum processo auxiliar, migração nova ou operação financeira foi iniciado no sandbox. A recusa TCP não é apresentada como falha funcional dos cenários. Não se presume aprovação real pelos unitários. Não foram fabricados PIDs ou contagens de efeitos persistidos. Bloqueio não foi contornado.

### Testes reais preparados, ainda não aprovados

1. Agendamento customizado compartilhado, REFUND após BET tardia, persistência atômica, replay histórico e Inbox preservada.
2. Referência ausente: reschedule conserva snapshot/prazo, Wallet, ledger, Inbox e Outbox.
3. Expiração exata: referência ausente rejeita com código estável e snapshot terminal atual.
4–5. Última checagem permitida: ausência encerra; referência disponível processa.
6–7. Backoff igual/posterior a expiresAt encerra sem loop ou data inválida.
8. Referência terminal inválida recebe REFERENCE_NOT_PROCESSED.
9. BET → REFUND → ROLLBACK fora de ordem, espera por referência temporária e três processos concorrentes.
10. Três processos/backend PIDs distintos disputam o mesmo pending; um processa, dois fazem no-op, com replay simultâneo pelo caso de uso.
11. REFUND/ROLLBACK da mesma BET concorrentes: um crédito e uma rejeição, sem duplicação.
12. ROLLBACK de WIN sem fundos recebe INSUFFICIENT_FUNDS_REVERSAL.
13–17. Falhas após wallet/wager/ledger/outbox/antes de commit: rollback integral e recuperação sem duplicação.
18. PostgreSQL injeta 40P01 uma vez; retry inteiro confirma um efeito e preserva tentativas. Não é prova de deadlock físico.
19. Referência válida disponível processa após scan atrasado além do TTL de espera.
20. Referência cruzada é rejeitada sem esperar o lock de outra Wallet.

Reconciliação é verificada nos cenários financeiros. Childs usam PostgreSQL real e pool individual max=1; tempo virtual só controla vencimento. Cada teste usa schema jungle_it_<uuid> em jungle_test e o remove após finalizar; nunca jungle_dev. CP-04 não exige LocalStack para esses testes, pois grava somente Outbox.

### Execução externa necessária para validar CP-04

Com TEST_DATABASE_URL e DATABASE_URL corretos no .env local ignorado e PostgreSQL/LocalStack existentes healthy, executar no Ubuntu:

```sh
cd /home/luishenriqs/projects/Jungle
export PATH="$HOME/.bun/bin:$PATH"
bun install --frozen-lockfile
bun run typecheck
bun test test/unit
bun test test/integration/pending-reference-worker.test.ts
bun test test/integration/worker-persistence.test.ts
bun test test/integration/financial.test.ts
bun test test/integration/multiprocess.test.ts
bun test test/integration/sqs-consumer.test.ts
bun test test/integration/outbox-publisher.test.ts
bun test
bun run check:bootstrap
git diff --check
```

Enviar saídas sanitizadas, códigos de retorno e PIDs/backend PIDs impressos pela suíte. Sem reset/down -v/rollback manual. A entrada operacional `bun scripts/resolve-pending-references.ts` atua no DATABASE_URL configurado; não deve ser usada como substituto do harness isolado para testes. Não foi iniciada contra o desenvolvimento nesta sessão.

**Gate CP-04 pendente. CP-05 e IMP-04 não iniciados.** Riscos: ausência de validação real do worker novo; repetição dos regressivos requerida após ligar política à entrada; relógios/configurações precisam permanecer consistentes entre instâncias; correlação worker é vinculada ao transactionId; provas de shutdown com timeout/SIGTERM/pool ficam no CP-05. VAL02-01 continua destinado ao IMP-04, sem alteração nesta tarefa. Nenhum commit/push.

## Encerramento CP-03 — execução externa de Luís

Luís Henrique Pereira confirmou `bun test test/integration/outbox-publisher.test.ts`: **10 testes aprovados, 0 falhas, 412 asserções**, em PostgreSQL 16.6 e LocalStack 4.10.0 reais. Três processos Bun e três backends PostgreSQL distintos processaram 100 eventos sem perda nos cenários testados. Foram aprovados claim antes do envio, envio fora da transação SQL, recuperação/expiração de lease, encerramentos após claim e publish, timeout após aceite SQS, fencing de confirmação/reagendamento tardios, invisibilidade de eventos não commitados e backoff. **Gate CP-03 validado.** Evidência externa atribuída a Luís, não executada pelo Codex nesta sessão. As pendências históricas CP-03 abaixo estão superadas por essa execução. CP-04 iniciado; CP-05 depende de seu gate.

## CP-03 — implementação e tentativas locais (histórico anterior ao aceite externo)

### Arquivos desta etapa

- src/modules/messaging/application/outbox-publisher.ts: publicação de um evento por tentativa, claim commitado antes de SQS, timeout, confirmação/retry fenced e loop com ClockPort.
- src/modules/messaging/infrastructure/aws-sqs-outbox-transport.ts: SDK SendMessage para wagering-events.fifo; corpo original, group=aggregateId, dedup=eventId e verificação de FIFO no startup.
- src/modules/messaging/infrastructure/publisher-lifecycle.ts: composição inicial do loop e drenagem antes do fechamento ORM; provas completas/timeout configurável de shutdown ficam no CP-05.
- src/modules/messaging/messaging.module.ts: forPublisher standalone, preservando forConsumer/base.
- scripts/publish-outbox.ts: entrada Nest operacional explícita; startup falho encerra com exit 1, sem log de segredo.
- test/unit/outbox-publisher.test.ts: 15 testes de protocolo/configuração/serialização; não demonstram concorrência persistente.
- test/integration/outbox-publisher.test.ts: dez cenários reais PostgreSQL/LocalStack.
- test/support/outbox-sqs.ts: fila de eventos por teste, sem PurgeQueue/filas compartilhadas.
- test/support/outbox-publisher-child.ts e outbox-publisher-client.ts: processos Bun independentes, pool individual max=1, readiness/barreira e encerramentos abruptos após fases duráveis.
- ARCHITECTURE.md, README.md e este relatório: CP-02 externo validado e estado/decisões CP-03.

Nenhuma dependência adicionada, nenhum SQL de persistência/migration ou domínio financeiro alterado no CP-03. Métodos CP-01 foram reutilizados. Modificações de etapas anteriores preservadas.

### Protocolo e recuperação

1. ClockPort fornece instante explícito; token UUID novo por tentativa, owner estável da instância, lease configurado. claimNextOutbox seleciona um evento com FOR UPDATE SKIP LOCKED e grava lease na transação.
2. Aguardar commit do claim. Validar margem restante de pelo menos timeout SQS + 1000ms; se insuficiente, não enviar, deixar lease expirar.
3. Publicar envelope persistido fora da transação SQL. MessageGroupId=aggregateId; MessageDeduplicationId=eventId. Nenhum novo eventId/timestamp/contrato é criado ao reenviar.
4. Envio confirmado: completeOutbox em outra transação, com owner/token/evento pendente/lease válido. Zero linhas significa claim perdido; não sobrescrever outro owner.
5. Envio falho ou ambíguo: scheduleRetry usando base/teto configurados, failOutbox em transação separada com fencing e contador anterior. Não descartar evento por limite de tentativas. Se lease expirou, update retorna false e ownership novo é preservado.
6. SQL indisponível após aceite SQS: confirmação pendente e lease recuperável; não converter em falha SQS nem marcar publicado sem persistência confirmada.
7. Crash após claim ou após publish: lease persistido expira, outro processo retoma; reenvio é permitido e mantém identidade. FIFO não é a garantia definitiva: duplicatas fora da janela são possíveis e consumidores devem deduplicar eventId.

Timer/AbortSignal impõe SQS_SEND_TIMEOUT_MS; não há heartbeat. Defaults 10000/3000ms (lease/send), backoff 1000..60000ms; poll 250ms. Configuração externa validada e código diagnóstico seguro, sem payload/erro bruto. Relógios UTC sincronizados e desvio monitorado são requisito operacional; ClockPort não corrige skew. Loop e lifecycle iniciais não substituem prova de shutdown/pool do CP-05.

### Evidências próprias do Codex

| Verificação | Resultado executado |
|---|---|
| Estado inicial | main, HEAD 013f151470b688b4f13469f73332ac4acf43f8fd; alterações CP-01/02 esperadas preservadas |
| bun test test/unit/outbox-publisher.test.ts | **15 pass, 0 fail, 159 asserções** |
| bun test test/unit | **195 pass, 0 fail, 1137 asserções, 17 arquivos** |
| bun run typecheck | Exit 0, incluindo harness de processos e todos os testes novos |
| Primeira tentativa de integração, oito cenários então preparados | Exit 1: 0 pass, 8 fail, todos em setup por ECONNREFUSED LocalStack |
| bun test test/integration/outbox-publisher.test.ts, dez cenários preparados | **Exit 1: 0 pass, 10 fail**, ECONNREFUSED 127.0.0.1:4566 no setup |
| git diff --check | Aprovado |
| Normativos/IMP-01-EVIDENCE/IMP-02-EVIDENCE, wagering/wallets e migrations vs HEAD | Preservados |

Não houve execução financeira, envio/claim real, criação de filas ou inicialização dos processos auxiliares no sandbox: todos os testes reais pararam na preparação do LocalStack. Nenhum PID/saldo/contagem real foi inventado. As falhas de setup não são resultados dos cenários financeiros. Typecheck e protocolo unitário não aprovam o gate CP-03.

### Suíte real preparada — resultados ainda não comprovados

1. Claim commitado e lock liberado antes de SendMessage real (checagem independente FOR UPDATE NOWAIT); corpo/IDs preservados e confirmação SQL posterior.
2. 100 eventos, três processos Bun com três pg_backend_pid distintos, barreira de início, participação dos três publishers, todos os IDs observados na fila e Outbox publicada; reconciliação das 50 Wallets. PIDs serão impressos somente após execução real.
3. Processo encerra com exit 71 após commit do claim, sem shutdown ORM/SQS; lease sobrevive e outro publisher recupera após avanço de ClockPort.
4. Processo encerra com exit 72 após SendMessage confirmado e antes de published_at; outro publisher republica o mesmo eventId e confirma no PostgreSQL.
5. Aceite SQS real seguido de perda de confirmação injetada: timer real do Publisher expira, backoff é persistido e retry mantém eventId. Não é apresentado como partição TCP real observada.
6. Owner antigo confirma tardiamente após owner novo publicar: fencing recusa alteração.
7. Owner antigo tenta reagendar enquanto owner novo detém o lease: token/owner/attempts novos preservados.
8. Falha de confirmação SQL injetada após SendMessage real: recuperação por expiração, sem perda do evento.
9. Outbox de transação financeira ainda não commitada é invisível ao publisher; só publica depois do commit.
10. Retry configurado 10/20ms sobrevive à reidratação SQL, cresce exponencialmente, respeita teto e publica após recuperação.

Cada teste cria fila jungle_it_<uuid>_events.fifo e schema próprio em jungle_test. Nunca usa jungle_dev, PurgeQueue ou filas compartilhadas. Processos são reais quando executados; virtualização se limita ao relógio para expiração de leases. A fila é lida por eventId e permite duplicatas, sem depender da janela FIFO para concluir ausência de perda. Não se aguardou a janela de cinco minutos nem foi demonstrado comportamento fora dela nesta sessão.

### Validação externa para encerrar CP-03

Com .env local ignorado contendo URLs corretas e os serviços existentes healthy, executar no Ubuntu:

```sh
cd /home/luishenriqs/projects/Jungle
export PATH="$HOME/.bun/bin:$PATH"
bun install --frozen-lockfile
bun scripts/check-sqs.ts
bun run typecheck
bun test test/unit
bun test test/integration/outbox-publisher.test.ts
bun test test/integration/worker-persistence.test.ts
bun test test/integration/sqs-consumer.test.ts
bun test
bun run check:bootstrap
git diff --check
```

Enviar saídas sanitizadas e códigos de retorno, incluindo PIDs/backend PIDs que o teste de três publishers imprime. Não executar reset/down -v/migration rollback manual. A inicialização operacional `bun scripts/publish-outbox.ts` não é usada como teste contra filas compartilhadas e não executa migrations.

**Gate CP-03 pendente desses resultados reais. CP-04 não iniciado. CP-05 e IMP-04 não iniciados.** Riscos residuais: validação SQL/SQS do código novo ausente no sandbox; harness/crashes precisam de execução externa; clock skew e timeout devem ser monitorados; eventos persistentemente inválidos ficam pendentes com retry para investigação, sem descarte silencioso; janela FIFO não dá exactly-once; tratamento de SIGTERM/limite de drenagem e preservação do pool ainda exigem CP-05. Nenhum commit/push.

## Encerramento CP-02 — execução externa de Luís

Luís Henrique Pereira informou `bun test test/integration/sqs-consumer.test.ts`: **14 testes aprovados, 0 falhas, 87 asserções**, PostgreSQL 16.6 e LocalStack 4.10.0 healthy. Foram validados ACK após commit, Inbox persistente, replay/colisões, erros permanentes, DLQ FIFO, retry/redrive, recuperação de ACK e rollback PostgreSQL. **Gate CP-02 validado.** Essa execução não foi realizada pelo Codex nesta sessão. As pendências de integração e tentativas bloqueadas abaixo são históricas e estão superadas por essa evidência. CP-03 iniciado, CP-04 bloqueado até seu gate.

## CP-02 — implementação e validação incremental (histórico anterior ao aceite externo)

**Fontes implementadas; gate funcional não aprovado ainda.** Os resultados CP-01 já aceitos não são apresentados como validação do novo Consumer.

### Componentes criados/alterados nesta etapa

| Arquivos | Finalidade |
|---|---|
| application/wager-request.ts | Decoder do envelope original, datas ISO válidas, campos whitelisted, Money, UUID interno e metadata de Inbox |
| application/consumer-config.ts | Configuração validada de polling, visibilidade, timeout, backoff e limite de receives |
| application/consumer-errors.ts | Taxonomia permanente/transitório/desconhecido sem log de erro bruto |
| application/sqs-transport.ts | Porta com identidades distintas para transporte e receipt |
| application/sqs-wager-consumer.ts | Reuso do caso de uso financeiro, ACK após commit, retries e encaminhamento seguro à DLQ |
| infrastructure/local-sqs-client.ts | Cliente SDK fixado ao emulador local, credenciais sintéticas, uma tentativa por requisição |
| infrastructure/aws-sqs-consumer-transport.ts | Receive/Delete/ChangeVisibility/Send reais; conferência inicial de FIFO e redrive |
| infrastructure/consumer-lifecycle.ts | Loop standalone Nest, cancelamento de poll e drenagem inicial; provas completas ficam no CP-05 |
| messaging.module.ts; scripts/consume-wagers.ts | Composição Nest explícita para consumidor; módulo base HTTP não inicia worker |
| test/unit/sqs-consumer.test.ts | 38 testes de protocolo/erros/contratos, sem alegação de garantia distribuída |
| test/support/sqs.ts; test/integration/sqs-consumer.test.ts | Filas reais exclusivas por teste e 14 cenários PostgreSQL + LocalStack |
| ARCHITECTURE.md; README.md; este relatório | Decisões, configuração, comandos e proveniência |

Caminhos application/infrastructure acima relativos a src/modules/messaging. Nenhuma dependência adicional foi instalada nesta etapa; SDK permanece 3.922.0. Código de wagering/wallets e migrations do IMP-02 preservados.

### Contratos e decisões

- envelope.messageId é a identidade Inbox; sqs.MessageId serve ao transporte/diagnóstico; data.idempotencyKey é financeira; ReceiptHandle só autoriza operações efêmeras SQS. Não são intercambiáveis.
- Decoder valida JSON/envelope/ISO-8601 e constrói somente os campos de entrada existentes. Money e validações financeiras continuam no domínio/caso de uso original. playerId textual é preservado; somente walletId é UUID interno. Referência ausente/null é normalizada; transporte não entra no hash canônico.
- execute do ProcessWagerTransactionUseCase retorna após commit transacional de Wallet/wager/ledger/Inbox/Outbox. Somente então DeleteMessage é chamado. Resultados persistidos PROCESSED/REJECTED/PENDING_REFERENCE e replay fazem ACK; FAILED histórico também pode ser confirmado em replay. Resultado PENDING inesperado não autoriza ACK.
- Exceção transitória usa visibilidade com backoff exponencial limitado e redrive nativo. Desconhecido primeiro recebe retry e, no limite configurado, diagnóstico à DLQ; não vira permanente imediatamente. Constraint SQL inesperada permanece desconhecida, em vez de ser tratada automaticamente como contrato inválido.
- Falha de ACK após commit não envia a operação financeira à DLQ: mantém redelivery/replay. Falha de ChangeVisibility não executa ACK; timeout original/redrive continuam aplicáveis.
- Envio manual à DLQ precisa retornar MessageId confirmado antes de DeleteMessage. GroupId e dedupId determinísticos por identidade SQS/hash; retry do mesmo encaminhamento pode ser deduplicado na janela FIFO. Fora dela, diagnósticos duplicados são possíveis; não se promete exactly-once.
- Corpo manual da DLQ contém tipo/versão, sourceMessageId, bodyHash, código estável, receiveCount e occurredAt. Não copia payload financeiro, receipt, exceção bruta ou credencial. Trade-off: não permite reconstruir o original apenas pela mensagem manual; usar identidades/hash e produtor para investigação. Redrive nativo preserva original segundo a semântica SQS.
- Adapter confere FIFO e policy real no startup, incluindo ARN da DLQ e maxReceiveCount. SQS_CONSUMER_NAME deve ser estável entre instâncias. Relógio, retry e timeouts configuráveis; nenhuma deduplicação em memória.
- Composição Nest standalone é explícita. Cancelamento de long polling e drenagem inicial estão presentes; limite configurável de shutdown, SIGTERM real, processos independentes e comportamento do pool continuam pendentes do CP-05. Não se declaram essas garantias concluídas.

### Evidências executadas pelo Codex

| Verificação | Resultado |
|---|---|
| Primeira suíte nova de unidade | 36 pass, 0 fail, 130 asserções |
| Typecheck após implementação | Exit 0 |
| Unitários após casos adicionais de PENDING inesperado/cancelamento de poll | **180 pass, 0 fail, 978 asserções, 16 arquivos**; 38 testes novos incluídos |
| bun test test/integration/sqs-consumer.test.ts | **Exit 1: 0 pass, 14 fail**; ECONNREFUSED 127.0.0.1:4566 em setup, antes dos corpos dos cenários |
| bun test (regressão completa tentada) | Exit 1: **180 pass, 22 fail, 978 asserções, 21 arquivos**; falhas de preparação PostgreSQL/LocalStack, não aprovação dos cenários de integração |
| bun run check:bootstrap | Exit 1: ECONNREFUSED 127.0.0.1:5433; bootstrap não aprovado nesta sessão |
| git diff --check | Aprovado |
| Normativos, IMP-01/02-EVIDENCE, wagering/wallets e migrations vs HEAD | Sem alterações |

Os dublês locais testam apenas protocolo e classificação; não simulam PostgreSQL/SQS para declarar validação distribuída. A suíte real não omite testes por falta de ambiente. Nenhuma fila foi criada/apagada e nenhum cenário financeiro novo foi executado no sandbox nesta tentativa bloqueada. Não houve contorno de rede/permissões.

### Cenários reais preparados, não aprovados nesta sessão

1. Mensagem válida: confirmar Inbox, wager, Wallet, ledger e Outbox por consulta independente antes do ACK real.
2. Redelivery lógico do mesmo envelope com dedup SQS diferente: um efeito e uma Inbox.
3. Envelope diferente/mesma key: duas Inbox, um efeito.
4. Colisão de Inbox com operação/payload divergente: conflito permanente e DLQ.
5. Key conflitante com novo envelope: snapshot/saldo preservados.
6. JSON inválido: FIFO DLQ confirmada e origem apagada; sem copiar conteúdo sensível.
7–8. REJECTED e PENDING_REFERENCE persistidos: ACK, sem DLQ indevida.
9. Trigger PostgreSQL injeta 40P01: rollback integral, sem ACK e sucesso em redelivery após recuperação. Isso não é prova de deadlock físico.
10. Remover somente DLQ isolada do teste provoca falha real de SendMessage: origem continua disponível.
11. ACK falho injetado após commit real: redelivery real faz replay, sem segundo débito. Não é crash de processo real; prova correspondente fica no CP-05.
12. Exceção desconhecida injetada respeita receive count real e limite antes da DLQ.
13. Transiente PostgreSQL persistente esgota redrive nativo sem commit financeiro.
14. Startup recusa divergência entre maxReceiveCount configurado e redrive real.

Após cenários financeiros, os testes verificam reconciliação. Cada teste usa filas jungle_it_<uuid> e schema descartável em jungle_test. Não usa PurgeQueue nem filas de produção/compartilhadas; não há rollback em jungle_dev. O harness só remove recursos que criou.

### Execução externa necessária para fechar o gate CP-02

Com LocalStack/PostgreSQL existentes healthy e URLs em .env local ignorado, executar no Ubuntu:

```sh
cd /home/luishenriqs/projects/Jungle
export PATH="$HOME/.bun/bin:$PATH"
bun install --frozen-lockfile
bun scripts/check-sqs.ts
bun run typecheck
bun test test/unit
bun test test/integration/sqs-consumer.test.ts
bun test test/integration/worker-persistence.test.ts
bun test test/integration/schema.test.ts
bun test test/integration/financial.test.ts
bun test test/integration/multiprocess.test.ts
bun test
bun run check:bootstrap
git diff --check
```

Enviar saídas sanitizadas e códigos de retorno; não imprimir variáveis de segredo, .env ou docker compose config completo. Nenhum comando de reset/migration down manual necessário. Para operação manual autorizada do consumidor: `bun scripts/consume-wagers.ts`; ele usa DATABASE_URL e filas configuradas, sem aplicar migrations. Não iniciar esse processo sobre filas compartilhadas para testar cenários isolados.

**Pendências/riscos:** execução real dos 14 cenários e regressão; startup Nest + SQS/PG ainda não provado nesta sessão; recuperação real com três processos, SIGTERM/pool e timeout de shutdown pendentes do CP-05; TTL/backoff de referência pendente do CP-04; publisher/fencing operacional pendentes do CP-03. CP-03 a CP-05 não iniciados nesta entrega, respeitando o gate CP-02. IMP-04 não iniciado. Nenhum commit/push.

## Encerramento CP-01 — evidência externa final

Luís Henrique Pereira confirmou execução externa de `bun scripts/check-sqs.ts`, exit **0**, no LocalStack real: `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wagering-events.fifo` verificadas; redrive da entrada apontando para a DLQ verificada, maxReceiveCount=5. Somam-se SDK 3.922.0 instalado, frozen install, typecheck, cinco testes PostgreSQL/31 asserções e 142 unitários aprovados. **Gate CP-01 validado.** Não se atribui essa execução SQS ao Codex. As antigas pendências de confirmação das filas abaixo são históricas e estão encerradas por esta evidência. CP-02 autorizado e iniciado sem reinicializar a implementação.

## Retomada após validação externa do CP-01

### Evidências fornecidas por Luís Henrique Pereira

Execução externa no Ubuntu, conforme comunicação do responsável técnico; não são execuções PostgreSQL/Docker do Codex nesta sessão:

| Verificação externa | Resultado informado por Luís |
|---|---|
| SDK SQS | @aws-sdk/client-sqs@3.922.0 instalado |
| bun install --frozen-lockfile | Aprovado |
| Containers PostgreSQL dev/test e LocalStack 4.10.0 | Healthy |
| LocalStack http://127.0.0.1:4566 | Acessível externamente; SQS running |
| bun run typecheck | Aprovado |
| bun test test/integration/worker-persistence.test.ts | **5 testes aprovados, 0 falhas, 31 asserções** |

A existência e os atributos das três filas FIFO não foram explicitamente confirmados nessa comunicação. Saúde de SQS/LocalStack não foi interpretada como essa evidência.

### Verificações próprias do Codex nesta retomada

- Branch main, HEAD 013f151470b688b4f13469f73332ac4acf43f8fd. Mudanças anteriores CP-01 preservadas; package.json e bun.lock passaram a incluir o SDK instalado externamente, conforme esperado.
- Import do cliente e leitura do manifest instalado: versão **3.922.0**, SQSClient disponível.
- bun install --offline --frozen-lockfile: exit 0, **285 instalações verificadas em 283 pacotes, sem mudanças**. Nenhuma nova instalação de dependência solicitada nesta retomada.
- bun run typecheck: exit 0.
- bun test test/unit: exit 0, **142 aprovados, 0 falhas, 845 asserções, 15 arquivos**.
- docker ps: acesso negado ao socket Docker.
- curl no health LocalStack: exit 7, conexão indisponível no sandbox.
- bun scripts/check-sqs.ts: exit 1, **ECONNREFUSED**. Não confirmou a existência/atributos de nenhuma fila; não foi interpretado como fila ausente no ambiente externo.
- git diff --check: aprovado. Normativos e IMP-01-EVIDENCE.md preservados.

### Verificação reproduzível das filas e condição do gate

Adicionado `scripts/check-sqs.ts`, somente leitura, usando o SDK instalado. Consulta as três filas por nome, verifica FifoQueue=true, ContentBasedDeduplication=false e QueueArn, e confere RedrivePolicy da entrada apontando para o ARN real da DLQ com maxReceiveCount configurado. Usa endpoint HTTP exclusivamente local, timeout de 5s por requisição, uma tentativa, credenciais sintéticas do emulador e diagnóstico sem mensagens brutas/credenciais. Não cria, apaga, publica ou consome mensagens. useQueueUrlAsEndpoint=false mantém as requisições no endpoint local configurado.

Executar externamente, sem exibir .env ou credenciais:

```sh
cd /home/luishenriqs/projects/Jungle
export PATH="$HOME/.bun/bin:$PATH"
bun scripts/check-sqs.ts
```

Se a porta for diferente, definir SQS_ENDPOINT no ambiente/arquivo local ignorado; usar os mesmos AWS_REGION e SQS_MAX_RECEIVE_COUNT do provisionamento. Endpoint padrão é http://127.0.0.1:4566; região padrão us-east-1; maxReceiveCount padrão 5. Solicita-se a saída sanitizada e o código de retorno. Se houver fila ausente/atributos incompatíveis, a correção de provisionamento prevista pode ser executada externamente:

```sh
docker compose exec -T localstack bash /etc/localstack/init/ready.d/10-provision-queues.sh
bun scripts/check-sqs.ts
```

**Gate CP-01 permanece aberto somente quanto à confirmação das filas/provisionamento.** Instalação do SDK e validação dos cinco cenários PostgreSQL estão comprovadas pelas origens acima. Sem confirmação das filas, CP-02 não foi iniciado; CP-03 a CP-05 também não. Não se solicitam novas decisões arquiteturais ou autorização de escopo, apenas a evidência de acesso que o sandbox impede obter. Nenhum bloqueio foi contornado.

### Alterações desta retomada e limites

Criado scripts/check-sqs.ts; atualizados este relatório, ARCHITECTURE.md e README.md. package.json/bun.lock são alterações externas esperadas e foram preservados. Código financeiro, migrations, testes existentes, Compose e .env não foram modificados nesta retomada. Nenhum teste financeiro/LocalStack adicional aprovado foi atribuído ao executor. Nenhum commit/push ou avanço ao IMP-04.

## Histórico da etapa anterior

As notas abaixo de SDK ausente, instalação bloqueada e cinco falhas de preparação descrevem a execução anterior; a instalação e os testes PostgreSQL foram posteriormente validados nas origens acima. A ausência de acesso local permanece, sem invalidar a evidência externa.

## Base e escopo

Inspeção antes das alterações: main; HEAD `013f151470b688b4f13469f73332ac4acf43f8fd`; working tree limpo; origin `git@github.com:luishenriqs/jungle-wagering-processor.git`. Documentos obrigatórios e contratos existentes inspecionados. Bun 1.4.4; Docker 29.1.3; Compose v2.40.3-desktop.1.

Os resultados aprovados de IMP-02 pertencem à revisão/execução externa daquele pacote; não provam os novos métodos de worker deste pacote. Nesta etapa não foram alterados contratos financeiros do domínio, migrations ou serviços PostgreSQL existentes.

## CP-01 — fontes preparadas

- `docker-compose.yml`: LocalStack SQS, imagem com tag fixa 4.10.0, porta local configurável, healthcheck das três filas. Serviços/volume PostgreSQL preservados. Disponibilidade da imagem ainda depende de pull externo.
- `docker/localstack/init/10-provision-queues.sh`: hook reproduzível das filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wagering-events.fifo`; atualiza atributos de filas existentes. Entrada recebe RedrivePolicy para DLQ, SQS_MAX_RECEIVE_COUNT default 5, validado em 1..1000. Não inclui credenciais. Uso exclusivo de awslocal no container LocalStack.
- `src/shared/application/clock.ts`: ClockPort/SystemClock. O relógio ainda não está ligado a loops operacionais, que não foram implementados.
- `src/modules/messaging/application/worker-config.ts`: valida defaults/autorização de lease, timeout de envio, retries e referência pendente. Lease exige margem mínima de 1000ms sobre timeout; valores temporais inteiros positivos limitados a 2147483647ms. Configuração apenas preparada; agendamento inicial do IMP-02 ainda usa seus defaults anteriores. VAL02-02 será concluído no CP-04, ao compartilhar a política com o worker e a entrada financeira.
- `src/shared/application/worker-store.ts`, FinancialStore e PostgresFinancialStore: primitivas transacionais para descoberta de referências vencidas, atualização condicional de pendentes e claims/fencing de Outbox.
- `src/database/mappers.ts`: retry policy opcional na reidratação Outbox, preservando o default anterior.
- `test/unit/worker-config.test.ts`: casos de configuração válida/inválida e relógio.
- `test/integration/worker-persistence.test.ts`: cinco cenários reais PostgreSQL preparados; ainda sem execução de seus corpos neste ambiente.

### Contratos de persistência

findDuePendingWagers recebe instante explícito; seleção sem lock, com expiração independente do próximo retry, favorecendo referências processadas. A resolução futura deve adquirir Wallet → Wager e revalidar status/vencimento. updatePendingWager atualiza somente campos mutáveis, com WHERE status='PENDING_REFERENCE', e retorna false se nenhuma linha for afetada. Não executa transição financeira automaticamente.

Claim de um evento usa SELECT FOR UPDATE SKIP LOCKED em CTE e grava owner/token/until na transação; não há acesso SQS nesse método. O chamador futuro precisa aguardar commit antes de publicar e usar token UUID novo em cada claim. Confirmação e reagendamento exigem id, owner, token, published_at nulo e lease ainda válido no instante explícito. Retry também confere contador anterior; zero linhas significa perda de claim. last_error aceita somente código diagnóstico limitado, sem erro bruto/payload/credenciais. Contratos e schema financeiros do IMP-02 permanecem preservados.

Todos os filtros temporais novos usam argumentos, sem now() SQL. Produção deverá sincronizar relógios UTC via NTP/chrony e monitorar desvio entre processos; ClockPort não resolve skew por si só. Valores virtuais pertencem somente aos testes. O fencing impede confirmação por token antigo; não elimina publicação duplicada após crash/timeout, que será tratada no CP-03.

## Verificações executadas pelo Codex nesta etapa

| Comando/verificação | Resultado real |
|---|---|
| Verificação inicial Git | Base esperada, main, remoto correto, working tree inicialmente limpo |
| bun --version | 1.4.4 |
| docker --version / docker compose version | 29.1.3 / v2.40.3-desktop.1 |
| docker ps --format | Exit 1, acesso negado ao socket Docker |
| bun test test/unit/worker-config.test.ts | 13 pass, 0 fail, 74 asserções |
| bun test test/unit | **142 pass, 0 fail, 845 asserções, 15 arquivos** |
| Primeiro typecheck com novo teste PostgreSQL | Exit 2: literal string em comparação enum; teste corrigido para WagerTransactionStatus.Rejected |
| bun run typecheck após correção | **Exit 0** |
| bash -n docker/localstack/init/10-provision-queues.sh | Exit 0, apenas sintaxe shell |
| docker compose config --quiet | Exit 0; sem exibir configuração/segredos; não executa containers |
| bun test test/integration/worker-persistence.test.ts | Exit 1, **0 pass, 5 fail**, ECONNREFUSED 127.0.0.1:5434 na preparação; nenhum cenário SQL novo executado |
| curl ao health LocalStack em 127.0.0.1:4566 | Exit 7, endpoint inacessível desta sessão |
| bun add --exact @aws-sdk/client-sqs@3.922.0 --cache-dir /tmp/jungle-imp03-bun-cache | Exit 1, DNSResolveFailed ao obter manifest do SDK |
| bun test | Exit 1: **142 pass, 8 fail, 845 asserções, 19 arquivos**; três preparações de suítes IMP-02 e cinco preparações novas falharam por ECONNREFUSED, sem executar seus cenários SQL |
| bun run check:bootstrap | Exit 1: conexão PostgreSQL recusada em 127.0.0.1:5433; Nest iniciou a composição, mas bootstrap não foi aprovado |
| Sintaxe Python embutida do hook, via ast.parse | Aprovada; não executa awslocal/provisionamento |
| git diff --check | Exit 0 |

A tentativa de instalação não adicionou o SDK a package.json nem atualizou bun.lock. Nenhum lockfile foi fabricado; nenhum import/stub do SDK foi introduzido. Versão pretendida é exata; resolução, instalação e compatibilidade do SDK dependem da execução externa. A operação de instalação foi interrompida após o bloqueio, conforme a ordem do responsável. Não houve tentativa de usar privilégios, rede alternativa ou acesso Docker alternativo.

O gate CP-01 não passou: provisionamento, atributos reais das filas, conectividade SQS e os novos comandos PostgreSQL precisam de validação externa. A regressão completa foi tentada: os arquivos de integração IMP-02 também falharam na preparação da conexão, sem executar cenários. Unitários anteriores continuam incluídos nos 142 aprovados. A aprovação do bootstrap e da regressão completa IMP-03 permanece pendente. Não há evidência de execução para CP-02/03/04/05 ou T01–T24. Os testes novos de persistência não substituem testes de processos/publishers reais futuros.

## Comandos para execução externa controlada no Ubuntu

Manter DATABASE_URL/TEST_DATABASE_URL e credenciais exclusivamente no .env local ignorado ou ambiente; não imprimir valores, docker compose config completo ou .env. Bun carrega .env. Instalação solicitada ao responsável:

```sh
cd /home/luishenriqs/projects/Jungle
export PATH="$HOME/.bun/bin:$PATH"
bun add --exact @aws-sdk/client-sqs@3.922.0
bun install --frozen-lockfile
bun run typecheck
bun test test/unit
```

Não executar comandos posteriores se a instalação falhar; enviar diagnóstico sanitizado. A versão deve continuar exata e o lockfile deve ser gerado pelo Bun.

```sh
# Preserva containers/volumes PostgreSQL; adiciona somente o serviço novo.
docker compose up -d --wait localstack
docker compose exec -T localstack awslocal sqs list-queues
docker compose exec -T localstack bash /etc/localstack/init/ready.d/10-provision-queues.sh
# Segunda execução do hook deve ser idempotente.
docker compose exec -T localstack bash /etc/localstack/init/ready.d/10-provision-queues.sh
```

Verificar FIFO e redrive reais sem depender apenas do healthcheck:

```sh
docker compose exec -T localstack python3 - <<'PY'
import json, os, subprocess

def sqs(*args):
    return json.loads(subprocess.check_output(['awslocal', 'sqs', *args, '--output', 'json'], text=True))

names = ['wager-transactions.fifo', 'wager-transactions-dlq.fifo', 'wagering-events.fifo']
attrs = {}
for name in names:
    url = sqs('get-queue-url', '--queue-name', name)['QueueUrl']
    attrs[name] = sqs('get-queue-attributes', '--queue-url', url, '--attribute-names', 'All')['Attributes']
    assert attrs[name]['FifoQueue'] == 'true'
    assert attrs[name]['ContentBasedDeduplication'] == 'false'
policy = json.loads(attrs[names[0]]['RedrivePolicy'])
assert policy['deadLetterTargetArn'] == attrs[names[1]]['QueueArn']
assert int(policy['maxReceiveCount']) == int(os.environ.get('SQS_MAX_RECEIVE_COUNT', '5'))
print('CP-01: three FIFO queues and DLQ redrive verified.')
PY
bun test test/integration/worker-persistence.test.ts
bun test test/integration/schema.test.ts
bun test test/integration/financial.test.ts
bun test test/integration/multiprocess.test.ts
bun test
bun run check:bootstrap
git diff --check
git status --short --untracked-files=all
```

Essas suítes usam somente schemas jungle_it_<uuid> descartáveis em jungle_test. Não executar down/reset/migration rollback em jungle_dev, down -v, PurgeQueue ou exclusão de recursos existentes. Solicitar saídas sanitizadas e códigos de retorno para retomar os checkpoints seguintes. A aprovação do CP-01 não deve ser inferida da configuração escrita.

## Riscos e próximos passos

1. SDK ausente e imagens/filas ainda não provisionadas pelo executor; instalação e validação reais bloqueiam o gate CP-01.
2. SQL novo precisa passar pelos cinco cenários de persistência e pela regressão real do IMP-02; não foi comprovado no sandbox.
3. CP-02 deve preservar as quatro identidades distintas (envelope/messageId SQS/key/receipt) e ACK somente após commit; não implementado.
4. CP-03 deve publicar depois do commit do claim, suportar perda de lease, duplicatas após envio e concorrência real; não implementado.
5. CP-04 deve compartilhar configuração, respeitar TTL/backoff e resolver cadeias com três workers sem duplicação; VAL02-02 ainda aberto neste pacote.
6. CP-05 deve provar shutdown antes do fechamento ORM, processos/conexões independentes e cenários de crash; não implementado.
7. VAL02-01 permanece destinado ao IMP-04, sem alteração nesta tarefa.

Nenhum commit/push, nenhuma migration destrutiva e nenhum avanço para IMP-04. Documentos normativos e IMP-01-EVIDENCE.md preservados.

## Integridade e Git ao interromper esta etapa

Main permanece no commit-base 013f151470b688b4f13469f73332ac4acf43f8fd. Seis arquivos rastreados modificados e sete novos não rastreados; nenhum staged. Inventário alterado corresponde aos arquivos descritos neste relatório, ARCHITECTURE.md e README.md. git diff --check passou. Diff contra HEAD confirmou preservação dos três normativos, IMP-01-EVIDENCE.md, IMP-02-EVIDENCE.md, package.json, bun.lock, migrations e domínios financeiros. Busca automatizada nos 85 arquivos versionáveis sem credenciais detectadas; .env permanece ignorado. Essa busca não é garantia formal contra todo formato possível de segredo. Nenhum commit ou push executado.

## Git e integridade ao encerrar a implementação do CP-02

Main no commit-base 013f151470b688b4f13469f73332ac4acf43f8fd. Alterações CP-01 e SDK instalado externamente preservados; CP-02 acrescenta os componentes/testes documentados acima. Nenhum staged, commit ou push. git diff --check aprovado. Diff contra HEAD confirma normativos, IMP-01-EVIDENCE.md, IMP-02-EVIDENCE.md, código de wagering/wallets e migrations intactos. Busca automatizada nos 98 arquivos versionáveis sem credenciais detectadas; .env ignorado e não alterado. Nenhum arquivo temporário foi incluído no inventário. CP-02 permanece com validação real pendente, CP-03 a CP-05 e IMP-04 não iniciados.

## Git e integridade ao encerrar CP-03 nesta sessão

Main permanece no commit-base 013f151470b688b4f13469f73332ac4acf43f8fd. 9 arquivos rastreados modificados e 29 novos não rastreados, incluindo etapas anteriores. Índice vazio; nenhum commit/push. Busca automatizada nos 107 arquivos versionáveis sem credenciais detectadas; .env ignorado. Normativos, IMP-01/02-EVIDENCE, código wagering/wallets e migrations preservados contra HEAD. Nenhuma dependência/lockfile, Compose ou persistência CP-01 foi alterada nesta etapa CP-03. git diff --check aprovado. A busca de segredos não é garantia formal para todo formato possível de credencial.

A fila FIFO ordena os envios aceitos por grupo; não se promete ordem global ou ordem de criação entre publishers/retries. EventId e snapshots/versões permanecem estáveis. Nenhum cenário externo novo é declarado aprovado; gate CP-03 aberto, CP-04 não iniciado.

## Git e integridade ao encerrar CP-04 nesta sessão

Main permanece em 013f151470b688b4f13469f73332ac4acf43f8fd. 11 arquivos rastreados modificados e 38 novos não rastreados, incluindo os checkpoints anteriores. Índice vazio, nenhum commit/push. git diff --check aprovado. Busca automatizada nos 116 arquivos versionáveis sem credenciais detectadas; .env permanece ignorado e não foi alterado. Normativos, IMP-01/02-EVIDENCE, domínios financeiros, código Wallets e migrations preservados contra HEAD. A mudança do caso de uso existente está restrita à política de agendamento autorizada. Contratos/implementação SQL, Compose e dependências não foram alterados no CP-04. Nenhum arquivo temporário preparado para versionamento. A busca não é garantia formal contra todo formato de segredo. CP-04 com gate real pendente; CP-05 e IMP-04 não iniciados.

## Git e integridade ao encerrar CP-05 nesta sessão

Main em 013f151470b688b4f13469f73332ac4acf43f8fd; 11 arquivos rastreados modificados e 44 novos não rastreados, incluindo todos os checkpoints anteriores. Índice vazio, nenhum commit/push. git diff --check aprovado. Normativos, IMP-01/02-EVIDENCE, domínios financeiros, Wallets e migrations preservados contra HEAD. .env ignorado e não alterado; nenhuma dependência, lockfile ou Compose alterado nesta etapa. Busca automatizada nos 122 arquivos versionáveis sem credenciais detectadas; não é garantia formal contra todo formato de segredo. Arquivos temporários de execução ficaram fora do repositório. IMP-03 preparado para validação completa; CP-05/regressão externos, revisão independente, definição explícita TTL e aprovação humana pendentes. IMP-04 não iniciado.


## CP-05 — diagnóstico e correção do teste de long polling

### Evidência externa recebida

Luís Henrique Pereira executou `bun test test/integration/worker-resilience.test.ts` no Ubuntu contra os serviços reais: **13 testes aprovados, 1 falha, 208 asserções**. Falha: `SIGTERM cancels real idle long polling, then a restarted consumer processes new work`; mensagem `Worker phase timeout` em resilience-client.ts:32. Os demais cenários de shutdown, SIGKILL, recuperação, concorrência e reconciliação passaram conforme relato externo. Esses resultados não são execuções do Codex e **não aprovam o gate CP-05**.

### Diagnóstico: fatos e limite da conclusão

O erro original era compartilhado por todas as esperas e não registrava fase, modo ou PID. Portanto, o resultado recebido **não permite identificar conclusivamente qual await expirou**. A espera `restarted.phase('acked')` é a hipótese compatível com o defeito temporal encontrado: o teste reutilizava a fila imediatamente após abortar um receive de 20s, configurado com visibilidade de 30s, mas aguardava ACK do processo reiniciado por apenas 15s. O shutdown tem deadline de 5s: uma falha de cancelamento normalmente produziria timeout/saída do filho antes desse prazo de 15s. Isso orienta o diagnóstico, mas não substitui o trace da execução original.

Inspeção do Consumer, adapter, lifecycle e coordenador: o AbortSignal chega ao SDK; o loop verifica parada antes de novo poll; receipt conhecido recebido durante parada é liberado sem processamento; ACK permanece após retorno confirmado do caso de uso. O handler HTTP Smithy instalado destrói a requisição cliente no abort. Isso não equivale a revogar um receive já executando no servidor.

No [código do LocalStack 4.10.0](https://github.com/localstack/localstack/blob/v4.10.0/localstack-core/localstack/services/sqs/models.py#L1067), o receive FIFO espera na fila interna e aplica visibilidade às mensagens selecionadas; não recebe sinal de cancelamento do cliente. O [provider](https://github.com/localstack/localstack/blob/v4.10.0/localstack-core/localstack/services/sqs/provider.py#L1010) chama essa operação antes de devolver a resposta HTTP. Assim, um pedido abortado pode reservar a mensagem nova sem que o cliente conheça o receipt. A reserva de 30s é incompatível com a espera de 15s do teste. **O mecanismo e a incompatibilidade são verificáveis pelo código; sua ocorrência na execução externa específica ainda não foi observada.** Não há defeito de produção comprovado nem notificação IPC perdida comprovada. O cliente de testes já armazena fases anteriores à instalação do waiter.

### Correção mínima e instrumentação

Somente harness/testes foram alterados, além desta evidência e ARCHITECTURE.md:

- resilience-child.ts: modo exclusivo `consumer-idle`, com visibilidade de 1s para o receive cancelado. Mantém long polling de 20s. O consumidor reiniciado continua no modo normal, com 30s. O teste passa a comportar recuperação natural de receipt desconhecido, sem presumir cancelamento remoto.
- worker-resilience.test.ts: usa esse modo apenas no processo ocioso; exige abort observado, rejeição do receive antes de `drained`, um único poll e ausência de retorno de mensagem, commit ou ACK pelo processo parado. Mantém limite de shutdown de 5s, timeout de fase de 15s e timeout total de 25s.
- resilience-child.ts: registra pollId, início, abort observado, retorno (com receiveCount) ou cancelamento/falha, sem payload, receipt, senha ou exceção bruta.
- resilience-client.ts: timeout/saída agora informam fase esperada, modo, PID e últimas 16 fases. Distingue `ready`, `poll-started`, `drained`, `acked` e outras esperas. A instrumentação permitirá estabelecer o await exato numa nova falha.
- resilience-diagnostics.test.ts: regressões de identificação/limitação dos diagnósticos e cancelamento propagado pelo SDK até um handler controlado, com encerramento do Consumer e ausência de novo receive ou chamada financeira. Este teste unitário não é evidência de cancelamento HTTP no LocalStack real.
- ARCHITECTURE.md: aceite formal da Opção A de TTL; nenhuma alteração financeira.

Nenhuma alteração nesta correção em produção, contratos, domínio, migrations, dependências, lockfile, Compose ou .env. Sem aumento de timeout. Não é possível liberar explicitamente um receipt desconhecido; a recuperação depende de visibilidade e Inbox/idempotência persistentes.

### Verificações executadas pelo Codex nesta correção

| Comando | Resultado efetivamente observado |
|---|---|
| `bun run typecheck` | Aprovado, exit 0 |
| `bun test test/unit` | 246 aprovados, 0 falhas, 1361 asserções, 21 arquivos |
| `bun test test/unit/resilience-diagnostics.test.ts` | 3 aprovados, 0 falhas, 13 asserções (incluídos nos totais acima) |
| `bun test test/integration/worker-resilience.test.ts --test-name-pattern "SIGTERM cancels real idle long polling"` | Bloqueado no setup PostgreSQL: ECONNREFUSED 127.0.0.1:5434; 0 aprovados, 1 falha, 13 filtrados; corpo do cenário não executado |

### Validação externa necessária

No diretório do projeto, com PostgreSQL/LocalStack e ambiente local já configurados, sem imprimir credenciais:

```sh
bun test test/integration/worker-resilience.test.ts --test-name-pattern "SIGTERM cancels real idle long polling"
bun test test/integration/worker-resilience.test.ts
```

O primeiro comando deve comprovar a sequência de cancelamento e recuperação na mesma fila. Se falhar, o erro agora identifica fase/modo/PID e histórico. Não apagar volumes, filas de desenvolvimento ou schemas de desenvolvimento. O harness cria somente filas/schema descartáveis no banco de testes.

**Estado:** correção de teste preparada; hipótese causal da execução externa e integração completa ainda exigem revalidação real. CP-05 não aprovado; regressão completa, revisão Antigravity e aceite humano pendentes. IMP-04 não iniciado. Nenhum commit/push.

Integridade ao encerrar esta correção: `git diff --check` aprovado (exit 0); AGENTS.md, technical-challenge.md, Jungle-Architecture-v0.2.md, IMP-01-EVIDENCE.md e IMP-02-EVIDENCE.md intactos contra HEAD. Main permanece em `013f151470b688b4f13469f73332ac4acf43f8fd`; índice vazio. As alterações não commitadas dos checkpoints anteriores foram preservadas.


## Conferências do Codex nesta consolidação documental

Executado nesta sessão: inspeção Git e inventário; comparação SHA-256 de todos os arquivos versionáveis antes/depois da tarefa; comparação dos documentos protegidos com HEAD; `git diff --check`; `git check-ignore .env`; inspeção do índice e busca automatizada de possíveis credenciais.

- `git diff --check`: aprovado, exit 0. Comparação com HEAD: AGENTS.md, technical-challenge.md, Jungle-Architecture-v0.2.md, IMP-01-EVIDENCE.md e IMP-02-EVIDENCE.md intactos, exit 0.
- Somente ARCHITECTURE.md, README.md e IMP-03-EVIDENCE.md foram alterados nesta tarefa. Código, testes, migrations, dependências, bun.lock, Compose e alterações anteriores preservados. Nenhuma nova execução de typecheck, testes ou bootstrap nesta tarefa documental; os resultados finais são externos de Luís.
- `.env` ignorado pelo Git e excluído do inventário versionável. Busca nos 123 arquivos por chaves privadas, padrões de tokens AWS/GitHub e URLs PostgreSQL com credenciais literais: nenhum achado. Comparação com valores secretos locais de tamanho relevante, sem imprimir valores: nenhum arquivo versionável correspondente. Nenhum arquivo .env, chave privada ou artefato temporário identificado no inventário. Credenciais sintéticas do emulador/testes e placeholders documentais não são credenciais reais.
- Branch main, HEAD `013f151470b688b4f13469f73332ac4acf43f8fd`; índice vazio. Working tree contém o IMP-03 ainda não versionado: 11 arquivos rastreados modificados e 45 não rastreados. Sem exclusões. Nenhum commit/push, operação de banco ou avanço ao IMP-04.

### Inventário Git completo nesta consolidação

78 arquivos rastreados (11 modificados e 67 sem alteração contra HEAD), mais 45 não rastreados, total 123 arquivos versionáveis. A lista abrange todo o checkout versionável, inclusive IMP-01/02; não implica incluir todos em um futuro commit. Recursos ignorados, como .env e node_modules, não integram essa lista.

Arquivos rastreados modificados (implementação anterior preservada; somente os três documentos indicados acima foram editados nesta tarefa):

```text
ARCHITECTURE.md
README.md
bun.lock
docker-compose.yml
package.json
src/database/mappers.ts
src/database/postgres-financial-store.ts
src/modules/messaging/messaging.module.ts
src/modules/wagering/application/process-wager-transaction.use-case.ts
src/modules/wagering/wagering.module.ts
src/shared/application/financial-store.ts
```

Todos os arquivos rastreados:

```text
.gitignore
AGENTS.md
ARCHITECTURE.md
IMP-01-EVIDENCE.md
IMP-02-EVIDENCE.md
Jungle-Architecture-v0.2.md
README.md
bun.lock
bunfig.toml
docker-compose.yml
package.json
scripts/check-bootstrap.ts
scripts/migrate.ts
src/app.module.ts
src/database/config.ts
src/database/database.module.ts
src/database/entities.ts
src/database/exact-numeric-type.ts
src/database/mappers.ts
src/database/migrations/Migration202611040001.ts
src/database/postgres-financial-store.ts
src/database/postgres-unit-of-work.ts
src/database/records.ts
src/database/timestamps.ts
src/main.ts
src/modules/messaging/domain/inbox-message.ts
src/modules/messaging/domain/outbox-message.ts
src/modules/messaging/messaging.module.ts
src/modules/wagering/application/get-wager-transaction.use-case.ts
src/modules/wagering/application/process-wager-transaction.use-case.ts
src/modules/wagering/application/wager-payload.ts
src/modules/wagering/domain/events/wager-event-data.ts
src/modules/wagering/domain/events/wager-transaction-pending-reference.ts
src/modules/wagering/domain/events/wager-transaction-processed.ts
src/modules/wagering/domain/events/wager-transaction-rejected.ts
src/modules/wagering/domain/failure-code.ts
src/modules/wagering/domain/wager-errors.ts
src/modules/wagering/domain/wager-rules.ts
src/modules/wagering/domain/wager-transaction.ts
src/modules/wagering/domain/wallet-opening.ts
src/modules/wagering/wagering.module.ts
src/modules/wallets/application/create-wallet.use-case.ts
src/modules/wallets/application/wallet-queries.ts
src/modules/wallets/domain/events/wallet-balance-changed.ts
src/modules/wallets/domain/wallet-ledger-entry.ts
src/modules/wallets/domain/wallet.ts
src/modules/wallets/wallets.module.ts
src/shared/application/application-errors.ts
src/shared/application/execution.ts
src/shared/application/financial-store.ts
src/shared/application/identifiers.ts
src/shared/domain/domain-errors.ts
src/shared/domain/events/integration-event.ts
src/shared/domain/money.ts
src/shared/domain/validation.ts
technical-challenge.md
test/fixtures.ts
test/integration/financial.test.ts
test/integration/multiprocess.test.ts
test/integration/schema.test.ts
test/support/postgres.ts
test/support/process-client.ts
test/support/process-worker.ts
test/unit/database-timestamps.test.ts
test/unit/financial-sequences.test.ts
test/unit/imp02-domain.test.ts
test/unit/inbox-message.test.ts
test/unit/integration-events.test.ts
test/unit/money.test.ts
test/unit/outbox-message.test.ts
test/unit/persistence-mappers.test.ts
test/unit/wager-payload.test.ts
test/unit/wager-rules.test.ts
test/unit/wager-transaction.test.ts
test/unit/wallet-ledger-entry.test.ts
test/unit/wallet-opening.test.ts
test/unit/wallet.test.ts
tsconfig.json
```

Todos os arquivos não rastreados:

```text
IMP-03-EVIDENCE.md
docker/localstack/init/10-provision-queues.sh
scripts/check-sqs.ts
scripts/consume-wagers.ts
scripts/publish-outbox.ts
scripts/resolve-pending-references.ts
src/modules/messaging/application/consumer-config.ts
src/modules/messaging/application/consumer-errors.ts
src/modules/messaging/application/outbox-publisher.ts
src/modules/messaging/application/sqs-transport.ts
src/modules/messaging/application/sqs-wager-consumer.ts
src/modules/messaging/application/wager-request.ts
src/modules/messaging/application/worker-config.ts
src/modules/messaging/infrastructure/aws-sqs-consumer-transport.ts
src/modules/messaging/infrastructure/aws-sqs-outbox-transport.ts
src/modules/messaging/infrastructure/consumer-lifecycle.ts
src/modules/messaging/infrastructure/local-sqs-client.ts
src/modules/messaging/infrastructure/publisher-lifecycle.ts
src/modules/wagering/application/pending-reference-policy.ts
src/modules/wagering/application/pending-reference-worker.ts
src/modules/wagering/infrastructure/pending-reference-lifecycle.ts
src/shared/application/clock.ts
src/shared/application/worker-shutdown.ts
src/shared/application/worker-signals.ts
src/shared/application/worker-store.ts
test/integration/outbox-publisher.test.ts
test/integration/pending-reference-worker.test.ts
test/integration/sqs-consumer.test.ts
test/integration/worker-persistence.test.ts
test/integration/worker-resilience.test.ts
test/support/outbox-publisher-child.ts
test/support/outbox-publisher-client.ts
test/support/outbox-sqs.ts
test/support/pending-worker-child.ts
test/support/pending-worker-client.ts
test/support/resilience-child.ts
test/support/resilience-client.ts
test/support/sqs.ts
test/unit/outbox-publisher.test.ts
test/unit/pending-reference-policy.test.ts
test/unit/pending-reference-worker.test.ts
test/unit/resilience-diagnostics.test.ts
test/unit/sqs-consumer.test.ts
test/unit/worker-config.test.ts
test/unit/worker-shutdown.test.ts
```

**Encaminhamento final: IMP-03 implementado e validado funcionalmente; pronto para revisão crítica independente do Antigravity. Aprovação humana final pendente. IMP-04 não iniciado.**

## IMP-03/REV3-FIX-01 — correção controlada de REV3-01 e smoke tests REV3-02

### Autorização, estado inicial e diagnóstico

Luís Henrique Pereira autorizou expressamente este checkpoint após o diagnóstico dos sete achados REV3. Escopo: tratamento de unknown e cobertura dos três entrypoints; demais achados não implementados. Branch main, HEAD 013f151470b688b4f13469f73332ac4acf43f8fd, índice vazio, 11 arquivos rastreados modificados e 45 não rastreados preexistentes. Leitura dos sete documentos e AGENTS.md; comparação com inventário do diagnóstico confirmou os mesmos 123 arquivos/bytes. Nenhum arquivo não rastreado tratado como descartável.

Defeito: unknown no limite de recebimentos era convertido em diagnóstico manual sem envelope e seguido de DeleteMessage. Se não houvesse commit financeiro, Inbox/Outbox/wager não forneciam uma cópia recuperável. O pg instalado pode gerar erro de conexão sem code e o conversor genérico MikroORM não acrescenta um código reconhecido. Hash não reconstrói o original. A proibição de payload completo em logs não exige apagar o envelope persistente na DLQ.

### RED executado antes de alterar o Consumer

Alterado somente o teste unitário existente para exigir preservação do corpo original no transporte controlado, ausência de envio manual, ausência de ACK e retry em receiveCount 1, 5, 6 e 1000. Erro sem code envolvido em RetryExhaustedError com cause original; o teste também verifica que classificação/manuseio não altera essa causa.

Comando: `bun test test/unit/sqs-consumer.test.ts --test-name-pattern 'preserves original envelope'`.

Resultado próprio do Codex: **exit 1; 1 pass, 3 fail, 38 filtrados, 17 asserções**. Os três casos no limite/acima falharam na comparação do original ainda disponível na origem: esperado envelope original, recebido undefined após ACK. Nenhuma falha de setup/banco/DNS integrou esse RED. Fixtures exclusivamente sintéticas. No teste final a mesma comparação é booleana para evitar imprimir o envelope numa falha, sem enfraquecer a condição de igualdade.

### Alteração implementada e GREEN

Única alteração de produção: `sqs-wager-consumer.ts` encaminha manualmente somente failure.kind === permanent. Unknown usa defer com backoff; não há SendMessage manual à DLQ nem DeleteMessage por esgotamento. A RedrivePolicy real continua sendo a única responsável por mover mensagens esgotadas. Sem alteração no classificador, contratos, domínio, migrations, política TTL, regras financeiras, SQL, Publisher ou PendingReferenceWorker.

GREEN inicial: `bun test test/unit/sqs-consumer.test.ts` — **42 pass, 0 fail, 176 asserções**, incluindo todos os casos RED e regressões dos erros permanentes, falha de envio manual, ACK falho e commit antes do ACK.

Integração ampliada em sqs-consumer.test.ts: três modos unknown, postgres-no-code e uncertain-commit. Todos usam filas reais criadas pelo harness, contador real de recebimentos e redrive nativo. O modo postgres-no-code lança DriverException do MikroORM instalado no checkpoint beforeCommit depois das escritas SQL reais: comprova rollback integral. O modo uncertain-commit confirma SQL real e perde a confirmação na borda do processador: recebimentos seguintes fazem replay, sem novos efeitos. Não se afirma que uma desconexão TCP ou perda física de resposta COMMIT tenha sido induzida.

Em cada modo verifica-se zero envios manuais/ACKs durante falhas, igualdade exata do corpo na DLQ e preservação de messageId/idempotencyKey/externalTransactionId. O teste simula recuperação operacional reenviando o original da DLQ após remover a falha, excluindo a cópia da DLQ somente após envio confirmado. Essa ação pertence ao teste, não a um novo mecanismo de redrive em produção. Uma duplicata posterior verifica replay. Resultado final por operação: um débito, wager/inbox/ledger/outbox esperados, Inbox processada e saldo reconciliado. No cenário pré-commit, nenhuma alteração parcial fica confirmada; no incerto, o efeito já existente é preservado.

### REV3-02 — scripts reais e isolamento

`worker-entrypoints.test.ts` executa processos Bun com os caminhos exatos scripts/consume-wagers.ts, scripts/publish-outbox.ts e scripts/resolve-pending-references.ts. Os scripts e seus DynamicModules de produção não são substituídos ou editados. Cada processo usa MessagingModule.forConsumer(), MessagingModule.forPublisher() ou WageringModule.forPendingReferences() conforme sua entrada real.

Configuração de teste indispensável: databaseConfig atual fixa schema public. `entrypoint-preload.ts`, carregado somente pelo harness via --preload, delega MikroORM.init real com schema descartável e search_path limitado a ele, sem fallback public. Nenhuma opção pública/configuração de produção foi acrescentada. A guarda de configuração valida jungle_test, URL de teste explícita igual a DATABASE_URL, host loopback, ausência de parâmetros de URL, schema jungle_it_<uuid>, endpoint local e os três nomes de filas isoladas. O pai utiliza somente os recursos que acabou de criar. Antes do spawn verifica a existência de seu schema; antes de devolver o ORM ao Nest, o filho comprova current_database/current_schema e as cinco tabelas nesse schema. Se não puder comprovar, não libera os loops. Os adapters de produção conectam às filas reais e validam atributos.

Observação, sem substituir operações: preload delega ORM.init/close e SDK.send/destroy reais; emite somente fases sem corpo/receipt/credenciais. Testes comprovam trabalho antes do SIGTERM, drenagem antes de fechar pool, pool desconectado, SDK destruído quando aplicável e nenhuma sessão PostgreSQL restante identificada pelo application_name exclusivo. Consumer recebe duas entregas separadas e confirma dois DeleteMessage com um único efeito financeiro. Publisher publica os eventIds persistidos; PendingWorker resolve REFUND persistida. Os três reiniciam sem criar artefatos financeiros extras. Há três cenários adicionais de startup com configuração inválida, exit 1, nenhum started e diagnóstico sanitizado. Dez unitários verificam aceitação/rejeição da configuração isolada antes do spawn.

### Comandos e resultados efetivamente executados pelo Codex

Runtime observado: Bun 1.4.4 (38afee6c8). PostgreSQL 16 e LocalStack reais já existentes; harness PostgreSQL valida versão major 16. Versões exatas de servidor/emulador anteriormente informadas por Luís não foram consultadas novamente neste checkpoint. Integrações exigiram execução fora do sandbox com autorização concedida; isso continua sendo execução do Codex, não resultado externo atribuído a Luís.

| Comando | Resultado observado |
|---|---|
| RED unitário filtrado acima | 1 pass, 3 fail, 17 asserções; falha funcional de preservação |
| `bun test test/unit/sqs-consumer.test.ts` | 42 pass, 0 fail, 176 asserções |
| `bun run typecheck` | Exit 0, inclusive novos testes/harness |
| `bun test test/unit` | 259 pass, 0 fail, 1411 asserções, 22 arquivos |
| `bun scripts/check-sqs.ts` | Exit 0; três filas FIFO e redrive real com maxReceiveCount=5; somente leitura |
| `bun test test/integration/sqs-consumer.test.ts`, primeira tentativa no sandbox | 0 pass, 16 fail por ECONNREFUSED 127.0.0.1:4566 no setup; nenhum corpo executado; não é RED |
| Mesmo comando, fora do sandbox | 16 pass, 0 fail, 156 asserções |
| `bun test test/integration/worker-entrypoints.test.ts`, versão final | 6 pass, 0 fail, 134 asserções; os três scripts e três startups inválidos |
| `bun test test/integration/worker-resilience.test.ts` | 14 pass, 0 fail, 224 asserções |
| `bun test test/integration/outbox-publisher.test.ts` | 10 pass, 0 fail, 412 asserções |
| `bun test test/integration/pending-reference-worker.test.ts` | 20 pass, 0 fail, 171 asserções |
| `bun test` | **366 pass, 0 fail, 2753 asserções, 31 arquivos; exit 0; 34,83s** |
| `bun run check:bootstrap`, direcionado a jungle_test | Exit 0; Nest/MikroORM reais, HTTP 404 esperado em porta efêmera |
| `git diff --check` | Exit 0 |

O bootstrap foi chamado sem imprimir URLs autenticadas pelo wrapper abaixo, que mantém o banco de testes e não altera .env:

```sh
bun -e 'import { testDatabaseUrl } from "./test/support/postgres"; const result = Bun.spawnSync([process.execPath, "run", "check:bootstrap"], { env: { ...process.env, DATABASE_URL: testDatabaseUrl() }, stdout: "inherit", stderr: "inherit" }); process.exit(result.exitCode);'
```

Identidades observadas na regressão completa: cenário multiprocessos, Bun PIDs 182802/182803/182804 e backends PostgreSQL 108160/108158/108159. São evidências desta execução; a ordem dos arrays corresponde à saída do harness. As contagens das suítes individuais já estão incluídas nos 366 e não devem ser somadas novamente. Os 345 testes/2500 asserções anteriores continuam como evidência histórica externa de Luís; não houve nova execução externa por Luís informada neste checkpoint.

### Arquivos e limites

Modificados neste checkpoint, relativamente ao working tree inicial:

- src/modules/messaging/application/sqs-wager-consumer.ts — decisão conservadora de unknown; única mudança de produção.
- test/unit/sqs-consumer.test.ts — regressão negativa de perda do original e preservação da causa.
- test/integration/sqs-consumer.test.ts — preservação nativa, rollback, recuperação e confirmação incerta.
- test/support/entrypoint-isolation.ts — novo, guarda de recursos exclusivos.
- test/support/entrypoint-preload.ts — novo, configuração/observação de teste com operações reais.
- test/support/entrypoint-client.ts — novo, spawn dos scripts, sinais e diagnósticos sanitizados.
- test/integration/worker-entrypoints.test.ts — novo, seis smokes das entradas reais.
- test/unit/entrypoint-isolation.test.ts — novo, dez guardas positivas/negativas de isolamento.
- ARCHITECTURE.md e README.md — correção, semântica de DLQ e cobertura real dos entrypoints.
- IMP-03-EVIDENCE.md — este registro, preservando todo o histórico anterior.

Todos os demais arquivos iniciais preservados por comparação SHA-256. Normativos, IMP-02-EVIDENCE.md, dependências/lockfile, Compose, migrations e código financeiro não foram alterados. As migrations existentes foram executadas somente pelos harnesses em schemas descartáveis jungle_test; a regressão schema executa up/down/up exclusivamente no schema novo que criou. Nenhuma operação manual de migration/rollback, instalação, PurgeQueue ou remoção de recurso compartilhado. Nenhum arquivo staged; nenhum commit/push. Cinco novos arquivos de teste/harness somam-se ao inventário anterior. IMP-04 não iniciado.

### Riscos residuais e procedimento de rollback

1. Redrive preserva o envelope dentro da retenção finita da DLQ, não oferece arquivo permanente. Operação precisa acompanhar a fila e recuperar mensagens antes de expiração. A recuperação é idempotente pelas identidades persistentes; diagnóstico manual não é envelope reprocessável.
2. A correção aumenta o uso do formato original já existente na DLQ nativa. Logs continuam sem payload completo/receipt/erro bruto. Erros permanentes mantêm a política anterior; não houve ampliação silenciosa desse escopo.
3. Provas reais usam LocalStack, não AWS de produção. Erros sem code e perda de confirmação são falhas injetadas com transações/SQS reais, não prova de toda partição física de rede.
4. Smoke tests usam configuração de schema exclusiva do harness; não provam uma opção pública de schema em produção. Conexões, módulos, casos de uso, sinais e fechamento são reais. Os achados REV3-03 a REV3-07 não foram implementados; TTL Opção A preservada.
5. Rollback de código não exige migration. Se houver regressão operacional, interromper os consumidores afetados, preservar filas/leases/envelopes e aplicar reversão localizada somente dos hunks deste checkpoint, sem reset/clean e sem remover arquivos preexistentes. Reativar o ramo destrutivo antigo sobre mensagens unknown reintroduz REV3-01 e não é rollback seguro: manter consumo suspenso até versão segura. Reverter fixtures/harness/docs somente por patch revisado, preservando o histórico de evidências. Não apagar mensagens para realizar rollback.

**Estado final: IMP-03/REV3-FIX-01 TECNICAMENTE VALIDADO.** REV3-01 corrigido com RED/GREEN, preservação/recuperação comprovadas e regressão financeira aprovada; REV3-02 com seis smokes aprovados; typecheck/bootstrap/diff-check aprovados. IMP-03 permanece aguardando revisão independente complementar e aprovação humana para commit. Nenhum commit/push ou avanço ao IMP-04.


## IMP-03-CLOSE — fechamento documental e preparação de versionamento

**IMP-03 TECNICAMENTE APROVADO. VERSIONAMENTO PENDENTE DE AUTORIZAÇÃO HUMANA de Luís Henrique Pereira.** Esta autorização cobre somente consolidação documental e proposta de inventário. Não autoriza git add, commit, push ou início do IMP-04.

### Histórico e consolidação funcional

CP-01 entregou infraestrutura SQS/configuração/persistência; CP-02 Consumer/Inbox; CP-03 Outbox Publisher; CP-04 PendingReferenceWorker; CP-05 shutdown/recuperação distribuída. A revisão adversarial REV3 inicialmente recomendou REPROVAR TEMPORARIAMENTE: REV3-01 apontou perda do envelope em unknown esgotado e REV3-02 apontou falta de smoke dos entrypoints. Após diagnóstico, Luís autorizou REV3-FIX-01, que corrigiu o caminho destrutivo e acrescentou os smokes. O parecer complementar abaixo aprova essa correção sem bloqueantes.

| Origem e etapa | Evidência preservada, sem nova execução neste fechamento |
|---|---|
| Luís, validação funcional anterior de CP-01 a CP-05 | 345 testes/0 falhas/2500 asserções/29 arquivos; detalhes e tentativas intermediárias preservados neste relatório. |
| Codex, RED anterior de REV3-FIX-01 | Três falhas diretamente na preservação do envelope, um caso aprovado; não falhas de setup. |
| Codex, GREEN anterior de REV3-FIX-01 | 366 testes aprovados, 0 falhas, 2753 asserções, 31 arquivos; unitários 259, Consumer 16 e smokes 6. Typecheck, bootstrap, verificação SQS e diff-check aprovados. PostgreSQL e LocalStack reais, recursos de teste isolados. |
| Antigravity, parecer complementar informado por Luís | Revisão predominantemente estática; typecheck, 259 unitários e diff-check aprovados. Nenhuma reexecução das integrações. |
| Codex, sessão IMP-03-CLOSE | Somente leitura/consolidação documental, inventário, comparação SHA-256, conferência de normativos/índice/ignore, inspeção de conteúdo e busca de credenciais; diff-check. Nenhum teste, bootstrap, instalação, migration ou operação SQS executado nesta sessão. |

As contagens de suítes individuais integram a regressão completa; não somar execuções de fases diferentes. Falhas anteriores de conexão, migration/reidratação e long polling permanecem no histórico, com os limites originais de diagnóstico e proveniência.

### Parecer independente complementar e proveniência

Parecer recebido do Antigravity, comunicado por Luís Henrique Pereira: **APROVAR REV3-FIX-01**, sem defeitos bloqueantes. Identificação exibida no relatório: **Gemini 4 Argon — medium**. Essa identificação é transcrita do relato recebido, não uma verificação independente do runtime do revisor.

Revisão predominantemente estática. O revisor executou somente `bun run typecheck` (aprovado), `bun test test/unit` (259 aprovados) e `git diff --check` (aprovado). Não reexecutou integrações nesta revisão. As integrações reais e a regressão de 366 testes continuam atribuídas à execução anterior do Codex em REV3-FIX-01, não ao revisor nem ao Codex nesta sessão documental.

O parecer confirmou:

1. Unknown não provoca DLQ manual nem DeleteMessage por esgotamento.
2. Redrive nativo continua operacional, preservando envelope original e identidade financeira.
3. Replay não duplica efeitos e o tratamento dos erros permanentes permanece preservado.
4. Falhas de ACK, visibilidade e commit continuam seguras, sem exposição adicional de dados sensíveis.
5. Não foi introduzido retry infinito fora da retenção e da política de redrive.

Para REV3-02, confirmou cobertura dos scripts consume-wagers.ts, publish-outbox.ts e resolve-pending-references.ts e das composições Nest reais: processamento operacional, PostgreSQL/LocalStack isolados, SIGTERM, fechamento ORM/SDK quando aplicável, reinicialização, idempotência e configuração inválida com saída não zero. São conclusões da inspeção da cobertura e das evidências anteriores, não novas integrações executadas pelo revisor.

### Riscos não bloqueantes e encaminhamentos

| ID | Estado e limite preservado |
|---|---|
| R1 | DLQ admite `WagerTransactionDeadLetter` (diagnóstico manual) e `WagerTransactionRequested` (envelope original do redrive nativo). A recuperação operacional deve discriminar explicitamente o tipo; nunca reenviar diagnóstico como mensagem financeira. Retenção da DLQ é finita. |
| R2 | Smokes usam preload exclusivo para schema isolado. Os módulos Nest e recursos reais são exercitados; configuração de schema é adaptada somente nos testes. Não é funcionalidade pública de configuração em produção. |
| R3 | API HTTP, observabilidade e VAL02-01 (divergência real na reconciliação e tratamento de soma negativa) permanecem no IMP-04. Nenhuma implementação iniciada neste fechamento. |
| REV3-03 | Parcialmente confirmado: visibilidade de 1s limita a prova de recuperação com default 120s, sem defeito de produção demonstrado. Teste adicional com prazo real foi proposto para avaliação no IMP-04; não implementado nem declarado resolvido. |
| REV3-04 | Confirmado por análise estática: timestamp anterior ao lock pode divergir da sequência financeira. Baixa severidade, sem corrupção financeira demonstrada; ajuste temporal e teste propostos para avaliação no IMP-04. Nenhuma alteração neste fechamento. |
| REV3-05 | Parcialmente confirmado: receive vazio isolado não prova exclusão, mas já existe observação de ACK/adapter real. Fortalecimento adicional proposto para avaliação no IMP-04; não se declara ausência de DeleteMessage na implementação. |
| REV3-06 | Parcialmente confirmado: dez verificações com backoff implicam janela nominal de 1023s, antes de 24h, acrescida de atrasos operacionais. É política documentada de primeiro limite tentativas/TTL, não defeito corrigido. Preservar Opção A aprovada: referência válida pode resolver após TTL. Esclarecimento operacional fica registrado, sem alterar defaults. |
| REV3-07 | Desatualizações documentais confirmadas. Este fechamento atualiza estado/revisão/proveniência nos três documentos autorizados, preservando histórico. Revisão documental geral proposta para IMP-04; não se declara limpeza completa de todos os documentos históricos. |

Os encaminhamentos REV3-03 a REV3-07 preservam as recomendações do diagnóstico; não são novos aceites individuais de mudança funcional ou autorização para iniciar IMP-04. Riscos não bloqueantes não são apresentados como defeitos corrigidos. At-least-once, relógios sincronizados, recuperação dentro da retenção e limites de falhas injetadas permanecem documentados.

### Inventário proposto para o futuro commit

Base conferida: branch `main`, HEAD `013f151470b688b4f13469f73332ac4acf43f8fd`; índice vazio. Inventário do checkout potencialmente versionável: **128 arquivos**, dos quais 78 já rastreados e 50 novos. Proposta de commit IMP-03: **61 arquivos**, sendo **11 rastreados modificados + 50 novos**, **0 excluídos**; os outros 67 rastreados estão sem alteração contra HEAD.

Os candidatos foram conferidos por finalidade, diffs rastreados e componentes/testes documentados; não são incluídos apenas por serem não rastreados. Nenhum artefato suspeito ou fora do escopo do IMP-03 identificado. SDK/lockfile, Compose e persistência são alterações preexistentes do pacote, preservadas nesta tarefa.

#### A. Rastreado modificado — 11 arquivos

| Caminho exato | Finalidade |
|---|---|
| `ARCHITECTURE.md` | Decisões, revisão técnica, riscos e limites do IMP-03. |
| `README.md` | Setup, comandos de workers/testes e estado de aprovação. |
| `bun.lock` | Resolução versionada do SDK SQS e dependências transitivas. |
| `docker-compose.yml` | Serviço LocalStack SQS e healthcheck das filas. |
| `package.json` | Dependência direta fixada @aws-sdk/client-sqs. |
| `src/database/mappers.ts` | Reidratação Outbox com política de retry. |
| `src/database/postgres-financial-store.ts` | Persistência de pendências e claims/leases/fencing Outbox. |
| `src/modules/messaging/messaging.module.ts` | Composição Nest standalone de Consumer e Publisher. |
| `src/modules/wagering/application/process-wager-transaction.use-case.ts` | Agenda inicial pela política compartilhada de referências. |
| `src/modules/wagering/wagering.module.ts` | Composição Nest do worker de referências. |
| `src/shared/application/financial-store.ts` | Integração da porta transacional com WorkerStore. |

#### B. Novo não rastreado — 50 arquivos

| Caminho exato | Finalidade |
|---|---|
| `IMP-03-EVIDENCE.md` | Histórico, proveniência, revisão e inventário final. |
| `docker/localstack/init/10-provision-queues.sh` | Provisionamento reproduzível das três filas FIFO e redrive. |
| `scripts/check-sqs.ts` | Verificação somente leitura de filas e RedrivePolicy. |
| `scripts/consume-wagers.ts` | Entrypoint real do Consumer e coordenação de sinais. |
| `scripts/publish-outbox.ts` | Entrypoint real do Publisher e coordenação de sinais. |
| `scripts/resolve-pending-references.ts` | Entrypoint real do PendingWorker e coordenação de sinais. |
| `src/modules/messaging/application/consumer-config.ts` | Configuração validada de polling, retry e visibilidade. |
| `src/modules/messaging/application/consumer-errors.ts` | Classificação de falhas sem exposição de exceções. |
| `src/modules/messaging/application/outbox-publisher.ts` | Loop Outbox concorrente, publicação e confirmação fenced. |
| `src/modules/messaging/application/sqs-transport.ts` | Porta de transporte Consumer e identidades de entrega. |
| `src/modules/messaging/application/sqs-wager-consumer.ts` | Consumo, ACK após commit e unknown por redrive nativo. |
| `src/modules/messaging/application/wager-request.ts` | Decoder/validação do envelope financeiro. |
| `src/modules/messaging/application/worker-config.ts` | Configuração compartilhada dos workers. |
| `src/modules/messaging/infrastructure/aws-sqs-consumer-transport.ts` | Adapter real Receive/Delete/ChangeVisibility/Send e validação de redrive. |
| `src/modules/messaging/infrastructure/aws-sqs-outbox-transport.ts` | Adapter real de publicação FIFO preservando eventId. |
| `src/modules/messaging/infrastructure/consumer-lifecycle.ts` | Lifecycle Nest e drenagem do Consumer. |
| `src/modules/messaging/infrastructure/local-sqs-client.ts` | Cliente restrito ao emulador com credenciais sintéticas. |
| `src/modules/messaging/infrastructure/publisher-lifecycle.ts` | Lifecycle Nest e drenagem do Publisher. |
| `src/modules/wagering/application/pending-reference-policy.ts` | Política única de tentativas, backoff e TTL. |
| `src/modules/wagering/application/pending-reference-worker.ts` | Resolução financeira sob locks Wallet → Wager. |
| `src/modules/wagering/infrastructure/pending-reference-lifecycle.ts` | Lifecycle Nest e drenagem do PendingWorker. |
| `src/shared/application/clock.ts` | Porta de relógio e implementação de sistema. |
| `src/shared/application/worker-shutdown.ts` | Deadline, cancelamento e drenagem coordenada. |
| `src/shared/application/worker-signals.ts` | SIGTERM/SIGINT e fechamento completo de recursos. |
| `src/shared/application/worker-store.ts` | Porta persistente de claims/fencing e descoberta de pendências. |
| `test/integration/outbox-publisher.test.ts` | Concorrência real, leases, recovery e publicação Outbox. |
| `test/integration/pending-reference-worker.test.ts` | Referências, TTL aprovado, concorrência e atomicidade reais. |
| `test/integration/sqs-consumer.test.ts` | Inbox/ACK/DLQ, preservação nativa, recovery e commit incerto. |
| `test/integration/worker-entrypoints.test.ts` | Seis smokes dos scripts reais com startup e SIGTERM. |
| `test/integration/worker-persistence.test.ts` | Primitivas SQL de workers e fencing. |
| `test/integration/worker-resilience.test.ts` | Sinais reais, crashes, reinícios e processos independentes. |
| `test/support/entrypoint-client.ts` | Spawn dos entrypoints reais e leitura sanitizada de fases. |
| `test/support/entrypoint-isolation.ts` | Guarda de banco/schema/filas exclusivos antes do spawn. |
| `test/support/entrypoint-preload.ts` | Configuração de schema e observação reais restritas aos smokes. |
| `test/support/outbox-publisher-child.ts` | Processo auxiliar independente para testes Publisher. |
| `test/support/outbox-publisher-client.ts` | Protocolo de controle dos processos Publisher. |
| `test/support/outbox-sqs.ts` | Fila descartável de eventos e coleta de eventIds. |
| `test/support/pending-worker-child.ts` | Processo auxiliar independente de referências. |
| `test/support/pending-worker-client.ts` | Protocolo de controle dos processos de referências. |
| `test/support/resilience-child.ts` | Processo Nest/ORM/SQS real com barreiras de resiliência. |
| `test/support/resilience-client.ts` | Sinais, fases e diagnósticos limitados dos testes de resiliência. |
| `test/support/sqs.ts` | Filas Consumer/DLQ descartáveis e helpers reais. |
| `test/unit/entrypoint-isolation.test.ts` | Guardas positivas/negativas de isolamento dos smokes. |
| `test/unit/outbox-publisher.test.ts` | Protocolo Publisher e configuração sem promessa distribuída. |
| `test/unit/pending-reference-policy.test.ts` | Backoff, tentativas e limites TTL. |
| `test/unit/pending-reference-worker.test.ts` | Ordem de locks, transições e política compartilhada. |
| `test/unit/resilience-diagnostics.test.ts` | Sanitização de fases e propagação de abort do SDK. |
| `test/unit/sqs-consumer.test.ts` | ACK/erros e regressão negativa do descarte de unknown. |
| `test/unit/worker-config.test.ts` | Validação de configuração e ClockPort. |
| `test/unit/worker-shutdown.test.ts` | Deadline, lifecycle, coordenação de sinais e fechamento. |

#### C. Exclusões

Nenhuma exclusão identificada.

#### D. Fora do commit

- `.env`: existente, ignorado, fora do índice e preservado; contém configuração/credenciais locais, nunca incluir.
- `node_modules/`: existente e ignorado; dependências instaladas não devem ser versionadas.
- `dist/`, `coverage/`, `.cache/`, `.env.*`, `*.log`, `*.tmp`, `*.temp`, `.DS_Store`: padrões de exclusão já configurados; não são novos arquivos candidatos identificados neste inventário.
- Os 67 rastreados inalterados, incluindo AGENTS.md, technical-challenge.md, Jungle-Architecture-v0.2.md, IMP-01-EVIDENCE.md e IMP-02-EVIDENCE.md, não têm mudanças a incluir. Metadados internos de `.git/` não integram o inventário de arquivos de trabalho para commit.

### Conferências próprias deste fechamento

Somente IMP-03-EVIDENCE.md, ARCHITECTURE.md e README.md editados. Comparação SHA-256 antes/depois confirma preservação de código, testes, migrations, dependências, lockfile, Compose e demais arquivos. Normativos e IMP-02-EVIDENCE.md também idênticos ao HEAD. Inventário inicial/final: mesmos 128 caminhos, nenhuma criação ou remoção.

`git diff --check` aprovado. `.env` ignorado por git check-ignore, ausente de git ls-files/índice e preservado por comparação de hash sem divulgar conteúdo. Índice permanece vazio; nenhum staging foi realizado.

Busca automatizada nos 128 arquivos potencialmente versionáveis por chaves privadas, tokens reconhecidos, URLs PostgreSQL autenticadas literais e correspondência com valores secretos locais relevantes: **nenhuma credencial identificada**. Três candidatos de atribuição literal foram inspecionados: scripts/check-sqs.ts, infrastructure/local-sqs-client.ts e test/unit/resilience-diagnostics.test.ts usam apenas credenciais sintéticas `test` do emulador. Placeholders documentais e fixtures sintéticas não são segredos reais. A busca é limitada aos padrões e valores examinados, não uma garantia absoluta para todo formato possível de segredo.

### Comandos propostos — NÃO EXECUTADOS

Executar somente após autorização humana expressa e nova conferência do estado, pois o inventário descreve este working tree específico. Staging explícito dos 61 caminhos, sem adicionar diretórios indiscriminadamente:

```sh
git add -- \
  ARCHITECTURE.md \
  README.md \
  bun.lock \
  docker-compose.yml \
  package.json \
  src/database/mappers.ts \
  src/database/postgres-financial-store.ts \
  src/modules/messaging/messaging.module.ts \
  src/modules/wagering/application/process-wager-transaction.use-case.ts \
  src/modules/wagering/wagering.module.ts \
  src/shared/application/financial-store.ts \
  IMP-03-EVIDENCE.md \
  docker/localstack/init/10-provision-queues.sh \
  scripts/check-sqs.ts \
  scripts/consume-wagers.ts \
  scripts/publish-outbox.ts \
  scripts/resolve-pending-references.ts \
  src/modules/messaging/application/consumer-config.ts \
  src/modules/messaging/application/consumer-errors.ts \
  src/modules/messaging/application/outbox-publisher.ts \
  src/modules/messaging/application/sqs-transport.ts \
  src/modules/messaging/application/sqs-wager-consumer.ts \
  src/modules/messaging/application/wager-request.ts \
  src/modules/messaging/application/worker-config.ts \
  src/modules/messaging/infrastructure/aws-sqs-consumer-transport.ts \
  src/modules/messaging/infrastructure/aws-sqs-outbox-transport.ts \
  src/modules/messaging/infrastructure/consumer-lifecycle.ts \
  src/modules/messaging/infrastructure/local-sqs-client.ts \
  src/modules/messaging/infrastructure/publisher-lifecycle.ts \
  src/modules/wagering/application/pending-reference-policy.ts \
  src/modules/wagering/application/pending-reference-worker.ts \
  src/modules/wagering/infrastructure/pending-reference-lifecycle.ts \
  src/shared/application/clock.ts \
  src/shared/application/worker-shutdown.ts \
  src/shared/application/worker-signals.ts \
  src/shared/application/worker-store.ts \
  test/integration/outbox-publisher.test.ts \
  test/integration/pending-reference-worker.test.ts \
  test/integration/sqs-consumer.test.ts \
  test/integration/worker-entrypoints.test.ts \
  test/integration/worker-persistence.test.ts \
  test/integration/worker-resilience.test.ts \
  test/support/entrypoint-client.ts \
  test/support/entrypoint-isolation.ts \
  test/support/entrypoint-preload.ts \
  test/support/outbox-publisher-child.ts \
  test/support/outbox-publisher-client.ts \
  test/support/outbox-sqs.ts \
  test/support/pending-worker-child.ts \
  test/support/pending-worker-client.ts \
  test/support/resilience-child.ts \
  test/support/resilience-client.ts \
  test/support/sqs.ts \
  test/unit/entrypoint-isolation.test.ts \
  test/unit/outbox-publisher.test.ts \
  test/unit/pending-reference-policy.test.ts \
  test/unit/pending-reference-worker.test.ts \
  test/unit/resilience-diagnostics.test.ts \
  test/unit/sqs-consumer.test.ts \
  test/unit/worker-config.test.ts \
  test/unit/worker-shutdown.test.ts
```

Antes de confirmar o commit, revisar `git diff --cached --check`, `git diff --cached --stat` e `git diff --cached`. Comando de commit proposto, igualmente não executado:

```sh
git commit -m "feat(imp-03): add SQS workers and distributed recovery"
```

Nenhum comando de push proposto como autorizado. O rollback técnico do REV3-FIX-01 continua documentado na seção anterior; este fechamento não executa reversão nem altera suas condições.

**Encerramento IMP-03-CLOSE: IMP-03 TECNICAMENTE APROVADO. VERSIONAMENTO PENDENTE DE AUTORIZAÇÃO HUMANA.** Nenhuma mudança funcional, git add, commit, push ou início do IMP-04.
