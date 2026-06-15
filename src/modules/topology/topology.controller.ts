import { Controller, Get } from '@nestjs/common';
import { TopologyService } from './topology.service';

/**
 * Read surface for the network topology + OSP cabling layer. All routes sit at
 * the v1 root (the FE calls `cables`, `strands`, … directly, not under
 * `topology/`), so the controller carries no path prefix and names each route.
 * Reads only — mutations land in later PRs (node form + customer-drop install).
 */
@Controller({ version: '1' })
export class TopologyController {
  constructor(private readonly topology: TopologyService) {}

  @Get('topology')
  getTopology() {
    return this.topology.getTopology();
  }

  @Get('cables')
  listCables() {
    return this.topology.listCables();
  }

  @Get('strands')
  listStrands() {
    return this.topology.listStrands();
  }

  @Get('splitters')
  listSplitters() {
    return this.topology.listSplitters();
  }

  @Get('closures')
  listClosures() {
    return this.topology.listClosures();
  }

  @Get('splices')
  listSplices() {
    return this.topology.listSplices();
  }

  @Get('circuits')
  listCircuits() {
    return this.topology.listCircuits();
  }
}
