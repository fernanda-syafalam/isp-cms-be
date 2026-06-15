import { Controller, Get } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { SatisfactionResponseDto } from './dto/satisfaction-response.dto';
import { SatisfactionService } from './satisfaction.service';

// Read-only satisfaction summary (any authenticated user).
@Controller({ path: 'satisfaction', version: '1' })
export class SatisfactionController {
  constructor(private readonly satisfaction: SatisfactionService) {}

  @Get()
  @ZodSerializerDto(SatisfactionResponseDto)
  get() {
    return this.satisfaction.get();
  }
}
