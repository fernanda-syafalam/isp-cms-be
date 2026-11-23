// Same allowlist as assertWipeAllowed in seed-demo.ts: demo data may only be
// written in development/test or on a DEPLOY_ENV=demo deployment.
export function isDemoSeedAllowed(env: { nodeEnv: string; deployEnv?: string }): boolean {
  return env.nodeEnv === 'development' || env.nodeEnv === 'test' || env.deployEnv === 'demo';
}
