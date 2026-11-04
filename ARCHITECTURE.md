# Decisões de implementação — JUNGLE-IMP-01

Fonte normativa: `technical-challenge.md`; arquitetura: `Jungle-Architecture-v0.2.md`; decisões posteriores: ordem explícita do responsável técnico autorizando IMP-01. O estado antigo de aprovação no documento v0.2 não foi alterado. Este documento registra decisões locais de implementação; não substitui a arquitetura.

## Fundação e dependências

NestJS `11.1.6` (`common`, `core` e `platform-express` alinhados), `reflect-metadata` `0.2.2` e RxJS `7.8.2` compõem o bootstrap mínimo. TypeScript `5.9.3` executa a verificação estática; `@types/bun` `1.3.3` fornece os contratos do runner. Bun `1.4.4` executa a aplicação, instala pacotes e roda os testes. Versões diretas exatas e o lockfile gerado evitam atualizações automáticas. Typecheck, testes unitários e inicialização/DI/fechamento NestJS sem socket foram executados com sucesso; a abertura HTTP permanece sem validação bem-sucedida devido a EPERM no sandbox.

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

`create` é a entrada externa: rejeita OPENING e provider SYSTEM. `createOpening` é a factory interna. REFUND/ROLLBACK exigem referência; WIN pode tê-la. Referência a si mesmo é inválida. Não há transição de PENDING_REFERENCE para si mesmo; reagendamento pertence ao worker futuro, sem nova entrada no estado.

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

IMP-02 deverá implementar MikroORM, NUMERIC(18,2), migrations reversíveis, constraints, proteção de ledger/terminais, unicidades e locks wallet-first. IMP-03 deverá implementar Inbox/Outbox persistentes, workers, recovery, ACK/Retry/DLQ e shutdown. IMP-04 deverá implementar API e observabilidade.

Autenticação não está implementada; o ponto de extensão ProviderIdentityPort/guard no-op documentado na v0.2 será tratado na borda HTTP em IMP-04. Não existem endpoints financeiros que precisem desse ponto de extensão no IMP-01.

O texto dos ajustes REV2-01 a REV2-04 não está presente nos arquivos deste checkout. A ordem de implementação informa sua existência e as decisões aprovadas, que foram seguidas. A revisão independente deverá conferir a rastreabilidade desses quatro ajustes nos pacotes correspondentes; este documento não presume seu conteúdo.
