import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration. Source of truth lives in
 * src/infrastructure/database/schema/. Generated migrations land in
 * ./drizzle/ and must be committed (Pilar 8).
 *
 * Migrations are applied by the deploy pipeline, never by the
 * application at runtime — see Pilar 8, "Migration di-apply lewat
 * pipeline".
 */
export default defineConfig({
  schema: './src/infrastructure/database/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app',
  },
  strict: true,
  verbose: true,
});
