import { Module } from '@nestjs/common';
import { EmailGateway, LoggingEmailGateway } from './email.gateway';
import { EmailModule } from './email.module';
import { EmailProcessor } from './email.processor';

/**
 * CONSUMER side only (R10-OPS-1). Registers EmailProcessor — the BullMQ
 * WorkerHost that delivers an `email` job via EmailGateway — and the
 * EmailGateway adapter it needs. Imports EmailModule to reuse its exported
 * EmailService/queue registration instead of re-registering the queue.
 *
 * Imported ONLY by WorkerModule. Never import this from AppModule or any
 * API-side module: doing so would instantiate the processor in the API
 * process again, reintroducing R10-OPS-1.
 */
@Module({
  imports: [EmailModule],
  providers: [EmailProcessor, { provide: EmailGateway, useClass: LoggingEmailGateway }],
})
export class EmailWorkerModule {}
