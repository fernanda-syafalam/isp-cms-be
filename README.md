# boilerplate-nestjs

Production-shaped NestJS service template. Fork it as the starting point
for a new HTTP service that needs auth, a Postgres-backed domain layer,
structured logging, and a green CI/Docker pipeline on day one.

The conventions and rationale live in:

- `docs/Backend-Best-Practices-NestJS-v2.md` — the authoritative pattern
  doc per pilar (architecture, API, DB, security, testing,
  observability, queues, migrations, containers)
- `docs/adr/0001-use-drizzle-orm-over-prisma.md` — why Drizzle, not Prisma
- `docs/adr/0002-tooling-vitest-biome-zod.md` — why Vitest + Biome + zod
- `CLAUDE.md` — project-level instructions for AI agents and engineers

Read those before changing conventions; raise a new ADR if you want to
pivot.

## Stack

| Layer              | Choice                                                                |
| ------------------ | --------------------------------------------------------------------- |
| Runtime            | Node.js 22 LTS, pnpm 10                                               |
| Framework          | NestJS 11 + Fastify adapter                                           |
| ORM / migrations   | Drizzle ORM + drizzle-kit                                             |
| Validation         | zod via `nestjs-zod` (env + DTO + global pipe)                        |
| Auth               | Passport JWT (`@nestjs/passport`) + argon2id password hashing         |
| Logging            | nestjs-pino (JSON in prod, pino-pretty in dev) with field redaction   |
| Errors             | RFC 7807 `application/problem+json` filter (uniform error shape)      |
| Rate limit         | `@nestjs/throttler` with Redis storage — consistent across pods       |
| Testing            | Vitest + Fastify `inject()` + Testcontainers Postgres                 |
| Linter / Formatter | Biome                                                                 |
| Container          | Multi-stage Docker, distroless runtime                                |
| CI                 | GitHub Actions (typecheck/lint/build, unit/e2e, integration)          |
| Database           | PostgreSQL 16+ via `pg` (`node-postgres`)                             |

## Quick start

Prerequisites: Node 22, pnpm 10 (handled automatically by `corepack`),
Docker (only for Postgres + integration tests).

```bash
git clone <this-repo> my-service
cd my-service

cp .env.example .env
# Edit .env — at minimum set JWT_SECRET to 32+ random characters.

pnpm install
pnpm db:up           # boots local Postgres + Redis via docker compose
pnpm db:migrate      # applies the committed migrations
pnpm dev             # starts the service on http://localhost:3000
```

Smoke check:

```bash
curl -s localhost:3000/healthz
curl -s localhost:3000/readyz

curl -X POST localhost:3000/v1/users \
  -H 'content-type: application/json' \
  -d '{"email":"a@b.test","fullName":"A","password":"correct-horse-battery-staple"}'

curl -X POST localhost:3000/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"a@b.test","password":"correct-horse-battery-staple"}'

# Use the accessToken from the previous response:
curl localhost:3000/v1/auth/me -H "authorization: Bearer <token>"
```

## Folder layout

```
src/
├── modules/<bounded-context>/
│   ├── dto/                  # zod schemas + createZodDto
│   ├── *.controller.ts       # HTTP only — no business logic
│   ├── *.service.ts          # @Injectable — business logic
│   ├── *.repository.ts       # Drizzle access layer (sole DB gate)
│   ├── *.module.ts           # wiring
│   └── *.spec.ts             # unit tests co-located
├── common/                   # decorators, filters, guards, pipes
├── config/                   # env.schema.ts, configuration.ts
├── infrastructure/           # database, logger, redis, queue, ...
├── app.module.ts             # composition root only
└── main.ts                   # FastifyAdapter bootstrap
```

The `users` module is the canonical reference end-to-end example.
Mirror its shape when adding a new bounded context.

## Endpoints today

| Endpoint              | Auth      | Notes                                       |
| --------------------- | --------- | ------------------------------------------- |
| `GET /healthz`        | `@Public` | Liveness — dependency-free                  |
| `GET /readyz`         | `@Public` | Readiness — pings the database              |
| `POST /v1/auth/login` | `@Public` | Returns `{ accessToken, user }` (15 min TTL)|
| `GET /v1/auth/me`     | JWT       | Echoes the current user                     |
| `POST /v1/users`      | `@Public` | Self-registration (argon2id hashed)         |
| `GET /v1/users`       | JWT       | Cursor pagination                           |
| `GET /v1/users/:id`   | JWT       | Single user                                 |
| `DELETE /v1/users/:id`| JWT       | Soft delete                                 |

## Common scripts

| Task                    | Command                                  |
| ----------------------- | ---------------------------------------- |
| Install                 | `pnpm install`                           |
| Dev server              | `pnpm dev`                               |
| Typecheck               | `pnpm typecheck`                         |
| Lint (autofix)          | `pnpm lint`                              |
| Lint (CI)               | `pnpm lint:ci`                           |
| Test (unit + e2e)       | `pnpm test`                              |
| Test with coverage      | `pnpm test:cov`                          |
| Test integration (DB)   | `pnpm test:int`                          |
| Build                   | `pnpm build`                             |
| Local Postgres up/down  | `pnpm db:up` / `pnpm db:down`            |
| Generate migration      | `pnpm db:generate`                       |
| Apply migrations        | `pnpm db:migrate`                        |

## Container & deploy

A multi-stage `Dockerfile` produces a distroless image that runs as
non-root:

```bash
docker build -t boilerplate-nestjs:dev .
docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e DATABASE_URL=postgres://... \
  -e JWT_SECRET=... \
  boilerplate-nestjs:dev
```

Kubernetes manifests are in `k8s/` and are pinned to v2 doc Pilar 9
defaults: separate liveness/readiness probes, non-root, resource
requests/limits, an HPA on CPU, and a `terminationGracePeriodSeconds`
that gives in-flight work time to drain. Tag the image with the commit
SHA — never `:latest`.

## CI

`.github/workflows/ci.yml` runs three parallel jobs on every PR:

- **Typecheck + Lint + Build** — `pnpm typecheck`, `pnpm lint:ci`, `pnpm build`
- **Unit + E2E** — `pnpm test:cov`; coverage artifact uploaded
- **Integration (Testcontainers)** — `pnpm test:int` against a real Postgres

Concurrency cancels superseded runs on the same ref.

## What is NOT in this template (yet)

These will land as separate PRs and matching ADR/doc updates when
they do. Add them to a service that needs them, do not invent your
own variants.

- Throttler / rate limiter with Redis storage
- OpenTelemetry SDK and exporter wiring
- Refresh-token rotation and `RolesGuard` for coarse RBAC
- BullMQ + worker entrypoint (process separate)
- Helm chart

## Contributing inside this repo

Branch protection is on `main`; every change goes through a PR.
Commits and file contents are written in **English**; chat and review
discussion can be in Bahasa Indonesia. Conventional commit subjects
(`feat(scope): …`, `fix(scope): …`) are required.

## License

UNLICENSED — internal use only.
