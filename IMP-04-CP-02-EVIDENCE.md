# JUNGLE-IMP-04/CP-02 — Wager HTTP API

## A. Identificação

- Projeto: Jungle Distributed Wagering Processor.
- Pacote/checkpoint: IMP-04/CP-02 — Processamento HTTP de Wager e Idempotência.
- Etapa: fechamento técnico controlado, registro de evidências, validação final e versionamento.
- Data: 05/11/2026.
- Baseline: `0b4d6b2c04d18d12d355984c109639c6f615751e`, branch `main`.
- Responsável pela aprovação: Luís Henrique Pereira.
- Executor: Codex.
- Revisor adversarial: Antigravity, conforme parecer comunicado por Luís na autorização de fechamento.
- Estado técnico homologado: **APROVADO**. Commit/push exclusivamente do CP-02 autorizados; o sucesso do versionamento depende da execução e conferência efetivas.

Este relatório distingue o histórico da implementação, o parecer independente recebido e as novas execuções deste fechamento. Não atribui ao revisor resultados do Codex nem apresenta testes históricos como reexecutados.

## B. Escopo e inventário

| Estado contra a baseline | Arquivo | Responsabilidade técnica |
|---|---|---|
| Modificado | `src/app.module.ts` | Cria uma única referência de DatabaseModule.forHttp() compartilhada entre Wallets/Wagering; centraliza filtro e correlação nas raízes HTTP padrão e registrada. |
| Modificado | `src/modules/wallets/wallets.module.ts` | Recebe a referência de banco fornecida pela raiz, registra controller/guard e deixa de criar infraestrutura HTTP própria. |
| Modificado | `src/modules/wagering/wagering.module.ts` | Acrescenta forHttp(database) com controller/guard e preserva a composição standalone de referências pendentes. |
| Novo | `src/modules/wagering/infrastructure/wagering.controller.ts` | Implementa POST, delega exclusivamente a ProcessWagerTransactionUseCase, define status HTTP e devolve seu resultado integral. |
| Novo | `src/modules/wagering/infrastructure/wager-http.dto.ts` | Valida header/body/referências/Money e fornece função pura de mapeamento dos resultados para HTTP. |
| Novo | `test/unit/wager-http.test.ts` | Contratos estritos, Idempotency-Key, duplicações reais, referências, hash HTTP/SQS, status, sanitização, correlação e modo sem banco. |
| Novo | `test/integration/wager-http.test.ts` | PostgreSQL/LocalStack reais, efeitos financeiros, replays históricos, concorrência entre canais, rollback/recuperação e composição compartilhada. |

O oitavo e único arquivo adicional autorizado nesta etapa é `IMP-04-CP-02-EVIDENCE.md`.

A conferência inicial encontrou somente os sete arquivos acima: três rastreados modificados, quatro novos e índice vazio. Não havia alterações concorrentes ou inesperadas. Foi capturado um snapshot SHA-256 dos 139 arquivos versionáveis preexistentes para verificar sua preservação durante o fechamento.

Nenhuma alteração em DatabaseModule, filtro compartilhado, casos de uso, domínio, FinancialStore, PostgresUnitOfWork, migrations, workers, dependências, scripts ou documentos existentes é autorizada nesta tarefa. CP-03 não foi iniciado.

## C. Contratos implementados

### Endpoint e resultados

`POST /wagering/transactions`, com `Idempotency-Key` obrigatório no header.

| Resultado | HTTP |
|---|---|
| PROCESSED, original ou replay | 200 |
| PENDING_REFERENCE, original ou replay | 202 |
| REJECTED, original ou replay | 422 |
| FAILED terminal persistido, incluindo replay | 422 |
| Entrada/header inválido | 400 |
| Wallet inexistente | 404 |
| Conflito de idempotência | 409 |
| Falha transitória reconhecida sem commit | 503 |
| Erro interno ou resultado intermediário incompatível | 500 |

O controller usa o ProcessWagerTransactionUseCase existente e retorna o ProcessWagerResult sem reconstruir saldo pela Wallet atual. O mapper aceita FAILED histórico com idempotentReplay=true; a implementação atual do caso de uso devolve FAILED nesse caminho de replay persistido. PENDING ou FAILED não histórico inesperado não são inventados como sucesso confirmado.

Replay preserva transactionId, status, failureCode quando existente, balance histórico e idempotentReplay. FAILED histórico não é convertido em 500/503, não muda estado terminal e não gera nova transação, ledger ou eventos financeiros.

### Validação e idempotência

- Header é a única fonte da chave; idempotencyKey no body é proibido.
- Ausência, vazio, tipo inválido e whitespace que chegue ao DTO são rejeitados. Quando rawHeaders está disponível, contam-se ocorrências reais sem distinguir capitalização: exige-se exatamente uma, compatível com o valor semântico do header.
- Body e money são objetos não nulos e não arrays, com whitelist de campos e tipos explícitos. playerId continua externo TEXT; walletId é UUID interno normalizado.
- Money usa strings decimais exatas, sem coerção. Valores inválidos, negativos, expoentes, escala incorreta e overflow são rejeitados antes do processamento financeiro.
- ISO-4217 inválido resulta em 400 sem nova wager; moeda válida incompatível com Wallet resulta em REJECTED/422 CURRENCY_MISMATCH, preservando a moeda real do snapshot.
- Referência ausente/null é omitida; string válida é preservada; valores vazios ou tipos inválidos são rejeitados. BET/LOSS não admitem referência; WIN admite referência opcional; REFUND/ROLLBACK exigem referência. OPENING externo e provider SYSTEM são proibidos.
- Canonicalização/hash financeiros existentes permanecem compartilhados com SQS; header e metadata de transporte não integram o hash.

### Interoperabilidade e composição

HTTP/SQS usam o mesmo caso de uso e as garantias persistentes de idempotência/transação, sem deduplicação financeira alternativa no controller ou dependência de FIFO como garantia final.

A raiz HTTP instancia uma referência de DatabaseModule.forHttp(uow) e a entrega aos dois módulos. HttpExceptionFilter e middleware de correlationId são centralizados e ativos em AppModule e RegisteredHttpApplication. O teste inspeciona ModulesContainer, providers, inicialização/pool real e compartilhamento do UoW; os controllers são operacionais no mesmo schema. A composição HTTP não inicia Consumer, Publisher ou PendingReferenceWorker.

AppModule.register({ uow }) e o bootstrap sem DATABASE_URL foram preservados. DatabaseModule.forRoot()/forHttp() não foram modificados. Autenticação permanece no-op, conforme escopo anterior; não há IdP real.

## D. Evidência RED — implementação anterior do Codex

Comando: `bun test test/unit/wager-http.test.ts`, com o executável `/home/luishenriqs/.bun/bin/bun`, acesso autorizado a socket local e HTTP real.

Antes de implementar o endpoint, foram observadas **duas falhas esperadas, zero testes aprovados, duas asserções**:

| Cenário | Esperado | Observado antes da implementação |
|---|---|---|
| POST válido com UoW indisponível | 503 | 404: rota ainda ausente |
| POST sem Idempotency-Key | 400, antes da persistência | 404: rota ainda ausente |

Essas falhas foram funcionais e chegaram às asserções HTTP; não eram falhas ambientais de socket, PostgreSQL ou LocalStack. Os resultados são históricos da implementação, não uma nova execução RED no fechamento.

## E. Evidência GREEN e validações

### Histórico executado pelo Codex na implementação

| Comando/verificação | Resultado histórico observado |
|---|---|
| `bun run typecheck`, baseline | Exit 0. |
| `bun test test/unit`, baseline | 324 aprovados, 0 falhas, 1720 asserções, 23 arquivos. |
| Suítes específicas CP-02, versão final da implementação | 158 aprovados, 0 falhas, 659 asserções, 2 arquivos; 130 unitários e 28 integrações. |
| `bun run typecheck`, final | Exit 0. |
| `bun test`, final | **600 aprovados, 0 falhas, 3799 asserções, 35 arquivos, 38,41s**, exit 0. |
| Bootstrap original com e sem DATABASE_URL | Exit 0 em ambos; raiz HTTP 404. Com banco, subprocesso aponta explicitamente para jungle_test. |
| `git diff --check` | Exit 0. |

Os testes específicos já integram os 600 da regressão completa. Não somar execuções ou contagens intermediárias.

PostgreSQL **16.6** real foi confirmado pela asserção server_version_num=160006. Integrações utilizam TEST_DATABASE_URL restrita a jungle_test, schemas descartáveis jungle_it_<uuid> e filas LocalStack descartáveis dos harnesses existentes. O smoke da composição padrão adapta somente o schema na fronteira real de MikroORM.init, preservando o grafo Nest e o pool real; confere banco/schema e fechamento do recurso. Não usa jungle_dev nem modifica filas compartilhadas.

A cobertura inclui:

- BET, WIN, LOSS, REFUND e ROLLBACK, rejeições financeiras, referências incompatíveis e ISO inválido versus moeda incompatível.
- FAILED terminal persistido respeitando as constraints existentes: replay 422 exato, snapshot histórico, estado imutável, ausência de novo ledger/evento.
- PENDING_REFERENCE: aceite 202, mudança posterior no saldo, replay com snapshot do aceite, referência tardia, resolução pelo worker existente e replay terminal com snapshot da resolução. Nenhuma mudança de TTL/backoff/Opção A.
- HTTP primeiro/SQS depois e ordem inversa; mesma identidade e conflitos por payload, external ID com outra key e key associada a outra Wallet.
- HTTP/SQS simultâneos com barreira antes do lock em transações SQL reais: um original/um replay para payload idêntico ou um vencedor/um conflito para payload divergente, com Inbox coerente e um efeito financeiro.
- Cinquenta POSTs concorrentes: um original, 49 replays e um débito/eventos únicos. Duas BETs de 80 sobre saldo 100: uma processada, outra rejeitada, saldo 20.
- Falha injetada antes do commit com rollback integral; perda de confirmação injetada após commit real e reenvio com replay, sem segundo efeito.
- SQLSTATE 40P01 injetado no PostgreSQL real, retry limitado, 503 sem commit e sucesso após recuperação. Isso verifica o protocolo de retry, não um ciclo físico de deadlock.
- Reconciliação de saldo/ledger, contagens negativas de novos efeitos, correlação e filtro nas duas rotas, um banco/UoW/ORM/pool na composição e ausência de workers HTTP.
- Regressão completa incluindo CP-01, integrações anteriores, processos independentes, recuperação e smokes dos workers standalone.

Falhas injetadas com serviços reais não são apresentadas como partições físicas de rede ou cobertura universal de falhas distribuídas.

### Execuções desta sessão de fechamento

Resultados executados pelo Codex **nesta sessão de fechamento**, preservando a implementação aprovada:

| Comando/verificação | Resultado efetivamente observado |
|---|---|
| `git status --short --branch`, `git rev-parse HEAD` | main na baseline, somente três rastreados modificados e quatro novos antes deste relatório. |
| `git diff --cached --stat` inicial | Vazio; nenhum arquivo staged. |
| `git remote -v` | origin corresponde ao repositório Jungle esperado. |
| `git ls-remote origin refs/heads/main` inicial | Exit 0; remoto na baseline 0b4d6b2c04d18d12d355984c109639c6f615751e. |
| `bun run typecheck` | Exit 0. |
| `bun test test/unit/wager-http.test.ts` | **130 aprovados, 0 falhas, 379 asserções, 1 arquivo**, exit 0. |
| `bun test test/integration/wager-http.test.ts` | **28 aprovados, 0 falhas, 280 asserções, 1 arquivo**, exit 0; PostgreSQL 16.6 e LocalStack reais, recursos descartáveis. |
| `bun test` | **600 aprovados, 0 falhas, 3799 asserções, 35 arquivos, 39,70s**, exit 0. |
| Bootstrap original sem DATABASE_URL no processo | Exit 0, raiz HTTP 404. |
| Bootstrap original em subprocesso com DATABASE_URL obtida de testDatabaseUrl() | Exit 0, PostgreSQL jungle_test, raiz HTTP 404. |
| `git diff --check` inicial e após criação do relatório | Exit 0. |
| Snapshot SHA-256 dos 139 arquivos versionáveis preexistentes | Todos preservados; somente este relatório criado no projeto. |
| Inspeção dos oito arquivos e busca de padrões de segredo | Nenhuma chave privada, token reconhecido ou URL PostgreSQL autenticada literal encontrada nos padrões examinados. Nenhum .env, dependência, migration ou artefato runtime no inventário. |

As suítes específicas já integram os 600 testes da regressão; não somar execuções. A regressão desta sessão inclui o CP-01 e os smokes dos workers standalone sem falhas. A implementação anterior e os resultados recebidos do revisor permanecem com sua proveniência separada.

Execução com Bun 1.4.4 no caminho `/home/luishenriqs/.bun/bin/bun`, com autorização para sockets e acesso aos serviços reais fora do sandbox. Nenhuma validação obrigatória falhou. Os comandos de bootstrap preservaram o ambiente do processo pai e não alteraram scripts ou arquivos de configuração:

```sh
bun -e 'delete process.env["DATABASE_URL"]; await import("./scripts/check-bootstrap.ts");'
bun -e 'import { testDatabaseUrl } from "./test/support/postgres"; const result = Bun.spawnSync([process.execPath, "run", "check:bootstrap"], { env: { ...process.env, DATABASE_URL: testDatabaseUrl() }, stdout: "inherit", stderr: "inherit" }); process.exit(result.exitCode);'
```

A inspeção de integridade encontrou exclusivamente os oito candidatos autorizados, sem alterações silenciosas em código, testes, dependências, domínio, migrations, workers ou outros documentos. A busca automatizada de segredos é limitada aos padrões examinados, complementada pela leitura dos oito arquivos; não é garantia absoluta para qualquer formato de segredo.

## F. Revisão adversarial independente

**Parecer do Antigravity: APROVAR.**

Origem: comunicação formal de Luís Henrique Pereira na autorização de fechamento técnico concedida em 05/11/2026. A implementação foi informada como concluída e submetida à revisão adversarial independente.

O aceite cobre o checkpoint Wager HTTP e suas garantias: reuso do caso de uso financeiro, idempotência persistente entre HTTP/SQS, resultados e snapshots históricos, preservação do terminal FAILED, atomicidade/ausência de efeitos duplicados, validação de contratos e composição compartilhada sem regressões no CP-01/workers. A evidência executável do Codex associada a essas propriedades está na seção E.

A ordem recebida não fornece logs integrais, modelo do revisor ou contagens específicas de testes executados pelo Antigravity. Não se inventam esses dados nem se atribuem ao revisor os 600 testes executados pelo Codex.

Achado residual recebido: **CP02-IMPL-REV-01 — LOW — NÃO BLOQUEANTE**. Oportunidade de adicionar futuramente um teste HTTP ponta a ponta específico para Idempotency-Key contendo apenas espaços. É uma melhoria de cobertura, não um defeito bloqueante homologado. Nenhum teste foi adicionado ou alterado nesta etapa para resolvê-lo.

## G. Decisões homologadas

Luís homologou os status HTTP registrados na seção C, incluindo **FAILED terminal persistido/replay em HTTP 422**, preservando integralmente o ProcessWagerResult histórico e a ausência de novos efeitos financeiros.

### Normalização OWS — decisão definitiva

Foi formalmente aprovada a normalização de **espaços e tabulações opcionais nas extremidades do header HTTP pelo parser nativo do Bun**. O valor entregue pelo parser é o valor semântico do header. Valores vazios e headers duplicados continuam proibidos; a validação defensiva de whitespace no DTO permanece preservada. Não será introduzida interceptação dos bytes brutos do socket HTTP.

Na implementação anterior, um diagnóstico TCP real observou que o valor enviado como `"  test-key  "` chegou como `"test-key"` tanto em headers quanto em rawHeaders. A pendência de interpretação então apresentada pelo Codex foi encerrada pela decisão definitiva desta autorização. Esse diagnóstico observou espaços; não é apresentado como nova execução nem como teste específico de tabulação.

A decisão OWS não altera o algoritmo de canonicalização, a chave financeira após interpretação HTTP ou o comportamento de domínio. Não exige mudanças no código aprovado.

O achado LOW CP02-IMPL-REV-01 será apenas registrado como melhoria futura, sem ampliar o escopo deste fechamento.

## H. Riscos residuais e limites

- **CP02-IMPL-REV-01:** melhoria de cobertura LOW e não bloqueante, pendente para avaliação futura. Não é declarado corrigido.
- **OWS:** decisão de contrato resolvida e homologada; não permanece como bloqueio técnico.
- Autenticação no-op e funcionalidades de checkpoints posteriores são limites de escopo, não defeitos corrigidos ou implementações novas desta etapa. A aprovação do CP-02 não conclui todo o desafio.
- As evidências de recuperação distinguem falhas injetadas de partições físicas; não há promessa de cobertura universal ou de entrega exactly-once.

Nenhum outro defeito bloqueante foi informado no parecer APROVAR recebido. Não foram executadas melhorias, refatorações ou atividades do CP-03 neste fechamento.

## I. Aprovação humana

Luís Henrique Pereira concedeu em **05/11/2026** aprovação formal para o fechamento técnico do IMP-04/CP-02 após parecer APROVAR do Antigravity, homologou OWS e o tratamento do achado LOW e autorizou especificamente commit/push para origin/main dos oito arquivos deste inventário.

Mensagem autorizada: `feat(imp-04-cp-02): add wagering HTTP API and validation`.

Essa autorização não permite alterar a implementação aprovada, ampliar o inventário, resolver o LOW ou iniciar CP-03. Não são inventadas assinaturas, horários de aprovação ou evidências externas.

## J. Resultado do fechamento e campos de versionamento

Este documento é preparado antes do commit. Campos reservados para a confirmação no relatório final da execução:

- Commit SHA: **a confirmar após execução de git commit**.
- Mensagem: `feat(imp-04-cp-02): add wagering HTTP API and validation`.
- Arquivos: exatamente os oito caminhos da seção B, incluindo este relatório.
- Push: **a confirmar após git push origin main, com exit 0**.
- Estado final Git: **a confirmar: HEAD=origin/main, main sincronizada, working tree e índice limpos**.

A conferência inicial do fechamento confirmou main, HEAD na baseline, índice vazio, somente os sete arquivos aprovados e origin/main na mesma baseline por git ls-remote (exit 0). Antes do push, o remoto deverá ser consultado novamente; avanço inesperado exige interrupção, sem pull/rebase/merge automático ou force.

Não se declara versionamento concluído antes da execução real. O relatório final ao responsável técnico preencherá os resultados efetivos desses comandos, sem alterar o histórico ou antecipar sucesso neste arquivo.
