// Re-export every Drizzle pgTable / relations / enum from this folder.
// Add new domain schemas here as they land — DrizzleService passes
// `{ schema }` into `drizzle()` so the relational query API can resolve
// references across files.
export * from './contracts.schema';
export * from './customers.schema';
export * from './inventory.schema';
export * from './invoices.schema';
export * from './leads.schema';
export * from './plans.schema';
export * from './resellers.schema';
export * from './routers.schema';
export * from './sla-credits.schema';
export * from './tickets.schema';
export * from './users.schema';
export * from './vouchers.schema';
export * from './work-orders.schema';
