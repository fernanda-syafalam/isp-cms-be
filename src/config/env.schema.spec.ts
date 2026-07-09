import { describe, expect, it } from 'vitest';
import { envSchema } from './env.schema';

// Minimal valid baseline — every var envSchema requires unconditionally,
// independent of NOTIFICATION_MODE / PAYMENT_MODE. Mirrors test/setup.ts's
// fixed test values.
function baseEnv(over: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://app:app@localhost:5432/app',
    JWT_SECRET: 'test-secret-must-be-at-least-32-characters-long',
    TWOFA_ENC_KEY: 'vnteJd7CUd7akqlbonvugRw6MNVSqV88K3ijn82XeoM=',
    ...over,
  };
}

describe('envSchema — NOTIFICATION_MODE (ADR-0017)', () => {
  it('defaults to log and does not require any WA_API_* var', () => {
    const parsed = envSchema.parse(baseEnv());
    expect(parsed.NOTIFICATION_MODE).toBe('log');
  });

  it('accepts NOTIFICATION_MODE=wa with both WA_API_* vars present', () => {
    const parsed = envSchema.parse(
      baseEnv({
        NOTIFICATION_MODE: 'wa',
        WA_API_URL: 'https://wa-gateway.example.com/send',
        WA_API_TOKEN: 'token',
      }),
    );
    expect(parsed.NOTIFICATION_MODE).toBe('wa');
  });

  it('fails fast when NOTIFICATION_MODE=wa and both WA_API_* vars are missing', () => {
    const result = envSchema.safeParse(baseEnv({ NOTIFICATION_MODE: 'wa' }));
    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['WA_API_URL', 'WA_API_TOKEN']));
  });

  it('fails fast when NOTIFICATION_MODE=wa and only WA_API_TOKEN is missing', () => {
    const result = envSchema.safeParse(
      baseEnv({
        NOTIFICATION_MODE: 'wa',
        WA_API_URL: 'https://wa-gateway.example.com/send',
      }),
    );
    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(['WA_API_TOKEN']);
  });
});

describe('envSchema — PAYMENT_MODE (ADR-0016)', () => {
  it('defaults to simulation and does not require any TRIPAY_* var', () => {
    const parsed = envSchema.parse(baseEnv());
    expect(parsed.PAYMENT_MODE).toBe('simulation');
  });

  it('accepts PAYMENT_MODE=live with all four TRIPAY_* vars present', () => {
    const parsed = envSchema.parse(
      baseEnv({
        PAYMENT_MODE: 'live',
        TRIPAY_API_KEY: 'key',
        TRIPAY_PRIVATE_KEY: 'secret',
        TRIPAY_MERCHANT_CODE: 'T0001',
        TRIPAY_BASE_URL: 'https://tripay.co.id/api',
      }),
    );
    expect(parsed.PAYMENT_MODE).toBe('live');
  });

  it('fails fast when PAYMENT_MODE=live and every TRIPAY_* var is missing', () => {
    const result = envSchema.safeParse(baseEnv({ PAYMENT_MODE: 'live' }));
    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(
      expect.arrayContaining([
        'TRIPAY_API_KEY',
        'TRIPAY_PRIVATE_KEY',
        'TRIPAY_MERCHANT_CODE',
        'TRIPAY_BASE_URL',
      ]),
    );
  });

  it('fails fast when PAYMENT_MODE=live and only one TRIPAY_* var is missing', () => {
    const result = envSchema.safeParse(
      baseEnv({
        PAYMENT_MODE: 'live',
        TRIPAY_API_KEY: 'key',
        TRIPAY_PRIVATE_KEY: 'secret',
        TRIPAY_MERCHANT_CODE: 'T0001',
        // TRIPAY_BASE_URL intentionally omitted
      }),
    );
    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(['TRIPAY_BASE_URL']);
  });
});

describe('envSchema — TRUST_PROXY (R5-SEC-1)', () => {
  it('is optional (absent env parses fine)', () => {
    const parsed = envSchema.parse(baseEnv());
    expect(parsed.TRUST_PROXY).toBeUndefined();
  });

  it.each(['1', '0', '2', 'true', 'false', '10.0.0.0/8', '10.0.0.1, 10.0.0.2'])(
    'accepts the valid value %j',
    (value) => {
      const result = envSchema.safeParse(baseEnv({ TRUST_PROXY: value }));
      expect(result.success).toBe(true);
    },
  );

  it.each(['yes', 'trust-all', '-1', 'abc'])(
    'rejects the garbage value %j with a clear message rather than crashing at bootstrap',
    (value) => {
      const result = envSchema.safeParse(baseEnv({ TRUST_PROXY: value }));
      expect(result.success).toBe(false);
      const paths = result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('TRUST_PROXY');
    },
  );
});

describe('envSchema — CORS_ORIGINS wildcard (R10-OPS-9)', () => {
  it('accepts a comma-separated list of explicit origins', () => {
    const result = envSchema.safeParse(
      baseEnv({ CORS_ORIGINS: 'https://isp.astaweda.com, https://admin.astaweda.com' }),
    );
    expect(result.success).toBe(true);
  });

  it.each(['*', 'https://isp.astaweda.com,*', ' * '])(
    'rejects a wildcard origin %j at boot (credentials:true forbids it)',
    (value) => {
      const result = envSchema.safeParse(baseEnv({ CORS_ORIGINS: value }));
      expect(result.success).toBe(false);
      const paths = result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('CORS_ORIGINS');
    },
  );
});
