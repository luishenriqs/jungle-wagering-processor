# Distributed Wagering Processor

**Language / Idioma:** [English](#english) | [Português](#português)

---

<a id="english"></a>

## English

### Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Prerequisites](#3-prerequisites)
4. [Quickstart](#4-quickstart)
5. [HTTP API Reference](#5-http-api-reference)
6. [Testing](#6-testing)
7. [Observability](#7-observability)
8. [Final Considerations and Known Limitations](#8-final-considerations-and-known-limitations)

---

### 1. Overview

#### Project Objective

**Distributed Wagering Processor** is a distributed financial transaction processing service built for the Jungle Gaming technical challenge ([`technical-challenge.md`](technical-challenge.md)). It processes real-time iGaming wallet operations (`BET`, `WIN`, `LOSS`, `REFUND`, and `ROLLBACK`) submitted by external game providers over both synchronous **HTTP** and asynchronous **AWS SQS** channels.

#### Problem Solved

In distributed iGaming environments, provider messages arrive under **at-least-once** delivery semantics: requests may be duplicated, delivered out of order (e.g., a `REFUND`, `ROLLBACK`, or `WIN` arriving before its referenced transaction), or processed concurrently by multiple application instances and background workers that may crash before or after database commits. This service guarantees financial integrity, deterministic replay, immutable auditing, and crash recovery without relying on in-memory locks or broker-only ordering.

#### Key Features

- **Unified Transactional Core:** HTTP and SQS entrypoints execute the exact same application use case (`ProcessWagerTransactionUseCase`) and canonical SHA-256 payload hashing rules.
- **Exact Decimal Arithmetic:** All monetary values use immutable `Money` domain objects backed by `decimal.js` (`NUMERIC(18,2)` in PostgreSQL, serialized as fixed 2-decimal strings) with zero floating-point conversion.
- **Database-Enforced Financial Invariants:** Pessimistic row-level locking (`SELECT ... FOR UPDATE` on `wallets`), non-negative and finite `CHECK` constraints (`Migration202611040001` and `Migration202611060001`), append-only ledger triggers, terminal state immutability triggers, and `DEFERRABLE INITIALLY DEFERRED` constraint triggers enforcing `wallets.balance == SUM(ledger)` at transaction commit.
- **Persistent Idempotency:** Deduplication across restarts and instances by `idempotency_key` and `(provider_id, external_transaction_id)` with historical balance snapshot preservation and conflict detection (`409 Conflict` on payload mismatch).
- **Out-of-Order Reference Resolution:** Dependent transactions whose referenced operation has not yet arrived are persisted as `PENDING_REFERENCE` and resolved asynchronously by `PendingReferenceWorker` with exponential backoff, configurable attempt/TTL limits, and deterministic terminalization (`FAILED` with `INFRASTRUCTURE_PERMANENT`) if a late credit overflows `NUMERIC(18,2)`.
- **Transactional Inbox & Outbox:** Atomic persistence of wallet updates, wager state, ledger entries, SQS Inbox claims, and integration events in a single PostgreSQL transaction, paired with lease-fenced concurrent Outbox publishing (`FOR UPDATE SKIP LOCKED`).

#### Technology Stack

| Layer | Technology | Version |
|---|---|---|
| Runtime, Package Manager & Test Runner | **Bun** | `1.4.4` (`>=1.4.4 <2`) |
| Language | **TypeScript** (`strict: true`, `exactOptionalPropertyTypes: true`) | `5.9.3` |
| Application Framework | **NestJS** (`@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`) | `11.1.6` |
| Relational Database | **PostgreSQL** | `16.6` |
| ORM & Migration Runner | **MikroORM** (`@mikro-orm/core`, `@mikro-orm/postgresql`, `@mikro-orm/migrations`, `@mikro-orm/nestjs`) | `6.6.8` / `6.1.1` |
| Messaging Broker | **AWS SQS** via **LocalStack** (`@aws-sdk/client-sqs`) | `4.10.0` / `3.922.0` |
| Decimal Arithmetic | **decimal.js** | `10.6.0` |
| Local Orchestration | **Docker Compose** | v2 |

#### Current Validation Status & Documentation Map

All implementation packages (`IMP-01` through `IMP-04`) and post-audit hardening packages (`FIX-D01`, `FIX-D02`, and `AUDIT-D03-FIX-01`) are complete and verified:

- **Consolidated Test Suite:** **1,274 passing tests** (`1,006` unit tests across `28` files + `268` integration tests across `16` files), **0 failures**, and **8,572 assertions**, plus `bun run typecheck` (`tsc --noEmit`).
- **Worker Metrics Export Evidence (`D04`):** [`AUDIT-D04-FIX-01-EVIDENCE.md`](AUDIT-D04-FIX-01-EVIDENCE.md)
- **Architecture & Design Decisions:** [`ARCHITECTURE.md`](ARCHITECTURE.md)
- **Consolidated Delivery Evidence (`FIX-D01` + `FIX-D02`):** [`FIX-D01-D02-FINAL-EVIDENCE.md`](FIX-D01-D02-FINAL-EVIDENCE.md)
- **PostgreSQL Monetary Finiteness Evidence (`FIX-D01`):** [`FIX-D01-EVIDENCE.md`](FIX-D01-EVIDENCE.md)
- **IMP-04 Delivery Evidence:** [`FINAL-DELIVERY-EVIDENCE.md`](FINAL-DELIVERY-EVIDENCE.md)
- **Historical Package Evidence:** [`IMP-01-EVIDENCE.md`](IMP-01-EVIDENCE.md), [`IMP-02-EVIDENCE.md`](IMP-02-EVIDENCE.md), [`IMP-03-EVIDENCE.md`](IMP-03-EVIDENCE.md)

---

### 2. Architecture

#### Modular Organization

```text
src/
├── main.ts                          # HTTP bootstrap entrypoint
├── app.module.ts                    # Root NestJS HTTP composition
├── database/                        # MikroORM config, EntitySchemas, PostgresUnitOfWork, versioned migrations
├── shared/
│   ├── domain/                      # Money, domain errors, validation primitives
│   ├── application/                 # FinancialUnitOfWork/FinancialStore ports, execution/retry policy,
│   │                                # structured logging, operational metrics, worker shutdown coordinator
│   └── infrastructure/              # HealthController, MetricsController, HttpExceptionFilter,
│                                    # CorrelationIdMiddleware, ProviderIdentityGuard (no-op extension point)
└── modules/
    ├── wallets/                     # Wallet aggregate, WalletLedgerEntry, WalletBalanceChanged event,
    │                                # CreateWalletUseCase, queries/reconciliation, WalletsController
    ├── wagering/                    # WagerTransaction aggregate, evaluateWager rules,FailureCode,
    │                                # wagering integration events, ProcessWagerTransactionUseCase,
    │                                # PendingReferenceWorker, WageringController
    └── messaging/                   # InboxMessage, OutboxMessage, SqsWagerConsumer, OutboxPublisher,
                                     # LocalStack SQS transport adapters and standalone worker lifecycles
scripts/
├── migrate.ts                       # Explicit CLI migration runner (up / down)
├── check-sqs.ts                     # Read-only verification of FIFO queues and RedrivePolicy
├── check-bootstrap.ts               # Ephemeral port HTTP bootstrap verification
├── consume-wagers.ts                # Standalone SQS Consumer worker entrypoint
├── publish-outbox.ts                # Standalone Outbox Publisher worker entrypoint
└── resolve-pending-references.ts    # Standalone Pending Reference worker entrypoint
```

#### Separation Between Domain, Application, and Infrastructure

- **Domain Layer (`*/domain`):** Pure TypeScript classes with private constructors, ECMAScript private fields (`#`), frozen instances, and explicit static factories (`create`, `open`, `from`, `enqueue`, `receive`, and `rehydrate`). Domain classes have zero dependencies on NestJS, MikroORM, or AWS SQS.
- **Application Layer (`*/application`):** Orchestrates domain rules inside transactional boundaries defined by `FinancialUnitOfWork` and `FinancialStore`, managing idempotency, retry classification, structured operational logs, and process metrics after transaction commit.
- **Infrastructure Layer (`src/database`, `*/infrastructure`):** Implements `PostgresUnitOfWork` using MikroORM `EntityManager.transactional()` with explicit parameterized SQL for lock ordering (`Wallet FOR UPDATE` -> `Inbox claim` -> `Wager/Reference lock`), NestJS HTTP controllers, and AWS SDK v3 SQS adapters.

#### HTTP, SQS, Inbox, Outbox, and Workers

1. **HTTP Channel (`src/main.ts`):** Validates DTOs and headers (`Idempotency-Key`), assigns/propagates `x-correlation-id`, and invokes wallet or wagering use cases.
2. **SQS Consumer (`scripts/consume-wagers.ts`):** Long-polls `wager-transactions.fifo`, claims `(consumer_name, message_id)` in `inbox_messages` inside the same PostgreSQL transaction as the wallet/wager/ledger/outbox writes, and executes `DeleteMessage` (ACK) **only after the database commit succeeds**. Permanent contract errors are forwarded to `wager-transactions-dlq.fifo` with a sanitized diagnostic payload before ACK; transient/unknown errors rely on visibility backoff and native SQS `RedrivePolicy` (`maxReceiveCount = 5`).
3. **Outbox Publisher (`scripts/publish-outbox.ts`):** Claims due rows in `outbox_messages` via `FOR UPDATE SKIP LOCKED` with a lease (`claim_owner`, `claim_token`, `claimed_until`), commits the claim, publishes the immutable event envelope to `wagering-events.fifo` (`MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`), and confirms `published_at` guarded by lease-fencing.
4. **Pending Reference Worker (`scripts/resolve-pending-references.ts`):** Scans due `PENDING_REFERENCE` wagers without holding row locks, then opens an isolated transaction per candidate locking `Wallet FOR UPDATE` -> `Wager FOR UPDATE` -> same-wallet `Reference FOR UPDATE` to either apply the movement, reject on invalid terminal reference or timeout (`REFERENCE_NOT_FOUND_TIMEOUT`), reschedule with exponential backoff, or terminalize as `FAILED` (`INFRASTRUCTURE_PERMANENT`) if the resulting wallet balance would exceed `NUMERIC(18,2)`.

---

### 3. Prerequisites

- **Bun:** `1.4.4` (`>=1.4.4 <2`)
- **Docker & Docker Compose:** Docker Engine with Compose v2 plugin
- **PostgreSQL `16.6` & LocalStack `4.10.0`:** Provided via [`docker-compose.yml`](docker-compose.yml):
  - `postgres` (development database `jungle_dev` bound to `127.0.0.1:5433`, persistent volume)
  - `postgres-test` (isolated test database `jungle_test` bound to `127.0.0.1:5434`, `tmpfs`, profile `test`)
  - `localstack` (SQS service bound to `127.0.0.1:4566`, auto-provisioning `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, and `wagering-events.fifo` via `docker/localstack/init`)

#### Environment Variables

| Variable | Default / Required | Description |
|---|---|---|
| `JUNGLE_DB_PASSWORD` | **Required** (Docker Compose) | Password for development PostgreSQL user (`jungle`) |
| `JUNGLE_TEST_DB_PASSWORD` | **Required** (`test` profile) | Password for test PostgreSQL user (`jungle_test`) |
| `DATABASE_URL` | **Required** (App & Workers) | PostgreSQL connection URL for development (`postgresql://jungle:<dev-password>@127.0.0.1:5433/jungle_dev`) |
| `TEST_DATABASE_URL` | **Required** (Integration Tests) | PostgreSQL connection URL for tests (`postgresql://jungle_test:<test-password>@127.0.0.1:5434/jungle_test`) |
| `PORT` | `3000` | HTTP server listening port (bound to `127.0.0.1` by default) |
| `SQS_ENDPOINT` | `http://127.0.0.1:4566` | LocalStack SQS endpoint URL |
| `AWS_REGION` | `us-east-1` | AWS region for SQS client |
| `SQS_INPUT_QUEUE_NAME` | `wager-transactions.fifo` | Input FIFO queue for wager commands |
| `SQS_DLQ_QUEUE_NAME` | `wager-transactions-dlq.fifo` | Dead-letter FIFO queue for input wager commands |
| `SQS_EVENTS_QUEUE_NAME` | `wagering-events.fifo` | Output FIFO queue for Outbox integration events |
| `SQS_CONSUMER_NAME` | `wager-transactions-consumer` | Logical consumer identity for Inbox deduplication (keep identical across instances) |
| `SQS_MAX_RECEIVE_COUNT` | `5` | Must match the input queue `RedrivePolicy.maxReceiveCount` |
| `SQS_WAIT_SECONDS` | `20` | SQS long-polling wait time (`1..20` seconds) |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `120` | SQS visibility timeout for in-flight messages |
| `OUTBOX_POLL_INTERVAL_MS` | `250` | Polling interval for `OutboxPublisher` |
| `OUTBOX_LEASE_MS` | `10000` | Lease duration for claimed Outbox rows (must exceed `SQS_SEND_TIMEOUT_MS` by at least `1000` ms) |
| `SQS_SEND_TIMEOUT_MS` | `3000` | Per-request timeout when publishing an Outbox event to SQS |
| `OUTBOX_BASE_RETRY_MS` / `OUTBOX_MAX_RETRY_MS` | `1000` / `60000` | Exponential backoff bounds for Outbox publish retries |
| `PENDING_REF_BASE_DELAY_MS` | `1000` | Initial retry delay for `PENDING_REFERENCE` wagers |
| `PENDING_REF_MAX_ATTEMPTS` | `10` | Maximum unavailable-reference checks before `REFERENCE_NOT_FOUND_TIMEOUT` |
| `PENDING_REF_TTL_MS` | `86400000` | Maximum waiting window (24 hours in ms) for unavailable references |
| `PENDING_REF_POLL_INTERVAL_MS` | `250` | Polling interval for `PendingReferenceWorker` |
| `PENDING_REF_BATCH_SIZE` | `100` | Maximum due candidates discovered per `PendingReferenceWorker` scan |
| `HEALTH_READINESS_TIMEOUT_MS` | `1500` | Timeout (`100..10000` ms) for `/health/ready` dependency probes |
| `WORKER_METRICS_INTERVAL_MS` | `10000` | Worker NDJSON snapshot interval in ms (`50..3600000`) |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | `60000` | Watchdog deadline (`1..300000` ms) covering worker drain and resource disposal |

---

### 4. Quickstart

#### 1. Clone the repository and install dependencies

```sh
git clone <repository-url>
cd Jungle
bun install --frozen-lockfile
```

#### 2. Configure the local environment

Export the environment variables in your shell (or place them in a local `.env` file ignored by Git, replacing `<dev-password>` and `<test-password>` with URL-safe values):

```dotenv
export JUNGLE_DB_PASSWORD=<dev-password>
export JUNGLE_TEST_DB_PASSWORD=<test-password>
export DATABASE_URL=postgresql://jungle:<dev-password>@127.0.0.1:5433/jungle_dev
export TEST_DATABASE_URL=postgresql://jungle_test:<test-password>@127.0.0.1:5434/jungle_test
export SQS_ENDPOINT=http://127.0.0.1:4566
export AWS_REGION=us-east-1
```

#### 3. Start Docker services (`postgres`, `postgres-test`, `localstack`)

```sh
docker compose --profile test up -d --wait postgres postgres-test localstack
```

#### 4. Run database migrations (development database) and verify SQS queues

```sh
bun run db:migrate
bun scripts/check-sqs.ts
```

> **Important Note on Migrations and Test Isolation:**
> - `bun run db:migrate` applies [`Migration202611040001`](src/database/migrations/Migration202611040001.ts) and [`Migration202611060001`](src/database/migrations/Migration202611060001.ts) to the target of `DATABASE_URL` (`jungle_dev`). Application processes never auto-run migrations on startup.
> - **Never run manual migrations against the `public` schema of `jungle_test` (port `5434`).** The `G6A` observability integration suite verifies that `jungle_test.public` is completely empty, while schema-dependent integration suites automatically create and drop their own isolated `jungle_it_<uuid>` schemas.
> - `bun run db:rollback` reverts a migration step and requires explicit confirmation via `JUNGLE_ALLOW_SCHEMA_ROLLBACK=yes` on a disposable target.

#### 5. Start the HTTP API and standalone workers

Open four terminal sessions with the same environment variables loaded:

```sh
# Terminal 1: HTTP API server (listens on http://127.0.0.1:3000; use `bun run dev` for watch mode)
bun run start

# Terminal 2: SQS Wager Consumer worker
bun scripts/consume-wagers.ts

# Terminal 3: Transactional Outbox Publisher worker
bun scripts/publish-outbox.ts

# Terminal 4: Pending Reference Resolution worker
bun scripts/resolve-pending-references.ts
```

#### 6. Run the verification suites

```sh
bun run typecheck
bun run test:unit
bun run test:integration
bun test
```

---

### 5. HTTP API Reference

#### Endpoint Summary

| Method | Path | Purpose | Success Status |
|---|---|---|---|
| `POST` | `/wallets` | Open a new player wallet for a given currency | `201 Created` |
| `GET` | `/wallets/:walletId` | Retrieve current wallet balance and version | `200 OK` |
| `GET` | `/wallets/:walletId/ledger` | List immutable wallet ledger entries with cursor pagination | `200 OK` |
| `POST` | `/wallets/:walletId/reconciliation` | Verify materialized wallet balance against exact ledger sum | `200 OK` |
| `POST` | `/wagering/transactions` | Submit a wagering transaction (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) | `200 OK` / `202 Accepted` |
| `GET` | `/wagering/transactions/:transactionId` | Retrieve a wager transaction by internal UUID | `200 OK` |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Retrieve a wager transaction by provider external identity | `200 OK` |
| `GET` | `/health/live` | Liveness probe (process responsive) | `200 OK` |
| `GET` | `/health/ready` | Readiness probe (PostgreSQL and SQS FIFO queues/RedrivePolicy verified) | `200 OK` (`503` when not ready) |
| `GET` | `/metrics` | Retrieve process-scoped operational metrics snapshot | `200 OK` |

#### Authentication & Correlation Headers

- **Authentication:** As explicitly permitted by Section 2 of the challenge specification to prioritize financial correctness and concurrency, external authentication is not implemented. [`ProviderIdentityGuard`](src/shared/infrastructure/provider-identity.guard.ts) is wired on `WalletsController` and `WageringController` as an explicit no-op extension point; the target OIDC/JWKS integration design (Keycloak/Zitadel) is documented in [`ARCHITECTURE.md`](ARCHITECTURE.md). Do not expose the local HTTP server as a public authenticated API without implementing `ProviderIdentityGuard`.
- **Correlation ID:** Every request accepts an optional valid `x-correlation-id` header (or generates a fresh UUID) and echoes `x-correlation-id` in the HTTP response headers.

#### 5.1 `POST /wallets` — Create Wallet

Creates a wallet for `(playerId, currency)`. When `initialBalance.amount > "0.00"`, atomically creates an internal `OPENING` transaction (`PROCESSED`), a `CREDIT` ledger entry, and two Outbox events (`WagerTransactionProcessed` and `WalletBalanceChanged`).

```sh
curl -sS -i http://127.0.0.1:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{
    "playerId": "player-demo",
    "initialBalance": { "amount": "100.00", "currency": "BRL" }
  }'
```

**Response (`201 Created`):**

```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "player-demo",
  "balance": { "amount": "100.00", "currency": "BRL" },
  "version": 1
}
```

- **Errors:** `400 Bad Request` (`INVALID_INPUT`, `INVALID_MONEY`, `MONEY_OVERFLOW`), `409 Conflict` (`WALLET_ALREADY_EXISTS` if `(playerId, currency)` already exists), `503 Service Unavailable` (`SERVICE_UNAVAILABLE`).

#### 5.2 `GET /wallets/:walletId` — Get Wallet

- **Path Parameter:** `walletId` (UUID).
- **Response (`200 OK`):** Same JSON structure as `POST /wallets`.
- **Errors:** `400 Bad Request` (`INVALID_INPUT` for malformed UUID), `404 Not Found` (`WALLET_NOT_FOUND`), `503 Service Unavailable`.

#### 5.3 `GET /wallets/:walletId/ledger` — List Wallet Ledger

Returns ledger entries ordered by `(created_at DESC, id DESC)` using an opaque `base64url` cursor encoding microsecond timestamp precision and entry UUID.

- **Query Parameters:** `limit` (optional integer `1..100`, default `50`), `cursor` (optional opaque string returned by previous page).

```sh
curl -sS "http://127.0.0.1:3000/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/ledger?limit=20"
```

**Response (`200 OK`):**

```json
{
  "entries": [
    {
      "id": "b7c0c8f0-48d9-4d40-965f-909638793a1d",
      "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
      "transactionId": "63d86e39-842b-4a56-9a3f-7a5804f1f001",
      "direction": "CREDIT",
      "money": { "amount": "100.00", "currency": "BRL" },
      "balanceBefore": { "amount": "0.00", "currency": "BRL" },
      "balanceAfter": { "amount": "100.00", "currency": "BRL" },
      "createdAt": "2026-11-06T09:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

- **Errors:** `400 Bad Request` (`INVALID_INPUT` on invalid UUID, cursor, limit, or unknown query parameter), `404 Not Found` (`WALLET_NOT_FOUND`), `503 Service Unavailable`.

#### 5.4 `POST /wallets/:walletId/reconciliation` — Reconcile Wallet Balance

Executes a read-only `REPEATABLE READ` comparison between `wallets.balance` and `COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0.00)` in `wallet_ledger_entries`. Accepts no query parameters and either no body or an empty JSON object (`{}`). Divergences are never silently repaired; they are logged, counted in metrics (`reconciliation.divergences`), and returned in the response.

```sh
curl -sS -X POST http://127.0.0.1:3000/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/reconciliation
```

**Response (`200 OK`):**

```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance": { "amount": "90.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "90.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 2
}
```

#### 5.5 `POST /wagering/transactions` — Submit Wager Transaction

Processes a provider wager operation. Requires **exactly one** non-empty, trimmed `Idempotency-Key` header.

- **Supported `kind` values:** `BET` (debit), `WIN` (credit, optional `referenceExternalTransactionId`), `LOSS` (`0.00` or positive amount, no balance movement), `REFUND` (credit reverting a `PROCESSED` `BET`, requires `referenceExternalTransactionId`), `ROLLBACK` (inverse movement reverting a `PROCESSED` `BET`, `WIN`, or `REFUND`, requires `referenceExternalTransactionId`). `OPENING` and `providerId: "SYSTEM"` are reserved for internal wallet creation and rejected with `400 Bad Request`.

```sh
curl -sS -i http://127.0.0.1:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-demo:bet-1' \
  -d '{
    "providerId": "provider-demo",
    "externalTransactionId": "bet-1",
    "playerId": "player-demo",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-1",
    "gameId": "game-1",
    "kind": "BET",
    "money": { "amount": "10.00", "currency": "BRL" }
  }'
```

**Response (`200 OK` for `PROCESSED`, `202 Accepted` for `PENDING_REFERENCE`, `422 Unprocessable Entity` for `REJECTED` or replay of terminal `FAILED`):**

```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "status": "PROCESSED",
  "balance": { "amount": "90.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

- When `status` is `REJECTED` or `FAILED` (`422 Unprocessable Entity`), the response includes `"failureCode"` (e.g., `"INSUFFICIENT_FUNDS_BET"`, `"INSUFFICIENT_FUNDS_REVERSAL"`, `"CURRENCY_MISMATCH"`, `"REFERENCE_NOT_FOUND_TIMEOUT"`, `"REFERENCE_INVALID_KIND"`, `"REFERENCE_CONTEXT_MISMATCH"`, `"REFERENCE_AMOUNT_MISMATCH"`, `"REFERENCE_NOT_PROCESSED"`, `"REFERENCE_ALREADY_REVERSED"`, or `"INFRASTRUCTURE_PERMANENT"`).
- **Idempotent Replay:** Repeating the same request returns the original status code (`200`, `202`, or `422`), the historical `balance` snapshot recorded when the transaction was evaluated, and `"idempotentReplay": true`.
- **Overflow During Pending Reference Resolution (`FIX-D02`):** If a `WIN`, `REFUND`, or `ROLLBACK` initially accepted as `PENDING_REFERENCE` later resolves when the wallet balance is near the `NUMERIC(18,2)` ceiling (`9999999999999999.99`) and the credit triggers `MoneyOverflowError`, `PendingReferenceWorker` terminalizes the wager as `FAILED` with `failureCode: "INFRASTRUCTURE_PERMANENT"`, records the observed balance snapshot, clears its retry schedule without altering wallet balance or ledger, and subsequent HTTP replays return `422 Unprocessable Entity`.
- **Errors:** `400 Bad Request` (`INVALID_INPUT`, `INVALID_MONEY`, `MONEY_OVERFLOW`), `404 Not Found` (`WALLET_NOT_FOUND`), `409 Conflict` (`IDEMPOTENCY_CONFLICT` if `Idempotency-Key` or `(providerId, externalTransactionId)` is reused with a different canonical payload hash or across different operations), `503 Service Unavailable` (`SERVICE_UNAVAILABLE`).

#### 5.6 `GET /wagering/transactions/:transactionId` & `GET /providers/:providerId/wagering/transactions/:externalTransactionId`

Retrieve a persisted wager transaction by internal `transactionId` (UUID) or by `(providerId, externalTransactionId)`.

**Response (`200 OK`):**

```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "providerId": "provider-demo",
  "externalTransactionId": "bet-1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "player-demo",
  "roundId": "round-1",
  "gameId": "game-1",
  "kind": "BET",
  "money": { "amount": "10.00", "currency": "BRL" },
  "status": "PROCESSED",
  "createdAt": "2026-11-06T09:01:00.000Z",
  "recordedBalance": { "amount": "90.00", "currency": "BRL" },
  "referenceExternalTransactionId": null,
  "referenceTransactionId": null,
  "failureCode": null,
  "processedAt": "2026-11-06T09:01:00.000Z"
}
```

- **External Identifier Preservation (`ARC2-02` & `AUDIT-D03-FIX-01`):** `:providerId` and `:externalTransactionId` are validated as required non-empty `TEXT` strings (`value.trim().length > 0`) and preserve their exact literal spelling (including URL-encoded peripheral whitespace when present, superseding the restrictive `IMP-04/CP-03` peripheral-whitespace path filter), matching `POST /wagering/transactions` and SQS consumption.
- **Errors:** `400 Bad Request` (`INVALID_INPUT`), `404 Not Found` (`WAGER_NOT_FOUND`), `503 Service Unavailable`.

#### 5.7 `GET /health/live`, `GET /health/ready`, and `GET /metrics`

- `GET /health/live` -> `200 OK` `{ "status": "ok" }`
- `GET /health/ready` -> `200 OK` `{ "status": "ready", "dependencies": { "postgres": "up", "sqs": "up" } }` or `503 Service Unavailable` (`"not_ready"` or `"draining"` during shutdown).
- `GET /metrics` -> `200 OK` returning `OperationalMetricsSnapshot` (`scope: "process"`). Neither `/health/*` nor `/metrics` accepts query parameters (`400 Bad Request`).

#### Standard HTTP Error Envelope

All non-2xx errors thrown through [`HttpExceptionFilter`](src/shared/infrastructure/http-exception.filter.ts) return a sanitized JSON body with stable machine-readable codes:

```json
{
  "code": "IDEMPOTENCY_CONFLICT",
  "message": "Idempotency conflict"
}
```

---

### 6. Testing

#### Test Commands

```sh
# Static type checking (TypeScript 5.9.3 strict mode)
bun run typecheck

# Unit tests only (1,006 tests across 28 files; no Docker containers required)
bun run test:unit

# Integration tests only (268 tests across 16 files; requires postgres-test on 5434 and LocalStack on 4566)
bun run test:integration

# Full test suite (1,274 tests across 44 files; 8,572 assertions)
bun test

# Check working tree for whitespace or conflict markers
git diff --check
```

#### Test Categories and Coverage

1. **Unit Tests (`test/unit/*.test.ts` — 1,006 tests, 28 files):**
   - `Money` precision, scale validation, currency mismatch rejection, and `NUMERIC(18,2)` overflow bounds.
   - `Wallet` opening, debit/credit transitions, version increments, and `WalletLedgerEntry` balance arithmetic.
   - `WagerTransaction` state machine transitions, `evaluateWager` business rules for `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`, chained reversals, and canonical payload hashing.
   - `InboxMessage`, `OutboxMessage` backoff calculations, `SqsWagerConsumer`, `OutboxPublisher`, and `PendingReferenceWorker` unit behavior (including `D02` overflow terminalization).
   - HTTP controllers, DTO validators, exception filter mapping, health readiness state machine, structured logging sanitization, and operational metrics reducers/saturation.
2. **PostgreSQL Schema, Monetary Integrity & Financial Integration Tests (`test/integration/schema.test.ts`, `monetary-integrity.test.ts`, `financial.test.ts`):**
   - Full `up -> down -> up` migration cycles in isolated `jungle_it_<uuid>` schemas.
   - Direct SQL rejection of negative balances, `NaN`/`±Infinity` across all 6 monetary columns (`FIX-D01`), ledger `UPDATE`/`DELETE`, terminal wager mutation, orphaned processed wagers without ledger entries, and duplicate reversals.
   - Atomic rollback across all 5 tables (`wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages`, `outbox_messages`) at every failure checkpoint (`wallet`, `wager`, `ledger`, `outbox`, `inbox`, `beforeCommit`).
   - 50 concurrent identical requests producing 1 debit and 49 idempotent replays; two concurrent `80.00 BRL` bets on a `100.00 BRL` wallet producing 1 `PROCESSED` (`20.00 BRL` final balance) and 1 `REJECTED` (`INSUFFICIENT_FUNDS_BET`).
3. **Multiprocess, SQS, Outbox, Pending Reference & Crash Recovery Tests (`test/integration/multiprocess.test.ts`, `sqs-consumer.test.ts`, `outbox-publisher.test.ts`, `pending-reference-worker.test.ts`, `worker-resilience.test.ts`, `worker-entrypoints.test.ts`):**
   - `>= 3` independent `bun` OS child processes with separate PostgreSQL backend PIDs contending on the same wallet, racing identical idempotency keys across distinct wallets, publishing 100 Outbox events without loss, and resolving out-of-order references.
   - Real `SIGTERM` and `SIGKILL` recovery: worker killed after database commit and before SQS `DeleteMessage`, publisher killed after `SendMessage` and before SQL confirmation, lease expiration and fencing of stale owners, and multiprocess restart after `FAILED` overflow terminalization (`REV-D02-01/02`).
4. **HTTP & Observability Integration Tests (`test/integration/wallet-http.test.ts`, `wager-http.test.ts`, `observability-http.test.ts`, `structured-logging.test.ts`, `operational-metrics.test.ts`):**
   - End-to-end HTTP contracts, `G6A` (`18` `NO_MIGRATION` scenarios verifying DI graph identity, empty `jungle_test.public`, blocked `Migrator.up`, and deterministic SQS queue cleanup), and `G6B` (`2` `MIGRATION_REQUIRED` scenarios verifying metrics emission across real PostgreSQL commit, rollback, and retry).

#### Targeted Execution Examples

```sh
bun test test/integration/monetary-integrity.test.ts test/integration/schema.test.ts test/integration/financial.test.ts
bun test test/integration/multiprocess.test.ts test/integration/worker-resilience.test.ts test/integration/worker-entrypoints.test.ts
bun test test/integration/sqs-consumer.test.ts test/integration/outbox-publisher.test.ts test/integration/pending-reference-worker.test.ts
bun test test/integration/operational-metrics.test.ts --test-name-pattern NO_MIGRATION
bun test test/integration/operational-metrics.test.ts --test-name-pattern MIGRATION_REQUIRED
```

#### Test Isolation Requirements

- Integration suites require `postgres-test` on `127.0.0.1:5434` (`jungle_test`) and `localstack` on `127.0.0.1:4566`. If either service is unreachable, tests fail explicitly rather than skipping assertions.
- Every relational integration test creates and drops its own `jungle_it_<uuid>` schema inside `jungle_test`. `jungle_test.public` remains empty (`0` tables).
- Every SQS integration test creates and deletes its own `jungle_it_<uuid>_*.fifo` queues while preserving the three pre-existing queues (`wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wagering-events.fifo`).

---

### 7. Observability

#### Structured Operational Logs

- Emitted as single-line JSON records to `stderr` via [`stderrOperationalLog`](src/shared/application/operational-logging.ts).
- Includes correlation fields (`component`, `event`, `level`, `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `status`, `code`, `idempotentReplay`, `consistent`, `checkedEntries`, `attempt`).
- Automatically redacts sensitive keys (`password`, `secret`, `token`, `authorization`, `cookie`, `receiptHandle`, URL credentials, and AWS access key patterns) and omits raw financial amounts or full request payloads.
- Defensive non-blocking boundary: logger throws, rejected promises, or reentrant calls never alter the outcome of a financial operation.

#### Operational Metrics (`GET /metrics`)

Exposes a deep-frozen JSON snapshot (`scope: "process"`) maintained by [`DefaultOperationalMetricsCollector`](src/shared/application/operational-metrics.ts):

- `transactionsByStatus`: `{ PROCESSED, REJECTED, PENDING_REFERENCE, FAILED }` (counted only after transaction commit, excluding idempotent replays).
- `duplicates`: `{ replays, conflicts }`.
- `retries`: `{ wagerUow, walletUow, pendingReference, sqsConsumer, outboxPublisher }`.
- `dlq`: `{ confirmedTransfers }` (manual permanent-error transfers confirmed via `SendMessage` to DLQ + `DeleteMessage` on source queue).
- `concurrencyConflicts`: `{ total, byCode: { "40P01", "40001", "55P03", "57014", "23505" } }`.
- `outboxLagMs` & `processingDurationMs`: `{ count, totalMs, minMs, maxMs, lastMs, buckets: { le5Ms, le10Ms, le25Ms, le50Ms, le100Ms, le250Ms, le500Ms, le1000Ms, gt1000Ms } }`.
- `reconciliation`: `{ divergences }`.
- `pendingReference`: `{ processed, rejected, rescheduled }`.

#### Standalone Worker Metrics (NDJSON on stderr)

Each standalone consumer, Outbox publisher and pending-reference worker exports its **own existing collector** as one JSON object per line on `stderr`. Filter records by `type: "OperationalMetricsSnapshot"`; operational event logs continue to share the stream. The envelope is:

```ts
type WorkerMetricsEnvelope = {
  type: 'OperationalMetricsSnapshot',
  version: 1,
  component: 'sqs-consumer' | 'outbox-publisher' | 'pending-reference-worker',
  executionId: string, // fresh UUID for this reporter execution
  pid: number,
  timestamp: string,   // ISO-8601 UTC sampling time
  snapshot: OperationalMetricsSnapshot // complete existing process-scoped JSON contract above
}
```

`WORKER_METRICS_INTERVAL_MS` defaults to `10000` ms (allowed range `50..3600000`). A snapshot is attempted after worker composition succeeds, then periodically and best-effort on graceful shutdown. Identical successfully written snapshots are skipped. Counters are cumulative observations since that process/context started; they reset on restart and are **not** a census of current database rows. Use `executionId` to distinguish resets, and compute deltas instead of summing successive cumulative snapshots.

The reporter permits at most one pending write and retains no sample queue. While that write is pending, new samples are skipped before reading the collector. Exceptions and rejected writes are contained; a write that never settles suppresses further samples from that reporter without blocking financial work or shutdown. A later successful sample includes the collector's accumulated counters, but intermediate exported records can be lost. Delivery is best-effort, with no persistence or cross-process aggregation. `GET /metrics` continues to expose **only the serving HTTP process**.

#### Health and Readiness Checks

- `GET /health/live`: Confirms the HTTP event loop is responsive (`200 OK`).
- `GET /health/ready`: Executes concurrent bounded probes (`HEALTH_READINESS_TIMEOUT_MS`, default `1500` ms) against PostgreSQL (`SELECT 1`) and LocalStack SQS (verifying existence, `FifoQueue === "true"`, `QueueArn`, and `RedrivePolicy` linking `wager-transactions.fifo` to `wager-transactions-dlq.fifo` with `maxReceiveCount`). Transitions immediately to `503 Service Unavailable` (`status: "draining"`) when application shutdown begins.

---

### 8. Final Considerations and Known Limitations

#### Technical Highlights

- **Defense-in-Depth Monetary Integrity:** Precision is enforced simultaneously at the TypeScript type/domain boundary (`Money` + `ExactNumericType`) and at the PostgreSQL physical storage layer (`NUMERIC(18,2)`, `ck_wallet_all_finite`, `ck_wager_all_finite`, `ck_ledger_all_finite`, and deferred balance-reconciliation constraint triggers).
- **Deterministic Convergence of Out-of-Order Operations:** `PendingReferenceWorker` guarantees that every `PENDING_REFERENCE` wager converges to a terminal state (`PROCESSED`, `REJECTED`, or `FAILED` on `NUMERIC(18,2)` credit overflow) without blocking healthy candidates or entering infinite retry loops.
- **Zero-Trust Concurrency Testing:** Validated with real PostgreSQL `40P01` deadlock/serialization retries, multi-process child workers, and mid-flight process termination (`SIGTERM`/`SIGKILL`).

#### Known Operational Limitations

1. **Authentication Not Implemented (By Design):** `ProviderIdentityGuard` is a no-op extension point as permitted by the challenge specification; external OIDC/JWKS validation must be enabled before exposing HTTP endpoints to untrusted networks.
2. **Process-Local Volatile Metrics:** `GET /metrics` reports in-memory metrics for the serving HTTP process (`scope: "process"`). Standalone worker processes (`consume-wagers.ts`, `publish-outbox.ts`, `resolve-pending-references.ts`) export their own in-process collectors as NDJSON on stderr; no external time-series aggregator or persistent metrics store is provided.
3. **At-Least-Once Outbox Delivery:** `OutboxPublisher` guarantees at-least-once publication to `wagering-events.fifo`. Downstream consumers must deduplicate integration events by `eventId`.
4. **Mixed DLQ Message Envelopes:** `wager-transactions-dlq.fifo` may receive either sanitized `WagerTransactionDeadLetter` diagnostic envelopes (for permanent contract errors) or original `WagerTransactionRequested` payloads (via native SQS `RedrivePolicy` after `maxReceiveCount` transient/unknown failures). Operators must inspect message `type` before replaying DLQ items and never replay a diagnostic envelope as a financial command.
5. **TypeScript `skipLibCheck`:** Following Bun's official TypeScript configuration guidance, `skipLibCheck: true` is enabled in `tsconfig.json` to avoid transitive declaration conflicts between `@types/bun` and `@types/node`, while full strict checking (`strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`) is enforced across all project source, script, and test files.

---

<a id="português"></a>

## Português

### Sumário

1. [Visão Geral](#1-visão-geral)
2. [Arquitetura](#2-arquitetura)
3. [Pré-requisitos](#3-pré-requisitos)
4. [Quickstart](#4-quickstart-1)
5. [Referência da API HTTP](#5-referência-da-api-http)
6. [Testes](#6-testes)
7. [Observabilidade](#7-observabilidade)
8. [Considerações Finais e Limitações Conhecidas](#8-considerações-finais-e-limitações-conhecidas)

---

### 1. Visão Geral

#### Objetivo do Projeto

O **Distributed Wagering Processor** é um serviço distribuído de processamento de transações financeiras desenvolvido para o desafio técnico da Jungle Gaming ([`technical-challenge.md`](technical-challenge.md)). Ele processa operações de carteira de iGaming em tempo real (`BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`) enviadas por provedores de jogos tanto de forma síncrona via **HTTP** quanto assíncrona via **AWS SQS**.

#### Problema Resolvido

Em ambientes distribuídos de iGaming, mensagens de provedores são entregues sob semântica **at-least-once**: requisições podem chegar duplicadas, fora de ordem (por exemplo, um `REFUND`, `ROLLBACK` ou `WIN` chegando antes da transação referenciada) ou ser processadas simultaneamente por múltiplas instâncias da aplicação e workers que podem sofrer falhas antes ou depois do commit no banco de dados. Este serviço garante integridade financeira, replay determinístico, auditoria imutável em ledger e recuperação após falhas sem depender de locks em memória ou apenas da ordenação do broker.

#### Principais Características

- **Núcleo Transacional Unificado:** As entradas HTTP e SQS executam exatamente o mesmo caso de uso (`ProcessWagerTransactionUseCase`) e as mesmas regras de canonicalização e hash SHA-256 de payload.
- **Aritmética Decimal Exata:** Todos os valores monetários utilizam objetos de domínio imutáveis `Money` baseados em `decimal.js` (`NUMERIC(18,2)` no PostgreSQL, serializados como strings decimais fixas com 2 casas), sem qualquer conversão para ponto flutuante (`number`).
- **Invariantes Financeiras Impostas pelo Banco de Dados:** Locks pessimistas por linha (`SELECT ... FOR UPDATE` em `wallets`), constraints `CHECK` de não-negatividade e finitude (`Migration202611040001` e `Migration202611060001`), triggers de ledger append-only, triggers de imutabilidade de estados terminais e constraint triggers `DEFERRABLE INITIALLY DEFERRED` que exigem `wallets.balance == SUM(ledger)` no commit.
- **Idempotência Persistente:** Deduplicação entre reinicializações e múltiplas instâncias por `idempotency_key` e `(provider_id, external_transaction_id)`, preservando o snapshot histórico de saldo e detectando conflitos de payload (`409 Conflict`).
- **Resolução de Referências Fora de Ordem:** Transações dependentes cuja operação referenciada ainda não chegou são persistidas como `PENDING_REFERENCE` e resolvidas assincronamente pelo `PendingReferenceWorker` com backoff exponencial, limites configuráveis de tentativas/TTL e terminalização determinística (`FAILED` com `INFRASTRUCTURE_PERMANENT`) caso um crédito tardio exceda `NUMERIC(18,2)`.
- **Transactional Inbox e Outbox:** Persistência atômica de atualização de carteira, estado da aposta, entrada no ledger, claim da Inbox SQS e eventos de integração em uma única transação PostgreSQL, combinada com publicação concorrente da Outbox protegida por lease e fencing (`FOR UPDATE SKIP LOCKED`).

#### Tecnologias Utilizadas

| Camada | Tecnologia | Versão |
|---|---|---|
| Runtime, Gerenciador de Pacotes e Test Runner | **Bun** | `1.4.4` (`>=1.4.4 <2`) |
| Linguagem | **TypeScript** (`strict: true`, `exactOptionalPropertyTypes: true`) | `5.9.3` |
| Framework de Aplicação | **NestJS** (`@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`) | `11.1.6` |
| Banco de Dados Relacional | **PostgreSQL** | `16.6` |
| ORM e Executor de Migrations | **MikroORM** (`@mikro-orm/core`, `@mikro-orm/postgresql`, `@mikro-orm/migrations`, `@mikro-orm/nestjs`) | `6.6.8` / `6.1.1` |
| Mensageria | **AWS SQS** via **LocalStack** (`@aws-sdk/client-sqs`) | `4.10.0` / `3.922.0` |
| Aritmética Decimal | **decimal.js** | `10.6.0` |
| Orquestração Local | **Docker Compose** | v2 |

#### Estado Atual da Validação e Mapa Documental

Todos os pacotes de implementação (`IMP-01` a `IMP-04`) e as correções pós-auditoria (`FIX-D01`, `FIX-D02` e `AUDIT-D03-FIX-01`) estão concluídos e verificados:

- **Suíte Consolidada de Testes:** **1.274 testes aprovados** (`1.006` unitários em `28` arquivos + `268` de integração em `16` arquivos), **0 falhas** e **8.572 asserções**, além de `bun run typecheck` (`tsc --noEmit`).
- **Evidência de Exportação de Métricas (`D04`):** [`AUDIT-D04-FIX-01-EVIDENCE.md`](AUDIT-D04-FIX-01-EVIDENCE.md)
- **Arquitetura e Decisões Técnicas:** [`ARCHITECTURE.md`](ARCHITECTURE.md)
- **Evidência Consolidada da Entrega (`FIX-D01` + `FIX-D02`):** [`FIX-D01-D02-FINAL-EVIDENCE.md`](FIX-D01-D02-FINAL-EVIDENCE.md)
- **Evidência de Finitude Monetária no PostgreSQL (`FIX-D01`):** [`FIX-D01-EVIDENCE.md`](FIX-D01-EVIDENCE.md)
- **Evidência de Entrega do IMP-04:** [`FINAL-DELIVERY-EVIDENCE.md`](FINAL-DELIVERY-EVIDENCE.md)
- **Evidências Históricas por Pacote:** [`IMP-01-EVIDENCE.md`](IMP-01-EVIDENCE.md), [`IMP-02-EVIDENCE.md`](IMP-02-EVIDENCE.md), [`IMP-03-EVIDENCE.md`](IMP-03-EVIDENCE.md)

---

### 2. Arquitetura

#### Organização Modular

```text
src/
├── main.ts                          # Entrypoint de bootstrap HTTP
├── app.module.ts                    # Composição raiz NestJS HTTP
├── database/                        # Configuração MikroORM, EntitySchemas, PostgresUnitOfWork, migrations versionadas
├── shared/
│   ├── domain/                      # Money, erros de domínio, primitivas de validação
│   ├── application/                 # Portas FinancialUnitOfWork/FinancialStore, política de execução/retry,
│   │                                # logs estruturados, métricas operacionais, coordenador de shutdown de workers
│   └── infrastructure/              # HealthController, MetricsController, HttpExceptionFilter,
│                                    # CorrelationIdMiddleware, ProviderIdentityGuard (ponto de extensão no-op)
└── modules/
    ├── wallets/                     # Agregado Wallet, WalletLedgerEntry, evento WalletBalanceChanged,
    │                                # CreateWalletUseCase, consultas/reconciliação, WalletsController
    ├── wagering/                    # Agregado WagerTransaction, regras evaluateWager, FailureCode,
    │                                # eventos de integração, ProcessWagerTransactionUseCase,
    │                                # PendingReferenceWorker, WageringController
    └── messaging/                   # InboxMessage, OutboxMessage, SqsWagerConsumer, OutboxPublisher,
                                     # adaptadores de transporte SQS LocalStack e lifecycles dos workers standalone
scripts/
├── migrate.ts                       # Executor explícito de migrations via CLI (up / down)
├── check-sqs.ts                     # Verificação read-only das filas FIFO e RedrivePolicy
├── check-bootstrap.ts               # Verificação de bootstrap HTTP em porta efêmera
├── consume-wagers.ts                # Entrypoint standalone do worker SQS Consumer
├── publish-outbox.ts                # Entrypoint standalone do worker Outbox Publisher
└── resolve-pending-references.ts    # Entrypoint standalone do worker Pending Reference
```

#### Separação entre Domínio, Aplicação e Infraestrutura

- **Camada de Domínio (`*/domain`):** Classes TypeScript puras com construtores privados, campos privados ECMAScript (`#`), instâncias congeladas (`Object.freeze`) e factories estáticas explícitas (`create`, `open`, `from`, `enqueue`, `receive` e `rehydrate`). As classes de domínio não possuem dependências de NestJS, MikroORM ou AWS SQS.
- **Camada de Aplicação (`*/application`):** Orquestra as regras de domínio dentro de limites transacionais definidos por `FinancialUnitOfWork` e `FinancialStore`, gerenciando idempotência, classificação de retries, logs operacionais estruturados e métricas de processo após o commit transacional.
- **Camada de Infraestrutura (`src/database`, `*/infrastructure`):** Implementa `PostgresUnitOfWork` utilizando `EntityManager.transactional()` do MikroORM com SQL parametrizado explícito para impor a ordem estrita de locks (`Wallet FOR UPDATE` -> `Inbox claim` -> `Wager/Reference lock`), controllers HTTP NestJS e adaptadores AWS SDK v3 SQS.

#### Processamento HTTP, SQS, Inbox, Outbox e Workers

1. **Canal HTTP (`src/main.ts`):** Valida DTOs e cabeçalhos (`Idempotency-Key`), atribui/propaga `x-correlation-id` e invoca os casos de uso de carteira ou apostas.
2. **SQS Consumer (`scripts/consume-wagers.ts`):** Executa long polling em `wager-transactions.fifo`, registra `(consumer_name, message_id)` em `inbox_messages` na mesma transação PostgreSQL das escritas de wallet/wager/ledger/outbox e executa `DeleteMessage` (ACK) **somente após a confirmação do commit no banco**. Erros permanentes de contrato são transferidos para `wager-transactions-dlq.fifo` com um envelope de diagnóstico sanitizado antes do ACK; falhas transitórias ou desconhecidas usam backoff de visibilidade e `RedrivePolicy` nativa do SQS (`maxReceiveCount = 5`).
3. **Outbox Publisher (`scripts/publish-outbox.ts`):** Reivindica eventos pendentes em `outbox_messages` via `FOR UPDATE SKIP LOCKED` com lease (`claim_owner`, `claim_token`, `claimed_until`), confirma o claim, publica o envelope imutável em `wagering-events.fifo` (`MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`) e confirma `published_at` protegido por fencing de lease.
4. **Pending Reference Worker (`scripts/resolve-pending-references.ts`):** Varre transações `PENDING_REFERENCE` vencidas sem manter locks de linha e, para cada candidata, abre uma transação isolada adquirindo `Wallet FOR UPDATE` -> `Wager FOR UPDATE` -> `Reference FOR UPDATE` (quando da mesma carteira) para aplicar o movimento, rejeitar por referência terminal inválida ou timeout (`REFERENCE_NOT_FOUND_TIMEOUT`), reagendar com backoff exponencial ou terminalizar como `FAILED` (`INFRASTRUCTURE_PERMANENT`) caso o saldo resultante exceda `NUMERIC(18,2)`.

---

### 3. Pré-requisitos

- **Bun:** `1.4.4` (`>=1.4.4 <2`)
- **Docker e Docker Compose:** Docker Engine com plugin Compose v2
- **PostgreSQL `16.6` e LocalStack `4.10.0`:** Provisionados via [`docker-compose.yml`](docker-compose.yml):
  - `postgres` (banco de desenvolvimento `jungle_dev` em `127.0.0.1:5433`, volume persistente)
  - `postgres-test` (banco isolado de testes `jungle_test` em `127.0.0.1:5434`, `tmpfs`, profile `test`)
  - `localstack` (serviço SQS em `127.0.0.1:4566`, provisionando automaticamente `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wagering-events.fifo` via `docker/localstack/init`)

#### Variáveis de Ambiente

| Variável | Default / Obrigatoriedade | Descrição |
|---|---|---|
| `JUNGLE_DB_PASSWORD` | **Obrigatória** (Docker Compose) | Senha do usuário PostgreSQL de desenvolvimento (`jungle`) |
| `JUNGLE_TEST_DB_PASSWORD` | **Obrigatória** (profile `test`) | Senha do usuário PostgreSQL de testes (`jungle_test`) |
| `DATABASE_URL` | **Obrigatória** (App e Workers) | URL de conexão PostgreSQL de desenvolvimento (`postgresql://jungle:<senha-dev>@127.0.0.1:5433/jungle_dev`) |
| `TEST_DATABASE_URL` | **Obrigatória** (Testes de Integração) | URL de conexão PostgreSQL de testes (`postgresql://jungle_test:<senha-teste>@127.0.0.1:5434/jungle_test`) |
| `PORT` | `3000` | Porta de escuta do servidor HTTP (vinculado a `127.0.0.1` por padrão) |
| `SQS_ENDPOINT` | `http://127.0.0.1:4566` | URL do endpoint SQS no LocalStack |
| `AWS_REGION` | `us-east-1` | Região AWS para o cliente SQS |
| `SQS_INPUT_QUEUE_NAME` | `wager-transactions.fifo` | Fila FIFO de entrada de transações de apostas |
| `SQS_DLQ_QUEUE_NAME` | `wager-transactions-dlq.fifo` | Fila FIFO Dead-Letter da fila de entrada |
| `SQS_EVENTS_QUEUE_NAME` | `wagering-events.fifo` | Fila FIFO de saída para eventos de integração da Outbox |
| `SQS_CONSUMER_NAME` | `wager-transactions-consumer` | Identidade lógica do consumidor na Inbox (manter igual entre instâncias) |
| `SQS_MAX_RECEIVE_COUNT` | `5` | Deve coincidir com `RedrivePolicy.maxReceiveCount` da fila de entrada |
| `SQS_WAIT_SECONDS` | `20` | Tempo de espera do long polling SQS (`1..20` segundos) |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `120` | Visibility timeout SQS para mensagens em processamento |
| `OUTBOX_POLL_INTERVAL_MS` | `250` | Intervalo de polling do `OutboxPublisher` |
| `OUTBOX_LEASE_MS` | `10000` | Duração do lease da Outbox (deve exceder `SQS_SEND_TIMEOUT_MS` em pelo menos `1000` ms) |
| `SQS_SEND_TIMEOUT_MS` | `3000` | Timeout por requisição ao publicar evento da Outbox no SQS |
| `OUTBOX_BASE_RETRY_MS` / `OUTBOX_MAX_RETRY_MS` | `1000` / `60000` | Limites do backoff exponencial de retentativas da Outbox |
| `PENDING_REF_BASE_DELAY_MS` | `1000` | Atraso inicial de retentativa para transações `PENDING_REFERENCE` |
| `PENDING_REF_MAX_ATTEMPTS` | `10` | Número máximo de verificações de referência indisponível antes de `REFERENCE_NOT_FOUND_TIMEOUT` |
| `PENDING_REF_TTL_MS` | `86400000` | Janela máxima de espera (24 horas em ms) por referência indisponível |
| `PENDING_REF_POLL_INTERVAL_MS` | `250` | Intervalo de polling do `PendingReferenceWorker` |
| `PENDING_REF_BATCH_SIZE` | `100` | Limite de candidatos vencidos lidos por varredura do `PendingReferenceWorker` |
| `HEALTH_READINESS_TIMEOUT_MS` | `1500` | Timeout (`100..10000` ms) das sondas de dependências em `/health/ready` |
| `WORKER_METRICS_INTERVAL_MS` | `10000` | Intervalo de snapshots NDJSON dos workers em ms (`50..3600000`) |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | `60000` | Prazo do watchdog (`1..300000` ms) cobrindo drenagem e fechamento de recursos dos workers |

---

### 4. Quickstart

#### 1. Clonar o repositório e instalar dependências

```sh
git clone <repository-url>
cd Jungle
bun install --frozen-lockfile
```

#### 2. Configurar o ambiente local

Exporte as variáveis no shell (ou defina em arquivo `.env` local ignorado pelo Git, substituindo `<senha-dev>` e `<senha-teste>` por valores codificados para URL):

```dotenv
export JUNGLE_DB_PASSWORD=<senha-dev>
export JUNGLE_TEST_DB_PASSWORD=<senha-teste>
export DATABASE_URL=postgresql://jungle:<senha-dev>@127.0.0.1:5433/jungle_dev
export TEST_DATABASE_URL=postgresql://jungle_test:<senha-teste>@127.0.0.1:5434/jungle_test
export SQS_ENDPOINT=http://127.0.0.1:4566
export AWS_REGION=us-east-1
```

#### 3. Inicializar serviços Docker (`postgres`, `postgres-test`, `localstack`)

```sh
docker compose --profile test up -d --wait postgres postgres-test localstack
```

#### 4. Executar migrations no banco de desenvolvimento e verificar filas SQS

```sh
bun run db:migrate
bun scripts/check-sqs.ts
```

> **Nota Importante sobre Migrations e Isolamento de Testes:**
> - `bun run db:migrate` aplica [`Migration202611040001`](src/database/migrations/Migration202611040001.ts) e [`Migration202611060001`](src/database/migrations/Migration202611060001.ts) no destino de `DATABASE_URL` (`jungle_dev`). Os processos da aplicação nunca aplicam migrations automaticamente na inicialização.
> - **Nunca execute migrations manuais no schema `public` de `jungle_test` (porta `5434`).** A suíte de integração `G6A` exige que `jungle_test.public` esteja completamente vazio, enquanto os testes que utilizam banco criam e removem automaticamente seus próprios schemas exclusivos `jungle_it_<uuid>`.
> - `bun run db:rollback` reverte um passo de migration e exige confirmação explícita via `JUNGLE_ALLOW_SCHEMA_ROLLBACK=yes` em banco descartável autorizado.

#### 5. Inicializar a aplicação HTTP e os workers standalone

Abra quatro terminais com as mesmas variáveis de ambiente carregadas:

```sh
# Terminal 1: Servidor HTTP (escuta em http://127.0.0.1:3000; use `bun run dev` para modo watch)
bun run start

# Terminal 2: Worker SQS Consumer
bun scripts/consume-wagers.ts

# Terminal 3: Worker Transactional Outbox Publisher
bun scripts/publish-outbox.ts

# Terminal 4: Worker de resolução de referências pendentes
bun scripts/resolve-pending-references.ts
```

#### 6. Executar as suítes de validação

```sh
bun run typecheck
bun run test:unit
bun run test:integration
bun test
```

---

### 5. Referência da API HTTP

#### Resumo dos Endpoints

| Método | Caminho | Finalidade | Status de Sucesso |
|---|---|---|---|
| `POST` | `/wallets` | Criar uma nova carteira para um jogador e moeda | `201 Created` |
| `GET` | `/wallets/:walletId` | Consultar saldo atual e versão da carteira | `200 OK` |
| `GET` | `/wallets/:walletId/ledger` | Listar entradas imutáveis do ledger paginadas por cursor | `200 OK` |
| `POST` | `/wallets/:walletId/reconciliation` | Reconciliar saldo materializado da carteira contra a soma exata do ledger | `200 OK` |
| `POST` | `/wagering/transactions` | Submeter transação de aposta (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) | `200 OK` / `202 Accepted` |
| `GET` | `/wagering/transactions/:transactionId` | Consultar transação pelo UUID interno | `200 OK` |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consultar transação pela identidade externa no provedor | `200 OK` |
| `GET` | `/health/live` | Sonda de liveness (processo ativo) | `200 OK` |
| `GET` | `/health/ready` | Sonda de readiness (PostgreSQL e filas FIFO/RedrivePolicy do SQS verificados) | `200 OK` (`503` quando indisponível) |
| `GET` | `/metrics` | Consultar snapshot JSON de métricas operacionais do processo HTTP | `200 OK` |

#### Autenticação e Cabeçalhos de Correlação

- **Autenticação:** Conforme permitido explicitamente pela Seção 2 do enunciado técnico para priorizar correção financeira e concorrência, autenticação externa não foi implementada. O [`ProviderIdentityGuard`](src/shared/infrastructure/provider-identity.guard.ts) está registrado em `WalletsController` e `WageringController` como ponto de extensão no-op explícito; o desenho de integração futura via OIDC/JWKS (Keycloak/Zitadel) está documentado em [`ARCHITECTURE.md`](ARCHITECTURE.md). A aplicação local não deve ser exposta como API pública autenticada sem implementar o `ProviderIdentityGuard`.
- **Correlation ID:** Todas as requisições aceitam o cabeçalho opcional `x-correlation-id` (ou geram um novo UUID) e devolvem `x-correlation-id` nos cabeçalhos da resposta HTTP.

#### 5.1 `POST /wallets` — Criar Carteira

Cria uma carteira para `(playerId, currency)`. Quando `initialBalance.amount > "0.00"`, persiste atomicamente uma transação interna `OPENING` (`PROCESSED`), um lançamento `CREDIT` no ledger e dois eventos na Outbox (`WagerTransactionProcessed` e `WalletBalanceChanged`).

```sh
curl -sS -i http://127.0.0.1:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{
    "playerId": "player-demo",
    "initialBalance": { "amount": "100.00", "currency": "BRL" }
  }'
```

**Resposta (`201 Created`):**

```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "player-demo",
  "balance": { "amount": "100.00", "currency": "BRL" },
  "version": 1
}
```

- **Erros:** `400 Bad Request` (`INVALID_INPUT`, `INVALID_MONEY`, `MONEY_OVERFLOW`), `409 Conflict` (`WALLET_ALREADY_EXISTS` se `(playerId, currency)` já existir), `503 Service Unavailable` (`SERVICE_UNAVAILABLE`).

#### 5.2 `GET /wallets/:walletId` — Consultar Carteira

- **Parâmetro de Rota:** `walletId` (UUID).
- **Resposta (`200 OK`):** Mesma estrutura JSON de `POST /wallets`.
- **Erros:** `400 Bad Request` (`INVALID_INPUT` para UUID inválido), `404 Not Found` (`WALLET_NOT_FOUND`), `503 Service Unavailable`.

#### 5.3 `GET /wallets/:walletId/ledger` — Listar Ledger da Carteira

Retorna os lançamentos do ledger ordenados por `(created_at DESC, id DESC)` usando cursor opaco em `base64url` que codifica precisão de microssegundos do timestamp PostgreSQL e o UUID do lançamento.

- **Parâmetros de Query:** `limit` (inteiro opcional `1..100`, default `50`), `cursor` (string opaca opcional retornada pela página anterior).

```sh
curl -sS "http://127.0.0.1:3000/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/ledger?limit=20"
```

**Resposta (`200 OK`):**

```json
{
  "entries": [
    {
      "id": "b7c0c8f0-48d9-4d40-965f-909638793a1d",
      "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
      "transactionId": "63d86e39-842b-4a56-9a3f-7a5804f1f001",
      "direction": "CREDIT",
      "money": { "amount": "100.00", "currency": "BRL" },
      "balanceBefore": { "amount": "0.00", "currency": "BRL" },
      "balanceAfter": { "amount": "100.00", "currency": "BRL" },
      "createdAt": "2026-11-06T09:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

- **Erros:** `400 Bad Request` (`INVALID_INPUT` para UUID, cursor, limit ou parâmetro desconhecido), `404 Not Found` (`WALLET_NOT_FOUND`), `503 Service Unavailable`.

#### 5.4 `POST /wallets/:walletId/reconciliation` — Reconciliar Saldo da Carteira

Executa uma comparação somente leitura sob `REPEATABLE READ` entre `wallets.balance` e `COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0.00)` em `wallet_ledger_entries`. Não aceita parâmetros de query e exige corpo vazio ou objeto JSON vazio (`{}`). Divergências nunca são corrigidas silenciosamente: são registradas em log, contabilizadas na métrica (`reconciliation.divergences`) e informadas na resposta.

```sh
curl -sS -X POST http://127.0.0.1:3000/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/reconciliation
```

**Resposta (`200 OK`):**

```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance": { "amount": "90.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "90.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 2
}
```

#### 5.5 `POST /wagering/transactions` — Submeter Transação de Aposta

Processa uma operação financeira de provedor. Exige **exatamente um** cabeçalho `Idempotency-Key` não vazio e sem espaços nas extremidades.

- **Valores aceitos de `kind`:** `BET` (débito), `WIN` (crédito, `referenceExternalTransactionId` opcional), `LOSS` (`0.00` ou valor positivo, sem movimentar saldo), `REFUND` (crédito revertendo uma `BET` `PROCESSED`, exige `referenceExternalTransactionId`), `ROLLBACK` (movimento inverso revertendo uma `BET`, `WIN` ou `REFUND` `PROCESSED`, exige `referenceExternalTransactionId`). `OPENING` e `providerId: "SYSTEM"` são reservados à abertura interna de carteira e rejeitados com `400 Bad Request`.

```sh
curl -sS -i http://127.0.0.1:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-demo:bet-1' \
  -d '{
    "providerId": "provider-demo",
    "externalTransactionId": "bet-1",
    "playerId": "player-demo",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-1",
    "gameId": "game-1",
    "kind": "BET",
    "money": { "amount": "10.00", "currency": "BRL" }
  }'
```

**Resposta (`200 OK` para `PROCESSED`, `202 Accepted` para `PENDING_REFERENCE`, `422 Unprocessable Entity` para `REJECTED` ou replay de `FAILED` terminal):**

```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "status": "PROCESSED",
  "balance": { "amount": "90.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

- Quando `status` é `REJECTED` ou `FAILED` (`422 Unprocessable Entity`), a resposta inclui `"failureCode"` (`"INSUFFICIENT_FUNDS_BET"`, `"INSUFFICIENT_FUNDS_REVERSAL"`, `"CURRENCY_MISMATCH"`, `"REFERENCE_NOT_FOUND_TIMEOUT"`, `"REFERENCE_INVALID_KIND"`, `"REFERENCE_CONTEXT_MISMATCH"`, `"REFERENCE_AMOUNT_MISMATCH"`, `"REFERENCE_NOT_PROCESSED"`, `"REFERENCE_ALREADY_REVERSED"` ou `"INFRASTRUCTURE_PERMANENT"`).
- **Replay Idempotente:** Repetir a mesma requisição retorna o código HTTP original (`200`, `202` ou `422`), o snapshot histórico `balance` registrado no momento da avaliação e `"idempotentReplay": true`.
- **Overflow durante Resolução de Referência Pendente (`FIX-D02`):** Se uma operação `WIN`, `REFUND` ou `ROLLBACK` aceita inicialmente como `PENDING_REFERENCE` for resolvida posteriormente quando o saldo da carteira estiver próximo ao limite de `NUMERIC(18,2)` (`9999999999999999.99`) e o crédito provocar `MoneyOverflowError`, o `PendingReferenceWorker` terminaliza a transação como `FAILED` com `failureCode: "INFRASTRUCTURE_PERMANENT"`, grava o snapshot do saldo observado, limpa a agenda de retry sem alterar saldo ou ledger e replays HTTP subsequentes retornam `422 Unprocessable Entity`.
- **Erros:** `400 Bad Request` (`INVALID_INPUT`, `INVALID_MONEY`, `MONEY_OVERFLOW`), `404 Not Found` (`WALLET_NOT_FOUND`), `409 Conflict` (`IDEMPOTENCY_CONFLICT` quando `Idempotency-Key` ou `(providerId, externalTransactionId)` é reutilizado com hash canônico divergente ou entre operações distintas), `503 Service Unavailable` (`SERVICE_UNAVAILABLE`).

#### 5.6 `GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId`

Consultam uma transação persistida pelo `transactionId` interno (UUID) ou por `(providerId, externalTransactionId)`.

**Resposta (`200 OK`):**

```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "providerId": "provider-demo",
  "externalTransactionId": "bet-1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "player-demo",
  "roundId": "round-1",
  "gameId": "game-1",
  "kind": "BET",
  "money": { "amount": "10.00", "currency": "BRL" },
  "status": "PROCESSED",
  "createdAt": "2026-11-06T09:01:00.000Z",
  "recordedBalance": { "amount": "90.00", "currency": "BRL" },
  "referenceExternalTransactionId": null,
  "referenceTransactionId": null,
  "failureCode": null,
  "processedAt": "2026-11-06T09:01:00.000Z"
}
```

- **Preservação Literal de Identificadores Externos (`ARC2-02` e `AUDIT-D03-FIX-01`):** `:providerId` e `:externalTransactionId` são validados como strings `TEXT` obrigatórias não vazias (`value.trim().length > 0`) e preservam sua grafia literal exata (incluindo eventuais espaços periféricos URL-encoded, superando o filtro restritivo de `IMP-04/CP-03`), de forma consistente com `POST /wagering/transactions` e o consumo SQS.
- **Erros:** `400 Bad Request` (`INVALID_INPUT`), `404 Not Found` (`WAGER_NOT_FOUND`), `503 Service Unavailable`.

#### 5.7 `GET /health/live`, `GET /health/ready` e `GET /metrics`

- `GET /health/live` -> `200 OK` `{ "status": "ok" }`
- `GET /health/ready` -> `200 OK` `{ "status": "ready", "dependencies": { "postgres": "up", "sqs": "up" } }` ou `503 Service Unavailable` (`"not_ready"` ou `"draining"` durante encerramento).
- `GET /metrics` -> `200 OK` retornando `OperationalMetricsSnapshot` (`scope: "process"`). Nem `/health/*` nem `/metrics` aceitam parâmetros de query (`400 Bad Request`).

#### Envelope Padrão de Erros HTTP

Todos os erros não-2xx tratados pelo [`HttpExceptionFilter`](src/shared/infrastructure/http-exception.filter.ts) retornam um corpo JSON sanitizado com códigos estáveis legíveis por máquina:

```json
{
  "code": "IDEMPOTENCY_CONFLICT",
  "message": "Idempotency conflict"
}
```

---

### 6. Testes

#### Comandos de Execução

```sh
# Verificação estática de tipos (TypeScript 5.9.3 modo estrito)
bun run typecheck

# Apenas testes unitários (1.006 testes em 28 arquivos; não requer containers Docker)
bun run test:unit

# Apenas testes de integração (268 testes em 16 arquivos; requer postgres-test na 5434 e LocalStack na 4566)
bun run test:integration

# Suíte completa (1.274 testes em 44 arquivos; 8.572 asserções)
bun test

# Verificação de formatação do diff e marcadores de conflito
git diff --check
```

#### Categorias de Testes e Cobertura

1. **Testes Unitários (`test/unit/*.test.ts` — 1.006 testes, 28 arquivos):**
   - Precisão de `Money`, validação de escala, rejeição de moedas divergentes e limites de overflow `NUMERIC(18,2)`.
   - Abertura de `Wallet`, transições de débito/crédito, incremento de versão e aritmética de `WalletLedgerEntry`.
   - Máquina de estados de `WagerTransaction`, regras de negócio `evaluateWager` para `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`, reversões encadeadas e hash canônico de payload.
   - Comportamento unitário de `InboxMessage`, `OutboxMessage`, `SqsWagerConsumer`, `OutboxPublisher` e `PendingReferenceWorker` (incluindo terminalização por overflow `D02`).
   - Controllers HTTP, validadores de DTO, mapeamento do filtro de exceções, readiness de health, sanitização de logs estruturados e redutores/saturação de métricas operacionais.
2. **Testes de Integração de Schema, Integridade Monetária e Finanças (`test/integration/schema.test.ts`, `monetary-integrity.test.ts`, `financial.test.ts`):**
   - Ciclos completos de migration `up -> down -> up` em schemas isolados `jungle_it_<uuid>`.
   - Rejeição via SQL direto de saldos negativos, `NaN`/`±Infinity` nas 6 colunas monetárias (`FIX-D01`), `UPDATE`/`DELETE` no ledger, mutação de apostas terminais, apostas processadas sem lançamento no ledger e reversões duplicadas.
   - Rollback atômico nas 5 tabelas (`wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages`, `outbox_messages`) em cada ponto de falha (`wallet`, `wager`, `ledger`, `outbox`, `inbox`, `beforeCommit`).
   - 50 requisições concorrentes idênticas produzindo 1 débito e 49 replays idempotentes; duas apostas concorrentes de `80.00 BRL` sobre saldo de `100.00 BRL` produzindo 1 `PROCESSED` (saldo final `20.00 BRL`) e 1 `REJECTED` (`INSUFFICIENT_FUNDS_BET`).
3. **Testes Multiprocesso, SQS, Outbox, Referências Pendentes e Recuperação de Falhas (`test/integration/multiprocess.test.ts`, `sqs-consumer.test.ts`, `outbox-publisher.test.ts`, `pending-reference-worker.test.ts`, `worker-resilience.test.ts`, `worker-entrypoints.test.ts`):**
   - `>= 3` processos filhos `bun` independentes no sistema operacional com PIDs de backend PostgreSQL distintos disputando a mesma carteira, colidindo chaves de idempotência em carteiras distintas, publicando 100 eventos da Outbox sem perda e resolvendo referências fora de ordem.
   - Recuperação real sob `SIGTERM` e `SIGKILL`: morte do worker após o commit no banco e antes do `DeleteMessage` no SQS, morte do publisher após `SendMessage` e antes da confirmação SQL, expiração de lease e fencing de owners antigos e reinício multiprocesso após terminalização `FAILED` por overflow (`REV-D02-01/02`).
4. **Testes de Integração HTTP e Observabilidade (`test/integration/wallet-http.test.ts`, `wager-http.test.ts`, `observability-http.test.ts`, `structured-logging.test.ts`, `operational-metrics.test.ts`):**
   - Contratos HTTP ponta a ponta, `G6A` (`18` cenários `NO_MIGRATION` verificando identidade de grafos DI, vacuidade de `jungle_test.public`, bloqueio de `Migrator.up` e limpeza determinística de filas SQS) e `G6B` (`2` cenários `MIGRATION_REQUIRED` verificando emissão de métricas após commit, rollback e retry reais no PostgreSQL).

#### Exemplos de Execução por Recorte

```sh
bun test test/integration/monetary-integrity.test.ts test/integration/schema.test.ts test/integration/financial.test.ts
bun test test/integration/multiprocess.test.ts test/integration/worker-resilience.test.ts test/integration/worker-entrypoints.test.ts
bun test test/integration/sqs-consumer.test.ts test/integration/outbox-publisher.test.ts test/integration/pending-reference-worker.test.ts
bun test test/integration/operational-metrics.test.ts --test-name-pattern NO_MIGRATION
bun test test/integration/operational-metrics.test.ts --test-name-pattern MIGRATION_REQUIRED
```

#### Requisitos de Isolamento de Testes

- As suítes de integração exigem `postgres-test` em `127.0.0.1:5434` (`jungle_test`) e `localstack` em `127.0.0.1:4566`. Se qualquer serviço estiver indisponível, os testes falham explicitamente em vez de omitir verificações.
- Cada teste de integração relacional cria e remove exclusivamente seu próprio schema `jungle_it_<uuid>` dentro de `jungle_test`. O schema `jungle_test.public` permanece vazio (`0` tabelas).
- Cada teste de integração SQS cria e remove suas próprias filas `jungle_it_<uuid>_*.fifo`, preservando as três filas preexistentes (`wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wagering-events.fifo`).

---

### 7. Observabilidade

#### Logs Operacionais Estruturados

- Emitidos como objetos JSON de linha única em `stderr` via [`stderrOperationalLog`](src/shared/application/operational-logging.ts).
- Incluem campos de correlação (`component`, `event`, `level`, `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `status`, `code`, `idempotentReplay`, `consistent`, `checkedEntries`, `attempt`).
- Redigem automaticamente chaves sensíveis (`password`, `secret`, `token`, `authorization`, `cookie`, `receiptHandle`, credenciais em URLs e padrões de chaves AWS) e omitem valores monetários brutos ou payloads financeiros completos.
- Fronteira defensiva não bloqueante: exceções, promises rejeitadas ou chamadas reentrantes de observadores de log nunca alteram o resultado de uma operação financeira.

#### Métricas Operacionais (`GET /metrics`)

Expõe um snapshot JSON imutável (`scope: "process"`) mantido pelo [`DefaultOperationalMetricsCollector`](src/shared/application/operational-metrics.ts):

- `transactionsByStatus`: `{ PROCESSED, REJECTED, PENDING_REFERENCE, FAILED }` (contabilizados somente após o commit da transação, excluindo replays idempotentes).
- `duplicates`: `{ replays, conflicts }`.
- `retries`: `{ wagerUow, walletUow, pendingReference, sqsConsumer, outboxPublisher }`.
- `dlq`: `{ confirmedTransfers }` (transferências manuais de erros permanentes confirmadas via `SendMessage` na DLQ + `DeleteMessage` na fila de origem).
- `concurrencyConflicts`: `{ total, byCode: { "40P01", "40001", "55P03", "57014", "23505" } }`.
- `outboxLagMs` e `processingDurationMs`: `{ count, totalMs, minMs, maxMs, lastMs, buckets: { le5Ms, le10Ms, le25Ms, le50Ms, le100Ms, le250Ms, le500Ms, le1000Ms, gt1000Ms } }`.
- `reconciliation`: `{ divergences }`.
- `pendingReference`: `{ processed, rejected, rescheduled }`.

#### Métricas dos Workers Standalone (NDJSON em stderr)

Cada consumidor, publisher de Outbox e worker de referências pendentes exporta **seu próprio coletor existente** como um objeto JSON por linha em `stderr`. Filtre registros por `type: "OperationalMetricsSnapshot"`; os logs operacionais continuam compartilhando o stream. O envelope é:

```ts
type WorkerMetricsEnvelope = {
  type: 'OperationalMetricsSnapshot',
  version: 1,
  component: 'sqs-consumer' | 'outbox-publisher' | 'pending-reference-worker',
  executionId: string, // UUID novo para esta execução do reporter
  pid: number,
  timestamp: string,   // instante da amostragem em ISO-8601 UTC
  snapshot: OperationalMetricsSnapshot // contrato JSON completo do processo descrito acima
}
```

`WORKER_METRICS_INTERVAL_MS` tem default de `10000` ms (faixa permitida `50..3600000`). Uma amostra é tentada após a composição válida do worker, periodicamente e em best-effort no encerramento gracioso. Snapshots idênticos já escritos com sucesso são omitidos. Os contadores são observações cumulativas desde o início daquele processo/contexto; zeram no reinício e **não** representam um censo das linhas atuais do banco. Use `executionId` para distinguir resets e calcule diferenças em vez de somar snapshots cumulativos sucessivos.

O reporter permite no máximo uma escrita pendente e não mantém fila de amostras. Enquanto essa escrita estiver pendente, novas amostras são descartadas antes de consultar o coletor. Exceções e escritas rejeitadas são contidas; uma escrita que nunca conclui suprime novas amostras daquele reporter sem bloquear operações financeiras ou shutdown. Uma amostra posterior bem-sucedida inclui os contadores acumulados do coletor, mas registros intermediários podem ser perdidos. A entrega é best-effort, sem persistência ou agregação entre processos. `GET /metrics` continua expondo **somente o processo HTTP que atende à requisição**.

#### Health Checks e Readiness

- `GET /health/live`: Confirma que o event loop do processo HTTP está responsivo (`200 OK`).
- `GET /health/ready`: Executa sondas concorrentes com timeout limitado (`HEALTH_READINESS_TIMEOUT_MS`, default `1500` ms) contra o PostgreSQL (`SELECT 1`) e o LocalStack SQS (verificando existência, `FifoQueue === "true"`, `QueueArn` e `RedrivePolicy` vinculando `wager-transactions.fifo` a `wager-transactions-dlq.fifo` com `maxReceiveCount`). Transiciona imediatamente para `503 Service Unavailable` (`status: "draining"`) quando o encerramento da aplicação é iniciado.

---

### 8. Considerações Finais e Limitações Conhecidas

#### Diferenciais Técnicos

- **Integridade Monetária em Profundidade:** A precisão decimal é imposta simultaneamente na fronteira de tipos/domínio TypeScript (`Money` + `ExactNumericType`) e no armazenamento físico do PostgreSQL (`NUMERIC(18,2)`, `ck_wallet_all_finite`, `ck_wager_all_finite`, `ck_ledger_all_finite` e constraint triggers diferidos de reconciliação entre saldo e ledger).
- **Convergência Determinística de Operações Fora de Ordem:** O `PendingReferenceWorker` garante que toda transação `PENDING_REFERENCE` convirja para um estado terminal (`PROCESSED`, `REJECTED` ou `FAILED` em caso de overflow de crédito `NUMERIC(18,2)`) sem bloquear candidatos saudáveis nem entrar em loop infinito de retentativas.
- **Testes de Concorrência Sem Mocks de Infraestrutura Crítica:** Validado com retries reais de deadlock/serialização `40P01` no PostgreSQL, múltiplos processos filhos do sistema operacional e interrupção abrupta de processos (`SIGTERM`/`SIGKILL`).

#### Limitações Operacionais Conhecidas

1. **Autenticação Externa Não Implementada (Por Decisão de Escopo):** O `ProviderIdentityGuard` é um ponto de extensão no-op conforme permitido pelo enunciado do desafio; validação externa via OIDC/JWKS deve ser implementada antes de expor endpoints HTTP a redes não confiáveis.
2. **Métricas Voláteis e Escopadas ao Processo:** `GET /metrics` retorna métricas em memória exclusivas do processo HTTP (`scope: "process"`). Os processos standalone de workers (`consume-wagers.ts`, `publish-outbox.ts`, `resolve-pending-references.ts`) exportam seus próprios coletores em memória como NDJSON em stderr; não há agregador externo de séries temporais nem armazenamento persistente de métricas.
3. **Entrega At-Least-Once na Outbox:** O `OutboxPublisher` garante entrega at-least-once na fila `wagering-events.fifo`. Consumidores downstream devem deduplicar eventos de integração por `eventId`.
4. **Envelopes Mistos na DLQ:** A fila `wager-transactions-dlq.fifo` pode receber tanto envelopes diagnósticos sanitizados `WagerTransactionDeadLetter` (para erros permanentes de contrato) quanto envelopes originais `WagerTransactionRequested` (via `RedrivePolicy` nativa do SQS após `maxReceiveCount` falhas transitórias/desconhecidas). Operadores devem inspecionar o campo `type` antes de reprocessar itens da DLQ e nunca reenviar um envelope diagnóstico como comando financeiro.
5. **TypeScript `skipLibCheck`:** Seguindo a recomendação oficial do Bun, `skipLibCheck: true` está habilitado no `tsconfig.json` para evitar conflitos internos de declarações transitivas entre `@types/bun` e `@types/node`, mantendo verificação estrita completa (`strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`) em todos os arquivos de código, scripts e testes do projeto.
