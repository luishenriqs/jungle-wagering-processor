# Decisões de implementação — Distributed Wagering Processor

Fonte normativa: `technical-challenge.md`; arquitetura: `Jungle-Architecture-v0.2.md`; decisões posteriores: ordem explícita do responsável técnico autorizando IMP-01. O estado antigo de aprovação no documento v0.2 não foi alterado. Este documento registra decisões locais de implementação; não substitui a arquitetura.

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

IMP-02 implementou MikroORM, NUMERIC(18,2), migrations reversíveis, constraints, proteção de ledger/terminais, unicidades, locks wallet-first e persistência transacional de Inbox/Outbox. IMP-03 implementará seus protocolos operacionais, workers, recovery, ACK/Retry/DLQ e shutdown. IMP-04 deverá implementar API e observabilidade.

Autenticação não está implementada; o ponto de extensão ProviderIdentityPort/guard no-op documentado na v0.2 será tratado na borda HTTP em IMP-04. Não existem endpoints financeiros que precisem desse ponto de extensão no IMP-01.

## IMP-02 — Persistência e concorrência

**Estado: APROVADO para fechamento e versionamento por Luís Henrique Pereira.** Revisão independente do Antigravity: **APROVAR COM RECOMENDAÇÕES NÃO BLOQUEANTES**. PostgreSQL 16.6 real validado: 165 testes aprovados, 0 falhas, 985 asserções, 17 arquivos; concorrência com três processos Bun independentes, TypeScript strict, bootstrap NestJS + MikroORM e diff-check aprovados na validação independente informada pelo responsável técnico. Consulte IMP-02-EVIDENCE.md para proveniência e resultados locais separados. IMP-03 não iniciado.

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
| VAL02-02 | IMP-03: parametrizar TTL e backoff de PENDING_REFERENCE; não implementado neste fechamento |
| VAL02-03 | Resolvido documentalmente neste fechamento: estado, validações externas e notas históricas do IMP-02 atualizados |

O parecer não bloqueante e o aceite humano encerram o IMP-02; não autorizam início automático do IMP-03. Publicação deve ser confirmada pelo resultado efetivo dos comandos Git, sem presumir sucesso de rede ou permissão.
