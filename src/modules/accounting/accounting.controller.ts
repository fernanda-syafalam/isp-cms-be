import { Controller, Get, Query } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { z } from 'zod';
import { AccountingService } from './accounting.service';
import { JournalResponseDto } from './dto/journal-response.dto';

// period is YYYY-MM and required.
const JournalQuerySchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
});

@Controller({ path: 'accounting', version: '1' })
export class AccountingController {
  constructor(private readonly accounting: AccountingService) {}

  // Read-only settlement journal for a period (any authenticated user).
  @Get('journal')
  @ZodSerializerDto(JournalResponseDto)
  journal(@Query() query: unknown) {
    const { period } = JournalQuerySchema.parse(query);
    return this.accounting.getJournal(period);
  }
}
