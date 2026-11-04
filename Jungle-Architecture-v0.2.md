# Jungle Gaming — Especificação Arquitetural v0.2 (candidata à aprovação)

**Data:** 04/11/2026  
**Fonte normativa:** `technical-challenge.md` (748 linhas)  
**Base:** Arquitetura v0.1; revisão independente REV-01…REV-13  
**Estado:** pronta para revisão crítica; **não autoriza implementação ainda**. Em conflito, prevalece o enunciado.

## 0. Decisões e limites

Monólito modular NestJS + Bun 1.x + TypeScript strict + MikroORM + PostgreSQL + LocalStack SQS FIFO + Docker Compose, com portas/adaptadores e domínio livre de framework. Um caso de uso `ProcessWagerTransaction` comum a HTTP, SQS e reprocessamento. PostgreSQL é a única autoridade de concorrência/idempotência. Sem Redis, Prisma, IdP em execução, double-entry ou observabilidade pesada. API auth: ponto de extensão `ProviderIdentityPort`/guard no-op documentado; health aberto. Uma moeda operacional BRL, modelo Money preserva conflito de moedas. `decimal.js`, JSON serializado com amount de duas casas; NUNCA `number` para operações monetárias.

**Invariantes:** cada transação com efeito financeiro produz no máximo um ledger por wallet; cada alteração de saldo e ledger correspondente ocorre no mesmo commit; nenhum saldo negativo; nenhum UPDATE/DELETE de ledger; evento de domínio materializado na outbox dentro do mesmo commit; replay não produz segundo efeito; independência entre wallets. `wallet.version` começa em 1, aumenta somente para alterações posteriores à criação que realmente mudam saldo.

## 1. SQL normativo proposto (migration inicial)

O SQL abaixo serve de contrato exato para migrations MikroORM; migration `down` deve desfazer objetos na ordem inversa, documentando perda de dados esperada de um rollback de schema. Aplicar no PostgreSQL com migrations em sequência e validar contra instância real.

```sql
CREATE TABLE wallets (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL,
  currency VARCHAR(3) NOT NULL,
  balance NUMERIC(18,2) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_wallet_player_currency UNIQUE (player_id, currency),
  CONSTRAINT ck_wallet_balance CHECK (balance >= 0),
  CONSTRAINT ck_wallet_version CHECK (version >= 1),
  CONSTRAINT ck_wallet_currency CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE TABLE wager_transactions (
  id UUID PRIMARY KEY,
  provider_id TEXT NOT NULL,
  external_transaction_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  wallet_id UUID NOT NULL REFERENCES wallets(id),
  player_id UUID NOT NULL,
  round_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  reference_external_transaction_id TEXT NULL,
  reference_transaction_id UUID NULL REFERENCES wager_transactions(id),
  status TEXT NOT NULL,
  failure_code TEXT NULL,
  recorded_balance_amount NUMERIC(18,2) NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ NULL,
  CONSTRAINT uq_wager_provider_external UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT uq_wager_idempotency UNIQUE (idempotency_key),
  CONSTRAINT ck_wager_kind CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  CONSTRAINT ck_wager_status CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  CONSTRAINT ck_wager_amount CHECK (amount >= 0 AND (kind = 'LOSS' OR amount > 0)),
  CONSTRAINT ck_wager_reference CHECK ((kind NOT IN ('REFUND','ROLLBACK')) OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT ck_wager_attempts CHECK (attempts >= 0),
  CONSTRAINT ck_wager_balance_snapshot CHECK (recorded_balance_amount IS NULL OR recorded_balance_amount >= 0),
  CONSTRAINT ck_wager_currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ck_wager_terminal_snapshot CHECK (status NOT IN ('PROCESSED','REJECTED') OR recorded_balance_amount IS NOT NULL),
  CONSTRAINT ck_wager_rejected_code CHECK (status <> 'REJECTED' OR failure_code IS NOT NULL),
  CONSTRAINT ck_wager_pending_ref_schedule CHECK (status <> 'PENDING_REFERENCE' OR (next_retry_at IS NOT NULL AND expires_at IS NOT NULL))
);

-- Sem duplicar reversão efetivamente aplicada, inclusive REFUND + ROLLBACK da mesma BET.
CREATE UNIQUE INDEX uq_wager_processed_reversal
ON wager_transactions(reference_transaction_id)
WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK') AND reference_transaction_id IS NOT NULL;
CREATE INDEX idx_wager_pending_ref ON wager_transactions(next_retry_at, id)
WHERE status = 'PENDING_REFERENCE';
CREATE INDEX idx_wager_ref_lookup ON wager_transactions(provider_id, external_transaction_id);

CREATE TABLE wallet_ledger_entries (
  id UUID PRIMARY KEY,
  wallet_id UUID NOT NULL REFERENCES wallets(id),
  transaction_id UUID NOT NULL REFERENCES wager_transactions(id),
  direction TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  balance_before NUMERIC(18,2) NOT NULL,
  balance_after NUMERIC(18,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_ledger_wallet_tx UNIQUE(wallet_id, transaction_id),
  CONSTRAINT ck_ledger_direction CHECK(direction IN ('DEBIT','CREDIT')),
  CONSTRAINT ck_ledger_amount CHECK(amount > 0),
  CONSTRAINT ck_ledger_balances CHECK(balance_before >= 0 AND balance_after >= 0),
  CONSTRAINT ck_ledger_arithmetic CHECK(
    (direction = 'DEBIT' AND balance_after = balance_before - amount)
    OR (direction = 'CREDIT' AND balance_after = balance_before + amount)
  ),
  CONSTRAINT ck_ledger_currency CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE INDEX idx_ledger_wallet_cursor
ON wallet_ledger_entries(wallet_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION prevent_ledger_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'immutable ledger: % forbidden', TG_OP USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE OR REPLACE FUNCTION protect_terminal_wager() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'terminal wager is immutable' USING ERRCODE = '55000';
  END IF;
  -- Identidade e payload nunca mudam durante estados intermediários.
  IF ROW(NEW.provider_id,NEW.external_transaction_id,NEW.idempotency_key,NEW.payload_hash,
         NEW.wallet_id,NEW.player_id,NEW.round_id,NEW.game_id,NEW.kind,NEW.amount,NEW.currency,
         NEW.reference_external_transaction_id)
     IS DISTINCT FROM
     ROW(OLD.provider_id,OLD.external_transaction_id,OLD.idempotency_key,OLD.payload_hash,
         OLD.wallet_id,OLD.player_id,OLD.round_id,OLD.game_id,OLD.kind,OLD.amount,OLD.currency,
         OLD.reference_external_transaction_id) THEN
    RAISE EXCEPTION 'wager identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_wager_terminal BEFORE UPDATE ON wager_transactions
FOR EACH ROW EXECUTE FUNCTION protect_terminal_wager();

CREATE TABLE inbox_messages (
  consumer_name TEXT NOT NULL,
  message_id TEXT NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ NULL,
  PRIMARY KEY(consumer_name,message_id)
);

CREATE TABLE outbox_messages (
  id UUID PRIMARY KEY,
  aggregate_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT NULL,
  lease_token UUID NULL,
  lease_until TIMESTAMPTZ NULL,
  published_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  CONSTRAINT ck_outbox_attempts CHECK(attempts >= 0),
  CONSTRAINT ck_outbox_lease CHECK(
    (lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL) OR
    (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
  )
);
CREATE INDEX idx_outbox_due ON outbox_messages(next_attempt_at, occurred_at, id)
WHERE published_at IS NULL;
```

**Revisão obrigatória do DDL:** constraints de moeda igual entre wallet e wager/ledger não são expressáveis somente por CHECK de uma linha; validar dentro do caso de uso sob lock e considerar FKs compostas/trigger caso o revisor exija enforcement de schema. O trigger de estados terminais impede inclusive limpeza posterior; não atualizar estado terminal após commit. `OPENING` interna pode usar metadata reservada (abaixo) e é única por wallet. Sem UPDATE/DELETE de ledger, a aplicação não tem rotina de correção silenciosa. Migrações podem reverter o schema em ambiente descartável, jamais destruir dados de produção como rotina.

## 2. Factories e criação OPENING

`Wallet.open({id,playerId,initialBalance})` gera saldo inicial diretamente e `version=1`; saldo inicial positivo gera **na mesma transação** `WagerTransaction OPENING PROCESSED` e ledger `CREDIT` de `0.00` a `initialBalance`, sem chamar `Wallet.credit()` nem incrementar versão. Convenção única e sem colisão: `providerId='SYSTEM'`, `externalTransactionId='opening:'+walletId`, `idempotencyKey='SYSTEM:opening:'+walletId`, `roundId='opening:'+walletId`, `gameId='SYSTEM_OPENING'`, amount initialBalance, mesmo player/wallet/currency. `OPENING` só por método interno; bordas HTTP e SQS rejeitam `kind=OPENING` e `providerId=SYSTEM`. Criação duplicada de `(player_id,currency)` => 409. Abertura zero não cria ledger nem OPENING e mantém version 1. Eventuais eventos de abertura: `WalletBalanceChanged` para abertura positiva, originados do mesmo commit, com versão 1.

## 3. Máquina de estados e negócios

- Estados: `PENDING -> PROCESSED | PENDING_REFERENCE | REJECTED | FAILED`; `PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED`. Terminais jamais transitam.
- `BET`: amount > 0, DEBIT; insuficiência => REJECTED `INSUFFICIENT_FUNDS_BET`.
- `WIN`: amount > 0, CREDIT; referência opcional. Sem referência => crédito imediato. Com referência => exige BET PROCESSED do mesmo provider/player/wallet/round/currency; referência ausente => PENDING_REFERENCE; BET revertida => REJECTED. Valor de WIN pode divergir da BET.
- `LOSS`: amount >= 0, PROCESSED sem efeito, sem ledger, gera evento Processed mas não BalanceChanged.
- `REFUND`: amount > 0, referência BET PROCESSED, igual valor, contexto idêntico, CREDIT.
- `ROLLBACK`: amount > 0, referência BET/WIN/REFUND PROCESSED, igual valor, contexto idêntico. BET => CREDIT; WIN e REFUND => DEBIT (rejeitar com `INSUFFICIENT_FUNDS_REVERSAL` se saldo insuficiente).
- **Reversão cruzada:** uma referência só aceita uma reversão PROCESSED do conjunto REFUND/ROLLBACK. Ex.: BET->REFUND->ROLLBACK(ref=REFUND) é permitido; BET->REFUND e ROLLBACK(ref=BET) adicional é rejeitado. Esta opção é deliberadamente mais restritiva que leitura literal “mesmo tipo”; documentar como interpretação da proibição global de crédito duplicado e pedir ao revisor validação.
- Referências resolvidas por `(providerId,referenceExternalTransactionId)` e comparadas quanto a provider, player, wallet, round, currency e tipo/status. Referência existente REJECTED/FAILED => REJECTED `REFERENCE_NOT_PROCESSED`; referência inexistente ou ainda não terminal => PENDING_REFERENCE até deadline.
- Exemplos de FailureCode: `INSUFFICIENT_FUNDS_BET`, `INSUFFICIENT_FUNDS_REVERSAL`, `CURRENCY_MISMATCH`, `REFERENCE_NOT_FOUND_TIMEOUT`, `REFERENCE_INVALID_KIND`, `REFERENCE_CONTEXT_MISMATCH`, `REFERENCE_AMOUNT_MISMATCH`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED`. Conflito de idempotência é erro de contrato HTTP 409, não nova transação REJECTED.

## 4. Protocolo transacional normal e idempotência

**Isolamento** `READ COMMITTED`, `EntityManager.transactional` com fork/contexto limpo por tentativa; SQL parametrizado explícito para locks e claims. **Ordem única de lock:** wallet primeiro, depois wager transaction/referência. Sem locks globais. Protocolo de caso de uso:

1. Validar DTO, `Money`, kind externo, header, providerId; construir payload normalizado e `SHA-256` do JSON canônico **antes** da transação. Nunca confiar em SQS FIFO como lock.
2. Iniciar SQL transaction; `SELECT wallets WHERE id=:walletId FOR UPDATE`. Sem wallet => 404/erro permanente conforme canal. É permitido fazer leituras **sem** lock antes; nenhum `FOR UPDATE` na wager antes do lock de wallet.
3. Após lock, consultar `wager_transactions` por key e também `(provider_id,external_transaction_id)`; se existir, verificar identidade e hash. Key+hash idênticos => replay; outro caso => 409. Não executar efeitos financeiros novamente. Para SQS, transação também deve gravar inbox de mensagem nova e marcar processed antes do commit, inclusive se replay.
4. Se não existe, criar wager PENDING, avaliar referência e regras. Se referência não existe e for requerida, persistir PENDING_REFERENCE com attempts=0, next_retry_at e expires_at; saldo observado gravado e evento PendingReference. Se rejeição, persistir REJECTED com failureCode, snapshot do saldo observado, evento Rejected. Se processado, alterar wallet sob lock, version apenas se saldo mudou, inserir ledger se aplicável, persistir PROCESSED+snapshot e eventos Processed e BalanceChanged (se houver movimento).
5. Persistir inbox (quando SQS) e outbox na mesma transaction, commit. Só depois responder HTTP ou fazer DeleteMessage.
6. Unique violation (`23505`): **rollback completo**, descartar EntityManager/Identity Map; abrir novo contexto. PostgreSQL normalmente espera que a transação concorrente que provocou a colisão se resolva antes de devolver o resultado do INSERT. Reler winner após rollback, confirmar id/hash e responder replay ou 409. Se winner não estiver visível por exceção operacional, retry curto e limitado com timeout; nunca interpretar ausência como autorização para débito duplo. Deadlock `40P01` / serialization/transient => retry do **caso de uso inteiro** com fork novo, até limite; se persistir, 503/visibilidade SQS para retry.

**Atenção:** a estratégia wallet-first serializa duas chamadas com mesma key e wallet, mas não basta para mesma key enviada para wallets diferentes; a unicidade SQL e protocolo pós-23505 cobrem esse cenário.

**Resposta histórica:** PROCESSED/REJECTED persistem `recorded_balance_amount` ao terminalizar; replay terminal devolve sempre esse saldo, status e failureCode originais. PENDING_REFERENCE persiste saldo do aceite; replay enquanto pendente devolve 202 e snapshot de aceite; após resolução terminal, replays retornam o novo status terminal e saldo fixado no processamento. O campo `idempotentReplay` é metadado de transporte e não integra hash.

**Canonicalização exata**: SHA-256 hex lowercase de JSON UTF-8 com chaves ordenadas recursivamente para exatamente `{externalTransactionId,gameId,kind,money:{amount,currency},playerId,providerId,referenceExternalTransactionId,roundId,walletId}`; referência ausente normalizada como `null`, money amount serializada sempre como decimal string de duas casas. Não incluir header, idempotencyKey, messageId, type, occurredAt, correlationId ou envelope. HTTP e SQS produzem hash idêntico.

## 5. PendingReferenceWorker

Parametrizar `PENDING_REF_MAX_ATTEMPTS` (default 10), `PENDING_REF_BASE_DELAY_MS` (default 1000), `PENDING_REF_TTL_MS` (default 86400000), com `ClockPort` para testes sem 24h de espera. A combinação limite de tentativas/TTL vale o que ocorrer primeiro; aumentar timeout em produção conforme negócio.

Worker consulta candidatos due **sem lock exclusivo**, por `(next_retry_at,id)`; para cada candidato abre transação: (1) `SELECT wallet FOR UPDATE`; (2) `SELECT pending wager FOR UPDATE`; (3) revalida status/due e processa/rejeita/reagenda; (4) outbox no mesmo commit. Outros workers que consultaram a mesma linha tornam-se no-op após lock. Nenhum worker faz lock em wager antes de wallet. `PENDING_REFERENCE` não retém SQS original: confirmação inicial do estado pendente já faz ACK. Referência temporariamente em PENDING/PENDING_REFERENCE => reagendar; terminal REJECTED/FAILED => rejeitar; ausência após tentativas/TTL => `REFERENCE_NOT_FOUND_TIMEOUT` e evento Rejected.

## 6. SQS Consumer / Inbox / Shutdown

Filas de entrada `wager-transactions.fifo` e `wager-transactions-dlq.fifo`; fila de eventos adicional `wagering-events.fifo`. Configurar redrive, visibility timeout maior que processamento normal, receive count limitado, backoff e polling configuráveis. MessageGroupId preferencialmente walletId (otimização somente); event stream: MessageGroupId=aggregateId, MessageDeduplicationId=eventId. EventId estável em reenvios; SQS FIFO dedup não substitui consumer idempotente.

| Resultado | Persistência/Inbox | SQS |
|---|---|---|
| PROCESSED/REJECTED/PENDING_REFERENCE | inbox processed + domínio + outbox mesmo commit | ACK após commit |
| Replay idêntico / duplicata de messageId e hash igual | verificar estado persistido e marcar inbox quando novo messageId | ACK após confirmação |
| Mesmo messageId, hash diferente | não executar operação; log/métrica de violação | DLQ como erro permanente |
| Payload malformado/permanentemente inválido | registrar diagnóstico sem efeitos financeiros | DLQ (manual com confirmação de envio, depois delete origem) ou redrive documentado |
| Erro PG/SQS transitório, lock timeout/deadlock persistente | rollback, sem inbox processed | não ACK; visibility/backoff e redrive configurado |

SIGTERM: interromper novos receives; abortar long polling; aguardar in-flight com timeout de shutdown; enquanto DB aberto concluir commit/ACK; liberar visibility para mensagens já recebidas e não processadas; só então fechar ORM/SQS. SIGKILL não é gracioso: visibility timeout + idempotência resolvem recuperação. Testar encerramento em lote.

## 7. Outbox Publisher concorrente (claim token fencing)

**Fila de destino:** `wagering-events.fifo`. Evento IntegrationEvent<T> abstrato e quatro subclasses, `eventType/version` fixos na classe e `MoneyProps` no JSON. O produtor de negócio só grava outbox no commit; nunca chama SQS antes.

**Claim, transação curta:**

```sql
WITH picked AS (
  SELECT id FROM outbox_messages
  WHERE published_at IS NULL AND next_attempt_at <= now()
    AND (lease_until IS NULL OR lease_until <= now())
  ORDER BY occurred_at, id
  FOR UPDATE SKIP LOCKED LIMIT :batch_size
)
UPDATE outbox_messages o
SET lease_owner = :worker_id,
    lease_token = :fresh_claim_uuid,
    lease_until = now() + (:lease_seconds * interval '1 second')
FROM picked p WHERE o.id = p.id
RETURNING o.*;
```

Para simplificar fencing, executar claim de **um evento por vez**, ou gerar token distinto por linha quando batch>1. Publicar fora da transação SQL. Após sucesso:

```sql
UPDATE outbox_messages
SET published_at=now(),lease_owner=NULL,lease_token=NULL,lease_until=NULL
WHERE id=:id AND published_at IS NULL
  AND lease_owner=:worker_id AND lease_token=:claim_token;
```

Após erro: incrementar attempts, definir próximo backoff, limpar lease com **os mesmos filtros de owner/token**. Se update afetar zero linhas, o claim foi perdido/expirado e não se deve sobrescrever o estado do novo owner. Após crash antes do publish, lease expira e outro worker assume. Após sucesso de SQS antes do update, republicação é permitida; mesmo eventId + dedup do consumer asseguram processamento idempotente. Lease deve exceder timeout de sendMessage ou ser renovado; usar send timeout curto e lease configurável. Publicadores não reivindicam mensagens fora do vencimento. Não prometer entrega exactly-once. Expor lag/attempts.

## 8. HTTP/queries/observabilidade

| Situação | HTTP |
|---|---|
| POST wallet criado | 201 |
| Wager PROCESSED ou replay terminal processado | 200 |
| Wager PENDING_REFERENCE | 202 |
| DTO, Money inválido, header ausente, OPENING externo | 400 |
| Entidade inexistente | 404 |
| Key/hash conflitante, external ID alterado, wallet duplicada | 409 |
| Wager REJECTED por regra de negócio | 422 com `transactionId,status,failureCode,balance,idempotentReplay` |
| Infra transitória sem commit | 503 com retry apropriado |

Para replay de REJECTED usar 422 e mesma resposta histórica exceto `idempotentReplay=true`. GET transações retorna estado armazenado, não reexecuta. `GET /wallets/:walletId/ledger?cursor=&limit=50`: ordenar `(created_at DESC,id DESC)`; cursor opaco base64url da tupla `(createdAt,id)`, filtro SQL `(created_at,id)<(:date,:id)`, índice composto. Reconciliar com SUM créditos - débitos (nenhuma entrada => 0), sem correção silenciosa, divergência em JSON log/métrica. Health live responde estado do processo; ready testa PG e SQS. Logs JSON com correlationId,messageId,transactionId,walletId,providerId sem payloads completos/PII. Métricas: status, duplicatas, retries, DLQ, conflitos de lock, outbox lag e latência.

## 9. Testes de aceitação (gates executáveis)

1. `Money`: strings com escala fixa; rejeitar NaN, Infinity, expoentes, >2 casas, negativo; conflito de moedas; testes sem `number` na aritmética monetária.
2. Wallet initialBalance `1000.00` => version 1, OPENING+ledger 0->1000; wallet `0.00` => version1, sem OPENING/ledger; abrir 3 wallets sem colisão de chave interna.
3. `LOSS` e BET rejeitada não modificam version nem ledger; BET processada aumenta version uma vez.
4. Duas apostas 80/100 em paralelo: 1 processada, 1 rejeitada, saldo20, único débito; repetir com >=3 processos.
5. Cinquenta BET idênticas em paralelo: 1 novo processamento, 49 replays, um débito e saldo original em todas respostas.
6. Conflito de idempotencyKey com hash diferente e de external ID com outra key: 409; mesma operação HTTP e SQS compartilha hash/replay.
7. Rejected terminal e saldo posterior diferente: replay conserva status/failureCode/saldo originais.
8. BET->REFUND + ROLLBACK(ref BET) sequencial e concorrente: só 1 crédito; BET->REFUND->ROLLBACK(ref REFUND) calcula efeitos corretos; rollback de WIN/REFUND sem saldo recebe failureCode distinto.
9. PendingReference antes da BET; três workers simultâneos e retry HTTP: exatamente 1 resolução e 1 ledger; referência ausente expira com código e outbox; referência inválida rejeita.
10. Mensagem SQS antes do ACK após commit (injeção de crash): redelivery não duplica; REJECTED/PENDING_REFERENCE fazem ACK, nunca DLQ indevida.
11. Outbox dois ou três publishers, 100 eventos; crash depois de claim pré-publicação e depois de publicação pré-mark; todos eventualmente publicados e nenhum evento financeiro perdido; lease expirado não permite que antigo owner confirme claim novo.
12. Shutdown SIGTERM e restart; commits/ack ou retorno à visibilidade. Reconciliação ledger==balance após todos os cenários.
13. Constraints diretas no PG: UPDATE/DELETE ledger bloqueado, valor negativo bloqueado, ledger desbalanceado bloqueado, terminal wager immutable, unicidades e migration up/down em ambiente descartável.
14. Paginar >120 entradas incluindo timestamps idênticos sem perdas/duplicatas; health live/ready, métricas e logs; README com `docker compose up`, migrations, testes e limitações.

**Observação de verificabilidade:** testes unitários e integração não substituem testes multi-processo reais com containers. Evidências devem registrar comandos, saída, versão Bun/PG, isolamento de dados, falhas injetadas e saldo reconstruído.

## 10. Mapeamento de achados REV

| Achado | Resolução proposta |
|---|---|
| REV-01 | Índice único parcial de reversões processadas + regra cruzada |
| REV-02 | Wallet-first; unique SQL; rollback e EntityManager novo ao tratar 23505 |
| REV-03 | Identificadores internos OPENING derivados de walletId |
| REV-04 | Outbox lease com owner + token de fencing + destino FIFO |
| REV-05 | DDL completo, checks aritméticos e triggers |
| REV-06 | Version manual sem version decorator automático; abertura version1 |
| REV-07 | Matriz Inbox ACK/Retry/DLQ |
| REV-08 | Lock order e revalidação do PendingReferenceWorker |
| REV-09 | Shutdown gracioso explícito |
| REV-10 | WIN opcional ref, LOSS >=0, regras de referência |
| REV-11 | Snapshot de resposta, HTTP e FailureCode |
| REV-12 | Canonicalização SHA-256 comum, cursor de tupla |
| REV-13 | Sem escopo opcional custoso; testes/infra essenciais primeiro |

## 11. Riscos abertos para adversarial review

- Revisar se o índice de reversão único (por `reference_transaction_id` processado) é compatível com intenção da regra “uma vez por tipo” versus invariante de não duplicar créditos; aceitar ou propor estado explícito de reversão que seja protegido no SQL.
- Verificar se constraints de referência, status terminal e moeda devem ganhar proteções adicionais no schema (FK composta/trigger); comparar custo com prazo de 72h.
- Verificar se `OPENING` deve emitir também WagerTransactionProcessed; especificação original lista OPENING como interno e eventos Processed para transação aplicada; documentar decisão final.
- Determinar comportamento de referências conhecidas mas ainda PENDING e WIN de BET revertida.
- Avaliar semântica de concorrência quando mesma idempotencyKey entra por wallets diferentes com mensagens SQS e quando o SQS é entregue depois do HTTP; garantir inbox no commit da dedup de transporte.
- Confirmar se token por claim e timeout SQS evitam publish storm sob latência; segurança depende de consumidores deduplicarem.
- Ajustar contrato de resposta para transações `FAILED` e PENDING_REFERENCE em eventual replay pós-recovery.

**Parecer solicitado ao Gemini/Antigravity:** revisar estritamente esta v0.2 contra enunciado original; reportar defeitos comprovados, riscos e lacunas com ID, severidade, SQL/interleaving reproduzível, correção mínima e teste. Não implementar. Aprovação desta arquitetura é gate para implementação.
