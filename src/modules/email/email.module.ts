import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EMAIL_QUEUE } from './email.constants';
import { EmailService } from './email.service';

/**
 * PRODUCER side only (R10-OPS-1). Registers the `email` queue so
 * EmailService can enqueue jobs. Loaded by both the HTTP app (AppModule)
 * and the worker (via EmailWorkerModule, which imports this module).
 *
 * The consumer (EmailProcessor + the EmailGateway delivery adapter it
 * needs) is registered ONLY in EmailWorkerModule, which is wired into
 * WorkerModule alone. A prior version of this module also declared
 * EmailProcessor here, which meant the API process (AppModule also imports
 * this module) instantiated a BullMQ WorkerHost and actually picked up
 * email jobs — the exact R10-OPS-1 bug this split fixes. Production
 * deployments run the worker as a separate Deployment with replica count
 * tuned against queue depth; the HTTP image and the worker image come from
 * the same Dockerfile with different CMDs (Pilar 7 + Pilar 9).
 */
@Module({
  imports: [BullModule.registerQueue({ name: EMAIL_QUEUE })],
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
