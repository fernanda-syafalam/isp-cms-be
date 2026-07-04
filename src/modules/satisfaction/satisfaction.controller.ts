import { Controller, Get } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Roles } from '../../common/decorators/roles.decorator';
import { SatisfactionResponseDto } from './dto/satisfaction-response.dto';
import { SatisfactionService } from './satisfaction.service';
// Read-only satisfaction summary (staff surface, P0.2).
@Roles('admin', 'staff')
@Controller({ path: 'satisfaction', version: '1' })
export class SatisfactionController {
  constructor(private readonly satisfaction: SatisfactionService) {}

  @Get()
  @ZodSerializerDto(SatisfactionResponseDto)
  get() {
    return this.satisfaction.get();
  }
}
