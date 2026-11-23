/**
 * True for a real production deploy: NODE_ENV=production and not the demo
 * deployment (DEPLOY_ENV=demo). Single predicate shared by the env schema
 * guard (no simulation modes) and the bootstrap-token requirement.
 */
export function isProductionDeploy(nodeEnv: string, deployEnv: string | undefined): boolean {
  return nodeEnv === 'production' && deployEnv !== 'demo';
}
