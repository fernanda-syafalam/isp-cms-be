import { Module } from '@nestjs/common';
import { TopologyController } from './topology.controller';
import { TopologyMutationService } from './topology.mutation.service';
import { TopologyRepository } from './topology.repository';
import { TopologyService } from './topology.service';

@Module({
  controllers: [TopologyController],
  providers: [TopologyService, TopologyMutationService, TopologyRepository],
  exports: [TopologyService],
})
export class TopologyModule {}
