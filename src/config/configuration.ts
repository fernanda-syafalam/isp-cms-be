import { registerAs } from '@nestjs/config';
import { envSchema } from './env.schema';

/**
 * Typed config object loaded into ConfigModule. Parses (does not just
 * cast) `process.env` here so coerced values (number, enum) reach the
 * config — see ADR-0002 / v2 Best Practices doc, Pilar 1 for the
 * "parse, don't cast" rationale.
 */
export const appConfig = registerAs('app', () => {
  const env = envSchema.parse(process.env);
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
  } as const;
});

export type AppConfig = ReturnType<typeof appConfig>;
