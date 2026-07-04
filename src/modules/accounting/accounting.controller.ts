import { Controller, Get, Query } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { z } from 'zod';
import { Roles } from '../../common/decorators/roles.decorator';
import { AccountingService } from './accounting.service';
import { JournalResponseDto } from './dto/journal-response.dto';

// period is YYYY-MM and required; pagination/search/sort params are optional.
const JournalQuerySchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  q: z.string().trim().min(1).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

@Roles('admin', 'staff')
@Controller({ path: 'accounting', version: '1' })
export class AccountingController {
  constructor(private readonly accounting: AccountingService) {}
  // Read-only settlement journal for a period (staff surface, P0.2).
  @Get('journal')
  @ZodSerializerDto(JournalResponseDto)
  journal(@Query() query: unknown) {
    return this.accounting.getJournal(JournalQuerySchema.parse(query));
  }
}
