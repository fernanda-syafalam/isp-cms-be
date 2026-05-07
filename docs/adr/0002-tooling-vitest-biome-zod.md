# ADR-0002: Adopt Vitest + Biome + zod for new NestJS services

**Status:** Accepted
**Date:** 2026-05-07
**Author:** sanjit@xprogroup.com.au
**Deciders:** <TBD>

## Context

ADR-0001 captured the Prisma → Drizzle decision. The v2.0 Backend Best
Practices document made three more tooling decisions that lacked written
rationale: **Vitest** replacing Jest as the test runner, **Biome**
replacing ESLint + Prettier as the linter/formatter, and **zod** (via
`nestjs-zod`) replacing `class-validator` + `class-transformer` as the
validation layer.

These three tools are bundled into one ADR because:

- Reversibility is high for all three — each is replaceable per-service
  if it underperforms.
- They form a coherent "tooling refresh" — adopting one without the
  others leaves the team with an inconsistent dev loop (e.g., Vitest
  but ESLint = two distinct watch processes; zod-only validation but
  no Biome = two formatting styles in one repo).
- Reviewing them as a package keeps the discussion focused. Splitting
  into 3 ADRs would generate redundant context sections.

This ADR applies to **greenfield NestJS services** only — there are no
existing Jest/ESLint/class-validator services in production to migrate.

## Decision Drivers

1. **Developer feedback loop speed** — test watch latency and lint
   runtime affect every iteration. Optimizing here compounds.
2. **Single source of truth for validation** — env config, request
   DTOs, and (optionally) repository response shapes should share one
   schema definition rather than redundant type + validator pairs.
3. **ESM-native** — Vitest, Biome, and zod all work natively with ESM,
   matching Drizzle's ESM-friendly story (ADR-0001) without `ts-jest`
   workarounds.
4. **Configuration surface** — fewer dev dependencies and fewer config
   files mean less maintenance and onboarding friction.
5. **Type inference quality** — zod's `z.infer<>` produces clean TS
   types from runtime schemas; class-validator decorators leak into
   types only via secondary tools.
6. **Migration path to Go** — all three tools are JS/TS-only, so the
   choice does not affect the Go side of the stack. No coupling
   introduced.

## Considered Options

### Test runner

1. **Vitest** (chosen) — ESM-native, ~20× faster cold start than
   Jest equivalent on this stack, near-1:1 API compatibility with Jest,
   first-class watch mode.
2. **Jest** — incumbent, mature, large plugin ecosystem. ESM support
   still rough; `ts-jest` overhead.
3. **node:test** — built-in, no dependency. Minimal API; lacks
   ergonomics (no in-test mocking, weaker watch UX) for NestJS-shaped
   tests.
4. **Bun test** — fast, but couples the test runtime to Bun, which
   is not the team's runtime.

### Linter / Formatter

1. **Biome** (chosen) — single binary, lint + format in one pass, ~25×
   faster than ESLint + Prettier on this codebase size, single
   `biome.json` config.
2. **ESLint + Prettier** — mature, large plugin ecosystem (especially
   eslint-plugin-import, eslint-plugin-jest). Two tools, two configs.
3. **oxlint** — Rust-based, very fast, but lint-only (no formatter)
   and rule coverage still maturing.
4. **dprint** — formatter only; would still need a separate linter.

### Validation

1. **zod** via `nestjs-zod` (chosen) — schema-first, runtime + compile
   types from one definition, used for env config and request DTOs in
   the same project.
2. **class-validator + class-transformer** — NestJS canonical,
   decorator-driven. Heavily reflective; types and runtime checks live
   apart.
3. **joi** — older, no TS inference, hard to share with frontend.
4. **valibot** — newer, smaller bundle, less mature ecosystem
   (especially around NestJS integration).
5. **typebox** — JSON-schema-based, very fast at runtime, verbose
   schema syntax compared to zod.

## Decision

Adopt **Vitest + Biome + zod** as the default tooling bundle for new
NestJS services.

## Consequences

### Positive

- **Faster feedback loop** — Vitest watch averages 100–500 ms re-run
  per file change vs. Jest's 1–5 s on equivalent suites; Biome lint +
  format completes in under a second on typical commit-sized diffs.
- **Single-source-of-truth validation** — same zod schema validates
  env at startup (Pilar 1), request body in pipe (Pilar 2), and (if
  needed) external API responses. No type/validator drift.
- **Smaller config surface** — Biome replaces ESLint, Prettier,
  `eslint-config-prettier`, and most plugin packages — typically ~5
  dev dependencies removed.
- **Cleaner CI pipeline** — `biome check && tsc --noEmit && vitest
run --coverage` is shorter and parallelizable than the equivalent
  ESLint + Prettier + Jest combination.
- **ESM-native** — no `--experimental-vm-modules`, no `ts-jest`
  ESM mode quirks. Matches Drizzle's ESM story.

### Negative

- **Biome rules ecosystem is smaller** — niche ESLint plugins
  (`eslint-plugin-import-x`, `eslint-plugin-functional`,
  `eslint-plugin-jsdoc`) have no Biome equivalent yet. Mitigation:
  fall back to ESLint for that one rule if the gap matters; otherwise
  skip.
- **zod parse cost** — every request boundary pays µs-scale runtime
  cost (~5–50 µs per typical DTO). Acceptable for OLTP request rates;
  measure if a service approaches very high RPS.
- **Vitest ecosystem younger** — some Jest setup plugins
  (`jest-preset-*`, framework-specific transformers) lack direct
  Vitest equivalents. Mitigation: SWC plugin (per Pilar 5) covers
  the NestJS decorator-metadata case.
- **`nestjs-zod` is a community adapter** — not first-party
  Anthropic/NestJS. Bus-factor risk if maintainer abandons. Mitigation:
  the adapter is small (~200 LOC); fork-and-vendor is feasible.
- **Three fronts of unfamiliarity** if a new hire has no prior
  exposure to Vitest, Biome, or zod. Onboarding cost is real.

### Neutral

- **Coverage tooling** — both Vitest (`v8` provider) and Jest
  (istanbul/v8) emit `lcov`. CI/Codecov integration unchanged.
- **IDE support** — both Biome and ESLint have mature VSCode
  extensions. Engineer preference, not a blocker.
- **Watch mode** — better in Vitest, but Jest's `--watch` also works.

## Implementation Notes

1. **New services** use this bundle from day 1, following Pilar 5
   (Vitest), Pilar 2 (zod via `nestjs-zod`), and the Tooling Stack
   section (Biome) of the v2 doc.
2. **`nestjs-zod` version pin** — pin minor in `package.json`. If the
   package is abandoned, fork to an internal package; the adapter is
   ~200 LOC of `ZodValidationPipe` + `createZodDto` and is replaceable.
3. **Biome rules** — start with `recommended: true` plus the explicit
   overrides in the v2 doc's `biome.json` template. Add rules only
   when the team hits real bugs that a rule would have caught.
4. **Vitest setup** — use the SWC plugin (`unplugin-swc`) so NestJS
   decorator metadata works in tests. `reflect-metadata` import in
   `test/setup.ts` is required.
5. **No ESLint coexistence** — once a service migrates to Biome, do
   not keep ESLint for "just one rule." If a rule is genuinely
   needed and Biome lacks it, raise it as a follow-up; don't run
   two linters.

## Validation

After the first greenfield service ships, measure:

- **CI test runtime** — expected ≥ 2× faster than Jest baseline from
  prior services.
- **Lint runtime** — expected ≥ 10× faster than ESLint + Prettier
  baseline on the same diff size.
- **Dev dependency count** — expected to drop ~5–8 packages from the
  ESLint + Prettier + plugin set.
- **Validation surface coverage** — confirm one zod schema serves env
  - DTO without duplication; if duplication appears, document why.
- **60-day DX check-in** — survey engineers: which of the three
  caused friction. If any single tool produces significant DX blocks
  (e.g., Biome missing a rule the team relies on), revisit and
  consider partial revert via a follow-up ADR.

## Related

- [ADR-0001: Use Drizzle ORM over Prisma](./0001-use-drizzle-orm-over-prisma.md) — same reversibility/greenfield framing.
- [Backend Best Practices v2.0](../Backend-Best-Practices-NestJS-v2.md) —
  Pilar 2 (zod DTOs), Pilar 5 (Vitest setup), Tooling Stack section
  (Biome rationale).
