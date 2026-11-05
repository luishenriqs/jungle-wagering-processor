# JUNGLE-IMP-04/CP-01 — Fundação HTTP e Wallet

## 1. Identificação e estado

- Projeto: Jungle Gaming — Distributed Wagering Processor.
- Pacote: IMP-04.
- Checkpoint: CP-01 — Fundação HTTP e Wallet.
- Fechamento: IMP-04/CP-01-CLOSE.
- Data: 05/11/2026.
- Responsável técnico: Luís Henrique Pereira.
- Executor: Codex.
- Baseline: `f888d1a276ccf9055ff48ce7ec93c64f29a2af5a`, branch `main`.
- Estado técnico: **APROVADO após revisão independente, com recomendações não bloqueantes**.
- Versionamento: commit e push autorizados exclusivamente para os dez arquivos deste checkpoint; a execução efetiva será conferida após os comandos. Este relatório não antecipa sucesso de commit/push.

A ordem de fechamento autoriza somente a criação deste documento, validações e versionamento controlado. Código, testes, migrations, dependências, scripts e documentos existentes devem permanecer integralmente preservados. CP-02 não foi iniciado.

## 2. Objetivo

Disponibilizar a borda HTTP de Wallet com `POST /wallets` e `GET /wallets/:walletId`, reutilizando `CreateWalletUseCase` e `GetWalletUseCase`. A entrega inclui validação estrita antes dos casos de uso, serialização explícita com MoneyProps, tradução sanitizada de erros, correlação por requisição, ponto de extensão no-op de autenticação e composição NestJS sem duplicação de infraestrutura no contexto HTTP atual.

A abertura financeira continua no caso de uso existente: Wallet, OPENING, ledger e eventos Outbox são persistidos atomicamente quando o saldo inicial é positivo. A abertura zero mantém a semântica existente, sem artefatos financeiros de movimento. Nenhuma regra financeira foi alterada.

## 3. Inventário e escopo implementado

Os nove arquivos da implementação aprovada são:

| Estado contra a baseline | Arquivo | Finalidade |
|---|---|---|
| Modificado | `src/app.module.ts` | Composição HTTP padrão e registro com UoW explícito; raiz separada evita mesclar imports de produção na composição de teste. |
| Modificado | `src/database/database.module.ts` | Acrescenta `forHttp()` com configuração tardia, ownership e fechamento do ORM, ou UoW fornecido pelo chamador; preserva `forRoot()`. |
| Modificado | `src/modules/wallets/wallets.module.ts` | Import explícito dos providers financeiros, controller, guard, filtro e correlação anterior ao parser JSON. |
| Novo | `src/modules/wallets/infrastructure/wallets.controller.ts` | POST/GET com delegação aos casos de uso existentes e validação do UUID interno na consulta. |
| Novo | `src/modules/wallets/infrastructure/wallet-http.dto.ts` | Whitelist estrita de campos, verificação de tipos, validação Money e projeção pública da Wallet. |
| Novo | `src/shared/infrastructure/http-exception.filter.ts` | Respostas públicas estáveis para erros conhecidos, transientes e desconhecidos, preservando status HTTP nativos sem copiar mensagens internas. |
| Novo | `src/shared/infrastructure/provider-identity.guard.ts` | Guard no-op explícito, permitindo todas as requisições; não implementa autenticação real. |
| Novo | `test/unit/wallet-http.test.ts` | 65 testes de contratos, serialização, erros, correlação, DI e bootstrap sem banco/configuração inválida. |
| Novo | `test/integration/wallet-http.test.ts` | 11 testes PostgreSQL/HTTP reais: isolamento, persistência, concorrência, rollback e composição/lifecycle do ORM. |

Este documento, `IMP-04-CP-01-EVIDENCE.md`, é o décimo arquivo autorizado para o commit. Não integra implementação de funcionalidades posteriores.

## 4. Decisões arquiteturais comprovadas

1. **Composição HTTP:** `WalletsModule.register()` importa uma única composição `DatabaseModule.forHttp()`. O NestJS 11 instalado foi inspecionado: a identificação padrão de DynamicModule é por referência, portanto chamadas independentes podem gerar composições distintas.
2. **Workers preservados:** `DatabaseModule.forRoot()` permanece com sua composição existente para os consumidores standalone. Nenhum worker foi modificado ou iniciado pela composição HTTP.
3. **ORM/pool:** o contexto HTTP padrão inicializa um único MikroORM e pool; o teste inspeciona os providers efetivos, conta a inicialização real, verifica ausência de réplicas/workers e confirma fechamento. Não se usa somente `app.get()` como evidência de unicidade.
4. **Bootstrap sem banco:** a factory consulta `DATABASE_URL` ao criar o contexto, sem capturá-la durante importação. Quando ausente, nenhuma inicialização ORM é feita e o UoW indisponível lança 503. Não retorna dados fictícios. Configuração presente e inválida falha no startup; não há catch convertendo falha de conexão em fallback.
5. **UoW explícito:** `AppModule.register({ uow: h.uow })` utiliza o recurso fornecido pelo harness; não inicializa outro ORM nem assume ownership desse recurso.
6. **Isolamento:** `createHarness()` exige `TEST_DATABASE_URL` para `jungle_test`, cria `jungle_it_<uuid>`, aplica a migration existente nesse schema e remove somente o recurso criado. A suíte valida `current_database()`/`current_schema()`. Um valor de desenvolvimento deliberadamente inutilizável em `DATABASE_URL` não interfere na composição injetada. No smoke do grafo padrão de produção, somente o schema é adaptado na fronteira real de `MikroORM.init`, como nos smokes existentes dos workers; banco/schema e fechamento do pool são verificados.
7. **Validação manual:** não foram adicionadas dependências. Body e initialBalance devem ser objetos não nulos e não arrays, sem campos extras. Tipos são verificados antes de `Money.from()`; amount numérico não é aceito nem convertido.
8. **Projeção pública:** a resposta contém exclusivamente `id`, `playerId`, `balance` em MoneyProps e `version`. A instância de Wallet não é retornada diretamente; datas, openingEntry e estruturas internas não são expostas.
9. **Erros:** filtro central mapeia entrada/Money para 400, ausência para 404, conflitos para 409, retry/transientes reconhecidos para 503 e invariantes/erros desconhecidos para 500. JSON malformado mantém 400 e rota inexistente mantém 404. Mensagens públicas são controladas, sem SQL, stack, credenciais ou payload financeiro completo.
10. **Correlação:** UUID novo por requisição, independente do header recebido, instalado antes do parser JSON, disponível ao controller/filtro e retornado em `x-correlation-id`. O POST propaga o mesmo identificador ao caso de uso e aos eventos financeiros existentes.
11. **Autenticação:** `ProviderIdentityGuard` é um ponto de extensão no-op, permitido pelo enunciado. Os endpoints não estão autenticados. Não há usuários, senhas, tokens próprios ou Identity Provider em execução.

## 5. Evidências RED — execução anterior do Codex

O contrato HTTP ainda não tinha o teste específico. Foi criado `test/unit/wallet-http.test.ts`, antes da implementação das rotas, para exigir 503 em uma criação válida no modo sem banco.

Comando: `bun test test/unit/wallet-http.test.ts` (executável local `/home/luishenriqs/.bun/bin/bun`).

- Primeira tentativa: `EPERM` em `listen`. Foi um bloqueio ambiental de socket, anterior à asserção HTTP; não constitui RED funcional.
- Reexecução autorizada fora do sandbox: o servidor e a requisição HTTP reais foram executados. **1 teste falhou, 1 asserção: esperado 503, recebido 404** no POST válido em `/wallets`.
- O RED foi inicialmente exercitado no módulo Wallets ainda vazio. O teste GREEN passou a exercitar a composição AppModule padrão, mantendo a exigência de indisponibilidade financeira explícita sem banco.

Não foram alteradas asserções para fabricar falha. O resultado 404/503 foi efetivamente observado, separado do bloqueio EPERM.

## 6. Evidências GREEN — implementação anterior do Codex

Resultados executados pelo Codex na implementação, antes deste fechamento:

| Verificação | Resultado observado |
|---|---|
| `bun run typecheck`, baseline | Aprovado, exit 0. |
| `bun test test/unit`, baseline | 259 aprovados, 0 falhas, 1411 asserções, 22 arquivos. |
| Duas suítes novas HTTP, execução conjunta anterior ao último reforço de isolamento do smoke | 76 aprovados, 0 falhas, 386 asserções, 2 arquivos. |
| `bun run typecheck`, final | Aprovado, exit 0. |
| `bun test`, final | **442 aprovados, 0 falhas, 3140 asserções, 33 arquivos**, 37,57s, exit 0. |
| Script original `scripts/check-bootstrap.ts`, sem DATABASE_URL no processo | Aprovado, raiz HTTP 404, exit 0. |
| `bun run check:bootstrap`, subprocesso com DATABASE_URL obtida de `testDatabaseUrl()` | Aprovado com PostgreSQL em `jungle_test`, raiz HTTP 404, exit 0. |
| `git diff --check` | Aprovado, exit 0. |

Os **76 testes novos** correspondem a 65 unitários e 11 integrações. Eles já estão incluídos nos 442 da regressão completa; não somar execuções. A execução conjunta de 386 asserções precedeu a asserção adicional de identidade banco/schema no smoke; a regressão final de 3140 asserções corresponde ao código aprovado.

Ambiente observado: Bun 1.4.4, TypeScript strict, PostgreSQL 16 real e LocalStack real. A regressão completa executou integrações, processos Bun e backends PostgreSQL independentes, sinais, crashes, reinícios e smokes dos três workers existentes. Não se atribui esse resultado a mocks ou a execuções de terceiros.

Na borda HTTP foram comprovados: abertura positiva/zero, resposta exata, consulta no schema isolado, eventos Outbox com a correlação da requisição, unicidade jogador/moeda, outra moeda permitida, doze criações concorrentes com um vencedor e onze conflitos, reconciliação e rollback após insertWallet/insertWager/appendLedger/enqueue/antes do commit. Os negativos cobrem estruturas nulas/arrays, campos extras, tipos/valores monetários inválidos, UUID inválido, inexistência, JSON malformado e tradução sanitizada de erros.

As falhas injetadas testam rollback/protocolo com banco real; não representam prova de todas as partições físicas de rede. O smoke de produção adapta somente o schema no teste, sem trocar o grafo Nest ou simular ORM/pool.

## 7. Revisão adversarial independente — Antigravity

**Parecer: APROVAR COM RECOMENDAÇÕES NÃO BLOQUEANTES.**

Origem: parecer e resultados informados por Luís Henrique Pereira na ordem `IMP-04/CP-01-CLOSE`. Identificação apresentada pelo revisor: **Gemini 4 Argon — Medium**. A identificação é transcrita do relato recebido, não uma verificação independente do runtime do revisor.

Os achados de planejamento **CP01-REV-01 a CP01-REV-07 foram classificados como RESOLVIDOS**: composição/visibilidade, bootstrap sem banco, isolamento PostgreSQL, exceções HTTP, validação/serialização, negativos adicionais e propagação de correlationId.

| Verificação independente informada | Resultado do Antigravity |
|---|---|
| Regressão completa | **442 aprovados, 0 falhas, 3140 asserções, 33 arquivos.** |
| Typecheck | Aprovado. |
| Bootstrap | Aprovado. |
| PostgreSQL/LocalStack | Testes com serviços reais aprovados. |

Esses resultados pertencem ao Antigravity e são recebidos por comunicação do responsável técnico. Não são novas execuções do Codex e não são somados à regressão do executor. Logs integrais da revisão não foram anexados nesta ordem; não são inventados PIDs, duração ou comandos adicionais do revisor.

## 8. Risco residual e encaminhamento

**CP01-IMPL-REV-01 — Severidade BAIXA — Não bloqueante.**

Ao adicionar controllers HTTP ao WageringModule no CP-02, chamadas independentes a `DatabaseModule.forHttp()` podem gerar composições e recursos duplicados.

Encaminhamento aprovado: o planejamento do CP-02 deverá avaliar a centralização de `DatabaseModule.forHttp()`, `HttpExceptionFilter` e middleware de correlationId, preservando uma única instância compartilhada de infraestrutura HTTP e PostgreSQL entre Wallets e Wagering.

A recomendação não indica duplicação comprovada no grafo HTTP atual, que foi testado. **Nenhuma reorganização foi executada neste fechamento; o CP-02 não foi planejado nem implementado nesta sessão.**

## 9. Limitações

- Autenticação permanece no-op, por decisão permitida na seção 2 do desafio; não há Identity Provider real e não se declara que os endpoints estão autenticados.
- CP-02 a CP-07 permanecem pendentes. A aprovação do CP-01 não representa conclusão do desafio inteiro.
- Os demais documentos foram preservados; suas notas históricas não foram reorganizadas neste fechamento.
- Aprovação e testes cobrem os cenários executados e não equivalem a garantia universal contra qualquer falha distribuída.

## 10. Aprovação humana e controle de mudanças

Luís Henrique Pereira aprovou formalmente o planejamento executivo v0.2, a implementação controlada, o fechamento técnico após revisão independente e o versionamento exclusivo do CP-01, incluindo commit e push para `origin/main`.

Mensagem autorizada: `feat(imp-04-cp-01): add wallet HTTP API and validation`.

Conferência inicial deste fechamento: branch `main`, HEAD igual à baseline, três rastreados modificados, seis novos, índice vazio e diff-check aprovado. O inventário coincide com os nove arquivos aprovados, sem alterações inesperadas. Foi capturado um snapshot SHA-256 dos 134 arquivos versionáveis existentes em `/tmp`, para conferir que somente este relatório foi criado nesta tarefa.

A autorização não permite refatoração, implementação adicional, alterações em testes/normativos/migrations/dependências ou avanço ao CP-02. Staging deverá conter exatamente os dez caminhos autorizados. Commit/push só poderão ser afirmados após a execução real e conferência de conteúdo, working tree e sincronização.

## 11. Validações desta sessão de fechamento

Resultados executados pelo Codex nesta sessão documental, sobre a implementação aprovada sem alterações:

| Comando/verificação | Resultado observado nesta sessão |
|---|---|
| `git status --short --branch`, `git rev-parse HEAD`, `git branch --show-current` | `main`, baseline confirmada, três rastreados modificados e seis novos antes da criação do relatório; nenhum staged. |
| `git diff --check` inicial e após criar o relatório | Exit 0. |
| `git diff --stat`, `git ls-files --others --exclude-standard` | Inventário inicial exato: três modificados (57 inserções/9 exclusões) e seis novos aprovados. |
| `bun run typecheck` | Exit 0. |
| `bun test test/unit/wallet-http.test.ts` | **65 aprovados, 0 falhas, 309 asserções, 1 arquivo**, exit 0. |
| `bun test test/integration/wallet-http.test.ts` | **11 aprovados, 0 falhas, 78 asserções, 1 arquivo**, exit 0; PostgreSQL 16 real, jungle_test/schema descartável verificados. |
| `bun test` | **442 aprovados, 0 falhas, 3140 asserções, 33 arquivos, 38,91s**, exit 0; PostgreSQL/LocalStack reais, integrações, multiprocessos, recovery e smokes existentes. |
| Bootstrap original sem DATABASE_URL no processo | Exit 0, raiz HTTP 404. |
| Bootstrap original em subprocesso com DATABASE_URL obtida de `testDatabaseUrl()` | Exit 0, PostgreSQL jungle_test, raiz HTTP 404. |
| Comparação SHA-256 do snapshot inicial | 134 arquivos preexistentes preservados; somente este relatório criado. |
| Inspeção dos dez candidatos e busca de padrões de chaves/tokens | Nenhum arquivo de ambiente, dependência ou runtime; nenhum padrão pesquisado encontrado. A URL de credencial literal nos testes é fixture sintética. A busca não é garantia absoluta para qualquer formato de segredo. |
| `git ls-remote origin refs/heads/main` | Primeira tentativa com DNS bloqueado no sandbox (exit 128); reexecução autorizada fora dele aprovada (exit 0), remoto na baseline. Nenhum avanço remoto observado antes do versionamento. |

Os testes foram executados com acesso autorizado fora do sandbox para sockets locais e serviços reais. Não houve falha de validação obrigatória nesta sessão. As suítes individuais já integram a regressão de 442 testes: não somar os resultados nem misturar estas execuções com as anteriores ou com o parecer independente.

Comandos de bootstrap, sem expor URLs/credenciais:

```sh
bun -e 'delete process.env["DATABASE_URL"]; await import("./scripts/check-bootstrap.ts");'
bun -e 'import { testDatabaseUrl } from "./test/support/postgres"; const result = Bun.spawnSync([process.execPath, "run", "check:bootstrap"], { env: { ...process.env, DATABASE_URL: testDatabaseUrl() }, stdout: "inherit", stderr: "inherit" }); process.exit(result.exitCode);'
```

O executável utilizado foi `/home/luishenriqs/.bun/bin/bun`, versão 1.4.4. Nenhum script, teste, configuração financeira ou documento existente foi modificado. Os resultados efetivos de staging, commit, push e sincronização serão apresentados no relatório final da execução, após sua conferência; este documento foi preparado antes desses comandos e não presume seu sucesso.
