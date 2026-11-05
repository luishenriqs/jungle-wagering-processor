# JUNGLE-IMP-04/CP-04 — Reconciliação Financeira

## A. Identificação

- Projeto: Jungle Distributed Wagering Processor.
- Checkpoint: IMP-04/CP-04 — Reconciliação Financeira.
- Data: 05/11/2026.
- Baseline: `9b4d50c8c37a5420fe869cde3a1c8a0287a08ff2`, branch `main`.
- Executor: Codex.
- Revisor adversarial: Antigravity, conforme parecer comunicado por Luís Henrique Pereira na autorização deste fechamento.
- Responsável pela aprovação: Luís Henrique Pereira.
- Estado técnico homologado: **APROVADO**. Encerramento de CP-04 e VAL02-01 e procedimento de commit/push formalmente autorizados em 05/11/2026.

Este documento separa o histórico da implementação, o parecer independente comunicado pelo responsável técnico e as verificações executadas pelo Codex neste fechamento. Não atribui execuções do Codex ao Antigravity nem declara versionamento antes dos comandos.

## B. Inventário

| Arquivo existente modificado | Responsabilidade |
|---|---|
| `src/modules/wallets/infrastructure/wallets.controller.ts` | POST de reconciliação, HTTP 200 explícito, UUID/contrato antes do UoW, delegação ao caso existente e contexto de correlação. |
| `src/modules/wallets/infrastructure/wallet-http.dto.ts` | Validação do body ausente/vazio e rejeição de campos e query parameters. |
| `src/modules/wallets/application/wallet-queries.ts` | Correção do agregado assinado, classificação monetária interna, UUID pré-UoW, preservação de REPEATABLE READ, contador consultável e telemetria após o UoW. |
| `test/unit/wallet-http.test.ts` | Cinco REDs, contratos HTTP, cálculo exato, negativos, corrupção/overflow, métricas, correlação e isolamento de falhas de instrumentação. |
| `test/integration/wallet-http.test.ts` | PostgreSQL real: reconciliação, fixtures de divergência, constraints/rollback, concorrência determinística e integridade das cinco tabelas. |

O único arquivo criado no fechamento é `IMP-04-CP-04-EVIDENCE.md`. A implementação acrescentou 28 testes unitários e cinco de integração, sem novos arquivos de teste.

A conferência inicial confirmou main e HEAD na baseline, índice vazio, exatamente os cinco arquivos acima modificados e nenhum arquivo não rastreado. `git ls-remote origin refs/heads/main` confirmou diretamente o remoto na baseline. Foram capturados em memória hashes SHA-256 dos 141 arquivos rastreados preexistentes para verificar sua preservação nesta etapa.

Não há alterações de domínio financeiro, Money, persistência, migrations, workers, Inbox/Outbox, processador financeiro, GetWalletUseCase, composição NestJS, dependências ou scripts. Nenhuma implementação ou correção do achado LOW foi realizada neste fechamento.

## C. Contratos implementados

### Endpoint e validação

`POST /wallets/:walletId/reconciliation` reutiliza ReconcileWalletUseCase, já registrado e exportado. O controller utiliza `@HttpCode(200)` explicitamente e mantém ProviderIdentityGuard.

- UUID validado por internalId() antes do caso de uso; o próprio caso também valida antes de uow.run().
- Body ausente (`undefined`) ou objeto vazio `{}` aceito no contrato JSON.
- Null, arrays, primitivos, objetos com campos e JSON malformado rejeitados.
- Query parameters não são aceitos.
- Entradas inválidas retornam 400 antes do UoW.
- Não exige Idempotency-Key.
- A limitação de Content-Type não-JSON está registrada na seção H.

### Resposta e status

Retorna exatamente walletId, storedBalance, calculatedBalance, difference, consistent e checkedEntries. Os três valores monetários são MoneyProps, com amount string decimal e currency preservada. checkedEntries conta lançamentos do ledger, incluindo OPENING quando existente; ledger vazio tem contagem zero.

| Situação | HTTP |
|---|---|
| Consistente ou divergente | 200 |
| UUID/contrato inválido | 400 |
| Wallet inexistente | 404 WALLET_NOT_FOUND |
| Falha transitória reconhecida | 503 SERVICE_UNAVAILABLE |
| Corrupção/overflow monetário interno ou erro inesperado | 500 INTERNAL_SERVER_ERROR |

O filtro global e os envelopes sanitizados anteriores permanecem inalterados. Não são expostos dados operacionais adicionais, SQL, credenciais ou mensagens internas.

### Cálculo e observabilidade

Preserva `difference = storedBalance - calculatedBalance` e `consistent = difference.isZero()`. A magnitude do agregado é validada com Money.from() antes de aplicar o sinal por negate(). Money.from() e a rejeição de entradas financeiras externas negativas permanecem intactos. `-0.00` e representações internas inválidas são recusados.

InvalidMoneyError, MoneyOverflowError e CurrencyMismatchError na reconstrução/cálculo são traduzidos especificamente para PersistenceInvariantError. Não há captura indiscriminada de falhas de persistência como invariantes monetárias; o tratamento transitório é preservado.

Wallet e agregado são lidos na mesma transação REPEATABLE READ. Não há correção automática, movimentação, novo ledger ou evento financeiro.

Após o UoW concluir, cada diagnóstico divergente incrementa um contador bigint monotônico. O getter público `divergenceObservations` permite leitura; callback opcional recebe o total para futura coleta. Chamadas repetidas representam observações distintas, sem Set de wallets. O contador é por instância/processo.

O log JSON HTTP contém apenas event=WalletReconciliationMismatch, walletId e correlationId correspondente à requisição. execute(walletId) permanece compatível, com contexto opcional. Falhas do callback de métrica e do logger são isoladas independentemente, sem retry operacional ou substituição do diagnóstico. Reconciliações consistentes e UoWs que falham não geram observação de divergência.

## D. Evidência RED — histórico da implementação

Antes da implementação, o Codex executou:

```sh
bun test test/unit/wallet-http.test.ts --test-name-pattern 'CP04 RED'
```

Resultado funcional histórico confirmado fora do sandbox: **0 aprovados, cinco falhas, oito asserções, 131 filtrados, um arquivo**, exit 1.

| RED | Esperado | Observado |
|---|---|---|
| RED-01 | POST retorna 200 | Rota ausente, HTTP 404 |
| RED-02 | Agregado -25.00 produz diagnóstico assinado | InvalidMoneyError antes do diagnóstico |
| RED-03 | Overflow interno vira invariante/500 | Mapeamento monetário retornava 400 |
| RED-04 | Métrica consultável inicia em 0n | Getter ausente, valor undefined |
| RED-05 | UUID inválido não abre UoW | Uma chamada ao UoW |

A validação de correlação também integra o teste RED-04, mas sua falha inicial ocorreu na primeira asserção, relativa à métrica ausente. A correlação foi comprovada posteriormente em GREEN.

Uma execução intermediária encontrou EPERM ao abrir socket local. A reexecução autorizada fora do sandbox confirmou a falha funcional da rota. Uma fixture inicial de saldo positivo também precisou usar reidratação em vez de abertura sem identidades OPENING. Nem EPERM nem essa preparação de fixture constituem evidências RED funcionais.

Essas falhas são históricas; não foram reproduzidas como falhas neste fechamento, que preserva a implementação aprovada.

## E. Evidência GREEN

### Histórico da implementação, anterior ao fechamento

O Codex registrou typecheck aprovado, 159 testes unitários Wallet HTTP/710 asserções, 20 testes de integração Wallet HTTP/235 asserções, regressão de 729 testes/4.499 asserções/35 arquivos sem falhas, bootstraps com e sem banco aprovados e diff-check aprovado. Esses resultados não substituem a execução final abaixo.

### Execução do Codex neste fechamento — 05/11/2026

| Comando/procedimento | Resultado observado |
|---|---|
| `bun run typecheck` | Aprovado, exit 0 |
| `bun test test/unit/wallet-http.test.ts` | 159 aprovados, zero falhas, 710 asserções, um arquivo, exit 0 |
| `bun test test/integration/wallet-http.test.ts` | 20 aprovados, zero falhas, 235 asserções, um arquivo, exit 0 |
| `bun test` | 729 aprovados, zero falhas, 4.499 asserções, 35 arquivos, exit 0; duração reportada 40,26 s |
| Bootstrap sem DATABASE_URL | Aprovado, raiz HTTP 404, exit 0 |
| Bootstrap com URL validada de jungle_test | Aprovado, raiz HTTP 404, exit 0 |

As suítes específicas pertencem à regressão completa e não devem ser somadas novamente ao total. Foi utilizado Bun 1.4.4. Testes com sockets/infraestrutura foram executados fora do sandbox sob autorização.

Os testes cobrem precisão decimal, vazio/OPENING, CREDIT/DEBIT, diferenças positivas e negativas, agregado negativo, -0.00, formatos inválidos, magnitude excedida, overflow da diferença, CurrencyMismatchError interno, ausência de Wallet, validação pré-UoW, sanitização, preservação de falhas transitórias, métrica monotônica, chamadas repetidas, correlação e falhas dos sinks de instrumentação.

O harness restringe a integração a TEST_DATABASE_URL com database jungle_test e schema descartável jungle_it_<uuid>, sem utilizar DATABASE_URL de desenvolvimento como persistência implícita. A integração verifica o database/schema reais e preserva a composição sem ORM adicional ou workers. A regressão completa utiliza PostgreSQL e LocalStack reais com recursos isolados dos harnesses existentes.

Bootstraps executados com os procedimentos existentes:

```sh
bun -e 'delete process.env["DATABASE_URL"]; await import("./scripts/check-bootstrap.ts");'
bun -e 'import { testDatabaseUrl } from "./test/support/postgres"; const result = Bun.spawnSync([process.execPath, "run", "check:bootstrap"], { env: { ...process.env, DATABASE_URL: testDatabaseUrl() }, stdout: "inherit", stderr: "inherit" }); process.exit(result.exitCode);'
```

## F. VAL02-01

Origem: IMP-02-EVIDENCE.md registra como recomendação não bloqueante adiada ao IMP-04 o teste de divergência real e o tratamento de soma negativa em ReconcileWalletUseCase. A agregação SQL já podia produzir string negativa, mas Money.from() a rejeitava antes de gerar diagnóstico/log. Overflow interno também recebia classificação inadequada de erro do cliente.

A correção utiliza as operações internas existentes de Money, preserva os contratos externos não negativos e traduz falhas monetárias internas para PersistenceInvariantError.

### Evidência PostgreSQL e limites da fixture

Três testes SQL reais demonstram storedBalance acima/abaixo do total e calculatedBalance negativo. Na fixture negativa: Wallet 0.00, wager BET 25.00 em contexto de teste, ledger DEBIT 25.00, balanceBefore=100.00 e balanceAfter=75.00. O SQL real retorna -25.00/count=1, e o diagnóstico retorna diferença 25.00 e consistent=false.

As constraints imediatas permanecem satisfeitas e os triggers diferidos ativos. O teste verifica sua configuração e REPEATABLE READ. Captura o diagnóstico na transação da fixture e compara todas as cinco tabelas antes/depois da reconciliação para provar ausência de correção. Ao tentar confirmar, PostgreSQL rejeita o commit com SQLSTATE 23514; as mutações da fixture são revertidas e o estado persistente volta ao snapshot anterior.

Somente após a rejeição/rollback, o UoW controlado de teste reproduz o diagnóstico capturado para exercitar a resposta HTTP, log correlacionado e métrica. Essa é uma **simulação controlada de divergência transacional pré-commit**, não corrupção previamente persistida nem comportamento de recuperação do UoW de produção. Cada cenário é repetido duas vezes, verificando duas observações e dois commits rejeitados.

A concorrência utiliza barreira determinística após getWallet() e antes de ledgerTotal(). Outra transação confirma um débito real durante a pausa. A primeira reconciliação preserva snapshot 100.00/100.00; a seguinte lê 75.00/75.00, sem falso positivo. O teste confirma transaction_isolation=repeatable read e snapshots das tabelas após a movimentação.

Antigravity emitiu APROVAR, conforme comunicado pelo responsável técnico. Luís aprovou formalmente a resolução e o encerramento de VAL02-01 nesta autorização. Não se apresentam evidências do Codex como execuções independentes do revisor.

## G. Revisão adversarial

Parecer independente do Antigravity: **APROVAR**, conforme comunicado por Luís Henrique Pereira na solicitação de fechamento.

Os achados de planejamento **CP04-REV-01, CP04-REV-02, CP04-REV-03, CP04-REV-04, CP04-REV-05 e CP04-REV-06** foram classificados como **RESOLVIDOS** no parecer de implementação informado pelo responsável técnico.

Não foi fornecido nesta autorização o texto integral de cada achado nem um novo inventário de comandos executados pelo Antigravity. Este registro preserva os IDs, a classificação e a proveniência comunicada, sem inventar descrições individuais, assinaturas ou resultados independentes.

## H. Achado residual

**CP04-IMPL-REV-01 — LOW — NÃO BLOQUEANTE.**

Payloads com Content-Type não-JSON podem não ser processados pelo parser JSON do Express e chegar ao controller como body ausente.

Decisão homologada: registrar como melhoria futura, não modificar código/testes neste fechamento e não bloquear o encerramento do CP-04. O achado não é apresentado como corrigido.

## I. Riscos residuais

1. Contador por instância/processo; reinicia com a instância. Agregação operacional entre instâncias permanece reservada ao CP-05.
2. A fixture PostgreSQL representa divergência transitória pré-commit e tem os limites descritos na seção F.
3. Melhoria LOW relativa ao tratamento de Content-Type não-JSON.
4. ProviderIdentityGuard permanece no-op, conforme escopo aprovado; não há autenticação real.

## J. Aprovação humana

Luís Henrique Pereira, na autorização formal de 05/11/2026 recebida nesta conversa, aprovou o parecer técnico APROVAR, o encerramento do CP-04, a resolução e o encerramento de VAL02-01, o aceite do achado LOW não bloqueante e o procedimento específico de staging, commit e push.

Esta autorização não cobre novas implementações, correções do LOW ou início do CP-05. Não são inventadas assinaturas, horários ou documentos de aprovação externos.

## K. Resultado do fechamento

Registro preparado antes do versionamento:

- Commit SHA: reservado ao resultado efetivo; identificável depois por `git log -1 --format=%H -- IMP-04-CP-04-EVIDENCE.md`.
- Mensagem autorizada: `feat(imp-04-cp-04): add wallet reconciliation HTTP API`.
- Parent esperado: `9b4d50c8c37a5420fe869cde3a1c8a0287a08ff2`.
- Inventário esperado do commit: exatamente os cinco arquivos da seção B e este relatório.
- Resultado do push: reservado à execução e verificação de `git push origin main`.
- Estado Git final: reservado à confirmação de HEAD=origin/main, main sincronizada, working tree limpo e índice vazio.

Gate anterior ao staging concluído: exatamente seis arquivos autorizados, apenas este relatório novo, índice vazio, diff-check aprovado e hashes dos 141 arquivos preexistentes idênticos aos capturados no início do fechamento. Inspeção do conteúdo/diff sem credenciais reais, tokens, .env ou artefatos adicionais. Todas as validações da seção E passaram nesta execução.

Antes do push será consultado novamente o SHA remoto; avanço inesperado exige interrupção, sem force, pull, rebase ou merge automático.

O relatório final da sessão registrará o SHA e os resultados reais de commit/push após execução. Estes campos reservados não declaram versionamento antecipadamente nem exigem amend ou alteração posterior do commit para incluir seu próprio SHA.
