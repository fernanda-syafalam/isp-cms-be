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

describe('envSchema — production guard (no simulation in prod)', () => {
  const live = {
    ROUTEROS_MODE: 'live',
    PAYMENT_MODE: 'live',
    TRIPAY_API_KEY: 'k',
    TRIPAY_PRIVATE_KEY: 'p',
    TRIPAY_MERCHANT_CODE: 'm',
    TRIPAY_BASE_URL: 'https://tripay.example.com',
    NOTIFICATION_MODE: 'wa',
    WA_API_URL: 'https://wa-gateway.example.com/send',
    WA_API_TOKEN: 'token',
    COOKIE_SECURE: 'true',
    CORS_ORIGINS: 'https://app.example.com',
  };
  const prod = (over: Record<string, string> = {}) =>
    baseEnv({ NODE_ENV: 'production', ...live, ...over });
  const paths = (env: Record<string, string>): string[] => {
    const result = envSchema.safeParse(env);
    return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
  };

  it('passes in production with every live value', () => {
    expect(envSchema.safeParse(prod()).success).toBe(true);
  });

  it.each([
    ['ROUTEROS_MODE', { ROUTEROS_MODE: 'simulation' }],
    ['PAYMENT_MODE', { PAYMENT_MODE: 'simulation' }],
    ['NOTIFICATION_MODE', { NOTIFICATION_MODE: 'log' }],
    ['COOKIE_SECURE', { COOKIE_SECURE: 'false' }],
    ['CORS_ORIGINS', { CORS_ORIGINS: 'https://app.example.com, http://localhost:5173' }],
    ['CORS_ORIGINS', { CORS_ORIGINS: 'http://127.0.0.1:5173' }],
  ])('rejects %s alone in production', (key, over) => {
    expect(paths(prod(over))).toEqual([key]);
  });

  it('reports each violation as its own issue (5 for all defaults)', () => {
    const result = envSchema.safeParse(baseEnv({ NODE_ENV: 'production' }));
    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues;
    expect(issues.map((i) => i.path.join('.')).sort()).toEqual(
      [
        'CORS_ORIGINS',
        'COOKIE_SECURE',
        'NOTIFICATION_MODE',
        'PAYMENT_MODE',
        'ROUTEROS_MODE',
      ].sort(),
    );
    expect(issues[0]?.message).toContain('DEPLOY_ENV=demo');
  });

  it.each([
    'http://[::1]:5173',
    'http://0.0.0.0:3000',
    'http://admin.localhost',
    'http://localhost.:5173',
  ])('treats %s as a local CORS origin', (origin) => {
    expect(paths(prod({ CORS_ORIGINS: origin }))).toEqual(['CORS_ORIGINS']);
  });

  it('still guards when DEPLOY_ENV is blank (compose forwards "")', () => {
    expect(paths(baseEnv({ NODE_ENV: 'production', DEPLOY_ENV: '' }))).toHaveLength(5);
  });

  it('exempts DEPLOY_ENV=demo (all simulation defaults validate)', () => {
    const parsed = envSchema.parse(baseEnv({ NODE_ENV: 'production', DEPLOY_ENV: 'demo' }));
    expect(parsed.PAYMENT_MODE).toBe('simulation');
  });

  it('leaves development untouched', () => {
    expect(envSchema.safeParse(baseEnv({ NODE_ENV: 'development' })).success).toBe(true);
  });
});

describe('envSchema — BOOTSTRAP_TOKEN', () => {
  it('is optional', () => {
    expect(envSchema.parse(baseEnv()).BOOTSTRAP_TOKEN).toBeUndefined();
  });

  it('treats blank BOOTSTRAP_TOKEN and TRIPAY_API_KEY as unset', () => {
    const parsed = envSchema.parse(baseEnv({ BOOTSTRAP_TOKEN: '', TRIPAY_API_KEY: '' }));
    expect(parsed.BOOTSTRAP_TOKEN).toBeUndefined();
    expect(parsed.TRIPAY_API_KEY).toBeUndefined();
  });

  it('rejects a token shorter than 32 chars', () => {
    expect(envSchema.safeParse(baseEnv({ BOOTSTRAP_TOKEN: 'short' })).success).toBe(false);
  });

  it('accepts a 32+ char token', () => {
    expect(envSchema.parse(baseEnv({ BOOTSTRAP_TOKEN: 'x'.repeat(32) })).BOOTSTRAP_TOKEN).toBe(
      'x'.repeat(32),
    );
  });
});
