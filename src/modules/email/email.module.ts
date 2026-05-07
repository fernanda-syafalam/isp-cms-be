import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EMAIL_QUEUE } from './email.constants';
import { EmailGateway, LoggingEmailGateway } from './email.gateway';
import { EmailProcessor } from './email.processor';
import { EmailService } from './email.service';

/**
 * Email module — registers the queue (so EmailService can produce
 * jobs) and the processor (so the worker process can consume them).
 *
 * Same module loaded in both the HTTP app (AppModule) and the worker
 * (WorkerModule). The processor is a no-op in the HTTP process
 * because BullMQ's WorkerHost only starts a worker when the
 * containing context is a WorkerHost — but in practice the HTTP
 * process here also picks up jobs. Production deployments typically
 * deploy the worker as a separate Deployment with replica count tuned
 * against queue depth; the HTTP image and the worker image come from
 * the same Dockerfile with different CMDs (Pilar 7 + Pilar 9).
 */
@Module({
  imports: [BullModule.registerQueue({ name: EMAIL_QUEUE })],
  providers: [
    EmailService,
    EmailProcessor,
    { provide: EmailGateway, useClass: LoggingEmailGateway },
  ],
  exports: [EmailService],
})
export class EmailModule {}
