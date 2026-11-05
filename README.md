# Distributed Wagering Processor

IMP-01 aprovado e publicado no commit b1b17ea6f5e1f4b841e8fd880463b948019e0651. **IMP-02 aprovado por Luís após revisão independente do Antigravity: APROVAR COM RECOMENDAÇÕES NÃO BLOQUEANTES.** Validação independente informada: PostgreSQL 16.6, 165 testes aprovados, zero falhas, 985 asserções, 17 arquivos, três processos Bun, TypeScript strict e bootstrap NestJS + MikroORM aprovados. Esses resultados externos não foram executados pelo Codex nesta sessão. Consulte IMP-02-EVIDENCE.md para proveniência, fechamento e encaminhamentos VAL02.

**IMP-03 TECNICAMENTE APROVADO. VERSIONAMENTO PENDENTE DE AUTORIZAÇÃO HUMANA de Luís Henrique Pereira.** O parecer complementar Antigravity é APROVAR REV3-FIX-01, sem bloqueantes (identificação exibida: Gemini 4 Argon — medium). A revisão foi predominantemente estática: o revisor executou typecheck, 259 unitários e diff-check, sem reexecutar integrações. A regressão de 366 testes/0 falhas/2753 asserções/31 arquivos, integrações reais, seis smokes, bootstrap e SQS foram executados anteriormente pelo Codex no REV3-FIX-01. Esta sessão IMP-03-CLOSE somente consolida documentos e confere integridade; não repetiu testes. IMP-03 ainda sem commit/publicação; IMP-04 não iniciado. O histórico abaixo preserva os estados anteriores, superados pelo fechamento atual.

## Ambiente

- Bun **1.4.4** (família 1.x), fixado em `packageManager`.
- TypeScript strict, NestJS 11.1.6 e decimal.js 10.6.0.
- Se Bun não estiver no PATH do shell automatizado: `export PATH="$HOME/.bun/bin:$PATH"`.
- Dependências diretas têm versões exatas e `bun.lock` foi gerado pelo Bun na instalação externa realizada pelo responsável técnico.

```sh
bun --version
bun --revision
bun install --frozen-lockfile
bun run typecheck
bun test
bun run check:bootstrap
bun run dev
```

Use `bun install --frozen-lockfile` nas instalações. Quando as dependências já estiverem disponíveis no cache local, `bun install --offline --frozen-lockfile` também permite validar a instalação sem rede.

O bootstrap escuta em `127.0.0.1:3000`, configurável por `PORT`. Não existem endpoints financeiros. O script `check:bootstrap` inicia NestJS em uma porta efêmera, verifica HTTP 404 e fecha a aplicação.

O compilador verifica fontes, testes e scripts em strict. `skipLibCheck=true`, conforme a configuração recomendada pelo Bun, omite a verificação interna dos `.d.ts` das dependências. Os conflitos observados entre bun-types 1.3.3 e @types/node 26.6.6 estão registrados nas evidências; as declarações das dependências não foram corrigidas ou validadas entre si.

## Estrutura

```text
src/
  app.module.ts
  main.ts
  shared/domain/           # Money, erros, validação e envelope de eventos
  modules/
    wallets/              # Wallet, ledger e WalletBalanceChanged
    wagering/             # Transações, regras puras, abertura e eventos
    messaging/            # Modelos Inbox e Outbox
test/
  fixtures.ts
  unit/                   # Testes Bun; nenhum banco/broker simulado
scripts/check-bootstrap.ts
```

## Evidência e limites do IMP-01

Os testes financeiros do IMP-01 eram sequenciais e locais ao domínio. Não demonstravam idempotência persistente, atomicidade SQL, concorrência distribuída, recuperação de crash ou entrega de eventos. Naquela etapa não havia banco, ORM operacional, migrations, consumidor SQS, publisher, workers ou autenticação.

O domínio não publica eventos: fornece envelopes e modelos para persistência posterior. Os artefatos de abertura e movimentos deverão ser gravados atomicamente pelos casos de uso dos próximos pacotes.

Consulte `ARCHITECTURE.md` para contratos e decisões, e `IMP-01-EVIDENCE.md` para resultados realmente executados e bloqueios. Os três documentos normativos originais permanecem preservados.

## PostgreSQL e IMP-02

As descrições acima dos limites locais referem-se à evidência do IMP-01. O IMP-02 acrescenta persistência, migration e casos de uso. As suítes PostgreSQL foram aprovadas externamente por Luís: schema 9 testes/24 asserções, financeiro 24/159 e multiprocessos 3/31, sem falhas. A restrição do sandbox explica a atribuição externa dessas evidências. Na entrega do IMP-02 ainda não havia consumidor SQS, publisher ou worker operacional; esses componentes foram acrescentados no IMP-03. Autenticação e API financeira permanecem fora desta entrega.

Dependências novas: MikroORM core/postgresql/migrations 6.6.8 e adapter Nest 6.1.1. Depois da instalação inicial que atualiza bun.lock, usar frozen-lockfile. Não editar o lockfile manualmente.

Variáveis locais necessárias:

| Variável | Uso |
|---|---|
| JUNGLE_DB_PASSWORD | Senha local de desenvolvimento, exigida pelo Compose |
| JUNGLE_DB_USER | Usuário de desenvolvimento, default jungle |
| JUNGLE_DB_PORT | Porta de desenvolvimento, default 5433 |
| JUNGLE_TEST_DB_PASSWORD | Senha da instância descartável de testes |
| JUNGLE_TEST_DB_PORT | Porta de teste, default 5434 |
| DATABASE_URL | URL PostgreSQL do banco jungle_dev; ativa DatabaseModule no Nest |
| TEST_DATABASE_URL | URL PostgreSQL do banco jungle_test; obrigatória para testes de integração |

Configure ambas as senhas no shell sem versioná-las. URLs devem usar senha codificada para URI quando houver caracteres especiais. Desenvolvimento e teste são serviços distintos; desenvolvimento usa volume nomeado jungle_postgres_dev, testes usam tmpfs. Recursos Compose têm prefixo jungle.

```sh
bun install
docker compose --profile test up -d --wait postgres postgres-test
# Configure DATABASE_URL e TEST_DATABASE_URL com as credenciais e portas acima.
bun run db:migrate
bun run typecheck
bun run test:unit
bun run test:integration
bun test
git diff --check
```

Formato das URLs: `postgresql://<usuario>:<senha>@127.0.0.1:<porta>/jungle_dev` e `postgresql://jungle_test:<senha>@127.0.0.1:<porta>/jungle_test`.

Os testes recusam banco diferente de jungle_test. Cada suíte cria um schema próprio jungle_it_<uuid> e remove apenas esse schema ao finalizar. O teste de migration down/up opera nesse schema novo, nunca no banco de desenvolvimento. Nenhum comando down -v é necessário.

`bun run db:rollback` remove tabelas/dados do schema configurado; o script exige JUNGLE_ALLOW_SCHEMA_ROLLBACK=yes para uma execução explicitamente autorizada em ambiente descartável. Não usar em banco com dados a preservar.

Integração cobre PostgreSQL real e três processos Bun independentes. Ausência de dependência, TEST_DATABASE_URL, Docker ou permissão TCP deve causar falha explícita, não um resultado verde com integração omitida. Unitários podem ser executados separadamente com `bun run test:unit`. Checkpoints internos de teste injetam falhas antes do commit e não são campos de entrada HTTP/SQS.

## IMP-03 — histórico de implementação e validação funcional

CP-01 validado externamente por Luís: SDK SQS 3.922.0, frozen install, cinco testes PostgreSQL/31 asserções e verificação efetiva das três filas FIFO/redrive (maxReceiveCount=5). CP-02 Consumer/Inbox/ACK/retry/DLQ validado externamente por Luís: 14 testes aprovados, 0 falhas, 87 asserções. Consulte [IMP-03-EVIDENCE.md](IMP-03-EVIDENCE.md). CP-03 Publisher validado externamente: 10 testes/412 asserções, três processos e 100 eventos nos cenários aprovados. CP-04 validado externamente: 20 testes/171 asserções e três processos PostgreSQL independentes. CP-05 validado funcionalmente na regressão externa final executada por Luís no Ubuntu com PostgreSQL e LocalStack reais: **345 testes aprovados, 0 falhas, 2500 asserções, 29 arquivos**, typecheck, bootstrap NestJS + MikroORM e diff-check aprovados. Esses resultados não foram executados pelo Codex nesta sessão. CP-01 a CP-05 funcionalmente validados; revisão independente do Antigravity e aprovação humana pendentes. IMP-04 não iniciado.

O Compose acrescenta LocalStack na porta local `${LOCALSTACK_PORT:-4566}`. O hook ready.d cria as três filas FIFO; `SQS_MAX_RECEIVE_COUNT` controla redrive da entrada para DLQ (default 5). Para provisionar somente o novo serviço: `docker compose up -d --wait localstack`. Para verificar: `bun scripts/check-sqs.ts`.

Consumer standalone, sem endpoints financeiros novos:

```sh
bun scripts/consume-wagers.ts
```

Requer DATABASE_URL e filas existentes; não executa migrations automaticamente. Usa o mesmo ProcessWagerTransactionUseCase do IMP-02, Inbox persistente e ACK após commit. Falha comprovadamente permanente envia diagnóstico à DLQ antes do ACK; falha de envio não apaga a origem. Diagnóstico manual não copia corpo financeiro, receipt ou erro bruto; contém hash/identidade para investigação. Após REV3-FIX-01, falhas unknown, inclusive infraestrutura sem code reconhecido, recebem retry sem envio manual à DLQ ou exclusão por esgotamento. A RedrivePolicy da fila controla o redrive nativo e preserva o envelope SQS original para recuperação. A DLQ admite diagnósticos e envelopes originais; somente o envelope financeiro válido pode ser reenviado operacionalmente, preservando messageId e identidades de negócio. FIFO não substitui idempotência PostgreSQL.

| Variável | Default |
|---|---|
| SQS_ENDPOINT | http://127.0.0.1:4566; somente emulador local |
| AWS_REGION | us-east-1 |
| SQS_INPUT_QUEUE_NAME | wager-transactions.fifo |
| SQS_DLQ_QUEUE_NAME | wager-transactions-dlq.fifo |
| SQS_CONSUMER_NAME | wager-transactions-consumer; manter igual entre instâncias |
| SQS_MAX_RECEIVE_COUNT | 5; precisa coincidir com redrive real |
| SQS_WAIT_SECONDS | 20 |
| SQS_VISIBILITY_TIMEOUT_SECONDS | 120; dimensionar acima do processamento normal |
| SQS_REQUEST_TIMEOUT_MS | 3000; receive acrescenta o tempo de long polling |
| SQS_RETRY_BASE_SECONDS / SQS_RETRY_MAX_SECONDS | 1 / 60 |

Credenciais do emulador são sintéticas; nenhuma credencial AWS real é necessária. URLs PostgreSQL/segredos continuam no ambiente ou .env local ignorado. O endpoint do adapter é limitado a hosts locais. Filas reais de testes usam nomes jungle_it_<uuid>; schemas são descartáveis apenas em jungle_test. Sem PurgeQueue ou remoção das filas compartilhadas.

```sh
bun run typecheck
bun test test/unit
bun test test/integration/sqs-consumer.test.ts
```

Configuração dos workers (Outbox CP-03 e referências CP-04): OUTBOX_LEASE_MS=10000, SQS_SEND_TIMEOUT_MS=3000, OUTBOX_BASE_RETRY_MS=1000, OUTBOX_MAX_RETRY_MS=60000, PENDING_REF_BASE_DELAY_MS=1000, PENDING_REF_MAX_ATTEMPTS=10 e PENDING_REF_TTL_MS=86400000. VAL02-02 foi implementado e validado externamente no CP-04; Luís aprovou formalmente a Opção A: TTL limita a espera por referência indisponível; uma referência já válida pode ser processada na avaliação transacional mesmo após o prazo de espera registrado. Relógios distribuídos devem estar sincronizados em UTC. Crash recovery/shutdown foram validados funcionalmente na regressão externa CP-05, com revisão independente ainda pendente.

### Outbox Publisher — CP-03

```sh
bun scripts/publish-outbox.ts
```

Requer DATABASE_URL e fila FIFO existente. Não aplica migrations. Reivindica um evento por vez e publica após o commit do claim; confirma/reagenda em nova transação com owner/token/lease. Republicações mantêm eventId e envelope. Entrega at-least-once: consumidores precisam deduplicar por eventId, inclusive fora da janela FIFO.

| Variável | Default |
|---|---|
| SQS_EVENTS_QUEUE_NAME | wagering-events.fifo |
| OUTBOX_WORKER_ID | Gerado por processo/início |
| OUTBOX_POLL_INTERVAL_MS | 250 |
| OUTBOX_LEASE_MS | 10000 |
| SQS_SEND_TIMEOUT_MS | 3000 |
| OUTBOX_BASE_RETRY_MS / OUTBOX_MAX_RETRY_MS | 1000 / 60000 |

Lease exige pelo menos 1000ms de margem sobre timeout. Eventos não são descartados por esgotamento; falhas deixam retry ou lease recuperável. Timeout após aceite pode causar republicação. Diagnóstico contém código/eventId, sem corpo ou erro bruto. A validação externa CP-03 foi aprovada por Luís (10 testes/412 asserções). Para reproduzir: executar `bun test test/integration/outbox-publisher.test.ts` no Ubuntu, com LocalStack/PostgreSQL acessíveis. O teste usa somente filas e schemas descartáveis próprios em jungle_test; não iniciar o publisher nas filas compartilhadas para executar esses cenários.

### Referências pendentes — CP-04

```sh
bun scripts/resolve-pending-references.ts
```

Processo Nest standalone, requer DATABASE_URL; não aplica migrations nem consome SQS. Descobre vencimentos com ClockPort e resolve sob locks Wallet → Wager, usando as regras financeiras existentes. Wallet/wager/ledger/Outbox são confirmados juntos; a Inbox do aceite permanece processada.

| Variável | Default |
|---|---|
| PENDING_REF_BASE_DELAY_MS | 1000 |
| PENDING_REF_MAX_ATTEMPTS | 10 |
| PENDING_REF_TTL_MS | 86400000 |
| PENDING_REF_POLL_INTERVAL_MS | 250 |
| PENDING_REF_BATCH_SIZE | 100 |

Aceitação e worker usam a mesma política; aplicar os mesmos valores entre instâncias. O prazo expiresAt persistido não é prorrogado. attempts conta reagendamentos; após o primeiro vencimento o delay é base*2, depois base*4. Uma referência já válida usa a avaliação financeira normal; limites encerram espera por referência ausente/ainda pendente. Backoff que não cabe antes do deadline rejeita com REFERENCE_NOT_FOUND_TIMEOUT. Reagendamento preserva snapshot e não repete eventos de status; resolução/rejeição terminal gera evento Outbox.

Validação externa isolada: `bun test test/integration/pending-reference-worker.test.ts`. A suíte usa somente schemas descartáveis em jungle_test e três processos Bun; não exige LocalStack. Não iniciar o worker nas filas/banco compartilhados para executar cenários de teste. Gate CP-04 validado por Luís; os cenários de shutdown/reinício também foram incluídos na regressão externa final do CP-05, aprovada funcionalmente por Luís.

### Shutdown e resiliência — CP-05

Os três scripts de worker usam coordenação explícita de SIGTERM/SIGINT: parar polls/cancelar long polling → aguardar in-flight → fechar contexto Nest/ORM/SQS → marcar stopped. ACK continua condicionado ao commit. Mensagens recebidas sem processamento ou tentativas encerradas com erro durante parada devolvem visibilidade; se o receipt não chegou ao cliente, a recuperação usa o timeout SQS.

WORKER_SHUTDOWN_TIMEOUT_MS default **60000**, validado em 1..300000ms, cobre drenagem e fechamento dos recursos. Ao exceder, exit 1 é interrupção forçada e requer recuperação persistente; não é sucesso gracioso. Falha inesperada do loop também exige reinício pelo supervisor. Configurar a margem do supervisor acima desse orçamento. SIGKILL nunca é tratado como gracioso.

Para fechar um contexto de worker programaticamente, usar closeWorkerApplication de src/shared/application/worker-signals.ts. Os scripts já usam enableWorkerSignals; não adicionar app.enableShutdownHooks em paralelo. Um fechamento programático direto com app.close não finaliza o watchdog do worker: usar o coordenador.

```sh
bun run typecheck
bun test test/unit
bun test test/integration/worker-resilience.test.ts
bun test
bun run check:bootstrap
git diff --check
```

A suíte CP-05 usa PostgreSQL/LocalStack reais, somente schemas e filas descartáveis Jungle, sinais reais e processos independentes. As tentativas anteriores do Codex ficaram bloqueadas no sandbox; a regressão completa posterior foi aprovada externamente por Luís. O IMP-03 está implementado e validado funcionalmente, aguardando revisão independente e aprovação humana. A Opção A de TTL foi formalmente aprovada, sem alteração de comportamento financeiro. Consulte IMP-03-EVIDENCE.md para proveniência, histórico e riscos residuais.

### IMP-03/REV3-FIX-01 — validação após a revisão independente

REV3-01 corrigido: unknown segue retry/redrive nativo, preservando o envelope. Erros comprovadamente permanentes mantêm o contrato anterior. Recuperação da DLQ deve preservar messageId, idempotencyKey e demais campos de negócio; não reenviar diagnósticos como operações. Retenção da DLQ é finita: exige acompanhamento e recuperação operacional, sem promessa de armazenamento permanente.

Smoke tests dos scripts reais, com as composições Nest de produção:

```sh
bun test test/integration/worker-entrypoints.test.ts
```

O teste cria os próprios schemas em jungle_test e filas jungle_it_<uuid>. Não executar os scripts manualmente sobre recursos compartilhados para substituir essa prova. Um preload exclusivamente de teste configura o schema e observa operações reais: valida isolamento antes do spawn e da liberação do ORM para o Nest, sem substituir os módulos de produção. Cobre trabalho, duplicatas, reinício, SIGTERM, fechamento de ORM/SQS e startup inválido sanitizado. A configuração pública de produção não foi alterada.

Codex executou neste checkpoint: **366 testes aprovados, 0 falhas, 2753 asserções, 31 arquivos**, typecheck e bootstrap HTTP com DATABASE_URL direcionado a jungle_test. Os seis smokes passaram com 134 asserções. Ver IMP-03-EVIDENCE.md para o RED, GREEN, comandos, isolamento e limites. Este resultado atualiza o encaminhamento anterior: o IMP-03 aguarda **revisão independente complementar e aprovação humana para commit**. Nenhum commit/push; IMP-04 não iniciado.


### IMP-03-CLOSE — parecer complementar e versionamento

O parecer Antigravity recebido por Luís foi **APROVAR REV3-FIX-01**, sem bloqueantes (identificação exibida: Gemini 4 Argon — medium). Confirmou recuperação de unknown por redrive nativo, envelope/identidades preservados, idempotência, permanentes e falhas de ACK/visibilidade/commit seguros, sem exposição adicional de dados ou retry infinito fora da política/retenção. Confirmou também a cobertura dos três entrypoints reais. Revisão predominantemente estática: typecheck, 259 unitários e diff-check executados pelo revisor; integrações não reexecutadas por ele. A regressão 366/0/2753 em 31 arquivos continua atribuída ao Codex no REV3-FIX-01, não a esta sessão documental.

Riscos não bloqueantes: R1, distinguir WagerTransactionDeadLetter de WagerTransactionRequested na DLQ e nunca reenviar diagnóstico como operação; R2, preload de schema exclusivo dos smokes; R3, API HTTP, observabilidade e VAL02-01 no IMP-04. A rastreabilidade de REV3-03 a REV3-07 está no quadro de fechamento de IMP-03-EVIDENCE.md: propostas de testes/ajuste temporal não são correções realizadas ou novos aceites funcionais; tentativas/TTL e Opção A continuam preservados.

O inventário final contém 61 candidatos ao futuro commit (11 rastreados modificados, 50 novos, nenhuma exclusão), com caminho/finalidade e proposta explícita de staging em IMP-03-EVIDENCE.md. .env e node_modules permanecem fora do commit. Somente README.md, ARCHITECTURE.md e IMP-03-EVIDENCE.md foram editados no fechamento; não houve nova execução de testes ou mudança funcional.

**IMP-03 TECNICAMENTE APROVADO. VERSIONAMENTO PENDENTE DE AUTORIZAÇÃO HUMANA de Luís Henrique Pereira.** Aguardar autorização antes de git add/commit/push; IMP-04 não iniciado.
