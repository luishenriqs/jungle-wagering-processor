# FIX-D01 — Integridade monetária PostgreSQL

Data: 06/11/2026. Executor: Codex. Autorização: Luís Henrique Pereira.
Baseline: `main`, `becd3d92ca2993d2349324f5ae59bd5e46ee3642`; working tree inicialmente limpa.
Estado deste checkpoint: implementação D01 e validação do recorte concluídas. Revisão FIX-D01-REV-01 posteriormente APROVADA, zero achados, conforme informação de Luís na autorização FIX-D01-D02-FINAL. Publicação e validação estável consolidadas em [FIX-D01-D02-FINAL-EVIDENCE.md](FIX-D01-D02-FINAL-EVIDENCE.md). As ressalvas de concorrência e ausência de commit abaixo descrevem o checkpoint histórico D01.

## Causa raiz e inventário

PostgreSQL admite NaN em NUMERIC(18,2). Comparações anteriores como `>= 0`, `> 0` e igualdade aritmética não o excluem. Um bundle contendo NaN em wallet, OPENING e ledger satisfazia inclusive os triggers diferidos e confirmava o commit. Money já rejeitava esse valor nas entradas públicas e não foi alterado.

Todas as colunas NUMERIC persistidas são monetárias e têm precisão 18/escala 2:

| Tabela | Colunas |
|---|---|
| wallets | balance |
| wager_transactions | amount, recorded_balance_amount (nullable) |
| wallet_ledger_entries | amount, balance_before, balance_after |

O teste de inventário consulta information_schema e exige exatamente essas seis colunas/tipos.

## RED executado antes da nova migration

Comando: `bun test test/integration/monetary-integrity.test.ts`.

Resultado: **17 pass, 6 fail, 71 asserções, 23 testes**. A reprodução do commit com NaN nas seis colunas passou no schema antigo. Os seis testes de rejeição pela proteção de finitude falharam. Alguns valores isolados já eram barrados por checks aritméticos/diferidos; por isso os testes exigem o nome da nova constraint, sem confundir outro erro com prova de finitude. O bundle coordenado comprova a aceitação efetiva anterior.

As doze verificações de Infinity/-Infinity passaram já no RED: o typmod NUMERIC(18,2) rejeita essas entradas com SQLSTATE 22003 antes dos checks.

A reprodução histórica permanece executável no teste `FIX-D01 legacy schema confirms NaN in all six monetary columns at commit`: ele remove exclusivamente a nova migration de um schema próprio, comprova o commit e descarta esse schema.

## Implementação e arquivos

- `src/database/migrations/Migration202611060001.ts`: nova migration, adicionando `ck_wallet_all_finite`, `ck_wager_all_finite` e `ck_ledger_all_finite`. Cada CHECK exclui explicitamente NaN, Infinity e -Infinity das colunas monetárias da tabela. NULL continua permitido no snapshot opcional. DOWN remove somente esses três CHECKs.
- `src/database/config.ts`: registro ordenado das duas migrations.
- `test/integration/monetary-integrity.test.ts`: 31 testes PostgreSQL reais: inventário, reprodução legada, NaN por coluna, infinidades por coluna, UPDATE, valores finitos/limite, snapshots nulos, replay, reconciliação, UP/DOWN/UP e rejeição atômica de dados legados inválidos nas três tabelas.
- `test/integration/operational-metrics.test.ts`: somente atualização da guarda de inventário para exigir as duas classes exatas, em ordem.
- `test/integration/structured-logging.test.ts`: mesma atualização de guarda e do diagnóstico de inventário. Nenhuma mudança de comportamento de métricas/logs.
- `FIX-D01-EVIDENCE.md`: evidência e procedimento de rollback deste pacote.

Nenhuma alteração em Money, PendingReferenceWorker, retry, regras WIN/REFUND, SQS/Outbox, scripts ou harness compartilhado. Não havia alterações concorrentes no início; nenhuma alteração alheia foi sobrescrita.

Migration original preservada:

```text
Migration202611040001.ts
597fb0904a4575010b2a2d03e07e4bd046d7c80ae6346644fdd38fecc2d91aa9
```

Nova migration:

```text
Migration202611060001.ts
bcb5d7f02024ccf3903a75aa3347e33c330cd83372907f0e6bfe03a266395377
```

## GREEN e regressões executadas

| Comando | Resultado |
|---|---|
| `bun test test/integration/monetary-integrity.test.ts test/integration/schema.test.ts test/integration/financial.test.ts` | **64 pass, 0 fail; 329 asserções; 3 arquivos** |
| `bun run typecheck` | Aprovado (`tsc --noEmit`) |
| `bun test` | **1.236 pass, 0 fail; 8.140 asserções; 42 arquivos** |
| `git diff --check` | Sem diagnósticos |

A primeira execução intermediária GREEN teve quatro falhas de fixture: o teste usava `down({to: baseline})`, que inclui a própria baseline no rollback, e esperava CHECK para UPDATE de amount de wager, que já é proibido pelo trigger de identidade. Corrigidos os testes para selecionar exclusivamente a nova migration e preservar a rejeição anterior 55000. Os resultados finais acima foram executados depois dessas correções.

A regressão completa acima inclui as suítes existentes de concorrência/multiprocessamento, HTTP, referências pendentes, Inbox/Outbox, crash recovery, shutdown, logs e métricas. Nenhum teste foi removido, omitido ou enfraquecido.

Na conferência final apareceram alterações concorrentes, preservadas sem edição, em `test/integration/pending-reference-worker.test.ts` e `test/unit/pending-reference-worker.test.ts`: dois novos REDs D02 exigiam `action: 'failed'`, ainda ausente no tipo de produção. Um novo `bun run typecheck` falhou com TS2769 nessas duas asserções (linhas 220 e 222 naquele instante). Em seguida o trabalho concorrente também modificou `src/modules/wagering/application/pending-reference-worker.ts`, e o typecheck global voltou a passar, inclusive em uma nova execução após a regressão descrita a seguir. Nenhuma dessas três alterações foi feita ou sobrescrita pelo executor D01.

Depois da detecção, o recorte D01 + schema + financial foi novamente executado: **64 pass, 0 fail; 329 asserções**. Uma segunda execução conjunta retornou **1.238 pass, 0 fail; 8.179 asserções; 42 arquivos**. Porém, o hash conjunto de fontes/testes/scripts mudou durante essa execução, de `3e0da62fce36bf234e6b2b74a8d16bf93b640b26bb2e8d252cfbfe020f69f06d` para `0a3338600082fc72cefb1e9434543f057b1533aa83d24aa1c30a79fbec85a0ad`: o trabalho D02 continuava sendo editado. Não se apresenta esse resultado como homologação de um snapshot final estável D02; a validação global deve ser repetida quando esse trabalho estiver estabilizado. Os arquivos próprios D01 permaneceram inalterados durante ambas as regressões.

## Isolamento

Antes das integrações: PostgreSQL 16.6 (`server_version_num=160006`), banco/role `jungle_test`, destino local 5434; consulta de auditoria read-only; nenhum objeto em public ou schemas jungle_it residuais e nenhuma outra sessão cliente. Docker confirmou container de desenvolvimento separado na porta 5433 e LocalStack 4.10.0 na porta 4566. Bun 1.4.4 é o runtime do projeto.

Migrations UP/DOWN executadas somente pelo harness em schemas exclusivos `jungle_it_<uuid>` de jungle_test, removidos após cada cenário. Nenhuma migration em public ou jungle_dev. As integrações SQS da regressão usam os recursos temporários dos harnesses existentes.

Conferência após a regressão completa: `publicObjects=[]`, `leftoverSchemas=[]`, `otherSessions=[]`; somente as três filas SQS preexistentes permaneciam. A conferência da identidade foi somente leitura e a conexão/cliente foram fechados.

## Riscos residuais e rollback

O UP valida imediatamente dados existentes, sem NOT VALID e sem reparos. NaN legado em wallet, wager ou ledger causa falha e rollback da migration inteira; testes confirmam ausência de CHECKs parciais, ausência de registro de migration aplicada e preservação do histórico. Eventual corrupção precisa de tratamento financeiro explicitamente autorizado, fora deste pacote.

ALTER TABLE com validação exige locks e leitura das tabelas; custo/tempo em bases grandes não foi medido. Não houve aplicação em ambiente de desenvolvimento/produção. D02–D05 não são homologados por este pacote.

Para rollback em destino descartável, com o ORM já conectado ao schema próprio verificado:

```ts
await orm.getMigrator().down({ migrations: ['Migration202611060001'] });
// Conferir dados, ledger e reconciliação; somente os três CHECKs novos são removidos.
await orm.getMigrator().up();
```

Não usar `down({to: 'Migration202611040001'})`: essa seleção também reverte a migration inicial. O DOWN novo preserva tabelas e dados, mas reabre D01 até o UP seguinte. O cenário UP/DOWN/UP usa dados no limite monetário e verifica preservação do saldo, imutabilidade do ledger e reconciliação.

Não houve desvio arquitetural: a migration adicional reforça o schema conforme a autorização FIX-D01. A revisão independente e a autorização de consolidação posteriores estão registradas no adendo de estado acima.
