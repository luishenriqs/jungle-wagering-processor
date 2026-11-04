# Distributed Wagering Processor

JUNGLE-IMP-01 — Fundação e Domínio. Pronto para revisão independente: typecheck e 93 testes unitários aprovados pelo executor; bootstrap HTTP aprovado fora do sandbox, com HTTP 404 esperado e exit code 0, conforme evidência fornecida por Luís Henrique Pereira. Permanecem a revisão do Antigravity, a resolução de eventuais bloqueios e a aprovação final de Luís. Não há autorização para avançar ao IMP-02.

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

## Limites do pacote

Os testes financeiros são sequenciais e locais ao domínio. Não demonstram idempotência persistente, atomicidade SQL, concorrência distribuída, recuperação de crash ou entrega de eventos. Não há banco, ORM operacional, migrations, consumidor SQS, publisher, workers ou autenticação.

O domínio não publica eventos: fornece envelopes e modelos para persistência posterior. Os artefatos de abertura e movimentos deverão ser gravados atomicamente pelos casos de uso dos próximos pacotes.

Consulte `ARCHITECTURE.md` para contratos e decisões, e `IMP-01-EVIDENCE.md` para resultados realmente executados e bloqueios. Os três documentos normativos originais permanecem preservados.
