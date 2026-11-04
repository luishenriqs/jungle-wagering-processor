# JUNGLE-IMP-01 — Evidências de execução

## Estado

**IMP-01 pronto para revisão independente.** Typecheck, instalação congelada offline e 93 testes unitários aprovados pelo executor. A validação HTTP do bootstrap foi executada com sucesso fora do sandbox pelo responsável técnico, conforme resultado fornecido por Luís Henrique Pereira e registrado abaixo. `node_modules` e `bun.lock` existem.

Não há pendência executável conhecida de typecheck, testes ou bootstrap para encaminhar este pacote à revisão. Permanecem a revisão independente do Antigravity, a resolução de eventuais achados bloqueantes e a aprovação explícita de Luís. O pacote não está aprovado definitivamente e não autoriza avanço ao IMP-02. A restrição de socket do sandbox permanece como limitação do ambiente; não foi solicitada elevação de permissões nem houve rejeição automática de aprovação.

## Evidência HTTP externa fornecida pelo responsável técnico

Origem: resultado informado por Luís Henrique Pereira nesta conversa. Execução no Ubuntu, fora do sandbox. O executor não repetiu esse teste nesta etapa documental e não apresenta esse resultado como execução própria.

Comando: `bun run check:bootstrap`.

Resultado informado:

- `NestApplication successfully started`.
- AppModule, WalletsModule, WageringModule e MessagingModule inicializados.
- `Bootstrap OK: http://127.0.0.1:35221`.
- HTTP 404 esperado.
- **Exit code: 0**.

Essa evidência resolve a pendência de validação HTTP antes bloqueada por EPERM no sandbox. Nesta etapa foram atualizados exclusivamente este relatório e README.md; código de produção, testes, lockfile e documentos normativos não foram alterados.

## Retomada de validação e correção — 04/11/2026

| Verificação final | Resultado real |
|---|---|
| `ls -ld node_modules bun.lock` | Diretório e lockfile confirmados |
| `bun --version` | 1.4.4 |
| `bun install --offline --frozen-lockfile` | Exit 0: Checked 116 installs across 115 packages (no changes) |
| `bun run typecheck` após correções | Exit 0: `tsc --noEmit`, sem diagnósticos na configuração documentada abaixo |
| `bun test` após correções | Exit 0: **93 pass, 0 fail, 362 expect() calls, 10 arquivos** |
| `bun run check:bootstrap` após correção de cleanup | Exit 1: módulos inicializados, erro EPERM em listen; não validou resposta HTTP |
| `bun run check:bootstrap` externo, informado por Luís | Exit 0: aplicação e quatro módulos inicializados; http://127.0.0.1:35221; HTTP 404 esperado |
| Inicialização real NestJS sem listen, por `bun -e` | Exit 0: `NestJS init/DI/close OK: WalletsModule, WageringModule, MessagingModule; HTTP listen not exercised` |
| `git diff --exit-code HEAD -- AGENTS.md technical-challenge.md Jungle-Architecture-v0.2.md` | Exit 0, sem diff: três documentos normativos idênticos ao HEAD |
| `git diff --stat` | Vazio porque todos os arquivos da implementação ainda são não rastreados |
| `git status --short` | Branch main com arquivos novos não rastreados; nenhum arquivo normativo modificado |

### Correções realizadas nesta retomada

- `test/unit/outbox-message.test.ts`: comparação do envelope como objeto com assinatura compatível com o matcher tipado do Bun.
- `test/unit/wallet-opening.test.ts`: expectativas utilizam os enums de kind/status, em vez de strings incompatíveis no typecheck.
- `test/unit/wallet.test.ts`: tupla literal preserva os dois códigos permitidos para insuficiência de saldo.
- `tsconfig.json`: remoção da biblioteca DOM, desnecessária ao alvo Bun; `skipLibCheck=true`, alinhado à recomendação oficial do Bun. Strict e as demais verificações do código continuam habilitados.
- `src/main.ts`: fechamento da aplicação quando listen falha, antes de propagar o erro. O script de verificação HTTP não foi alterado para ocultar EPERM.
- `README.md`, `ARCHITECTURE.md` e este relatório: atualizados com resultados, limite do typecheck e pendência HTTP.

O primeiro typecheck desta retomada falhou com quatro diagnósticos em testes e conflitos nas declarações transitivas. `bun-types@1.3.3` depende de `@types/node: "*"`; o lock resolveu Node types `26.6.6`, que conflitam com overrides de Bun em `noDeprecation`, `EncodeIntoResult` e TLS. A combinação com lib.dom também gerava conflito em SubtleCrypto. As fontes do domínio não apresentaram diagnósticos nessa execução.

`skipLibCheck=true` não corrige esses `.d.ts`: omite sua checagem interna. A verificação strict de fontes/testes/scripts passa usando as declarações disponíveis; a compatibilidade das declarações entre si não foi demonstrada. Essa decisão está explícita em ARCHITECTURE.md, baseada no [tsconfig recomendado pelo Bun](https://bun.com/docs/runtime/typescript). Nenhuma declaração em node_modules foi modificada, nenhuma dependência substituída e nenhum teste removido.

O diagnóstico sem socket criou uma aplicação Nest real, executou `app.init()`, resolveu por DI WalletsModule/WageringModule/MessagingModule e fechou a aplicação em finally. Não substitui a verificação HTTP exigida. Posteriormente, Luís forneceu a evidência de execução HTTP externa bem-sucedida, registrada separadamente acima; nenhum resultado externo foi presumido.

### Hashes observados após as validações

```text
0dca6860cc5d49f1c1737e4830ca4ff3dbb35b588c85379ad2674f0629910690  bun.lock
9bb38770f3a5d49cc3220343c969a9ff4e76fdf7d88d51c6b0162616e16deec0  AGENTS.md
9d2cb54d071554a391cd73d6222b3d8f40562d198e1b876e569ad5b8ad9169c8  technical-challenge.md
31b015e34cb3fd72d339d0f863922fe48d416a21d7ebc63546b2f703c73319fb  Jungle-Architecture-v0.2.md
```

## Ambiente observado

- Diretório: `/home/luishenriqs/projects/Jungle`.
- Branch: `main`; upstream `origin/main`.
- Remoto: `git@github.com:luishenriqs/jungle-wagering-processor.git`.
- Commit base: `6406e84 chore: initialize Jungle technical challenge documentation`.
- Git inicialmente limpo.
- Node: `v24.22.2`, confirmado na preparação anterior desta mesma ordem.
- Bun: `1.4.4`; revision `1.4.4+38afee6c8`, Linux x64.
- Executável: `/home/luishenriqs/.bun/bin/bun`.

O shell automatizado não inclui `~/.bun/bin` no PATH. Cada comando usa `PATH=/home/luishenriqs/.bun/bin:$PATH`, sem modificar arquivos de configuração do usuário. Uma nova sessão interativa `zsh -ic 'command -v bun; bun --version'` encontrou Bun 1.4.4. O shell interativo também tentou atualizar caches do Oh My Zsh fora das áreas graváveis e emitiu avisos; esses avisos não impediram a execução do Bun.

## Histórico anterior à instalação externa das dependências

| Comando/verificação | Resultado |
|---|---|
| `git status`, `git branch --show-current`, `git remote -v`, `git log -1 --oneline` | Base e branch confirmadas; inicialmente limpo |
| Leitura integral de AGENTS.md, technical-challenge.md e Jungle-Architecture-v0.2.md | Requisitos consultados; documentos preservados |
| `bun --version`, `bun --revision` com PATH local | 1.4.4 / 1.4.4+38afee6c8 |
| `curl -I --max-time 15 https://registry.npmjs.org/decimal.js` | Exit 6: não resolve o host |
| Consulta aos caches locais Bun/npm e caminhos de ferramentas | Dependências financeiras/Nest não disponíveis localmente |
| `BUN_INSTALL_CACHE_DIR=/tmp/jungle-bun-cache bun install` | Exit 1: DNSResolveFailed para dependências declaradas |
| `bun install --frozen-lockfile` | Exit 1: DNSResolveFailed; não gerou lockfile |
| `bun test test/unit/money.test.ts test/unit/wallet.test.ts test/unit/wallet-ledger-entry.test.ts` | Exit 1: 0 pass, 3 fail, 3 errors; decimal.js ausente |
| `bun test test/unit/inbox-message.test.ts` | Exit 0: 3 pass, 0 fail, 17 expect calls |
| `bun test test/unit/inbox-message.test.ts test/unit/outbox-message.test.ts` | Exit 0: 9 pass, 0 fail, 71 expect calls |
| `bun run typecheck` | Exit 127: `tsc: command not found` |
| `bun test` | Exit 1: 9 pass, 8 fail, 8 errors, 71 expect calls, 10 arquivos |
| `bun run check:bootstrap` | Exit 1: reflect-metadata ausente |
| Transpilação sintática por `Bun.Transpiler` de src/test/scripts | 35 arquivos TypeScript transpilados; NÃO equivale a typecheck |
| Busca por dependências de infraestrutura/conversões numéricas em `src` | Nest somente no bootstrap/módulos; `Number()` somente para porta HTTP, sem conversão monetária |
| `git diff --exit-code -- AGENTS.md technical-challenge.md Jungle-Architecture-v0.2.md` | Exit 0: documentos originais intactos |
| `git diff --stat` | Vazio: arquivos novos ainda não rastreados, não significa ausência de trabalho |
| `git status` / `git ls-files --others --exclude-standard` | Arquivos novos não rastreados; nenhum arquivo original modificado |

As oito falhas dessa execução histórica eram erros de carregamento por ausência de decimal.js. Foram superadas pela instalação externa e pela execução atual de 93 testes, registrada acima. Não houve substituição da biblioteca decimal, NestJS ou TypeScript por stubs.

## Inventário

Todos os arquivos desta entrega são novos:

- Fundação: `.gitignore`, `bunfig.toml`, `package.json`, `bun.lock`, `tsconfig.json`.
- Bootstrap: `src/main.ts`, `src/app.module.ts`, `scripts/check-bootstrap.ts`.
- Módulos: `src/modules/wallets/wallets.module.ts`, `src/modules/wagering/wagering.module.ts`, `src/modules/messaging/messaging.module.ts`.
- Domínio compartilhado: `src/shared/domain/money.ts`, `domain-errors.ts`, `validation.ts`, `events/integration-event.ts`.
- Wallets: `src/modules/wallets/domain/wallet.ts`, `wallet-ledger-entry.ts`, `events/wallet-balance-changed.ts`.
- Wagering: `src/modules/wagering/domain/wager-transaction.ts`, `wager-rules.ts`, `wager-errors.ts`, `failure-code.ts`, `wallet-opening.ts`.
- Eventos Wagering: `src/modules/wagering/domain/events/wager-event-data.ts`, `wager-transaction-processed.ts`, `wager-transaction-rejected.ts`, `wager-transaction-pending-reference.ts`.
- Mensageria: `src/modules/messaging/domain/inbox-message.ts`, `outbox-message.ts`.
- Testes: `test/fixtures.ts` e `test/unit/{money,wallet,wallet-ledger-entry,wallet-opening,wager-transaction,wager-rules,financial-sequences,integration-events,inbox-message,outbox-message}.test.ts`.
- Documentação: `README.md`, `ARCHITECTURE.md`, este relatório.

`bun.lock` foi gerado na instalação externa e preservado nesta retomada. `node_modules` está ignorado e contém as dependências reais. Há 43 arquivos novos da entrega, incluindo o lockfile, ainda não adicionados ao índice Git.

## Retomada reproduzível

Em ambiente que permita abrir uma porta local (para o bootstrap HTTP):

```sh
cd /home/luishenriqs/projects/Jungle
export PATH="$HOME/.bun/bin:$PATH"
bun install --frozen-lockfile
bun run typecheck
bun test
bun run check:bootstrap
git status
git diff --stat
```

Se o cache já estiver populado e a rede estiver bloqueada, a instalação pode usar `bun install --offline --frozen-lockfile`, como executado nesta retomada. O teste HTTP já passou externamente conforme evidência fornecida por Luís; o revisor pode reproduzi-lo em ambiente com permissão para socket local.

## Decisões e riscos

As decisões estão detalhadas em `ARCHITECTURE.md`: decimal isolado com precisão 40 e limites NUMERIC(18,2), transições terminais, lançamento antes da mutação, snapshots históricos, abertura com dois eventos, payloads congelados e retry sem descarte definitivo. Não há desvio arquitetural intencional. As evidências atuais cobrem domínio unitário, typecheck do código, inicialização Nest sem socket e HTTP externo bem-sucedido informado pelo responsável técnico. Permanecem revisão independente e aprovação final. Os conflitos das declarações de dependências permanecem como limitação conhecida de `skipLibCheck`. As menções à pendência HTTP em ARCHITECTURE.md refletem o estado anterior à evidência externa; esse arquivo foi preservado nesta etapa por restrição explícita de escopo.

Não há evidência de PostgreSQL, SQS, atomicidade persistente, unicidades, concorrência/múltiplos processos ou crash recovery. Essas garantias e seus testes pertencem aos próximos pacotes e não são simuladas como concluídas aqui. O conteúdo integral de REV2-01 a REV2-04 não existe neste checkout, conforme registrado em ARCHITECTURE.md.

Nenhum commit, push, merge ou PR foi realizado. Nenhuma alteração de arquivos normativos ou configuração global do Node/Bun foi realizada.
