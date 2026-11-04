# AGENTS.md — Jungle Gaming Technical Challenge

## 1. Project Context

Project: Distributed Wagering Processor

Objective: Implement a distributed financial transaction processing service that satisfies all mandatory requirements of the Jungle Gaming technical challenge.

Target: 100/100 evaluation points, with no disqualifying failures.

Delivery deadline: November 2026, according to the agreed 72-hour development window.

## 2. Source of Truth

Before implementing or reviewing changes, read:

1. `technical-challenge.md` — original technical requirements.
2. `Jungle-Architecture-v0.2.md` — reviewed architecture.

Document precedence:

1. Original technical challenge.
2. Explicit decisions approved by Luís Henrique Pereira.
3. Approved architecture and documented amendments.
4. This AGENTS.md.
5. Task-specific implementation instructions.

If documents conflict, report the inconsistency before proceeding.

Do not silently reinterpret requirements.

## 3. Mandatory Technology Stack

- Bun 1.x
- TypeScript strict
- NestJS
- PostgreSQL
- MikroORM
- AWS SQS via LocalStack
- Docker Compose
- Versioned and reversible migrations
- Bun test runner

Prohibited:

- Prisma or other unsupported ORMs.
- Floating-point arithmetic for money.
- In-memory idempotency guarantees.
- Reliance on SQS FIFO as the sole concurrency guarantee.
- Publishing integration events before database commit.
- Global locks across unrelated wallets.

## 4. Financial Invariants

The following invariants must always hold:

1. Wallet balances cannot become negative.
2. Financial operations cannot produce duplicate debits or credits.
3. Each balance movement has a corresponding ledger entry.
4. Ledger entries are immutable.
5. Ledger reconstruction must match the materialized wallet balance.
6. Idempotency must survive process restarts.
7. Concurrent workers must preserve financial correctness.
8. Multiple application instances must operate safely.
9. Events committed to the Outbox must not be permanently lost.
10. Money operations must use exact decimal arithmetic.

Database-level constraints must enforce the applicable invariants.

Violations of these guarantees are release blockers.

## 5. Domain Design

Follow the approved DDD and modular architecture.

Domain classes must:

- Encapsulate their state.
- Use private or protected constructors.
- Provide explicit static factories.
- Express valid state transitions.
- Reject invalid transitions.
- Avoid dependencies on NestJS, MikroORM and SQS.

Rehydration factories reconstruct persisted state without reexecuting business transitions.

Money must be immutable and preserve decimal precision.

Do not introduce unnecessary abstractions or architectural layers.

## 6. Implementation Governance

Work only within the explicitly authorized implementation package.

Before modifying files:

1. Inspect the current repository state.
2. Read the applicable requirements.
3. Identify the intended files and changes.
4. Present the implementation plan when required by the task.
5. Respect approval checkpoints.

Never:

- Modify unrelated files.
- Rename existing identifiers without authorization.
- Expand scope silently.
- Remove tests to make builds pass.
- Weaken financial invariants.
- Introduce unapproved architectural dependencies.
- Overwrite another agent's work without coordination.

Prefer small, reviewable and reversible changes.

Preserve existing behavior unless a change is explicitly authorized.

## 7. Testing Requirements

Use test-first development when practical.

Every financial invariant must have positive and negative tests.

Required test categories:

- Domain unit tests.
- PostgreSQL integration tests.
- SQS integration tests.
- Concurrent execution tests.
- Multi-process tests.
- Crash recovery tests.

Integration tests must use real PostgreSQL and SQS-compatible containers where required.

Mocks must not replace all integration evidence.

A passing unit test suite does not prove distributed correctness.

Never report a test as passing unless it was actually executed.

## 8. Agent Responsibilities

### Codex

Primary implementation agent.

Responsibilities:

- Implement authorized packages.
- Maintain architectural consistency.
- Write and execute tests.
- Report file modifications.
- Provide reproducible execution evidence.

### Antigravity

Independent validation agent.

Responsibilities:

- Review implemented changes.
- Challenge assumptions.
- Execute independent tests.
- Identify defects and missing coverage.
- Report findings with reproducible evidence.

Antigravity must not modify implementation files during read-only validation tasks.

### GPT

Architecture and technical coordination.

Responsibilities:

- Define implementation boundaries.
- Analyze architectural risks.
- Evaluate review findings.
- Prepare implementation instructions.

### Gemini

Independent architectural reviewer.

Responsibilities:

- Challenge design decisions.
- Identify concurrency and financial risks.
- Review technical trade-offs.

### Luís Henrique Pereira

Technical owner and final approver.

Only Luís may authorize scope expansion or progression through approval gates.

## 9. Git and Change Control

Before changes, inspect:

- Current branch.
- Working tree status.
- Existing uncommitted changes.

Do not overwrite or discard existing user changes.

Do not execute destructive Git commands.

Do not commit, push, merge or open pull requests unless explicitly authorized.

Provide a summary of modified files and their purposes.

## 10. Execution Evidence

At the end of each implementation package, report:

1. Package identifier.
2. Files created or modified.
3. Technical decisions.
4. Commands executed.
5. Test results.
6. Known limitations.
7. Remaining risks.
8. Any deviations from the approved architecture.

Separate verified results from assumptions.

Do not claim completion when mandatory tests are missing or failing.

## 11. Approval Gates

Implementation packages:

- IMP-01: Foundation and domain.
- IMP-02: PostgreSQL persistence and concurrency.
- IMP-03: SQS, Inbox, Outbox and recovery.
- IMP-04: API, observability, documentation and delivery.

Each package requires:

1. Implementation.
2. Executable validation.
3. Independent review.
4. Resolution of blocking findings.
5. Explicit approval before the next package.

Agents must not proceed automatically to subsequent packages.

## 12. Time and Scope Discipline

The delivery window is limited.

Prioritize:

1. Elimination of disqualifying failures.
2. Financial correctness.
3. Concurrency and idempotency.
4. Distributed recovery.
5. Mandatory integration tests.
6. Observability and documentation.

Optional features must not compromise mandatory requirements.

Prefer the simplest solution that demonstrably satisfies the technical challenge.
