# ADR-0001: Use Drizzle ORM (over Prisma) for new NestJS services

**Status:** Accepted
**Date:** 2026-05-07
**Author:** sanjit@xprogroup.com.au
**Deciders:** <TBD>

## Context

The global engineering standard (`~/.claude/CLAUDE.md`) previously named
**Prisma** as the default ORM for NestJS services, with **sqlc/pgx** for
Go services. The v2.0 Backend Best Practices document (April 2026)
replaces Prisma with **Drizzle ORM** as the NestJS default while keeping
sqlc/pgx for Go.

Without an explicit ADR, two contradictory standards would coexist
(global instructions vs. v2 doc) and future engineers would pick
arbitrarily, causing service-level drift.

The team is also building services that will eventually be ported to Go
(per the `migrate-to-go` skill). The chosen ORM affects how
migration-friendly each NestJS service is when the time comes.

This decision applies to **greenfield NestJS services**. There are no
existing Prisma services in production, so no migration plan is required.

## Decision Drivers

1. **Type safety end-to-end** — domain types should be derived from the
   schema, not duplicated. Drift between TS types and DB schema is a
   recurring source of runtime bugs.
2. **Migration philosophy** — migrations should be SQL artifacts that
   are reviewed in PR and applied by pipeline, not generated at runtime
   by the ORM.
3. **Closeness to SQL** — the team writes SQL queries directly in Go
   (sqlc); the NestJS side should not abstract SQL so much that
   engineers lose intuition when reading EXPLAIN plans or moving
   services to Go.
4. **Operational maturity** — the chosen tool should have stable
   instrumentation hooks (OpenTelemetry, pg-pool integration) and not
   block production observability.
5. **Team familiarity** — the team has shipped Prisma-based services
   before. Switching cost is non-zero and must be acknowledged.
6. **Migration path to Go** — repository code that maps closely to SQL
   queries ports more cleanly to sqlc than Prisma's higher-level query
   DSL.

## Considered Options

1. **Stay on Prisma** — keep current standard. Mature, opinionated,
   large community, prior team experience.
2. **Migrate to Drizzle ORM** (chosen) — type-safe SQL builder,
   schema-first, drizzle-kit for migrations, no runtime engine binary.
3. **Drop ORM entirely, use `pg` + hand-written SQL** — closest to the
   Go stack. `pgtyped` provides typed query results but is niche.
4. **Use Kysely** — query builder with similar philosophy to Drizzle
   but smaller ecosystem and no schema-first migration tool of
   equivalent maturity.

## Decision

Adopt **Drizzle ORM + drizzle-kit** as the default ORM for new NestJS
services.

## Consequences

### Positive

- **Type safety from schema** — `$inferSelect` / `$inferInsert`
  eliminate the duplicated DTO ↔ Prisma model definitions.
- **Migrations are SQL files** — reviewable, replayable, no shadow DB
  needed; aligns with the team's pipeline-driven deploy model.
- **No runtime query engine** — Prisma's Rust binary adds 30–50 MB to
  the runtime image and one process boundary; Drizzle is pure JS.
- **Closer to SQL** — engineers practicing query optimization in
  Drizzle develop skills that transfer to sqlc/pgx in Go.
- **Migration to Go is cheaper** — repository code that already maps to
  SQL queries ports almost 1:1 to sqlc.

### Negative

- **Smaller ecosystem** — fewer Stack Overflow answers, fewer
  third-party integrations (e.g., NestJS DevTools doesn't introspect
  Drizzle the way it does Prisma).
- **Less abstraction = more SQL knowledge required** — junior engineers
  must understand JOIN/index/lock semantics earlier. Mitigation: pair
  reviews, EXPLAIN-in-PR convention for hot endpoints.
- **No Studio-equivalent UI** out of the box (drizzle-studio exists but
  is less mature than Prisma Studio).
- **Less battle-testing in NestJS specifically** — most Drizzle
  examples target standalone Node or Bun apps, not NestJS DI
  integration. The v2 doc compensates with explicit patterns
  (`DrizzleService`, repository pattern).

### Neutral

- `drizzle-kit migrate` vs `prisma migrate deploy` — both
  pipeline-friendly, no operational change.
- Connection pooling is `pg` (`node-postgres`) for both, so pool tuning
  knowledge transfers.

## Implementation Notes

1. **New services use Drizzle from day 1**, following Pilar 3 of the v2
   doc.
2. **Update `~/.claude/CLAUDE.md`** in atomic with this ADR going to
   Accepted: change `PostgreSQL (Prisma untuk NestJS, sqlc/pgx untuk
Go)` → `PostgreSQL (Drizzle untuk NestJS, sqlc/pgx untuk Go)` so
   agent routing and skill triggers stay consistent.
3. **No mixed-ORM modules** — a single module is either Drizzle or
   another ORM, never both in the same module.
4. **Prepared statement strategy** — when using `pgbouncer` in
   transaction mode, avoid Drizzle `prepare()` for hot queries (or
   route them through a dedicated session-mode pool). Document which
   pool is in use per service.

## Validation

After the first greenfield service is live, capture:

- **Image size**: expected smaller than equivalent Prisma service
  (no Prisma engine binary).
- **p95 query latency** for the top 5 endpoints — should not regress
  versus Prisma baselines from prior services.
- **Build time**: expected faster (no `prisma generate` step).
- **DX feedback**: 30-day check-in with engineers who shipped on it —
  what was harder than expected, what was easier.

If validation surfaces issues that change the cost/benefit (e.g.,
critical missing feature, severe DX friction), revisit this ADR with a
new status (`Superseded` or `Deprecated`) and a follow-up ADR.

## Related

- [Backend Best Practices v2.0](../Backend-Best-Practices-NestJS-v2.md) — Pilar 3 (Database & Data Layer) is the implementation reference for this decision.
