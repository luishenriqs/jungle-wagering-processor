# JUNGLE-IMP-02 — PostgreSQL, Persistência e Concorrência

## 1. Estado do pacote

**IMP-02 APROVADO. FECHAMENTO DOCUMENTAL E VERSIONAMENTO AUTORIZADOS POR LUÍS HENRIQUE PEREIRA. IMP-03 NÃO INICIADO.**

Parecer independente do Antigravity comunicado pelo responsável técnico: **APROVAR COM RECOMENDAÇÕES NÃO BLOQUEANTES**. Luís autorizou explicitamente o aceite, fechamento, commit e push. A criação do commit e publicação remota dependem da execução efetiva; este documento não presume sucesso de permissões ou rede.

### Aceite, revisão independente e proveniência

- **Antigravity, conforme comunicação de Luís:** 165 testes aprovados, 0 falhas, 985 asserções, 17 arquivos; TypeScript strict, PostgreSQL 16.6, três processos Bun independentes, bootstrap NestJS + MikroORM e diff-check aprovados. Revisão concluída com recomendações não bloqueantes. Logs integrais não foram executados ou produzidos pelo Codex nesta sessão.
- **Luís:** resultados externos das suítes detalhadas abaixo e autorização humana explícita de fechamento/versionamento.
- **Codex nesta sessão:** typecheck aprovado (exit 0); bun test executado com 129 aprovados, 3 falhas de preparação PostgreSQL por ECONNREFUSED 127.0.0.1:5434, 771 asserções, 17 arquivos descobertos. A regressão local não passou integralmente; conforme autorização, as evidências independentes sustentam o aceite das integrações. Nenhum reset/migration foi executado.
- **Codex, conferências documentais:** apenas ARCHITECTURE.md, README.md e este relatório editados; implementação aprovada preservada. Resultados finais de integridade/Git registrados no fechamento abaixo.

| Achado não bloqueante | Encaminhamento |
|---|---|
| VAL02-01 | IMP-04: teste de divergência real e tratamento de soma negativa em ReconcileWalletUseCase. Não implementado nesta tarefa |
| VAL02-02 | IMP-03: parametrizar TTL e backoff de PENDING_REFERENCE. Não implementado nesta tarefa |
| VAL02-03 | Resolvido nesta tarefa documental: ARCHITECTURE.md atualizado com validação real, aceite e histórico pertinente |

As seções 2–6 abaixo preservam o relato da preparação anterior à revisão; seus estados de revisão/aceite pendentes e inventário pré-versionamento são históricos e estão superados por este fechamento. Permanece o limite documental dos textos REV2 ausentes: foram registradas as garantias demonstradas e o aceite recebido, sem inventar correspondência por ID. As recomendações VAL02-01/02 não bloqueiam o aceite e não foram implementadas.

## 2. Consolidação final das evidências externas

**Origem de todos os resultados desta seção: Luís Henrique Pereira, responsável técnico.** Execução no Ubuntu, fora do sandbox do Codex, contra PostgreSQL 16.6 real em Docker Desktop. O contexto de runtime confirmado é Bun 1.4.4. Codex não executou esses testes nesta sessão documental, nem apresenta resultados externos como execução própria.

| Comando externo | Aprovados | Falhas | Asserções | Resultado informado |
|---|---:|---:|---:|---|
| bun test test/integration/schema.test.ts | 9 | 0 | 24 | Aprovado |
| bun test test/integration/financial.test.ts | 24 | 0 | 159 | Aprovado |
| bun test test/integration/multiprocess.test.ts | 3 | 0 | 31 | Aprovado |
| bun run typecheck | — | — | — | Aprovado |
| bun test | **165** | **0** | **985** | Aprovado, **17 arquivos de teste** |
| git diff --check | — | — | — | Aprovado |

As suítes de integração somam 36 testes e 214 asserções. Em conjunto com os 129 unitários/771 asserções da etapa anterior, as contagens são compatíveis com 165 testes/985 asserções. As execuções individuais já estão contidas na regressão completa e não devem ser somadas novamente a ela.

### Cobertura externa atestada

- Schema: migration UP/DOWN/UP, constraints financeiras, imutabilidade do ledger, integridade referencial, proteção de operações terminais e restrições de Inbox/Outbox.
- Financeiro: processamento de operações, disputa pela mesma Wallet, 50 requisições idênticas simultâneas, idempotência persistente, colisões entre Wallets, retry de SQLSTATE 40P01, rollback sob falhas injetadas, Inbox/redelivery, REFUND/ROLLBACK e paginação estável.
- Multiprocessos: três processos Bun independentes e três backend PIDs/conexões PostgreSQL distintos; Wallet compartilhada, referências/reversões concorrentes, independência entre Wallets, encerramento antes do commit e replay após commit/reinicialização.
- Reconciliação: os testes financeiros e multiprocessos contêm verificações de consistência entre saldo e ledger e fazem parte das suítes aprovadas informadas.

Não foram fornecidos nesta comunicação os números literais dos PIDs ou saídas integrais das execuções. Não foram inventados identificadores, horários, hashes de execução ou logs para completar o relato. A reprodução independente deve registrar esses detalhes quando disponíveis.

### Separação entre executor e responsável técnico

| Origem | Evidências |
|---|---|
| Codex, etapas anteriores | Typecheck; 129 unitários/771 asserções; 21 regressões de timestamps com parser real do driver sem rede; inspeção offline do runner/Knex da migration; bloqueios locais ECONNREFUSED/daemon negado |
| Luís, execução externa final | As três suítes PostgreSQL, regressão completa de 165 testes/985 asserções, typecheck e diff-check da tabela acima |
| Codex, esta sessão documental | Leitura e consolidação; inspeção de Git; comparação dos normativos; busca de credenciais em arquivos versionáveis; verificação de que somente os dois documentos autorizados foram alterados |

Os bloqueios locais descritos no histórico explicam por que o executor não executou PostgreSQL no sandbox; não constituem falha remanescente dos testes externos aprovados. Nesta sessão não foram repetidos testes, migrations ou comandos Docker.

## 3. Histórico consolidado das correções e fechamento funcional

| Ocorrência | Diagnóstico/correção | Evidência de fechamento |
|---|---|---|
| Migration: SQLSTATE 42601, posição 10216 | CASE sem parênteses na condição IF era encerrado no THEN interno pelo leitor PL/pgSQL; acrescentados apenas os dois parênteses. SQL integral preservado por MikroORM/Knex; delimitadores $$ e objetos SQL mantidos | Migration UP/DOWN/UP e suíte de schema final aprovadas externamente por Luís |
| Reidratação: A valid date is required | OID 1184 retorna string no driver usado por em.execute; created_at falhava antes de updated_at. Conversão explícita e validação na persistência, PostgresRow e cobertura de todos os timestamps usados pelos mapeadores; dateCopy/Wallet preservados | 21 regressões locais aprovadas; schema final 9/9 e regressão completa externa 165/165, conforme Luís |

O detalhamento das reproduções, correções mínimas e verificações locais foi preservado nas seções históricas abaixo. As antigas indicações de pendência PostgreSQL correspondem àquele momento e estão superadas pela evidência externa final, sem transformar tentativas bloqueadas em testes aprovados.

## 4. Resumo técnico para encaminhamento ao Antigravity

**Objeto da revisão:** IMP-02 funcionalmente validado, ainda sem aprovação independente ou humana final. Base Git main/b1b17ea6f5e1f4b841e8fd880463b948019e0651, com a implementação no working tree; nenhum commit deste pacote foi feito pelo executor.

### Componentes implementados

- PostgreSQL 16.6 em Compose, desenvolvimento persistente e teste separado; migration reversível com cinco tabelas, índices, constraints e triggers.
- MikroORM 6.6.8, adapter Nest 6.1.1, DatabaseModule, EntitySchemas separados do domínio, records, mappers e conversão estrita de NUMERIC/TIMESTAMPTZ.
- FinancialStore/FinancialUnitOfWork e seis casos de uso: CreateWallet, ProcessWagerTransaction, GetWallet, GetWagerTransaction, ListWalletLedger e ReconcileWallet.
- Hash canônico SHA-256, Inbox transacional e gravação de eventos Outbox. Não há consumidor SQS, publisher ou worker operacional.

### Contratos financeiros críticos

- Money usa strings e decimal exato, escala 2 e limites NUMERIC(18,2); nenhum cálculo monetário em number.
- UUIDs são internos; playerId e demais identificadores externos são TEXT. Os testes incluem player-test-01.
- Abertura positiva cria OPENING, ledger e dois eventos no mesmo commit, com versão 1. Zero não cria esses artefatos.
- Débito/crédito válido produz o ledger correspondente; LOSS e rejeições não movem saldo. Ledger e wagers terminais são protegidos contra mutação; triggers diferidos verificam consistência financeira no commit.
- REFUND/ROLLBACK exigem referência compatível e valor integral. Reversões cruzadas duplicadas são bloqueadas, inclusive pelo índice único parcial. Insuficiência de reversão tem código distinto de insuficiência de BET.
- Snapshots históricos preservam saldo observado e moeda, inclusive em rejeição CURRENCY_MISMATCH; datas são convertidas antes de rehydrate sem relaxar o domínio.

### Concorrência, idempotência e transações

- READ COMMITTED, FOR UPDATE por Wallet; ordem Wallet → Inbox, se presente → wager/referência. Não há lock global ou aquisição de outra Wallet para uma referência inválida.
- Um EntityManager limpo por tentativa e uma transação financeira que reúne Wallet, wager, ledger, Inbox e Outbox. Retry limitado de transientes ocorre fora da transação abortada.
- Identidade é consultada sem lock antes da Wallet e revalidada sob lock. Key reutilizada com outro walletId é conflito, mesmo se o destino não existir. Key nova para destino inexistente produz NotFoundError.
- Unicidades persistentes por key e provider/external ID; hash usa apenas os campos de negócio, com referência ausente null, excluindo key/metadados de transporte. Identidade ou payload divergentes conflitam; replay não repete saldo, ledger ou eventos financeiros.
- Inbox usa unicidade consumer/message, comparação de hash e confirmação no commit. Mensagem nova de operação já existente também recebe Inbox processada, sem duplicar efeitos.
- 23505 é classificado por constraint; só as duas unicidades de identidade de negócio seguem para comparação com vencedor após rollback completo. 40P01 e demais transientes têm retry limitado com fork novo.
- Consultas ao ledger usam cursor de timestamp/id, mantendo microsegundos no cursor. Reconciliação usa REPEATABLE READ e não corrige divergências silenciosamente.

### Foco solicitado para a revisão independente

Reexecutar as três suítes de integração e a regressão completa em PostgreSQL 16.6, verificando os resultados atestados (9/24/3 e 165 no total). Revisar ordem de aquisição de locks, colisões simultâneas de Inbox/identidade entre Wallets, descarte de contexto abortado, proteção SQL de reversões, snapshots e consistência após falhas. Registrar achados reproduzíveis com severidade, arquivo/linha, interleaving ou SQL, impacto e correção recomendada. Esta preparação não atribui um parecer ao Antigravity nem inicia sua revisão em nome dele.

## 5. Riscos residuais e limites da evidência final

1. **Revisão e aprovação pendentes:** testes aprovados não substituem análise adversarial. Não há parecer independente final deste pacote nem aprovação humana final registrada.
2. **Rastreabilidade REV2:** textos completos de REV2-01 a REV2-04 não estão disponíveis no checkout/conversa. Conferir os pareceres originais; não presumir resolução por IDs. ARC2 e VAL01 estão descritos no código/documentação existentes.
3. **Limite do typecheck:** skipLibCheck permanece como no IMP-01 aprovado; a compatibilidade interna dos .d.ts transitivos não foi comprovada. A regressão externa atesta o código na configuração atual.
4. **Limite do teste 40P01:** o teste usa trigger PostgreSQL que injeta esse SQLSTATE e sequência para contar tentativas. Comprova rollback/retry/esgotamento no banco, mas não demonstra um ciclo físico de deadlock entre sessões. Revisar essa cobertura sem confundir os dois tipos de evidência.
5. **Precisão/formato de datas:** domínio usa Date em milissegundos; cursor usa texto com seis casas. Revisar offsets, limites de formato suportado, nulidade e separação entre esses dois usos.
6. **Reprodutibilidade:** resultados externos são atestados por Luís; não foram anexados nesta conversa logs integrais, PIDs numéricos ou manifesto criptográfico do run. O revisor deve reproduzir contra o working tree preparado antes de aprovação/commit.
7. **Documentação histórica:** ARCHITECTURE.md contém indicações anteriores de bloqueio/contagens menores. Foi preservado por restrição desta tarefa. Para estado e evidências finais, prevalece a consolidação deste relatório, sem modificar decisões arquiteturais.
8. **Limite do pacote:** ACK/redelivery real SQS, DLQ, publisher, leases/fencing operacionais, PendingReferenceWorker e observabilidade/API completas pertencem aos próximos pacotes. Não foram implementados ou aprovados por estes resultados.

Nenhum novo defeito financeiro foi comprovado nesta etapa documental. Os pontos acima são limites conhecidos ou alvos de revisão, não uma declaração de ausência de defeitos. Se a revisão identificar bloqueios, sua correção exige autorização no escopo correspondente. Não foi implementada correção adicional nesta sessão.

## 6. Conferências documentais e de Git desta consolidação

Foram alterados exclusivamente IMP-02-EVIDENCE.md e README.md. Código, testes, migrations, dependências, lockfile, Docker, .env, ARCHITECTURE.md e demais documentos permaneceram com os mesmos bytes do início da sessão, conforme comparação de hashes locais antes/depois. A comparação não atribui os resultados externos a um hash de execução que não foi fornecido.

Verificações próprias desta sessão:

- git diff --check: aprovado após as alterações documentais.
- AGENTS.md, technical-challenge.md e Jungle-Architecture-v0.2.md: sem diff contra HEAD e sem alteração nesta sessão.
- Índice Git vazio de alterações staged; nenhum arquivo foi adicionado ao índice.
- .env ignorado e fora do índice, modo 0600; conteúdo preservado, sem exibição de senhas.
- Conferência dos 78 arquivos rastreados/não rastreados não ignorados: nenhuma chave privada, token reconhecido, URL PostgreSQL autenticada real ou atribuição literal de credencial detectada. Placeholders documentais e referências a variáveis de ambiente não são credenciais. A busca é uma conferência automatizada com inspeção de contexto, não garantia formal contra todo formato de segredo possível.
- Git permanece em main, no commit-base; seis arquivos rastreados modificados e 32 novos não rastreados, da implementação ainda não commitada. O estado completo está no encerramento deste documento.

**Gates restantes:** revisão crítica independente do Antigravity → resolução de eventuais achados bloqueantes → aprovação explícita de Luís. Nenhum avanço automático para IMP-03, commit ou push foi executado ou autorizado por esta consolidação.

## Histórico de implementação e validações anteriores

As seções seguintes preservam a cronologia, os bloqueios locais e os resultados disponíveis em cada etapa. Expressões como "pendente", "não executado" e "não concluído" nessas seções são históricas; o estado atual é o consolidado acima.

## Correção da reidratação — TIMESTAMPTZ na fronteira de persistência

### Evidência externa recebida

Luís executou `bun test test/integration/schema.test.ts` fora do sandbox e informou:

- Migration UP/DOWN/UP: **aprovada**.
- Nove testes de schema executados: **cinco aprovados e quatro falhas**.
- As quatro falhas apresentaram `InvalidDomainInputError: A valid date is required`, com stack em dateCopy, construtor/rehydrate de Wallet e PostgresFinancialStore.getWallet.

Esses resultados são informação do responsável técnico, não execução própria do agente. Superam a pendência anterior de confirmação da sintaxe da migration, mas não aprovam a suíte inteira nem os cenários de concorrência.

### Causa-raiz comprovada

O primeiro campo rejeitado é **wallets.created_at**, transferido por walletDomain para WalletState.createdAt. Ele chega como **string**, enquanto dateCopy aceita somente uma instância Date finita. wallets.updated_at sofre a mesma incompatibilidade, mas o construtor processa createdAt primeiro.

No MikroORM PostgreSQL 6.6.8 instalado, PostgreSqlConnection.getConnectionOptions registra `setTypeParser(oid, str => str)` para OID 1184 (TIMESTAMPTZ). A configuração efetiva do cliente Knex foi instanciada com connect:false e o parser real foi chamado: typeof retornou string e instanceof Date retornou false. Não foi uma consulta ao servidor ou mock do driver.

As consultas de PostgresFinancialStore usam SqlEntityManager.execute, cujo caminho devolve os valores brutos de rows sem hidratação EntitySchema. Declarar `execute<WalletRecord[]>` e `created_at: Date` apenas afirmava um tipo TypeScript incorreto; não fazia conversão em runtime. Os EntitySchemas já descreviam Date/timestamptz corretamente e não precisaram mudar. Os mapeadores anteriores apenas repassavam os valores brutos ao domínio.

### Correção aplicada

- `records.ts`: PostgresRow<T> representa datas brutas como Date | string, preservando null em campos anuláveis. Records normalizados de escrita/EntitySchemas continuam usando Date.
- `postgres-financial-store.ts`: tipos dos resultados SELECT e INSERT RETURNING passam a descrever PostgresRow, sem alterar SQL, locks ou transações.
- `timestamps.ts`: conversão explícita na persistência, com timezone obrigatório em strings, validação de calendário/valor finito, cópia defensiva de Date válido e erros que identificam a coluna sem imprimir seu conteúdo. Números, string vazia, datas inválidas e NULL obrigatório são rejeitados; somente NULL em coluna anulável vira ausência no domínio.
- `mappers.ts`: normaliza todas as datas utilizadas antes de chamar rehydrate.
- `database-timestamps.test.ts`: regressões com o parser real configurado pelo MikroORM e testes de formatos/timezones, nulidade, cópias defensivas e dados corrompidos.

Campos auditados e convertidos:

| Tabela | Campos usados pelos mapeadores de domínio |
|---|---|
| wallets | created_at, updated_at |
| wager_transactions | created_at, processed_at, next_retry_at, expires_at |
| wallet_ledger_entries | created_at |
| inbox_messages | received_at, processed_at |
| outbox_messages | occurred_at, next_attempt_at, published_at |

lease_until da Outbox também é TIMESTAMPTZ e seu tipo bruto está coberto por PostgresRow. Não integra o modelo OutboxMessage atual nem é lido pelo mapper de domínio; o protocolo operacional de lease continua no IMP-03. Nenhum campo de lease foi acrescentado ao domínio nesta correção.

A conversão para Date respeita a precisão de milissegundos do contrato existente. O texto separado cursor_time do ledger permanece intacto, com seis casas, para não perder precisão na paginação. Não houve alteração de Money, aritmética, schema, migration, contratos públicos do domínio, dateCopy ou Wallet.rehydrate.

### Testes e verificações realmente executados

| Verificação | Resultado |
|---|---|
| Parser real de TIMESTAMPTZ, sem conexão | string; não é Date |
| Nova regressão antes da correção dos mapeadores | Exit 1: 2 pass, 19 fail; primeiro teste reproduziu o stack original em dateCopy → Wallet → rehydrate |
| Nova regressão após correção | Exit 0: **21 pass, 0 fail, 356 expect calls** |
| Primeiro typecheck dos novos testes | Exit 2: array de valores inválidos não aceitava null na inferência; corrigido para unknown[] na matriz de teste |
| bun run typecheck final | Exit 0 |
| bun test test/unit final | Exit 0: **129 pass, 0 fail, 771 expect calls, 14 arquivos** |
| git diff --check | Exit 0 |
| bun test test/integration/schema.test.ts no sandbox | Exit 1: 0 pass, 1 fail; ECONNREFUSED 127.0.0.1:5434 no beforeAll |
| Diff de documentos normativos, dateCopy e Wallet contra HEAD | Sem alterações |

As 21 regressões locais não substituem execução PostgreSQL: testam o parser instalado e a fronteira de reidratação sem rede. Nesta etapa o servidor não foi alcançado e não se declara que as quatro falhas externas já passaram no banco.

Arquivos alterados nesta correção: src/database/records.ts, src/database/postgres-financial-store.ts, src/database/mappers.ts, src/database/timestamps.ts, test/unit/database-timestamps.test.ts e este relatório. As demais modificações no working tree são das etapas anteriores e foram preservadas.

### Validação externa necessária

```sh
cd /home/luishenriqs/projects/Jungle
export PATH="$HOME/.bun/bin:$PATH"
bun run typecheck
bun test test/unit
bun test test/integration/schema.test.ts
```

As URLs permanecem no .env local ignorado, sem divulgação de credenciais. O teste usa apenas schema novo e descartável em jungle_test; não é necessário reset do desenvolvimento. Após a suíte de schema passar, retomar financial.test.ts e multiprocess.test.ts para o aceite do IMP-02. Não houve commit, push ou avanço ao IMP-03.

## Correção exclusiva da migration inicial — SQLSTATE 42601

### Evidência externa e diagnóstico

Luís informou execução externa de `bun test test/integration/schema.test.ts` com PostgreSQL acessível, mas falha da Migration202611040001: SQLSTATE 42601, syntax error at end of input, position 10216. Esse resultado é atribuído ao responsável; não foi reproduzido no servidor pelo agente.

A inspeção integral de UP_SQL/DOWN_SQL localizou a condição de protect_wallet_identity_version na linha 180 do arquivo da migration (linha 178 de UP_SQL). No SQL anterior à correção, position 10216 aponta para o espaço imediatamente anterior ao THEN interno do CASE; esse THEN começa na posição 10217. A expressão começava assim:

```sql
IF NEW.version <> OLD.version + CASE WHEN NEW.balance IS DISTINCT FROM OLD.balance THEN 1 ELSE 0 END THEN
```

A causa é a leitura da condição IF pelo parser PL/pgSQL do PostgreSQL 16.6: `expr_until_then` lê a expressão até THEN e `read_sql_construct` encerra nesse token quando o nível de parênteses é zero. Sem parênteses envolvendo CASE, o THEN interno encerra prematuramente a condição; o parser SQL recebe uma expressão CASE incompleta e acusa fim de entrada. A posição informada coincide exatamente com esse ponto no SQL original. Referência primária: [parser PostgreSQL REL_16_6, expr_until_then e read_sql_construct](https://github.com/postgres/postgres/blob/REL_16_6/src/pl/plpgsql/src/pl_gram.y#L2280).

O caminho instalado foi inspecionado e exercitado sem conexão: Migration.addSql mantém a string na fila; MigrationRunner.getQueries conserva UP_SQL inteiro e run envia cada item ao driver na transação. O split por nova linha do runner se aplica somente ao SQL auxiliar de início/fim do schema, não a UP_SQL. Platform.formatQuery com parâmetros vazios e Knex raw/toSQL/toNative conservaram o SQL integral, com zero bindings. Não há evidência de fragmentação da função ou alteração do delimitador $$ nesse caminho.

### Correção mínima aplicada

```sql
IF NEW.version <> OLD.version + (CASE WHEN NEW.balance IS DISTINCT FROM OLD.balance THEN 1 ELSE 0 END) THEN
```

Foram inseridos somente dois caracteres em UP_SQL: um par de parênteses. Isso mantém o THEN do CASE dentro do nível parentizado, reservando o THEN externo para o IF. O cálculo de versão permanece igual. Nenhum objeto, constraint, índice, trigger, nome, delimitador $$, comando DOWN_SQL, mecanismo transacional ou isolamento de testes foi alterado.

Arquivos alterados nesta correção: `src/database/migrations/Migration202611040001.ts` e `IMP-02-EVIDENCE.md`. Demais modificações do working tree pertencem às etapas anteriores e foram preservadas. Não foram alterados testes ou dependências.

### Verificações executadas após a correção

| Verificação | Resultado efetivamente observado |
|---|---|
| Fila real MigrationRunner/driver/Knex, sem executar SQL | Um payload UP_SQL integral; platformPreservesSql=true; knexPreservesSql=true; bindings=0 |
| Comparação integral do UP_SQL corrigido com cópia anterior | Exatamente a substituição da expressão acima; diferença de dois caracteres; todo o restante idêntico |
| bun run typecheck | Exit 0 |
| bun test test/unit | Exit 0: **108 pass, 0 fail, 415 expect calls, 13 arquivos** |
| git diff --check | Exit 0 |
| bun test test/integration/schema.test.ts | Exit 1: **0 pass, 1 fail**, ECONNREFUSED 127.0.0.1:5434 no beforeAll |
| Diff dos documentos normativos contra HEAD | Sem alterações em AGENTS.md, technical-challenge.md e Jungle-Architecture-v0.2.md |

O teste PostgreSQL não chegou a executar a migration nesta sessão. A causa foi identificada pela posição e pela implementação dos parsers/runner; a execução bem-sucedida da migration corrigida ainda não foi comprovada. Não houve reset, migration ou operação destrutiva no banco de desenvolvimento.

### Validação externa necessária

Com TEST_DATABASE_URL já configurada no .env local ignorado:

```sh
cd /home/luishenriqs/projects/Jungle
export PATH="$HOME/.bun/bin:$PATH"
bun run typecheck
bun test test/unit
bun test test/integration/schema.test.ts
git diff --check
```

O harness cria um schema jungle_it_<uuid> novo no banco jungle_test e nele executa migrations up/down/up e testes de constraints/triggers. Não é necessário reset manual, bun run db:rollback no desenvolvimento ou docker compose down -v. Solicita-se registrar a saída sanitizada e o código de retorno dessa execução externa antes de afirmar aprovação da migration. O IMP-02 permanece pendente; nenhum commit/push ou avanço ao IMP-03 foi executado.

## Retomada após inicialização externa da infraestrutura

### Evidência informada por Luís, não executada pelo agente

O responsável confirmou instalação com bun install, typecheck externo aprovado e PostgreSQL 16.6 no Docker Desktop. Informou os containers jungle-postgres-1 (127.0.0.1:5433) e jungle-postgres-test-1 (127.0.0.1:5434) healthy e aprovados em pg_isready. O agente não conseguiu consultar esses containers pelo daemon e não apresenta os estados informados como inspeção própria.

### Configuração local verificada pelo agente

Compose e databaseConfig foram inspecionados. A configuração correta é:

| Variável | Host | Porta | Banco | Usuário |
|---|---|---|---|---|
| DATABASE_URL | 127.0.0.1 | 5433 | jungle_dev | jungle (default do Compose) |
| TEST_DATABASE_URL | 127.0.0.1 | 5434 | jungle_test | jungle_test |

As senhas existentes em .env foram preservadas. As duas URLs foram acrescentadas ao mesmo arquivo local, ignorado por .gitignore, com credenciais codificadas na URI. O arquivo está em modo 0600. Foi conferido, sem imprimir valores, que as senhas das URLs após decodificação correspondem às variáveis locais de origem. Não há credenciais neste relatório. Bun carrega .env automaticamente; não é necessário executar source nem imprimir o arquivo.

### Resultados realmente executados nesta retomada

| Verificação | Resultado |
|---|---|
| Inspeção dos quatro manifests instalados | core/postgresql/migrations 6.6.8; nestjs 6.1.1 |
| bun install --offline --frozen-lockfile | Exit 0: Checked 216 installs across 215 packages (no changes) |
| bun run typecheck | Exit 0: tsc --noEmit sem diagnósticos |
| bun test test/unit | Exit 0: **108 pass, 0 fail, 415 expect calls, 13 arquivos** |
| Inicialização MikroORM connect:false | Exit 0: descobriu InboxRecord, LedgerRecord, OutboxRecord, WagerRecord e WalletRecord; não abriu conexão PostgreSQL |
| docker --version | Docker 29.1.3, build f52814d |
| docker compose version | v2.40.3-desktop.1 |
| docker ps com formato sem dados de configuração | Exit 1: permission denied no socket /var/run/docker.sock |
| Conexão MikroORM a TEST_DATABASE_URL | Exit 1: ECONNREFUSED; nenhuma consulta SQL executada |
| bun test test/integration | Exit 1: **0 pass, 3 fail**, falha no beforeAll de cada arquivo ao conectar a 127.0.0.1:5434 |
| git check-ignore .env | Confirma .env ignorado |
| stat de .env | Modo 600 |
| git diff --check | Exit 0 |
| Diff dos três documentos normativos e IMP-01-EVIDENCE.md contra HEAD | Exit 0, documentos preservados |

As suítes agora carregam corretamente, mas não alcançam o PostgreSQL. **Nenhuma migration, constraint, trigger, operação financeira, teste de atomicidade ou processo financeiro auxiliar foi executado nesta retomada.** O arquivo multiprocess.test.ts falhou na preparação da conexão, antes de iniciar os três processos. Os três erros de preparação não equivalem a três cenários de negócio executados. Não se atribui a recusa TCP a um defeito comprovado do serviço externo: o fato observado é que o endpoint não é acessível desta sessão.

Os comandos com possibilidade de saída de configuração foram executados com captura e redação de URLs e senhas antes de exibir resultados. Nenhum Docker inspect/config completo, arquivo de credenciais ou URL autenticada foi impresso. Não se tentou contornar o socket negado ou a restrição de rede.

### Comandos exatos para execução externa no Ubuntu

O .env local já contém as URLs. Estes comandos usam migrations apenas nos schemas novos e isolados de jungle_test criados pelo harness; não executam down no desenvolvimento.

```sh
cd /home/luishenriqs/projects/Jungle
export PATH="$HOME/.bun/bin:$PATH"
bun run typecheck
bun test test/integration/schema.test.ts
bun test test/integration/financial.test.ts
bun test test/integration/multiprocess.test.ts
bun test
git diff --check
```

Executar na ordem e informar saída sanitizada e código de retorno. O primeiro arquivo cobre migration up/down/up, índices, constraints e triggers no schema descartável; o segundo cobre transações/atomicidade/idempotência; o terceiro cobre três processos reais, isolamento entre Wallets e reinício. A execução completa continua necessária após correções. Não executar bun run db:rollback no banco de desenvolvimento nem docker compose down -v.

### Etapas

| Etapa | Estado real |
|---|---|
| IMP-02.1 — domínio/hash | Implementado e validado; 105 unitários/402 asserções e typecheck passaram nessa etapa |
| IMP-02.2 — Compose/MikroORM/migration | Dependências instaladas, metadados e typecheck aprovados; validação SQL bloqueada por conexão |
| IMP-02.3 — mappers/repositório/casos de uso | Fontes preparadas; roundtrips puros de mapper passaram, execução SQL não comprovada |
| IMP-02.4 — concorrência/multi-processo | Harness e cenários preparados; não executados com PostgreSQL |

## 2. Ambiente e estado inicial — histórico anterior à retomada

- Diretório: `/home/luishenriqs/projects/Jungle`.
- Branch: main, preservada.
- Commit-base confirmado: b1b17ea6f5e1f4b841e8fd880463b948019e0651.
- Working tree inicialmente limpa.
- Bun: 1.4.4, usando PATH local `/home/luishenriqs/.bun/bin` por comando, sem modificar configuração global.
- Docker/Compose/info/ps: o executável acessível retorna que Docker não está disponível nesta distro WSL e orienta habilitar a integração Docker Desktop. Não foi possível consultar daemon ou containers.
- `/var/run/docker.sock` não existe.
- `CODEX_SANDBOX_NETWORK_DISABLED=1`.
- DATABASE_URL e TEST_DATABASE_URL não estavam configuradas na verificação inicial. Credenciais não foram registradas.
- Foram lidos AGENTS.md, technical-challenge.md, Jungle-Architecture-v0.2.md, ARCHITECTURE.md e IMP-01-EVIDENCE.md.

## 3. Dependências

Declaradas no package.json:

- @mikro-orm/core 6.6.8.
- @mikro-orm/postgresql 6.6.8.
- @mikro-orm/migrations 6.6.8.
- @mikro-orm/nestjs 6.1.1.

O adapter Nest tem versão independente dos outros três pacotes; seu manifesto oficial admite MikroORM 6 e NestJS 11. pg é fornecido transitivamente pelo driver PostgreSQL. Não foram introduzidos ORM alternativo, Redis ou bibliotecas de teste adicionais.

A instalação inicial `bun install --cache-dir /tmp/jungle-imp02-bun-cache` falhou com DNSResolveFailed. Posteriormente Luís instalou as dependências externamente. A retomada confirmou suas versões, lockfile e frozen install, conforme tabela acima.

**bun.lock foi atualizado pela instalação externa e validado por frozen install sem alterações.** Não foi fabricado ou editado manualmente. Nenhum tipo ou dependência foi substituído por stub.

## 4. Histórico de comandos antes da instalação externa MikroORM

| Comando | Resultado |
|---|---|
| pwd / git status --short / git branch --show-current / git rev-parse HEAD | Diretório, main e commit-base confirmados; início limpo |
| bun --version | 1.4.4 |
| docker --version / docker compose version / docker info / docker ps -a | Falharam: integração WSL/Docker indisponível |
| ls -l /var/run/docker.sock | Socket inexistente |
| bun install --cache-dir /tmp/jungle-imp02-bun-cache | Exit 1: DNSResolveFailed, quatro dependências MikroORM não resolvidas |
| bun test test/unit, depois de domínio/hash | Exit 0: 105 pass, 0 fail, 402 expect calls, 12 arquivos |
| bun run typecheck, antes de adicionar imports MikroORM | Exit 0; corresponde somente à etapa IMP-02.1 |
| bun test test/unit, após mappers e correção de snapshot de moeda | Exit 0: **108 pass, 0 fail, 415 expect calls, 13 arquivos** |
| Transpilação sintática por Bun.Transpiler | 63 arquivos TypeScript transpilados; não equivale a typecheck |
| bun run typecheck, estado completo atual | Exit 2: módulos MikroORM ausentes, com erros derivados de tipos não resolvidos |
| bun test test/integration | Exit 1: 0 pass, 3 fail, 3 errors; os três arquivos não carregaram por falta de @mikro-orm/postgresql |
| bun test, estado completo atual | Exit 1: **108 pass, 3 fail, 3 errors, 415 expect calls**, 16 arquivos |
| bun run check:bootstrap, estado atual | Script exit 1: @mikro-orm/nestjs ausente no DatabaseModule |
| git diff --check | Exit 0, sem erros de whitespace |
| git diff --exit-code HEAD -- AGENTS.md technical-challenge.md Jungle-Architecture-v0.2.md IMP-01-EVIDENCE.md | Exit 0; documentos normativos e evidência anterior preservados |

As três falhas da suíte completa são erros de carregamento de arquivos de integração, não cenários financeiros executados com resultado negativo. O Bun informa 111 testes nesse resultado por contabilizar esses erros de arquivo; isso não representa execução dos casos de integração neles definidos.

Na execução histórica o typecheck falhava por ausência dos módulos e diagnósticos derivados. **O typecheck da retomada atual passou**, como registrado acima, sem alterações adicionais de código de produção ou testes.

## 5. Arquivos e decisões

Arquivos existentes modificados:

- package.json: dependências MikroORM e scripts de migration/integração.
- src/app.module.ts: composição condicional DatabaseModule quando DATABASE_URL estiver presente.
- src/modules/wagering/domain/wager-transaction.ts: VAL01-01/02, snapshot correto de rejeição por moeda e saldo opcional em fail para persistência auditável.
- ARCHITECTURE.md: decisões efetivamente escritas, aprovação histórica do IMP-01 e pendências de rastreabilidade.
- README.md: setup PostgreSQL, ambiente, comandos e limites atuais.

Arquivos novos por grupo:

- docker-compose.yml: PostgreSQL 16.6, healthchecks, volume Jungle de desenvolvimento e serviço separado de teste em tmpfs.
- scripts/migrate.ts: migrations programáticas; down protegido por autorização explícita de schema descartável.
- src/database: configuração, EntitySchemas, records, tipo decimal string, mappers, implementação FinancialStore/UoW, DatabaseModule e migration inicial reversível.
- src/shared/application: portas de persistência, identificadores internos, classificação de erros e execução/retry/checkpoints internos.
- src/modules/wallets/application: CreateWallet/GetWallet/ListWalletLedger/ReconcileWallet.
- src/modules/wagering/application: ProcessWagerTransaction/GetWagerTransaction/hash canônico.
- test/unit: ajustes de domínio, canonicalização e roundtrips puros de mappers.
- test/integration: testes financeiros/atomicidade, schema/migrations e multi-processo.
- test/support: conexão isolada PostgreSQL e protocolo de processos Bun de teste.
- Este relatório.

### Decisões relevantes

1. UUIDs internos são gerados pela aplicação; player_id e demais identificadores externos são TEXT. Não há validação UUID para playerId.
2. EntitySchemas não decoram nem reconstroem o domínio por transições; mappers usam rehydrate. NUMERIC nunca é convertido para number.
3. READ COMMITTED e Wallet → Inbox → wager/referência, com SQL explícito no EntityManager transacional. Sem flush implícito de objetos de domínio, lock global ou segunda Wallet durante referência inválida.
4. Identidade é consultada sem lock antes da Wallet e revalidada depois do lock. Chave já usada com outro walletId conflita mesmo para destino inexistente; uma key nova para Wallet inexistente produz NotFoundError.
5. Snapshot contém sua própria moeda. Rejeição por CURRENCY_MISMATCH guarda money original e saldo real da Wallet, sem falsificar o payload.
6. Triggers diferidos foram preparados para recusar divergência saldo/ledger e ledger incompatível com wager. Ainda não há evidência SQL de que funcionam corretamente.
7. Inbox só é confirmada no commit financeiro; replay com novo messageId também persiste Inbox, sem novo evento financeiro. Claims/leases de publicação estão somente no schema, sem publisher.
8. Reconciliação usa REPEATABLE READ; paginação preserva microsegundos no cursor (created_at,id).

## 6. Concorrência — testes preparados, NÃO comprovados

- Duas BET de 80 sobre saldo 100: esperado um débito, uma rejeição, saldo 20 e versão 2.
- Cinquenta requisições idênticas no mesmo processo e em três processos: esperado um original e 49 replays com mesmo snapshot.
- Chave compartilhada por Wallets distintas: barreira força duas tentativas antes de inserir wager, exercitando colisão de unicidade e rollback do perdedor.
- Mesma mensagem Inbox em Wallets diferentes: somente um payload pode produzir efeito; hash divergente conflita sem adquirir outra Wallet.
- REFUND/ROLLBACK e WINs referenciados concorrentes em três processos.
- Wallets distintas em três processos; uma Wallet progride enquanto outra está bloqueada.
- Registro de PIDs Bun e pg_backend_pid para comprovar processos e conexões distintos quando o teste for executado.

Não existe saída real de PIDs, transações concorrentes ou saldo final de PostgreSQL nesta entrega. Esses campos não foram preenchidos com valores esperados ou inventados.

## 7. Atomicidade e recuperação — testes preparados, NÃO comprovados

- Checkpoints internos lançam falha após Wallet, wager, ledger, outbox, Inbox e imediatamente antes do commit; consultas independentes devem comprovar rollback dos cinco conjuntos de dados.
- Criação positiva tem testes de falha que devem deixar nenhum artefato de abertura.
- Trigger PostgreSQL de teste injeta SQLSTATE 40P01 e usa sequência não transacional para verificar exatamente três tentativas, tanto com recuperação quanto com esgotamento. Isso testa o protocolo de abort/retry, não representa um deadlock físico já observado.
- Processo de teste termina antes do commit: esperado rollback. Outro termina depois do commit e antes de responder: reenvio em processo novo deve retornar replay.
- Todos os cenários financeiros exigem reconciliação. Não há teste de ACK SQS, redrive ou publisher no IMP-02.

## 8. Bloqueios e riscos remanescentes

- Instalação MikroORM e atualização do lockfile resolvidas e verificadas; não são mais bloqueios.
- Docker CLI/Compose disponíveis, mas acesso ao daemon negado no sandbox; containers não puderam ser inspecionados pelo agente.
- Conexão PostgreSQL testada e recusada nesta sessão (ECONNREFUSED); integração ainda sem execução de cenários. Não se tentou contornar permissões, instalar PostgreSQL alternativo ou substituir a stack.
- Schema/migrations podem revelar defeitos que somente a execução real identificará. Os critérios de aceite continuam bloqueados até sua correção.
- Typecheck e descoberta de metadados MikroORM aprovados; compatibilidade com operações reais de banco e bootstrap configurado ainda depende da liberação do acesso.
- skipLibCheck continua no estado aprovado do IMP-01, com limitação de checagem interna das declarações das dependências.
- REV2-01 a REV2-04 não constam no checkout nem foram detalhados nesta conversa. Seu texto foi solicitado. Não foi inventado mapeamento dos achados; ARCHITECTURE.md registra os quatro como pendentes de conferência.

## 9. Preparação externa anterior — histórico

As instruções abaixo foram fornecidas na execução anterior. Luís confirmou que dependências e containers foram preparados. Para a validação restante, usar os comandos da seção de retomada no início deste documento.

```sh
export PATH="$HOME/.bun/bin:$PATH"
bun install
bun install --frozen-lockfile
docker --version
docker compose version
docker info
docker ps -a
```

Configurar JUNGLE_DB_PASSWORD e JUNGLE_TEST_DB_PASSWORD localmente, sem versionar. Depois:

```sh
docker compose --profile test up -d --wait postgres postgres-test
# Configurar TEST_DATABASE_URL para jungle_test e DATABASE_URL para jungle_dev.
bun run typecheck
bun run test:unit
bun run test:integration
bun test
bun run check:bootstrap
git diff --check
git status
git diff --stat
```

O banco de desenvolvimento pode receber `bun run db:migrate` quando configurado e autorizado pelo responsável; os testes executam up/down/up somente em seus schemas novos e isolados no banco jungle_test. Não usar docker compose down -v e não remover volumes existentes.

Após liberar as dependências/ambiente, o executor deve retomar validação e correções. Resultados externos informados por Luís deverão ser atribuídos explicitamente a essa origem, separados de execuções próprias. Até lá, não há aceite, revisão final concluída ou avanço para IMP-03.

## 10. Git

Main permanece no commit-base b1b17ea6f5e1f4b841e8fd880463b948019e0651. Há seis arquivos rastreados modificados (incluindo bun.lock atualizado externamente) e 32 arquivos novos não rastreados, incluindo o helper/regressão de timestamps desta correção. `git diff --stat` resume somente os arquivos rastreados; os novos constam em git status/inventário. `git diff --check` passou. AGENTS.md, technical-challenge.md, Jungle-Architecture-v0.2.md e IMP-01-EVIDENCE.md permanecem idênticos ao HEAD. .env está ignorado, não deve ser adicionado ao índice e não integra o inventário versionável.

Nenhum arquivo foi adicionado ao índice e nenhum commit ou push foi executado.

## Estado Git completo na consolidação final

Inventário de todas as alterações do IMP-02, incluindo as anteriores a esta sessão. Nesta consolidação foram editados somente README.md e IMP-02-EVIDENCE.md. Branch main, HEAD b1b17ea6f5e1f4b841e8fd880463b948019e0651; índice sem alterações staged.

```text
 M ARCHITECTURE.md
 M README.md
 M bun.lock
 M package.json
 M src/app.module.ts
 M src/modules/wagering/domain/wager-transaction.ts
?? IMP-02-EVIDENCE.md
?? docker-compose.yml
?? scripts/migrate.ts
?? src/database/config.ts
?? src/database/database.module.ts
?? src/database/entities.ts
?? src/database/exact-numeric-type.ts
?? src/database/mappers.ts
?? src/database/migrations/Migration202611040001.ts
?? src/database/postgres-financial-store.ts
?? src/database/postgres-unit-of-work.ts
?? src/database/records.ts
?? src/database/timestamps.ts
?? src/modules/wagering/application/get-wager-transaction.use-case.ts
?? src/modules/wagering/application/process-wager-transaction.use-case.ts
?? src/modules/wagering/application/wager-payload.ts
?? src/modules/wallets/application/create-wallet.use-case.ts
?? src/modules/wallets/application/wallet-queries.ts
?? src/shared/application/application-errors.ts
?? src/shared/application/execution.ts
?? src/shared/application/financial-store.ts
?? src/shared/application/identifiers.ts
?? test/integration/financial.test.ts
?? test/integration/multiprocess.test.ts
?? test/integration/schema.test.ts
?? test/support/postgres.ts
?? test/support/process-client.ts
?? test/support/process-worker.ts
?? test/unit/database-timestamps.test.ts
?? test/unit/imp02-domain.test.ts
?? test/unit/persistence-mappers.test.ts
?? test/unit/wager-payload.test.ts
```

Estado final: **implementado e validado funcionalmente; aguardando revisão crítica independente e aprovação humana**. Nenhum commit, push ou avanço para IMP-03 foi executado.

## Fechamento autorizado — verificações finais

Nesta tarefa foram editados somente ARCHITECTURE.md, IMP-02-EVIDENCE.md e README.md. Normativos e IMP-01-EVIDENCE.md preservados; código, testes, migration, Compose e dependências mantidos como aprovados. Typecheck local aprovado; integração local indisponível conforme resultado acima. O resultado final de Git, incluindo eventual bloqueio de commit/push, deve ser lido no relatório de entrega. Nenhum avanço ao IMP-03.

Conferências de fechamento executadas pelo Codex: git diff --check aprovado; AGENTS.md, technical-challenge.md, Jungle-Architecture-v0.2.md e IMP-01-EVIDENCE.md idênticos ao HEAD; comparação de hashes confirmou somente os três documentos autorizados editados nesta tarefa. Busca nos 78 arquivos versionáveis sem credenciais detectadas; .env ignorado e preservado; nenhum arquivo temporário novo no inventário. Implementação anterior do IMP-02 preservada para inclusão explícita no índice.

### Resultado efetivo do versionamento nesta sessão

A inclusão explícita dos 38 arquivos aprovados foi tentada com git add, mas terminou com exit 128: `Unable to create .git/index.lock: Read-only file system`. O sandbox mantém .git somente para leitura. Nenhum arquivo foi staged, nenhum commit foi criado e o push não foi tentado; não houve tentativa de contornar a restrição. **IMP-02 aprovado; versionamento local e publicação remota pendentes de execução externa autorizada.** HEAD permanece b1b17ea6f5e1f4b841e8fd880463b948019e0651; working tree contém as alterações aprovadas. IMP-03 não iniciado.
