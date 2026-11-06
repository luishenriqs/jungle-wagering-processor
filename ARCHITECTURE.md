# Decisões de implementação — Distributed Wagering Processor

Fonte normativa: [technical-challenge.md](technical-challenge.md); desenho aprovado: [Jungle-Architecture-v0.2.md](Jungle-Architecture-v0.2.md). Decisões posteriores aprovadas por Luís são registradas neste documento e nas evidências por pacote.

## Estado da entrega — IMP-04 concluído

A implementação inclui API financeira, reconciliação, health checks, logs estruturados e métricas operacionais, além do domínio/persistência/mensageria dos IMP-01–03. GREEN-G1–G5 foram homologados; G6A validou cinco integrações sem migrations e quatro grafos DI reais, com nove negativos; G6B validou métricas após commit/rollback/retry em PostgreSQL isolado (`20/20` testes aprovados em `test/integration/operational-metrics.test.ts`, compondo `989` testes unitários em `27` arquivos e `216` testes de integração em `14` arquivos, totalizando `1.205` testes aprovados em `41` arquivos). A evidência consolidada da entrega está em [FINAL-DELIVERY-EVIDENCE.md](FINAL-DELIVERY-EVIDENCE.md); os relatórios históricos das etapas anteriores estão em [IMP-01-EVIDENCE.md](IMP-01-EVIDENCE.md), [IMP-02-EVIDENCE.md](IMP-02-EVIDENCE.md) e [IMP-03-EVIDENCE.md](IMP-03-EVIDENCE.md).

HTTP e SQS reutilizam ProcessWagerTransactionUseCase. MikroORM usa EntityManager transacional por tentativa e SQL parametrizado explícito para locks/claims. Money permanece decimal string/NUMERIC(18,2); não depende dos tipos monetários do ORM. Locks wallet → wager e unicidade SQL preservam concorrência entre processos, incluindo chaves repetidas em wallets distintas. Os detalhes abaixo conservam as decisões e o histórico dos pacotes: referências a implementação futura ou aprovação pendente descrevem o estado daquela etapa e são superadas por este fechamento.

### API, autenticação e fronteiras de confiança

Controllers validam DTOs e encaminham aos casos de uso; não fazem operações financeiras diretamente. Rotas expostas: `POST /wallets` (`201 Created`), `GET /wallets/:walletId` (`200 OK`), `GET /wallets/:walletId/ledger` (`200 OK`, paginação por cursor `(createdAt, id)`), `POST /wallets/:walletId/reconciliation` (`200 OK`, corpo vazio), `POST /wagering/transactions` (`200 OK` para `PROCESSED`, `202 Accepted` para `PENDING_REFERENCE`, `422 Unprocessable Entity` para `REJECTED` de negócio, `409 Conflict` para colisão de `Idempotency-Key` ou `(providerId, externalTransactionId)` com payload divergente, `404 Not Found` para recursos inexistentes, `400 Bad Request` para contrato inválido e `503 Service Unavailable` para falha transitória esgotada), `GET /wagering/transactions/:transactionId` (`200 OK`), `GET /providers/:providerId/wagering/transactions/:externalTransactionId` (`200 OK`), `GET /health/live` (`200 OK`), `GET /health/ready` (`200 OK` / `503 Service Unavailable` verificando `PostgresHealthProbe` e `SqsHealthProbe` nas três filas FIFO) e `GET /metrics` (`200 OK`). Wager HTTP exige um único `Idempotency-Key`; canonicalização e hash SHA-256 são os mesmos do canal SQS. A reconciliação compara saldo materializado e soma exata do ledger sob `REPEATABLE READ` sem corrigir valores silenciosamente. Health expõe liveness/readiness sem dados sensíveis; falhas operacionais e `HttpExceptionFilter` usam códigos estáveis, `x-correlation-id` e logs JSON sanitizados via `stderrOperationalLog`.

Autenticação não foi implementada, conforme opção permitida pelo desafio para priorizar correção financeira. ProviderIdentityGuard é o ponto de extensão explícito e permite todas as requisições. Em uma implantação exposta, o desenho seria integrar Keycloak/Zitadel via OIDC: validar assinatura/JWKS, issuer, audience e expiração de access tokens; vincular claims confiáveis à identidade do provider e autorizar acesso à wallet antes do caso de uso. Não haveria tabela própria de senhas. Health permanece aberto; SQS é canal interno confiável, mas os campos de provider continuam sujeitos às validações de domínio. Esse desenho não representa autenticação já disponível.

### Métricas operacionais e DI

Um provider OPERATIONAL_METRICS por DatabaseModule fornece o mesmo coletor aos três casos financeiros e aos workers do grafo. Consultas recebem somente UoW. AppModule.register e as factories standalone aceitam coletor explícito; grafos padrão independentes criam instâncias independentes. GET /metrics devolve um snapshot JSON com scope process e cópias defensivas. Não existe agregação entre processos nem persistência das métricas.

M1/M2 contam resultados originais/replays após confirmação da UoW; conflitos definitivos são classificados separadamente. M3 exige retry efetivamente programado; no Consumer, só após confirmação de visibilidade. M4 exige DLQ e ACK confirmados. M5 conta SQLSTATEs homologados por ocorrência, inclusive tentativa final; 23505 só nas constraints conhecidas. M6 exige completeOutbox confirmado e usa a mesma amostra de tempo enviada ao SQL; lag regressivo válido satura em zero e amostra inválida omite apenas a métrica. M7 mede duração monotônica, incluindo retries/backoff, antes dos observers finais; M8 conta divergência confirmada de reconciliação. Pending emite resolução somente para processed/rejected/rescheduled após confirmação.

O emissor defensivo isola throws, rejeições e reentrância e não aguarda retornos assíncronos dos observers. Observers customizados executam sincronicamente até retornar; código que bloqueie a thread não pode ser preemptado pelo emissor. Labels têm cardinalidade fixa e contadores saturam em inteiro seguro. Transferências confirmadas de DLQ não representam tamanho atual da fila; lag representa idade na confirmação da publicação, não latência de consumo.

### Evidência externa e isolamento

G6A intercepta CoreORM.init para impedir ensureDatabase/ensureIndexes e verifica a configuração efetiva e identidade PostgreSQL via query read-only. Exige public vazio, bloqueia Migrator.up e intercepta a UoW antes do bootstrap dos loops. As sondas exercitam providers reais com estado financeiro em memória; filas SQS são reais e exclusivas. Contextos são sequenciais, totalmente fechados antes do próximo, com watchdog concluído. Filhos têm deadline e kill/join de contingência.

G6B usa a migration versionada Migration202611040001 somente em schemas jungle_it_<uuid> do banco jungle_test; valida identidade e inventário antes de migrar e remove apenas os próprios schemas. Essa prova complementa G6A: testes sem migration não provam commit/rollback financeiro real. Nenhum mecanismo de isolamento de teste substitui a implementação de produção.

## Fundação e dependências

NestJS `11.1.6` (`common`, `core` e `platform-express` alinhados), `reflect-metadata` `0.2.2` e RxJS `7.8.2` compõem o bootstrap mínimo. TypeScript `5.9.3` executa a verificação estática; `@types/bun` `1.3.3` fornece os contratos do runner. Bun `1.4.4` executa a aplicação, instala pacotes e roda os testes. Versões diretas exatas e o lockfile gerado evitam atualizações automáticas. No IMP-01, typecheck, 93 testes e inicialização/DI/fechamento NestJS sem socket passaram no executor. O bootstrap HTTP passou fora do sandbox, conforme evidência de Luís: `bun run check:bootstrap`, http://127.0.0.1:35221, HTTP 404 esperado, exit 0. O IMP-01 foi posteriormente aprovado e publicado no commit b1b17ea6f5e1f4b841e8fd880463b948019e0651.

O tsconfig mantém `strict`, `exactOptionalPropertyTypes` e as demais verificações de código. Segue-se a [recomendação oficial do Bun](https://bun.com/docs/runtime/typescript) de `skipLibCheck=true`: fontes, testes e scripts são verificados contra os tipos das bibliotecas, mas os arquivos `.d.ts` não são verificados internamente. A instalação resolveu bun-types `1.3.3` com @types/node `26.6.6` (a dependência transitiva de bun-types é `*`); a checagem completa das declarações revelou conflitos em `noDeprecation`, `EncodeIntoResult` e tipos TLS. A biblioteca DOM foi removida do tsconfig porque o alvo é Bun, que fornece os tipos web utilizados, sem frontend. Não houve edição de node_modules, redução de strict, remoção de testes ou alteração dos tipos financeiros. O trade-off é que a compatibilidade interna dos tipos transitivos permanece sem comprovação; uma futura atualização controlada deve alinhar esses pacotes.

Não há CLI Nest, biblioteca de testes adicional ou dependência de infraestrutura no domínio. A composição de módulos está nas classes `*.module.ts`. A referência oficial para o bootstrap é [NestJS First steps](https://docs.nestjs.com/first-steps).

O bootstrap fecha a aplicação caso a abertura da porta falhe, antes de propagar o erro. O script de validação HTTP continua exigindo listen e uma resposta HTTP real; EPERM não é convertido em sucesso nem substituído por teste sem socket.

## Money

`decimal.js` `10.6.0` é a biblioteca decimal já prevista na v0.2. Usa-se um construtor clonado, privado ao módulo, com precisão 40. Nenhum valor monetário é convertido para `number`. A soma/subtração de dois valores no limite NUMERIC(18,2) requer no máximo 19 dígitos; a precisão configurada comporta os cálculos sem arredondamento. Referência: [decimal.js API](https://mikemcl.github.io/decimal.js/).

Contratos aceitam exatamente duas casas e até 16 dígitos inteiros, sem espaços, sinal, expoente, zeros iniciais redundantes ou separador local. Overflow é rejeitado antes de construir um decimal excessivamente longo. O limite absoluto, incluindo resultados internos negativos, é `9999999999999999.99`. `subtract` e `negate` podem produzir negativos; entradas externas, saldos e snapshots não podem.

`toString()` retorna somente o valor decimal fixo; `toJSON()` inclui moeda. Todas as operações binárias, inclusive igualdade e comparação, rejeitam moedas diferentes. A validação de moeda usa os códigos reconhecidos por `Intl.supportedValuesOf('currency')` no runtime fixado; não aplica quantidade variável de casas por moeda. BRL é a moeda operacional; USD também é exercitado nos testes. A lista depende dos dados ICU do runtime, razão para fixar Bun.

## Encapsulamento e reidratação

Classes usam construtores privados, factories e campos privados ECMAScript (`#`). Instâncias são congeladas; campos privados mutáveis só mudam pelos métodos de transição. Datas são copiadas na entrada e em cada getter. Money não expõe o objeto Decimal interno. Payloads JSON são copiados e congelados recursivamente, inclusive arrays.

Factories `rehydrate` recebem estados confiáveis da futura persistência. Copiam estruturas/datas, mas não reexecutam transições de negócio, abertura, créditos, débitos ou emissão de eventos. Não substituem constraints do banco nem validam retrospectivamente todas as regras de negócio.

## Wallet, ledger e abertura

`Wallet.open` retorna uma Wallet. Abertura positiva exige identidades do lançamento e da transação e expõe o lançamento em `openingEntry`; zero não cria lançamento. A versão inicial é sempre 1.

`debit`/`credit` recebem valor, instante e identidades de transação/ledger e retornam `WalletLedgerEntry`. O método calcula e valida o lançamento inteiro antes de atribuir saldo, versão e timestamp. Valores zero não são movimentos válidos; LOSS não chama esses métodos. Não há setter público de saldo nem histórico usado como garantia de idempotência.

`createWalletOpening` é uma factory pura que reúne Wallet, transação OPENING já PROCESSED, ledger e os dois eventos. Não é um caso de uso transacional. Abertura positiva gera `WagerTransactionProcessed` e `WalletBalanceChanged` na versão 1; zero não gera nenhum desses artefatos. Os eventIds precisam ser distintos. Metadata interna segue a v0.2: provider `SYSTEM`, external/round `opening:<walletId>`, key `SYSTEM:opening:<walletId>` e game `SYSTEM_OPENING`.

IDs, tempo, correlação e hash são fornecidos pelo chamador para permitir determinismo. A factory não calcula hash de transporte nem oferece garantia global de unicidade. A persistência futura deverá salvar o bundle completo em uma única transação.

## WagerTransaction

```text
PENDING           -> PROCESSED | PENDING_REFERENCE | REJECTED | FAILED
PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED
PROCESSED / REJECTED / FAILED -> nenhuma transição
```

`create` é a entrada externa: rejeita OPENING e provider SYSTEM. `createOpening` é a factory interna. REFUND/ROLLBACK exigem referência; WIN pode tê-la; BET e LOSS rejeitam referências (VAL01-02). Referência a si mesmo é inválida. `markProcessed` também rejeita referência interna quando não há referência externa admitida. `reschedulePendingReference(nextRetryAt)` incrementa attempts somente em PENDING_REFERENCE, exige avanço do próximo instante antes do deadline e preserva snapshot/expiração (VAL01-01). O worker permanece no IMP-03.

`markProcessed` e `reject` exigem o snapshot do saldo. `markPendingReference` exige snapshot e agenda inicial; `fail` registra código terminal. Snapshots de terminais não podem ser substituídos. `requiresReference` significa exigência por kind; `expectsReference` também considera WIN com referência opcional fornecida. `ledgerDirectionFor` retorna `undefined` para LOSS.

`evaluateWager` é uma função pura: valida wallet, saldo/moeda, referência e insuficiência. Não altera entidades, não busca dados e não mantém mapas. Para REFUND/ROLLBACK, exige valor igual e contexto provider/player/wallet/round/currency correspondente. WIN pode ter valor diferente. ROLLBACK de BET credita; de WIN/REFUND debita. Referências inexistentes ou válidas ainda não terminais aguardam; referências rejeitadas/falhas não podem ser aplicadas.

Uma referência só pode ter uma reversão processada do conjunto REFUND/ROLLBACK. WIN sobre BET já revertida também é rejeitada. O chamador fornece `referenceAlreadyReversed` a partir do banco sob o futuro lock da wallet. A função verifica esse fato, mas não o garante persistentemente. A cadeia BET -> REFUND -> ROLLBACK(ref REFUND) é permitida porque a última operação referencia outro lançamento.

`matchesPayload` compara hashes; `assertReplay` também verifica provider, external ID e key. Não armazena deduplicação em memória. Canonicalização, consultas por unicidade e replay HTTP/SQS pertencem aos casos de uso futuros. Não se retorna o saldo atual para substituir o snapshot histórico.

## Códigos e erros

| FailureCode | Significado |
|---|---|
| INSUFFICIENT_FUNDS_BET | Débito de aposta excede saldo |
| INSUFFICIENT_FUNDS_REVERSAL | Débito de reversão excede saldo |
| CURRENCY_MISMATCH | Moedas incompatíveis |
| REFERENCE_NOT_FOUND_TIMEOUT | Esgotamento da espera pela referência; atribuído pelo worker futuro |
| REFERENCE_INVALID_KIND | Tipo de referência não permitido |
| REFERENCE_CONTEXT_MISMATCH | Identidade ou contexto de referência incompatível |
| REFERENCE_AMOUNT_MISMATCH | Reversão parcial ou valor divergente |
| REFERENCE_NOT_PROCESSED | Referência terminal que não foi processada |
| REFERENCE_ALREADY_REVERSED | Reversão anterior impede nova aplicação |
| INFRASTRUCTURE_PERMANENT | Falha permanente auditável que terminaliza como FAILED |

O código adicional `INFRASTRUCTURE_PERMANENT` distingue FAILED de rejeição financeira. Conflitos de idempotência são `IdempotencyConflictError`, não uma nova transação rejeitada. `InvalidTransactionStateError` indica erro de programação nas transições. Erros de valor, overflow, ledger e estado de mensagem têm classes específicas. O mapeamento HTTP não está implementado neste pacote.

## Eventos e mensageria

Os quatro eventos têm versão 1 fixa e aggregateId igual a walletId, alinhado ao agrupamento futuro por wallet. O envelope contém eventId, eventType, version, aggregateId, correlationId, causationId opcional, occurredAt ISO-8601 e data JSON. Dados monetários são MoneyProps, nunca Money. Factories rejeitam estados incompatíveis; o evento de saldo exige um ledger correspondente ao saldo observado da wallet.

Inbox preserva a primeira data de processamento em chamadas repetidas. Comparar um hash divergente lança conflito. Isso é proteção de estado local, não unicidade persistente.

Outbox usa eventId como id e persiste o envelope completo. Enfileiramento nasce pendente, com attempts 0 e nextAttemptAt igual a occurredAt. Retry número n usa `min(maxDelayMs, baseDelayMs * 2^(n-1))`, sendo o primeiro n=1. Defaults: base 1000 ms, teto 60000 ms. Política é configurável por instância e copiada defensivamente; na reidratação, o chamador deve aplicar a mesma configuração de processo. Não há jitter para manter determinismo; o teto limita o intervalo, não a quantidade de tentativas. Nenhum evento é descartado por esgotamento. Publicação é terminal para os métodos locais.

Claims, leases, fencing, envio SQS e confirmação concorrente permanecem no IMP-03. A classe Outbox não autoriza publicação antes do commit.

## Pendências dos próximos pacotes

IMP-02 implementou MikroORM, NUMERIC(18,2), migrations reversíveis, constraints, proteção de ledger/terminais, unicidades, locks wallet-first e persistência transacional de Inbox/Outbox. IMP-03 implementou seus protocolos operacionais, workers, recovery, ACK/Retry/DLQ e shutdown. IMP-04 deverá implementar API e observabilidade; não foi iniciado neste fechamento.

Autenticação não está implementada; o ponto de extensão ProviderIdentityPort/guard no-op documentado na v0.2 será tratado na borda HTTP em IMP-04. Não existem endpoints financeiros que precisem desse ponto de extensão no IMP-01.

## IMP-02 — Persistência e concorrência

**Estado: APROVADO para fechamento e versionamento por Luís Henrique Pereira.** Revisão independente do Antigravity: **APROVAR COM RECOMENDAÇÕES NÃO BLOQUEANTES**. PostgreSQL 16.6 real validado: 165 testes aprovados, 0 falhas, 985 asserções, 17 arquivos; concorrência com três processos Bun independentes, TypeScript strict, bootstrap NestJS + MikroORM e diff-check aprovados na validação independente informada pelo responsável técnico. Consulte IMP-02-EVIDENCE.md para proveniência e resultados locais separados. O IMP-03 foi posteriormente implementado e validado funcionalmente, conforme seção própria abaixo; revisão independente e aprovação humana do IMP-03 pendentes.

### Identificadores — ARC2-02

IDs internos de Wallet, WagerTransaction, ledger e Outbox são UUIDs gerados pela aplicação com `node:crypto.randomUUID()`; FKs internas também usam UUID. EventId é o próprio ID da Outbox e não é regenerado em replay. IDs válidos já recebidos não ficam limitados à versão 4.

**playerId é externo e não é validado como UUID. `wallets.player_id` e `wager_transactions.player_id` usam TEXT**, conforme decisão explícita de Luís, que substitui os tipos UUID dessas duas colunas no DDL v0.2. Provider/external transaction ID, referências externas, key, round/game e identidade da Inbox são TEXT. Preserva-se a grafia do identificador externo; walletId, que identifica um recurso interno, é validado e normalizado para UUID minúsculo antes do hash.

Domínio continua recebendo strings; fixtures unitárias existentes não foram convertidas para UUID. Integração usa UUIDs internos reais e inclui player-test-01 e playerIds em formato UUID.

### MikroORM e fronteira de persistência

Instalados `@mikro-orm/{core,postgresql,migrations}` 6.6.8 e `@mikro-orm/nestjs` 6.1.1. O [manifesto oficial do adapter Nest](https://github.com/mikro-orm/nestjs/blob/v6.1.1/package.json) admite MikroORM 6 e NestJS 11. A instalação inicial foi bloqueada por DNS; Luís a executou externamente e o agente confirmou versões, lockfile atualizado e frozen install offline sem alterações. A integração SQL foi posteriormente aprovada externamente pelo responsável técnico e na revisão independente. O driver já fornece pg transitivamente; nenhuma dependência direta pg adicional foi introduzida.

EntitySchemas e records estão em src/database, separados do domínio. `ExactNumericType` recusa números JS; campos monetários são strings decimais no driver/mappers. Toda reconstrução usa rehydrate. Não há version decorator; Wallet.version é manual.

A porta FinancialUnitOfWork oferece uma transação e um FinancialStore por tentativa. PostgresUnitOfWork usa fork limpo e `EntityManager.transactional`, com SQL parametrizado no SqlEntityManager transacional. Os comandos explícitos tornam a ordem de bloqueios e escritas verificável, sem depender de flush automático. EntitySchemas descrevem os registros, enquanto a migration versionada é a autoridade para constraints, índices e triggers; não se usa schema update em execução. Referência: [transações MikroORM 6.6](https://mikro-orm.io/docs/6.6/transactions).

DatabaseModule registra MikroORM e os seis casos de uso por factories Nest. A composição ativa a conexão quando DATABASE_URL está configurada; o bootstrap sem banco continua disponível para o estágio de fundação. Não são criados endpoints financeiros neste pacote.

### Schema e atomicidade

PostgreSQL 16.6 em Compose, volume nomeado Jungle para desenvolvimento, instância separada jungle_test em tmpfs e portas configuráveis. Cada suíte de integração cria e remove somente seu próprio schema jungle_it_<uuid> no banco jungle_test; o helper recusa URLs de outro banco. A migration down destrói somente o schema selecionado e exige autorização explícita no script para uso manual.

A migration cria as cinco tabelas previstas e inclui as unicidades de wallet, key, provider/external ID, ledger e reversões processadas. Ledger é append-only por trigger. Wagers terminais são imutáveis inclusive em DELETE; identidade de wagers não terminais também é protegida. Estados/tipos, valor positivo exceto LOSS, referências obrigatórias/inesperadas, failureCode e snapshots obrigatórios são protegidos no banco. FAILED exige snapshot e código na persistência; `fail(code,balance?)` permite fornecer o saldo observado sem quebrar os contratos unitários anteriores.

Triggers de constraint diferidos verificam no commit que saldo é igual à soma do ledger e que uma wager processada financeira tem exatamente o lançamento correspondente; LOSS e transações não processadas não podem ter lançamentos. FKs compostas protegem contexto de Wallet/player e moeda do ledger. Referência processada é validada quanto a contexto, kind, valor e status. Essas proteções foram validadas nas suítes reais PostgreSQL aprovadas pelo responsável técnico e na revisão independente.

`recorded_balance_currency` foi acrescentado ao snapshot. Em rejeição CURRENCY_MISMATCH, money preserva a moeda enviada, enquanto o snapshot preserva a moeda real da Wallet. Por isso uma wager rejeitada pode carregar moeda diferente da Wallet; uma processada e seu ledger não podem. Não se falsifica a moeda do payload para tornar a rejeição persistível.

### Locks e Inbox — ARC2-01

READ COMMITTED; ordem: Wallet FOR UPDATE → claim Inbox, quando houver → wager/referência. Uma operação por transação, sem lock global e sem adquirir uma segunda Wallet ao encontrar referência inválida.

Leituras prévias de identidade são sem locks de linha. Garantem que uma key previamente utilizada com outro walletId gere IdempotencyConflictError, mesmo quando esse destino não existe. Se a Wallet não for encontrada, há nova leitura de identidade antes de NotFoundError. Uma operação concorrente ainda não comprometida não é presumida como já existente; o erro reflete a identidade visível na leitura de decisão.

Inbox usa INSERT ON CONFLICT DO NOTHING RETURNING depois do lock da Wallet e antes de escritas/bloqueios da wager. Em colisão, outra instrução READ COMMITTED lê o vencedor comprometido. Hash divergente é conflito; hash igual requer Inbox processada e wager com identidade/key/hash correspondentes. Inbox comprometida sem processedAt, ou sem wager correspondente, é inconsistência e não autoriza novo efeito.

Replay por uma nova mensagem persiste a nova Inbox processada no mesmo commit, sem novo ledger/outbox financeiro. Em PENDING_REFERENCE, processedAt da Inbox significa conclusão daquela entrega, não conclusão financeira. Nenhum polling ou ACK SQS é implementado.

23505 é classificado pela constraint. Apenas uq_wager_idempotency e uq_wager_provider_external autorizam releitura do vencedor e comparação para replay. Rollback completo precede a releitura em contexto novo. Para persistir Inbox de uma nova entrega após a colisão, uma nova tentativa segue novamente Wallet → Inbox → wager. Outras violações não são convertidas em replay. 40P01, 40001, lock timeout e statement timeout têm no máximo três tentativas por padrão, fork novo e backoff limitado fora da transação.

### Casos de uso e consultas

CreateWalletUseCase persiste o bundle de abertura e os dois eventos atomicamente; zero não cria OPENING/ledger/eventos. ProcessWagerTransactionUseCase compartilha o contrato de negócio entre entradas futuras HTTP/SQS, calcula SHA-256 canônico, preserva snapshots e grava Inbox/Outbox no mesmo commit. Não executa publicação externa.

GetWallet/GetWagerTransaction são consultas de estado. ListWalletLedger usa cursor base64url de (createdAt,id), ordenação descendente e timestamp PostgreSQL com seis casas no cursor, preservando precisão mesmo com timestamps iguais. ReconcileWallet usa REPEATABLE READ para wallet e agregado do ledger; retorna diferença e registra somente identificação da divergência, sem corrigir dados ou expor payload financeiro em logs.

### Validação e estimativa — ARC2-03

Testes executados externamente e aprovados para migrations up/down/up, SQL direto negativo, atomicidade com falha em cada fase, 50 replays concorrentes, apostas disputando saldo, Inbox concorrente, reversões cruzadas e três processos Bun com conexões próprias. O harness usa confirmação de readiness, IPC por stdio e barreira explícita para forçar colisão de key entre Wallets distintas. Um teste mantém uma Wallet bloqueada enquanto outra conclui. Outro injeta 40P01 no próprio PostgreSQL via trigger de teste e sequência não transacional, para verificar retry limitado e rollback; não é apresentado como deadlock físico observado.

Processos de teste também terminam antes do commit e depois do commit/antes da resposta para verificar rollback/replay persistente. Isso não comprova ACK SQS ou recuperação de publisher, exclusivos do IMP-03. Reconciliação é exigida após os cenários financeiros.

A estimativa histórica reservava 8–12 h, ou 10–16 h com contingência, para validação crítica. A execução real foi concluída externamente; bloqueios anteriores do sandbox não são bloqueios do pacote aprovado nem são contabilizados como testes locais aprovados.

### Rastreabilidade de revisões

| Achado | Registro nesta implementação |
|---|---|
| VAL01-01 | Reagendamento explícito e testes de estado/attempts |
| VAL01-02 | BET/LOSS sem referência; markProcessed rejeita referência inesperada |
| VAL01-03 | Bootstrap HTTP do IMP-01 e NestJS + MikroORM do IMP-02 aprovados externamente; rastreabilidade REV2 detalhada abaixo |
| ARC2-01 | Wallet → Inbox → wager, rollback e comparação de vencedor |
| ARC2-02 | UUID interno, playerId e demais identificadores externos TEXT |
| ARC2-03 | Harness multi-processo, atomicidade e reserva de execução |
| REV2-01 | Pacote aceito após revisão independente; garantias demonstradas listadas abaixo. Texto original ausente: correspondência individual por ID não verificável neste checkout |
| REV2-02 | Pacote aceito após revisão independente; garantias demonstradas listadas abaixo. Texto original ausente: correspondência individual por ID não verificável neste checkout |
| REV2-03 | Pacote aceito após revisão independente; garantias demonstradas listadas abaixo. Texto original ausente: correspondência individual por ID não verificável neste checkout |
| REV2-04 | Pacote aceito após revisão independente; garantias demonstradas listadas abaixo. Texto original ausente: correspondência individual por ID não verificável neste checkout |

Atendimento efetivamente demonstrado no IMP-02: schema/constraints/triggers, atomicidade, idempotência persistente e snapshots, ordem Wallet → Inbox → wager/referência, reversões concorrentes, reconciliação, três processos independentes e recuperação antes/depois do commit. O aceite independente e humano do pacote foi comunicado por Luís. Sem os textos originais REV2, não se atribui arbitrariamente cada garantia a um ID; este é um limite documental de rastreabilidade, não um novo achado bloqueante da revisão recebida. Os documentos normativos permanecem intactos.

### Encaminhamentos da revisão VAL02

| Achado | Encaminhamento |
|---|---|
| VAL02-01 | IMP-04: teste de divergência real em ReconcileWalletUseCase e tratamento de soma negativa; não implementado neste fechamento |
| VAL02-02 | CP-04: política compartilhada implementada e validada externamente (20 testes/171 asserções); semântica do TTL formalmente aprovada por Luís (Opção A) |
| VAL02-03 | Resolvido documentalmente neste fechamento: estado, validações externas e notas históricas do IMP-02 atualizados |

O parecer não bloqueante e o aceite humano encerram o IMP-02; não autorizam início automático do IMP-03. Publicação deve ser confirmada pelo resultado efetivo dos comandos Git, sem presumir sucesso de rede ou permissão.

## IMP-03 — histórico de validação dos CP-01 a CP-05

Base `013f151470b688b4f13469f73332ac4acf43f8fd`. Luís confirmou externamente SDK SQS 3.922.0, frozen install, typecheck, cinco testes PostgreSQL/31 asserções e `bun scripts/check-sqs.ts` exit 0: três filas FIFO e redrive para a DLQ com maxReceiveCount=5. **Gate CP-01 validado.** Docker/LocalStack continuam inacessíveis ao executor; as evidências externas são atribuídas ao responsável técnico. LocalStack preserva os serviços e o volume PostgreSQL. Não se usa FIFO como garantia financeira. Ver IMP-03-EVIDENCE.md para resultados e limites.

ClockPort fornece instantes explícitos para vencimento e leases; os novos comandos SQL não usam now(). Produção requer UTC e relógios sincronizados/monitorados. Configuração valida timeout/lease com margem mínima de 1000ms e valores positivos; entrada e worker compartilham a política de referência desde o CP-04, validado externamente.

Primitivas de WorkerStore compõem FinancialStore no mesmo UnitOfWork. Descoberta de pendências não bloqueia wagers; a resolução implementada no CP-04 exige Wallet → Wager, revalidando status e vencimento. Atualização altera somente campos mutáveis e exige origem PENDING_REFERENCE. Claim Outbox é individual, com CTE FOR UPDATE SKIP LOCKED e owner/token/until, devendo ser commitado antes de SQS. Confirmação e retry são condicionais a owner/token, evento pendente e lease ainda válido no instante fornecido; false indica claim perdido. Retry confere contador e aceita apenas código diagnóstico seguro. A reidratação Outbox admite política opcional sem mudar o default existente.

CP-02 implementa Consumer com adapter SDK SQS e porta de transporte; decoder seleciona campos do contrato original, normaliza referência ausente/null e usa Money/UUID existentes. envelope.messageId identifica Inbox; sqs.MessageId é diagnóstico de transporte; data.idempotencyKey mantém identidade financeira; ReceiptHandle é token efêmero de ACK/visibilidade. occurredAt de transporte é validado, mas não entra no hash. correlationId opcional usa messageId como fallback; causationId aponta para a mensagem de origem.

O Consumer chama o mesmo ProcessWagerTransactionUseCase, sem nova camada financeira, e só executa DeleteMessage após seu retorno confirmado por commit. PROCESSED, REJECTED, PENDING_REFERENCE e replay (inclusive FAILED histórico) fazem ACK. Falha de ACK após commit segue para redelivery/replay, nunca reclassifica a operação financeira como permanente. Classificação distingue conflitos, contratos/Money, NotFound, PostgreSQL transitório, rede, timeout e desconhecidos. Após REV3-FIX-01, transientes e desconhecidos usam backoff de visibilidade e redrive nativo: unknown nunca provoca envio manual de diagnóstico à DLQ nem DeleteMessage por esgotamento. A RedrivePolicy é o único controle de esgotamento desses recebimentos e preserva o envelope original. O startup confere que maxReceiveCount e ARN da DLQ correspondem à configuração efetiva.

Envio manual à DLQ fica restrito aos erros comprovadamente permanentes e exige confirmação SendMessage antes de apagar origem. GroupId válido e dedupId SHA-256 são determinísticos por identidade SQS/hash do corpo. O diagnóstico manual inclui somente tipo/versão, identidade SQS, hash, código estável, contador e instante; omite corpo financeiro, receipt, exceção bruta e credenciais. Isso impede reconstruir o payload original apenas pela mensagem de diagnóstico manual; a investigação desses erros permanentes depende das identidades/hash e do produtor. O redrive nativo mantém o corpo original por semântica SQS, inclusive para falhas de infraestrutura sem code reconhecido. DLQ_SEND_FAILED e ACK_FAILED mantêm origem para retry; dedup FIFO tem janela limitada, sem promessa de entrega única. A DLQ pode conter diagnóstico manual ou envelope original; não reenviar um diagnóstico como instrução financeira. Nenhum desses corpos é copiado para logs.

A entrada operacional é `bun scripts/consume-wagers.ts`, contexto Nest standalone de MessagingModule.forConsumer com DatabaseModule; importar MessagingModule base no HTTP não inicia loops. Cada instância recebe uma mensagem por vez, com long polling cancelável e timeout independente para operações in-flight. beforeApplicationShutdown drena o loop antes do fechamento MikroORM em onApplicationShutdown; encerramento com limite configurado, SIGTERM real e preservação do pool compõem o CP-05, validado funcionalmente na regressão externa final de Luís. Startup falho encerra o processo com código 1 para não manter recursos de um contexto parcial.

CP-02 validado externamente por Luís: `bun test test/integration/sqs-consumer.test.ts`, 14 testes aprovados, zero falhas, 87 asserções em PostgreSQL 16.6/LocalStack 4.10.0 reais. CP-03 validado externamente por Luís: 10 testes aprovados, zero falhas, 412 asserções; PostgreSQL 16.6/LocalStack 4.10.0, três processos/backends distintos, 100 eventos sem perda nos cenários. CP-04 validado por Luís: 20 testes aprovados, 0 falhas, 171 asserções, três processos/backends PostgreSQL independentes. CP-05 validado funcionalmente na regressão externa final executada por Luís no Ubuntu com PostgreSQL 16.6 e LocalStack 4.10.0 reais: **345 testes aprovados, 0 falhas, 2500 asserções, 29 arquivos**, typecheck, bootstrap NestJS + MikroORM e git diff --check aprovados. A execução é atribuída ao responsável técnico, não ao Codex nesta sessão. IMP-03 aguarda revisão independente do Antigravity e aprovação humana; IMP-04 não iniciado. Modelo: at-least-once delivery com efeitos financeiros idempotentes persistentes.

### CP-03 — Outbox Publisher

OutboxPublisher usa FinancialUnitOfWork e os métodos CP-01 sem alterar SQL/schema financeiro. Cada tentativa gera token UUID novo, reivindica um evento com SKIP LOCKED/lease e aguarda commit. SQS é chamado fora da transação de claim. Em seguida outra transação confirma published_at somente com id/owner/token, published_at nulo e lease ainda válido; false significa perda do claim. Falha de envio aplica OutboxMessage.scheduleRetry com política configurada e failOutbox com o mesmo fencing. Falha SQL após envio confirmado deixa confirmação pendente, sem confundir com falha SQS; após expiração, outro publisher assume. Nenhum evento é descartado por esgotamento de tentativas.

Adapter publica o envelope persistido sem reconstruir eventos: eventId estável, MessageGroupId=aggregateId e MessageDeduplicationId=eventId. Confere identidade do envelope antes de enviar. Mensagem/contrato monetário e timestamps permanecem intactos. FIFO só reduz duplicatas dentro da janela; recuperação pode reenviar e consumidores do evento precisam deduplicar por eventId.

Configuração inicial: OUTBOX_LEASE_MS=10000, SQS_SEND_TIMEOUT_MS=3000, OUTBOX_BASE_RETRY_MS=1000 e OUTBOX_MAX_RETRY_MS=60000. Validação exige pelo menos 1000ms entre timeout e lease; após commit do claim, o envio também exige essa margem ainda disponível. Timeout de envio é imposto por timer/AbortSignal, mesmo se o port não responder. Não há heartbeat. ClockPort fornece os instantes; produção deve sincronizar UTC e monitorar skew. Falhas SQL podem deixar o lease expirar; nunca se usa estado em memória como ownership definitivo.

Entrada standalone `bun scripts/publish-outbox.ts`, MessagingModule.forPublisher; importar módulo base não inicia workers. SQS_EVENTS_QUEUE_NAME default wagering-events.fifo, OUTBOX_WORKER_ID default único por processo/início, OUTBOX_POLL_INTERVAL_MS default 250. Lifecycle drena publishNext antes do fechamento ORM; CP-05 implementa o deadline e a coordenação de recursos, com validação funcional real de SIGTERM/pool incluída na regressão externa final de Luís.

Suíte preparada com filas/schema isolados inclui 100 eventos e três processos Bun/backend PIDs distintos, encerramento abrupto após claim e após SendMessage confirmado, timeout de confirmação após aceite real SQS, fencing de owners antigos, backoff configurado e invisibilidade de Outbox financeira não commitada. Esses cenários falharam no setup do sandbox por ECONNREFUSED e depois foram aprovados externamente por Luís, conforme os 10 testes/412 asserções acima. A evidência externa não é atribuída ao Codex. A falha de confirmação/timeouts é injetada no harness após envio real, sem afirmar que uma partição TCP real foi observada. O gate CP-03 foi encerrado pela evidência externa registrada.

### CP-04 — PendingReferenceWorker e política compartilhada

pending-reference-policy.ts é a fonte única de PENDING_REF_BASE_DELAY_MS=1000, PENDING_REF_MAX_ATTEMPTS=10 e PENDING_REF_TTL_MS=86400000. ProcessWagerTransactionUseCase passa a usá-la no agendamento inicial, preservando defaults, hash, identidade, regras financeiras e compatibilidade do construtor (override opcional interno). WorkerConfig delega a essa mesma fonte. TTL persistido em expiresAt é preservado ao reagendar; não se estende o prazo em reinícios.

O worker usa descoberta sem lock pelos métodos CP-01/ClockPort; por candidato abre transação nova, bloqueia Wallet primeiro, confere a associação do candidato por leitura sem lock e só então bloqueia Wager. Status e vencimento são revalidados com relógio lido após os locks. Referência da mesma Wallet é bloqueada depois; outra Wallet/referência inválida de outro contexto permanece somente leitura. Não há lock global ou garantia concorrencial em memória.

A decisão financeira vem de evaluateWager, Wallet e WagerTransaction existentes. Referência já válida é aplicada; referência terminal inválida recebe o código de domínio original. Quando a referência continua ausente/pendente, TTL/tentativas/backoff determinam a espera. O TTL limita a espera por referência indisponível: uma referência disponível/financeiramente válida continua avaliada pelas regras originais mesmo se o scan do worker atrasou. Contador attempts representa reagendamentos concluídos; a checagem de número attempts+1 é a tentativa atual. No default, até dez verificações de referência indisponível são permitidas, sem agendar uma décima primeira.

Agendamento inicial usa base; após o primeiro vencimento, próximo delay é base*2, depois base*4 etc. Antes de construir a próxima Date ou chamar reschedulePendingReference, verifica-se limite, expiração e next < expiresAt; se não houver próximo instante permitido, rejeita REFERENCE_NOT_FOUND_TIMEOUT. Não há clamp de data nem loop de erro por reagendamento igual/posterior ao prazo. Snapshot de aceite fica inalterado em reagendamentos; o terminal registra saldo observado na resolução.

Atualização é condicional à origem PENDING_REFERENCE, somente campos mutáveis, e precisa afetar uma linha. Zero inesperado aborta a transação. Movimento, versão, wager, ledger e eventos Outbox são atômicos; terminalização emite Processed/Rejected e BalanceChanged quando há movimento. Reagendamento mantém status/snapshot e não repete evento PendingReference; Inbox já processada no aceite não é alterada. Falhas SQL transitórias usam retry da transação inteira em contexto limpo, sem consumir tentativas da referência.

Os eventos mantêm o contrato v1; na resolução, correlationId e causationId usam transactionId estável, pois a correlação original não integra o estado persistido Wager. Eventos anteriores conservam sua correlação original. As identidades permitem relacionar aceite e resolução, sem inventar metadados originais ou alterar schema.

Entrada explícita `bun scripts/resolve-pending-references.ts`, WageringModule.forPendingReferences, sem SDK/SQS operacional nesse processo. PENDING_REF_POLL_INTERVAL_MS=250 e PENDING_REF_BATCH_SIZE=100 são configuráveis; polling/drenagem/deadline têm implementação CP-05. Os 20 testes CP-04 foram aprovados externamente, incluindo três processos/backend PIDs, cadeias, reversões e atomicidade. A prova real dos novos hooks/sinais/pool integra a regressão final CP-05 aprovada funcionalmente por Luís.

### CP-05 — shutdown coordenado, sinais e recuperação

As implementações instaladas foram inspecionadas: MikroOrmCoreModule 6.1.1 fecha ORM em onApplicationShutdown; Nest 11.1.6 aguarda beforeApplicationShutdown antes dessa fase, mas callbacks de módulo raiz podem ocorrer antes dos importados no fechamento final. Por isso o watchdog não é desarmado num hook local presumindo que o pool já fechou.

WorkerShutdown interrompe novos polls por AbortSignal, aguarda o loop completo e mantém deadline WORKER_SHUTDOWN_TIMEOUT_MS (default 60000, faixa 1..300000ms) até os recursos terminarem. enableWorkerSignals coordena SIGTERM/SIGINT nos três scripts standalone: drain → app.close(signal) (hooks Nest, ORM e SQS) → completeShutdown. Não usar simultaneamente app.enableShutdownHooks nesses processos. Para fechamento programático dos módulos de worker, usar closeWorkerApplication; ele garante a mesma sequência e desarma o watchdog após todos os hooks.

Consumer cancela long polling ocioso; mensagem retornada após parada e ainda não processada tem visibility=0, sem ACK. Uma tentativa já em andamento termina com seu próprio prazo/transação; commit confirmado autoriza ACK enquanto o pool continua aberto. Falha concluída durante parada devolve visibilidade imediatamente. Recibo não conhecido por resposta de receive interrompida só pode ser recuperado pelo visibility timeout SQS. Publisher termina o evento em curso ou preserva lease/retry; PendingWorker termina o candidato em curso e não inicia o próximo.

Se o deadline expira, o processo termina com exit 1, incluindo durante a limpeza de recursos. Não se encerra graciosamente o pool sob operação ainda ativa, não se fabrica ACK e não se registra stopped. O estado persistente/SQS oferece recuperação. Falha inesperada do loop também pede exit 1 para reinício pelo supervisor. stopped só é emitido depois de app.close completo; SIGKILL não executa hooks e depende de rollback PostgreSQL, Inbox/idempotência, visibilidade e leases. O supervisor deve dar margem além do timeout configurado antes de SIGKILL.

Testes CP-05 usam contexto Nest real, MikroORM/SQL reais, filas isoladas LocalStack e child processes; observadores verificam consulta SQL antes de ACK, flags in-flight, pool desconectado após close e PIDs independentes. Pausas/falhas são apenas seams do harness, não flags de transporte ou produção. Incluem SIGTERM, SIGKILL, crash após commit/publicação, reinícios, 50 duplicatas com três consumidores/grupos distintos e reconciliação. As tentativas anteriores no sandbox falharam no setup por ECONNREFUSED. Posteriormente, Luís confirmou a regressão externa completa aprovada, incluindo CP-05. O histórico da falha de long polling, correção do harness e limites do diagnóstico original está preservado em IMP-03-EVIDENCE.md; passar na regressão não reconstitui o trace ausente da falha anterior.

Decisão formal de Luís Henrique Pereira — TTL, Opção A: o TTL limita a espera por referências indisponíveis. Se a referência já estiver válida no momento da avaliação transacional, a operação poderá ser processada mesmo após o prazo de espera. Essa decisão resolve a ambiguidade identificada em §5 (limite de espera versus ausência após tentativas/TTL) e confirma o teste `available valid reference is processed even when worker scan was delayed beyond the waiting TTL`. Nenhum comportamento financeiro foi alterado para registrar o aceite. Revisão independente do IMP-03 continua pendente; documentos normativos preservados.

### IMP-03/REV3-FIX-01 — correção e cobertura dos entrypoints

Checkpoint autorizado por Luís após o parecer independente REV3 de reprovação temporária. REV3-01 corrigido pelo tratamento conservador de unknown descrito acima; nenhuma nova taxonomia de erros, camada persistente ou mecanismo de redrive. Erros permanentes continuam no contrato manual anterior. Classificação não altera a exceção/causa recebida. TTL, domínio, migrations, PendingReferenceWorker e Publisher preservados.

Testes de Consumer cobrem erro sem code, rollback real antes do commit, perda de confirmação depois do commit, redrive nativo com igualdade do corpo e identidades, replay operacional da DLQ e duplicata posterior com um único efeito financeiro. A falha sem code é injetada usando DriverException do MikroORM instalado; não se alega desconexão física de PostgreSQL nessa prova.

REV3-02: `test/integration/worker-entrypoints.test.ts` executa os três scripts reais em processos Bun, portanto as composições MessagingModule.forConsumer/forPublisher e WageringModule.forPendingReferences. O preload exclusivo de teste adapta somente as opções de MikroORM.init para schema descartável e search_path sem fallback public, pois databaseConfig de produção fixa public. Não substitui DynamicModules, providers, regras, SDK ou transações. Valida URL jungle_test/loopback, nomes de filas isoladas e schema antes do spawn; na conexão do processo filho comprova current_database, current_schema e presença das cinco tabelas antes de devolver ORM ao Nest e iniciar loops. Adapters reais resolvem filas e conferem FIFO/redrive.

Observadores de teste delegam init/close/send/destroy reais e emitem apenas fases. Verificam trabalho financeiro/publicação/resolução, dois DeleteMessage confirmados para duplicatas do Consumer, SIGTERM, drenagem antes de pool.close, pool desconectado, SDK destruído quando aplicável, ausência de sessões do processo e reinício sem novos efeitos financeiros. Cada script também tem startup inválido com exit 1 e diagnóstico sanitizado. Essa adaptação não acrescenta uma opção de schema à configuração pública de produção.

Validação efetivamente executada pelo Codex neste checkpoint: RED unitário com três falhas de preservação do original; GREEN completo de **366 testes, 0 falhas, 2753 asserções, 31 arquivos**, typecheck, bootstrap HTTP em jungle_test e verificação SQS aprovados. Smokes: **6/6, 134 asserções**; detalhes, limitações e rollback em IMP-03-EVIDENCE.md. Os resultados externos anteriores de Luís permanecem históricos e não são somados a esta execução. Checkpoint tecnicamente validado; IMP-03 aguarda revisão independente complementar e aprovação humana para commit. Sem commit/push ou início do IMP-04.


### IMP-03-CLOSE — aprovação técnica e limites do parecer

Parecer complementar Antigravity comunicado por Luís: **APROVAR REV3-FIX-01**, sem bloqueantes; identificação exibida Gemini 4 Argon — medium. Confirmou unknown sem DLQ manual/DeleteMessage por esgotamento, redrive nativo preservando envelope/identidades, replay financeiro único, permanentes preservados, segurança de ACK/visibilidade/commit e ausência de exposição adicional ou retry infinito fora da retenção/política. Para REV3-02, confirmou cobertura dos três scripts reais e seus módulos Nest, recursos isolados, trabalho, SIGTERM, fechamento, reinício, idempotência e startup inválido.

A revisão foi predominantemente estática: o revisor executou typecheck, 259 unitários e diff-check; não repetiu integrações. Os 366 testes/0 falhas/2753 asserções/31 arquivos e integrações reais permanecem evidência anterior do Codex no REV3-FIX-01. Esta consolidação não executou testes. O parecer supera o estado anterior de revisão complementar pendente; aprovação técnica não autoriza versionamento.

Riscos não bloqueantes: **R1**, DLQ mista com WagerTransactionDeadLetter (diagnóstico) e WagerTransactionRequested (original nativo), exigindo distinguir tipos na recuperação e nunca reenviar diagnóstico financeiro; **R2**, preload dos smokes adapta somente schema de teste, mantendo módulos reais; **R3**, API HTTP, observabilidade e VAL02-01 permanecem no IMP-04. REV3-03 (visibilidade reduzida), REV3-04 (tempo anterior ao lock) e REV3-05 (força da prova de exclusão) preservam propostas de avaliação no IMP-04, sem correção declarada. REV3-06 é política intencional documentada: janela nominal de 1023s por tentativas, antes de TTL de 24h; Opção A preservada. REV3-07 recebe atualização documental nos três arquivos autorizados, sem declarar limpeza de todo o histórico. O quadro detalhado em IMP-03-EVIDENCE.md preserva classificações e não cria novos aceites de implementação.

**IMP-03 TECNICAMENTE APROVADO. VERSIONAMENTO PENDENTE DE AUTORIZAÇÃO HUMANA de Luís Henrique Pereira.** Somente documentos consolidados; inventário revisável de 61 arquivos no relatório. Nenhum staging, commit/push ou início do IMP-04.
