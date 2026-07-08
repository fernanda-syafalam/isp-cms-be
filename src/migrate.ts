/**
 * Standalone migration runner — the deploy-pipeline entrypoint.
 *
 * Applies every pending Drizzle migration in ./drizzle, then exits.
 * Pilar 8 mandates that migrations are applied by the pipeline, never
 * by the application at runtime (that would race across replicas), so
 * this is a dedicated one-shot process, separate from main.ts.
 *
 * It runs inside the distroless runtime image, which has no shell and
 * no drizzle-kit (a dev dependency, pruned from the production image).
 * It depends only on drizzle-orm + pg — both production dependencies —
 * so the runtime command is simply:
 *
 *   node dist/migrate.js
 *
 * In the Dokploy compose (docker-compose.dokploy.yml) this is the
 * `migrate` service; the `api` and `worker` services must wait for it
 * to complete successfully before they start.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    // Fail loud, fail fast — never fall back to a default localhost DB.
    throw new Error('DATABASE_URL is required to run migrations');
  }

  // A single short-lived connection is enough for a one-shot migration.
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const db = drizzle(pool);
    // migrationsFolder resolves against the process CWD, which is /app
    // in the runtime image (WORKDIR /app, with ./drizzle copied there).
    await migrate(db, { migrationsFolder: './drizzle' });
    console.log('migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('migration failed', err);
  process.exit(1);
});
