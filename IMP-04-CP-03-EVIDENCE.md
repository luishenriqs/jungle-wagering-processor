# JUNGLE-IMP-04/CP-03 — Endpoints de Consulta

## A. Identificação

- Projeto: Jungle Distributed Wagering Processor.
- Checkpoint: IMP-04/CP-03 — Endpoints de Consulta.
- Etapa: fechamento técnico controlado, registro de evidências, validação final e versionamento.
- Data: 05/11/2026.
- Commit-base: `e17493bd3dd10f6307a458a858e553ad1438e1b5`, branch `main`.
- Responsável pela aprovação: Luís Henrique Pereira.
- Executor: Codex.
- Revisor independente: Antigravity, conforme parecer comunicado por Luís na autorização de fechamento.
- Estado técnico homologado: **APROVADO**. Encerramento, commit e push exclusivamente do CP-03 autorizados; seu sucesso depende da execução real e das verificações finais.

Este documento distingue evidências históricas da implementação, informações do parecer independente recebidas do responsável técnico e validações executadas nesta sessão de fechamento. Não atribui resultados do Codex ao Antigravity nem presume versionamento antes dos comandos.

## B. Escopo e inventário

Os onze arquivos existentes da implementação aprovada são:

| Arquivo | Responsabilidade |
|---|---|
| `src/modules/wallets/infrastructure/wallets.controller.ts` | GET do ledger, validação pré-UoW e delegação a ListWalletLedgerUseCase. |
| `src/modules/wagering/infrastructure/wagering.controller.ts` | GETs por UUID e pelo par provider/external ID, representação comum e tradução da ausência; POST preservado no mesmo caminho. |
| `src/modules/wallets/infrastructure/wallet-http.dto.ts` | Query estrita de ledger, validação compartilhada do cursor e projeção pública de entries/nextCursor. |
| `src/modules/wagering/infrastructure/wager-http.dto.ts` | Validação de identificadores externos e projeção pública única de Wager para os dois GETs. |
| `src/modules/wallets/application/wallet-queries.ts` | Parser puro do cursor reutilizado em HTTP/aplicação, com calendário real e preservação de microssegundos; paginação existente preservada. |
| `src/shared/application/application-errors.ts` | WagerNotFoundError como subtipo de NotFoundError, preservando a organização e hierarquia existentes. Caminho confirmado antes da edição na implementação. |
| `src/shared/infrastructure/http-exception.filter.ts` | Identifica WagerNotFoundError antes de NotFoundError e retorna WAGER_NOT_FOUND, mantendo os demais mapeamentos. |
| `test/unit/wallet-http.test.ts` | Contratos de ledger, calendário, query estrita e ausência de acesso ao UoW para entradas inválidas. |
| `test/unit/wager-http.test.ts` | Contratos GET, projeção, opcionais, identificadores externos, erro específico e sanitização. |
| `test/integration/wallet-http.test.ts` | PostgreSQL real: páginas vazias/únicas, 121 registros, precisão temporal, isolamento e ausência de efeitos persistidos dos GETs. |
| `test/integration/wager-http.test.ts` | PostgreSQL real: todos os estados, OPENING, snapshots, referências, provedores, 404 específicos e leitura durante operação financeira concorrente. |

O décimo segundo e único arquivo criado nesta etapa é `IMP-04-CP-03-EVIDENCE.md`.

A conferência inicial encontrou main na baseline, exatamente os onze arquivos rastreados modificados, nenhum arquivo não rastreado e índice vazio. Consulta direta com git ls-remote confirmou origin/main na baseline. Um snapshot SHA-256 dos 140 arquivos versionáveis preexistentes foi capturado fora do repositório para verificar sua preservação durante o fechamento.

A implementação não modificou AppModule, DatabaseModule, WalletsModule ou WageringModule. Domínio financeiro, persistência PostgreSQL, migrations, workers, GetWagerTransactionUseCase, ProcessWagerTransactionUseCase, idempotência/hash, Inbox/Outbox, retries, dependências e scripts permanecem preservados. Não foram criados repositórios, adapters ou casos de uso financeiros.

## C. Endpoints implementados e decisões homologadas

### GET /wallets/:walletId/ledger

Reutiliza ListWalletLedgerUseCase e o FinancialUnitOfWork/FinancialStore existentes.

- walletId validado por internalId() antes do caso de uso.
- Query permite somente limit e cursor; rejeita parâmetros desconhecidos, repetidos, arrays e objetos.
- limit é uma única string compatível com `^[1-9][0-9]*$`, com intervalo 1 a 100; default 50. Decimais, expoentes, hexadecimal, zeros à esquerda, espaços e vazio são rejeitados antes do UoW.
- Cursor opaco base64url de 1 a 512 caracteres, contendo objeto JSON plano com exatamente createdAt/id, timestamp UTC com seis dígitos fracionários, ano a partir de 0001, calendário/hora reais e UUID válido.
- parseLedgerCursor() é compartilhado entre a borda e a aplicação. A validação de calendário compara a representação em milissegundos, mas devolve o timestamp original com seis dígitos: não reduz a precisão do cursor usado pelo SQL.
- Ordenação preservada `(created_at DESC, id DESC)` e comparação estrita `(created_at, id) < (:createdAt, :id)`. Nenhuma alteração no SQL ou índice existente.
- Resposta 200 com entries explícitas: id, walletId, transactionId, direction, money, balanceBefore, balanceAfter e createdAt ISO-8601. Money permanece MoneyProps com amount string.
- nextCursor é string quando há próxima página e null quando não há. Nenhum totalizador foi acrescentado; o handler não chama ledgerTotal().
- Wallet inexistente retorna 404 WALLET_NOT_FOUND; entradas inválidas retornam 400 antes de abrir UoW.

Paginação determinística para conjunto estável, sem promessa de snapshot congelado entre requisições independentes.

### GET /wagering/transactions/:transactionId

Valida UUID antes do UoW e utiliza GetWagerTransactionUseCase, sem executar o processador.

Retorna 200 para qualquer transação existente, incluindo PENDING, PENDING_REFERENCE, PROCESSED, REJECTED, FAILED e transações internas OPENING. Os status de resultado do POST não são reaplicados às consultas.

### GET /providers/:providerId/wagering/transactions/:externalTransactionId

Valida providerId/externalTransactionId como texto não vazio e sem espaços periféricos antes do caso de uso. Utiliza a consulta existente pelo par exato, preservando identificadores externos TEXT. A mesma transação consultada pelos dois GETs produz JSON idêntico.

A consulta por provider mantém filtro lógico de dados, não autenticação real. SYSTEM/OPENING podem ser consultados; a proibição da submissão externa não foi aplicada às leituras.

### Projeção pública e erros de Wager

Uma função pura projeta os campos obrigatórios transactionId, providerId, externalTransactionId, walletId, playerId, roundId, gameId, kind, money, status e createdAt.

recordedBalance, referenceExternalTransactionId, referenceTransactionId, failureCode e processedAt são representados como null quando ausentes. Datas usam ISO-8601 consistente. recordedBalance é o snapshot histórico persistido, nunca o saldo atual da Wallet.

Não são expostos idempotentReplay, payloadHash, attempts, nextRetryAt, expiresAt ou metadados internos. A instância privada de domínio não é retornada diretamente.

Wager inexistente nos dois GETs é traduzido por tipo para WagerNotFoundError e recebe 404 com `{"code":"WAGER_NOT_FOUND","message":"Wager transaction not found"}`. Não se inspeciona error.message. Wallet inexistente, inclusive no POST de Wager, continua retornando 404 WALLET_NOT_FOUND; erros inesperados permanecem sanitizados.

O prefixo do WageringController foi ajustado para rotas completas. O POST continua em /wagering/transactions, com o processamento e os status anteriores. ProviderIdentityGuard permanece aplicado ao controller e é no-op por escopo; nenhuma autenticação real foi implementada.

## D. Evidência RED — histórico da implementação do Codex

Comando efetivamente executado antes da implementação:

```sh
bun test test/unit/wallet-http.test.ts test/unit/wager-http.test.ts --test-name-pattern CP03
```

Resultado histórico: **0 aprovados, 5 falhas funcionais esperadas, 8 asserções, 195 testes filtrados, 2 arquivos**, exit 1. Os testes alcançaram as asserções; não houve erro artificial de importação ou configuração, nem bloqueio ambiental usado como RED.

| Cenário | Esperado | Observado antes da implementação |
|---|---|---|
| GET ledger para Wallet existente no store controlado | 200 com página vazia explícita | 404, rota ausente. |
| GET Wager por UUID inexistente | 404 WAGER_NOT_FOUND | 404 NOT_FOUND nativo, rota ausente. |
| GET Wager por provider/external ID inexistente | 404 WAGER_NOT_FOUND | 404 NOT_FOUND nativo, rota ausente. |
| Cursor com 2026-02-30 | InvalidDomainInputError e zero acessos ao UoW | O cursor atravessou a validação; contador de UoW foi 1, esperado 0. |
| GET ledger com limit=1e1 | 400 antes da persistência | 404, rota ainda ausente. |

O levantamento anterior também identificara que o filtro genérico traduzia NotFoundError de Wager como WALLET_NOT_FOUND. Essa constatação de inspeção/sonda local não é confundida com o envelope NOT_FOUND das rotas ausentes observado no RED HTTP.

Estas evidências são históricas. Não foram recriadas revertendo a implementação durante o fechamento.

## E. Evidência GREEN

### Histórico executado pelo Codex na implementação

| Verificação | Resultado histórico observado |
|---|---|
| Typecheck e unitários na baseline | Aprovados; 454 testes, 0 falhas, 2099 asserções, 24 arquivos. |
| Unitários Wallet HTTP finais | 131 aprovados, 0 falhas, 553 asserções. |
| Unitários Wager HTTP finais | 146 aprovados, 0 falhas, 416 asserções. |
| Integração Wallet HTTP final | 15 aprovados, 0 falhas, 130 asserções. |
| Integração Wager HTTP final | 38 aprovados, 0 falhas, 385 asserções. |
| `bun run typecheck` final | Exit 0. |
| `bun test` final | **696 aprovados, 0 falhas, 4237 asserções, 35 arquivos, 42,38s**, exit 0. |
| Bootstraps originais com e sem banco | Exit 0 em ambos; raiz HTTP 404. |
| Diff-check e inventário | Exit 0; somente onze arquivos existentes autorizados, nenhum arquivo novo e índice vazio. |

As suítes específicas estão incluídas na regressão completa e não são somadas novamente. Foram adicionados 96 testes ao conjunto anterior de 600; os números acima pertencem às execuções históricas da implementação, não ao revisor nem à sessão atual.

### Integração real e integridade

Os testes usam PostgreSQL real no banco jungle_test, schemas jungle_it_<uuid> e os harnesses existentes. A regressão completa também exercita LocalStack real, filas descartáveis, processos independentes, recuperação e workers standalone. A composição de teste recebe UoW explicitamente; o smoke do grafo padrão adapta apenas o schema na fronteira real de MikroORM.init, mantendo ORM/pool reais.

Foram comprovados:

- Ledger vazio e página única com contrato exato, ausência de totalizadores, limites e queries inválidas.
- 121 entradas com timestamp igual, paginação **50 + 50 + 21**, ordem descendente exata, ausência de duplicações/omissões em conjunto estável e isolamento entre wallets.
- Microssegundos distintos dentro do mesmo milissegundo, com preservação de posições .123999 e .123500 nos cursores. A fixture adapta somente o timestamp no INSERT, dentro da mesma transação e do schema descartável, sem UPDATE de ledger nem desabilitar constraints.
- Validação compartilhada de calendários impossíveis, ano zero, formato/estrutura do cursor, limites, duplicações e identificadores inválidos, com zero chamadas ao UoW quando exigido.
- JSON idêntico entre GETs de Wager, todos os estados e OPENING, campos opcionais null, referências resolvidas/ausentes e snapshots após movimentação posterior da Wallet.
- Moeda da operação diferente da moeda do snapshot em rejeição CURRENCY_MISMATCH, sem reconstruir saldo atual.
- Mesmo external ID em provedores diferentes consultado pelo par correto.
- Comparação integral das cinco tabelas antes/depois dos GETs: Wallets, WagerTransactions, WalletLedgerEntries, Inbox e Outbox inalterados.
- GETs concluindo enquanto uma operação financeira real mantém lock de escrita na Wallet, observando somente estado commitado; transação ainda não commitada retorna ausência e fica visível após commit.
- Preservação dos POSTs, dos contratos anteriores, da composição única e dos workers standalone na regressão.

### Validações desta sessão de fechamento

Resultados executados pelo Codex **nesta sessão de fechamento**, sem alterar a implementação aprovada:

| Comando/verificação | Resultado efetivamente obtido |
|---|---|
| `git status --short --branch`, `git rev-parse HEAD` | main na baseline; onze rastreados modificados, nenhum novo antes deste relatório. |
| `git diff --cached --stat` inicial | Vazio; índice sem alterações. |
| `git remote -v` | origin corresponde ao repositório Jungle esperado. |
| `git ls-remote origin refs/heads/main` inicial | Exit 0; remoto em e17493bd3dd10f6307a458a858e553ad1438e1b5. |
| `bun run typecheck` | Exit 0. |
| `bun test test/unit/wallet-http.test.ts` | **131 aprovados, 0 falhas, 553 asserções, 1 arquivo**, exit 0. |
| `bun test test/unit/wager-http.test.ts` | **146 aprovados, 0 falhas, 416 asserções, 1 arquivo**, exit 0. |
| `bun test test/integration/wallet-http.test.ts` | **15 aprovados, 0 falhas, 130 asserções, 1 arquivo**, exit 0. |
| `bun test test/integration/wager-http.test.ts` | **38 aprovados, 0 falhas, 385 asserções, 1 arquivo**, exit 0. |
| `bun test` | **696 aprovados, 0 falhas, 4237 asserções, 35 arquivos, 39,17s**, exit 0. |
| Bootstrap original sem DATABASE_URL no processo | Exit 0, raiz HTTP 404. |
| Bootstrap original em subprocesso com DATABASE_URL obtida de testDatabaseUrl() | Exit 0, banco jungle_test, raiz HTTP 404. |
| `git diff --check` inicial e após criação do relatório | Exit 0. |
| Comparação SHA-256 com o snapshot inicial | 140 arquivos preexistentes preservados; somente este relatório criado no projeto. |
| Inspeção do inventário/conteúdo e busca de padrões de segredo | Doze candidatos autorizados; nenhum segredo identificado nos padrões pesquisados. A URL fictícia preexistente no teste de sanitização foi conferida como fixture, não credencial real. |

As contagens individuais já integram os 696 testes da regressão e não são somadas novamente. A nova execução inclui PostgreSQL/LocalStack reais, recursos isolados, CP-01/CP-02, multiprocessos, recuperação e workers standalone, sem regressões observadas. Nenhuma validação obrigatória falhou nesta sessão.

Foi utilizado Bun 1.4.4 no caminho `/home/luishenriqs/.bun/bin/bun`, com acesso autorizado fora do sandbox para sockets e serviços reais. Os testes permaneceram nos ambientes configurados de teste; os bootstraps preservaram o ambiente do processo pai e não modificaram scripts ou configuração:

```sh
bun -e 'delete process.env["DATABASE_URL"]; await import("./scripts/check-bootstrap.ts");'
bun -e 'import { testDatabaseUrl } from "./test/support/postgres"; const result = Bun.spawnSync([process.execPath, "run", "check:bootstrap"], { env: { ...process.env, DATABASE_URL: testDatabaseUrl() }, stdout: "inherit", stderr: "inherit" }); process.exit(result.exitCode);'
```

A inspeção encontrou somente os doze arquivos autorizados. Nenhum .env, dependência, migration, artefato runtime/temporário ou alteração adicional de código/testes foi introduzido. A busca automatizada por chaves privadas, tokens reconhecidos e URLs autenticadas foi complementada pela leitura dos arquivos; permanece limitada aos padrões examinados.

## F. Revisão adversarial independente e achados do planejamento

**Parecer do Antigravity: APROVAR.**

Origem: comunicação de Luís Henrique Pereira na autorização formal de fechamento técnico em 05/11/2026. O responsável informa que a implementação foi submetida à revisão independente e aprovada.

A revisão do planejamento identifica **CP03-REV-01, CP03-REV-02, CP03-REV-03, CP03-REV-04 e CP03-REV-05**. Sua resolução na implementação está consolidada nos requisitos do plano executivo v0.2 e no aceite técnico recebido, com as seguintes evidências funcionais:

| Frente resolvida na implementação aprovada | Evidência |
|---|---|
| Validação de query/identificadores antes do UoW | Testes HTTP e de aplicação com contador zero para entradas inválidas. |
| Cursor estrito, calendário real e microssegundos | Parser puro compartilhado, negativos de datas/estrutura e paginação real com precisão de seis casas. |
| Projeções públicas e representação uniforme | JSON exato nos dois GETs de Wager, todos os estados, nulls e snapshots persistidos. |
| Ausência de Wager corretamente identificada | WagerNotFoundError por tipo, mapeado antes de NotFoundError; Wallet e POST preservados. |
| Rotas e composição compatíveis | Três GETs operacionais, POST no mesmo caminho e regressão sem alteração dos módulos compartilhados/workers. |

Os textos/títulos individuais dos cinco IDs não foram anexados às ordens recebidas; por isso não se inventa uma associação individual entre ID e título. O registro distingue os IDs homologados, a resolução funcional demonstrada e o parecer APROVAR recebido.

Não foram fornecidos nesta ordem modelo do revisor, logs integrais ou contagens próprias de testes do Antigravity. Os 696 testes da seção E são execução histórica do Codex e não são atribuídos ao revisor. A confirmação específica do revisor sobre o filtro SQL por wallet_id é registrada na seção G.

## G. Achado residual homologado

**CP03-IMPL-REV-01 — LOW — NÃO BLOQUEANTE.**

Descrição: ausência de teste explícito utilizando um cursor obtido da carteira A em uma consulta à carteira B.

Segundo o parecer comunicado por Luís, o revisor confirmou que a consulta SQL mantém o filtro por wallet_id. A implementação existente de ledgerPage() aplica esse filtro em conjunto com a comparação do cursor.

Decisão homologada: registrar como melhoria futura de cobertura. Não alterar código nem acrescentar o teste neste fechamento. O achado não é declarado corrigido e não amplia o inventário autorizado.

## H. Riscos residuais

- **Paginação sem snapshot congelado:** ordenação determinística para conjunto estável não garante uma visão congelada entre requisições independentes durante novas inserções.
- **Autenticação no-op:** ProviderIdentityGuard permite as requisições; o filtro por provider é isolamento lógico da consulta, não uma identidade autenticada ou autorização real.
- **Cobertura LOW:** CP03-IMPL-REV-01 permanece como melhoria futura, sem bloqueio ao aceite homologado.

Nenhum desses pontos é apresentado como nova funcionalidade implementada ou defeito corrigido nesta etapa. Não foi iniciado CP-04.

## I. Aprovação humana

Luís Henrique Pereira concedeu aprovação formal em **05/11/2026** para a conclusão técnica do CP-03, aceitou o parecer APROVAR do Antigravity e o achado LOW não bloqueante e autorizou especificamente encerramento, commit e push para origin/main dos doze arquivos autorizados.

Mensagem aprovada: `feat(imp-04-cp-03): add financial query HTTP endpoints`.

A autorização não permite alterar a implementação, corrigir o LOW, ampliar o inventário, modificar regras financeiras ou iniciar CP-04. Não são inventadas assinaturas, horários ou evidências externas.

## J. Resultado do fechamento e campos de versionamento

Este documento é preparado antes do commit. Campos reservados para confirmação no relatório final da execução:

- Commit SHA: **a confirmar após git commit**.
- Mensagem: `feat(imp-04-cp-03): add financial query HTTP endpoints`.
- Conteúdo: exatamente os onze arquivos da seção B e este relatório.
- Resultado do push: **a confirmar após git push origin main com exit 0**.
- Estado Git final: **a confirmar: HEAD=origin/main, main sincronizada, working tree e índice limpos**.

A conferência inicial confirmou branch/HEAD/inventário/índice e remoto na baseline. Antes do push, nova consulta deverá confirmar que origin/main permanece em e17493bd3dd10f6307a458a858e553ad1438e1b5. Avanço inesperado exige interrupção, sem pull/rebase/merge automático ou force.

Não se declara versionamento concluído antes da execução efetiva. O relatório final ao responsável técnico registrará o SHA e os resultados reais de commit/push/sincronização após suas verificações, sem alterar o histórico.
