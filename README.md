# Distributed Wagering Processor

IMP-01 aprovado e publicado no commit b1b17ea6f5e1f4b841e8fd880463b948019e0651. **IMP-02 aprovado por Luís após revisão independente do Antigravity: APROVAR COM RECOMENDAÇÕES NÃO BLOQUEANTES.** Validação independente informada: PostgreSQL 16.6, 165 testes aprovados, zero falhas, 985 asserções, 17 arquivos, três processos Bun, TypeScript strict e bootstrap NestJS + MikroORM aprovados. Esses resultados externos não foram executados pelo Codex nesta sessão. Consulte IMP-02-EVIDENCE.md para proveniência, fechamento e encaminhamentos VAL02. IMP-03 não iniciado. A publicação depende do resultado efetivo do commit/push registrado no relatório de entrega.

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

As descrições acima dos limites locais referem-se à evidência do IMP-01. O IMP-02 acrescenta persistência, migration e casos de uso. As suítes PostgreSQL foram aprovadas externamente por Luís: schema 9 testes/24 asserções, financeiro 24/159 e multiprocessos 3/31, sem falhas. A restrição do sandbox explica a atribuição externa dessas evidências. Não existe consumidor SQS, publisher, worker operacional, autenticação ou API financeira.

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
