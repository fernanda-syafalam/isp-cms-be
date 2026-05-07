// Re-export every Drizzle pgTable / relations / enum from this folder.
//
// Add domain schemas as files (one per bounded context) and re-export
// them here so DrizzleService can pass `{ schema }` into `drizzle()`
// for the relational query API. Example once a domain lands:
//
//   export * from './users.schema';
//   export * from './orders.schema';
//
// Keeping this file even when empty signals the convention to engineers
// adding the first schema.
export {};
