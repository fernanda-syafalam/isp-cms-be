import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateNodeDto, UpdateNodeDto } from './dto/create-node.dto';
import { CustomerDropDto } from './dto/customer-drop.dto';
import { UpdateCableRouteDto } from './dto/update-cable-route.dto';
import { TopologyMutationService } from './topology.mutation.service';
import { TopologyService } from './topology.service';

/**
 * Network topology + OSP cabling layer. All routes sit at the v1 root (the FE
 * calls `cables`, `strands`, … directly, not under `topology/`), so the
 * controller carries no path prefix and names each route. Reads are open to any
 * authenticated user; mutations (node form + customer-drop install + cable
 * re-route) are gated to admin/staff and audited.
 */
@Roles('admin', 'staff', 'teknisi')
@Controller({ version: '1' })
export class TopologyController {
  constructor(
    private readonly topology: TopologyService,
    private readonly mutation: TopologyMutationService,
  ) {}

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

  // ---- Mutations (admin/staff, audited) ------------------------------------

  @Roles('admin', 'staff', 'teknisi')
  @Audit('topology.create')
  @Post('topology')
  @HttpCode(HttpStatus.CREATED)
  createNode(@Body() body: CreateNodeDto) {
    return this.mutation.createNode(body);
  }

  @Roles('admin', 'staff', 'teknisi')
  @Audit('topology.install')
  @Post('topology/customer-drop')
  @HttpCode(HttpStatus.CREATED)
  customerDrop(@Body() body: CustomerDropDto) {
    return this.mutation.customerDrop(body);
  }

  @Roles('admin', 'staff', 'teknisi')
  @Audit('topology.update')
  @Patch('topology/:id')
  updateNode(@Param('id') id: string, @Body() body: UpdateNodeDto) {
    return this.mutation.updateNode(id, body);
  }

  @Roles('admin', 'staff', 'teknisi')
  @Audit('topology.delete')
  @Delete('topology/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteNode(@Param('id') id: string) {
    return this.mutation.deleteNode(id);
  }

  @Roles('admin', 'staff', 'teknisi')
  @Audit('topology.cable.update')
  @Patch('cables/:id')
  updateCableRoute(@Param('id') id: string, @Body() body: UpdateCableRouteDto) {
    return this.mutation.updateCableRoute(id, body);
  }
}
