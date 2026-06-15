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
  Query,
} from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { InventoryItemResponseDto } from './dto/inventory-response.dto';
import { MoveInventoryDto } from './dto/move-inventory.dto';
import { StockInDto } from './dto/stock-in.dto';
import { UpdateInventoryDto } from './dto/update-inventory.dto';
import { InventoryService } from './inventory.service';

const ListQuerySchema = z.object({
  status: z.enum(['warehouse', 'installed', 'broken']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const MovementQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@Controller({ path: 'inventory', version: '1' })
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.inventory.list(ListQuerySchema.parse(query));
  }

  // Literal path — declared before any param routes (none here, but keeps
  // intent clear).
  @Get('movements')
  listMovements(@Query() query: unknown) {
    return this.inventory.listMovements(MovementQuerySchema.parse(query));
  }

  @Roles('admin', 'staff')
  @Audit('inventory.stock_in')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ZodSerializerDto(InventoryItemResponseDto)
  stockIn(@Body() body: StockInDto) {
    return this.inventory.stockIn(body);
  }

  @Roles('admin', 'staff')
  @Audit('inventory.move')
  @Post(':id/move')
  @ZodSerializerDto(InventoryItemResponseDto)
  move(@Param('id') id: string, @Body() body: MoveInventoryDto) {
    return this.inventory.move(id, body);
  }

  @Roles('admin', 'staff')
  @Audit('inventory.update')
  @Patch(':id')
  @ZodSerializerDto(InventoryItemResponseDto)
  update(@Param('id') id: string, @Body() body: UpdateInventoryDto) {
    return this.inventory.update(id, body);
  }

  @Roles('admin', 'staff')
  @Audit('inventory.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string): Promise<void> {
    return this.inventory.remove(id);
  }
}
