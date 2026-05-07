// NestJS dependency injection relies on emitDecoratorMetadata via reflect-metadata.
// Importing once here makes it available for every Vitest worker.
import 'reflect-metadata';
