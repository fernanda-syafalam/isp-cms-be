# Project Instructions — boilerplate-nestjs

NestJS service boilerplate. Goal: become the reference implementation
for the v2 Best Practices doc and the two ADRs accepted in this repo.

## Repo state (as of 2026-05-07)

Tooling, infrastructure, and the first reference modules are in place:

- `HealthModule` (`/healthz`, `/readyz` with real DB ping) — `@Public()`
- `UsersModule` under `/v1/users` — full Pilar 1+3+4+5 example with
  argon2id hashing, cursor pagination, unit + integration tests
- `AuthModule` under `/v1/auth` — login + JWT issuance, `JwtAuthGuard`
  registered globally so every endpoint requires a JWT unless
  `@Public()` is applied; `@CurrentUser` decorator for handlers
- `RolesGuard` global, opt-in via `@Roles('admin', ...)` for coarse
  RBAC; resource ownership stays in the service
- `AuditInterceptor` global, opt-in via `@Audit('action.name')` —
  emits structured `audit: true` log lines with actor + target +
  outcome for compliance pipelines
- `AppLoggerModule` (nestjs-pino) — JSON logs in prod, pino-pretty in
  dev; redacts password / token / authorization fields; every line
  carries the Fastify request id
- `AllExceptionsFilter` — uniform `application/problem+json` (RFC 7807)
  responses; never leaks server-side stack traces to the client
- `RedisModule` (ioredis) — single shared client for the throttler
  + BullMQ
- `ThrottlerGuard` global, Redis-backed (Pilar 2) — limit consistent
  across pods, configurable via `THROTTLER_TTL_MS` / `THROTTLER_LIMIT`
- `QueueModule` + `EmailModule` — BullMQ wired with idempotent
  `jobId`, attempts + exponential backoff defaults, capped
  `removeOnComplete`/`removeOnFail`. `dist/worker.js` runs the
  consumer in a separate process; same image as the API, override
  the container command (Pilar 7)
- Env validation via zod parsed at startup; `ZodValidationPipe`
  global; URI versioning enabled
- `AppModule` is a pure composition root

| Aspect             | Current state                                | Target state                                            | Reference       |
| ------------------ | -------------------------------------------- | ------------------------------------------------------- | --------------- |
| HTTP adapter       | ✅ `@nestjs/platform-fastify`                | `@nestjs/platform-fastify`                              | v2 doc, Pilar 1 |
| ORM                | ✅ Drizzle (users schema + first migration committed)       | Drizzle + drizzle-kit                                   | ADR-0001        |
| Validation         | ✅ zod env + global ZodValidationPipe + first DTO via createZodDto | zod via nestjs-zod                                      | ADR-0002        |
| Test runner        | ✅ Vitest + SWC + Fastify `inject()` for E2E | Vitest                                                  | ADR-0002        |
| Linter / Formatter | ✅ Biome                                     | Biome                                                   | ADR-0002        |
| Folder layout      | ✅ `src/modules/*` (Health, Users) + `src/infrastructure/database/*` + `src/config/*` | `src/modules/*`, `src/infrastructure/*`, `src/common/*` | v2 doc, Pilar 1 |

## Target stack (single source of truth)

- **Runtime:** Node.js 22 LTS, pnpm 9
- **Framework:** NestJS 11+ with the Fastify adapter
- **ORM:** Drizzle + drizzle-kit (rationale: ADR-0001)
- **Validation:** zod via `nestjs-zod`
- **Testing:** Vitest + Testcontainers (DB) + Fastify `inject()` (E2E)
- **Linter / Formatter:** Biome (rationale: ADR-0002)
- **Database:** PostgreSQL 16+, `pg` (`node-postgres`) driver
- **Cache / Queue:** Redis 7+, BullMQ
- **Container:** multi-stage Docker, distroless runtime (`Dockerfile` at repo root)
- **CI:** GitHub Actions — `static`, `test`, and `integration` jobs (`.github/workflows/ci.yml`)
- **K8s manifests:** `k8s/` — Deployment + Service + HPA + ConfigMap + Secret template (Pilar 9 defaults)
- **Observability:** nestjs-pino (live) → OpenTelemetry → Tempo / Loki / Mimir (planned)

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

| Task        | Command                                       |
| ----------- | --------------------------------------------- |
| Install     | `pnpm install`                                |
| Dev server  | `pnpm dev`                                    |
| Typecheck   | `pnpm typecheck`                              |
| Lint        | `pnpm lint` (Biome, with `--write`)           |
| Lint (CI)   | `pnpm lint:ci` (Biome, no autofix)            |
| Test (unit + e2e) | `pnpm test` (Vitest, no Docker needed)  |
| Test e2e only     | `pnpm test:e2e`                         |
| Test integration  | `pnpm test:int` (Testcontainers, Docker required) |
| Build       | `pnpm build`                                  |
| Local DB up | `pnpm db:up` (docker compose Postgres)        |
| DB down     | `pnpm db:down`                                |
| DB migrate  | `pnpm db:generate` then `pnpm db:migrate`     |

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
- Do **not** turn on Biome's `style/useImportType` rule. It auto-flips
  class imports used only for DI (`import { AppService }`) into
  `import type`, which the compiler erases — Nest then fails to
  resolve the provider at runtime. Rule is intentionally `"off"` in
  `biome.json`.
- `javascript.parser.unsafeParameterDecoratorsEnabled: true` in
  `biome.json` is required because NestJS uses parameter decorators
  (`@Body()`, `@Param()`, `@Query()`) which Biome rejects by default.

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
