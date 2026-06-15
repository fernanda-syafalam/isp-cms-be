import { Module } from '@nestjs/common';
import { TopologyController } from './topology.controller';
import { TopologyRepository } from './topology.repository';
import { TopologyService } from './topology.service';

@Module({
  controllers: [TopologyController],
  providers: [TopologyService, TopologyRepository],
  exports: [TopologyService],
})
export class TopologyModule {}
