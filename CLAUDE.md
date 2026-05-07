# Project Instructions — boilerplate-nestjs

NestJS service boilerplate. Goal: become the reference implementation
for the v2 Best Practices doc and the two ADRs accepted in this repo.

## Repo state (as of 2026-05-07)

⚠️ **The repo is still in default `nest new` state.** The target stack
defined in the ADRs has **not yet been implemented**. Every PR to `main`
should advance reality toward the aspiration, not preserve the default.

| Aspect             | Current state              | Target state                                            | Reference       |
| ------------------ | -------------------------- | ------------------------------------------------------- | --------------- |
| HTTP adapter       | `@nestjs/platform-express` | `@nestjs/platform-fastify`                              | v2 doc, Pilar 1 |
| ORM                | (none)                     | Drizzle + drizzle-kit                                   | ADR-0001        |
| Validation         | (none)                     | zod via nestjs-zod                                      | ADR-0002        |
| Test runner        | Jest                       | Vitest                                                  | ADR-0002        |
| Linter / Formatter | ESLint + Prettier          | Biome                                                   | ADR-0002        |
| Folder layout      | `src/app.*` flat           | `src/modules/*`, `src/infrastructure/*`, `src/common/*` | v2 doc, Pilar 1 |

## Target stack (single source of truth)

- **Runtime:** Node.js 22 LTS, pnpm 9
- **Framework:** NestJS 11+ with the Fastify adapter
- **ORM:** Drizzle + drizzle-kit (rationale: ADR-0001)
- **Validation:** zod via `nestjs-zod`
- **Testing:** Vitest + Testcontainers (DB) + Fastify `inject()` (E2E)
- **Linter / Formatter:** Biome (rationale: ADR-0002)
- **Database:** PostgreSQL 16+, `pg` (`node-postgres`) driver
- **Cache / Queue:** Redis 7+, BullMQ
- **Container:** multi-stage Docker, distroless runtime
- **Observability:** OpenTelemetry → Tempo / Loki / Mimir

## Required reading (do not re-discuss)

All decisions are already documented:

- `docs/Backend-Best-Practices-NestJS-v2.md` — pattern detail per pilar
- `docs/adr/0001-use-drizzle-orm-over-prisma.md` — why Drizzle (not Prisma)
- `docs/adr/0002-tooling-vitest-biome-zod.md` — why Vitest + Biome + zod

If the user asks "why X", do not re-derive — check the ADR or v2 doc.
If a decision is genuinely obsolete, propose a new ADR; do not silently
pivot.

> **Note on language:** the v2 doc body is currently in Indonesian
> (legacy from a Google Doc export). New content (this file, ADRs,
> code, commits) must be in English. A translation pass on the v2 doc
> is tracked separately as a future task and does not block new work.

## Folder convention (v2 doc, Pilar 1)

```
src/
├── modules/<bounded-context>/
│   ├── dto/                     # zod schema + createZodDto
│   ├── *.controller.ts          # HTTP only, no business logic
│   ├── *.service.ts             # @Injectable business logic
│   ├── *.repository.ts          # Drizzle access layer (sole DB gate)
│   ├── *.module.ts              # wiring
│   └── *.spec.ts                # unit tests co-located
├── common/                      # decorators, filters, guards, interceptors, pipes
├── config/                      # env.schema.ts (zod), configuration.ts
├── infrastructure/
│   ├── database/schema/*.ts     # Drizzle pgTable schemas
│   ├── database/drizzle.{service,module}.ts
│   ├── redis/, queue/, logger/
├── app.module.ts                # composition root only
└── main.ts                      # FastifyAdapter bootstrap
```

## Common commands

| Task       | Current                  | Target (post-migration)                 |
| ---------- | ------------------------ | --------------------------------------- |
| Install    | `pnpm install`           | `pnpm install`                          |
| Dev server | `pnpm start:dev`         | `pnpm dev`                              |
| Test       | `pnpm test` (Jest)       | `pnpm test` (Vitest)                    |
| Lint       | `pnpm lint` (ESLint)     | `pnpm biome check --write`              |
| Format     | `pnpm format` (Prettier) | (handled by Biome)                      |
| Build      | `pnpm build`             | `pnpm build`                            |
| DB migrate | (n/a)                    | `pnpm drizzle-kit generate` + `migrate` |

## Agent routing (project override)

| Trigger                                                                                | Agent / Skill                     |
| -------------------------------------------------------------------------------------- | --------------------------------- |
| Edit `src/infrastructure/database/schema/*.ts`, `drizzle/*.sql`, files using `pgTable` | `database-postgres-expert`        |
| Edit `src/modules/**/*.{controller,service,repository,module}.ts`                      | `backend-nestjs-expert`           |
| Edit `Dockerfile`, `k8s/*.yaml`                                                        | `devops-docker-k8s`               |
| User asks "add module X" / "create new resource"                                       | (future) `/scaffold-module` skill |
| Editing migration, mention "rename column / add NOT NULL"                              | (future) `/db-migrate-safe` skill |
| Auth / payment / file upload work                                                      | `security-reviewer`               |

## Auto-prevent gotchas (Common Pitfalls in v2 doc)

- Never call `app.listen(port)` without `'0.0.0.0'` — fails in K8s
- Never use `@Res() reply` in a handler — kills the NestJS pipeline
- Never commit a migration that `DROP COLUMN` while a still-deployed
  version of the code uses that column — use expand-contract (Pilar 8)
- `db.execute(sql.raw(...))` with user input = SQL injection. Use the
  parameterized `` sql`...` `` template.
- A BullMQ worker without a concurrency limit will exhaust the DB pool
- Migrations in `onApplicationBootstrap` race across replicas — run
  them in the pipeline only

## PR conventions

- Branch protection: `main` is protected; all changes go through a PR
- Commit messages: `feat(scope): ...`, `fix(scope): ...` — **English**
- PR title and description: **English**
- All chat with the user (this assistant): Bahasa Indonesia
- All file contents (code, comments, docs, ADRs, migrations): **English**
- Do not skip hooks (`--no-verify`) without a written reason
- New business logic requires tests (see v2 doc, Pilar 5)

## When in doubt

1. Read the relevant section of the v2 doc first
2. Check the ADRs — for tooling/library decisions
3. Ask the user — do not assume, especially when touching migration
   plans or API contracts
