import { describe, expect, it, vi } from 'vitest';
import { assertWipeAllowed } from './seed-demo';

describe('assertWipeAllowed', () => {
  it('does not wipe or throw when SEED_WIPE is unset', () => {
    expect(assertWipeAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(assertWipeAllowed({})).toBe(false);
  });

  it('wipes when SEED_WIPE=true in development', () => {
    expect(assertWipeAllowed({ SEED_WIPE: 'true', NODE_ENV: 'development' })).toBe(true);
  });

  it('wipes when SEED_WIPE=true in test', () => {
    expect(assertWipeAllowed({ SEED_WIPE: 'true', NODE_ENV: 'test' })).toBe(true);
  });

  it('wipes in production when DEPLOY_ENV=demo', () => {
    expect(
      assertWipeAllowed({ SEED_WIPE: 'true', NODE_ENV: 'production', DEPLOY_ENV: 'demo' }),
    ).toBe(true);
  });

  it('throws in production without DEPLOY_ENV=demo', () => {
    expect(() => assertWipeAllowed({ SEED_WIPE: 'true', NODE_ENV: 'production' })).toThrow(
      /DEPLOY_ENV=demo/,
    );
  });

  it('throws when NODE_ENV is unset', () => {
    expect(() => assertWipeAllowed({ SEED_WIPE: 'true' })).toThrow(/DEPLOY_ENV=demo/);
  });
});

describe('seed-demo module import', () => {
  it('does not run main() on import', async () => {
    vi.resetModules();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await import('./seed-demo.js');
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
