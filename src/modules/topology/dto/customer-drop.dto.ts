import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Request body for POST /v1/topology/customer-drop — "Pasang pelanggan": provision
// a subscriber's drop onto a target ODP. The server allocates the splitter port +
// drop cable + strand + circuit and returns the created customer node. Mirrors the
// FE CustomerDropSchema.
export const CustomerDropSchema = z.object({
  customerId: z.string().min(1),
  odpId: z.string().min(1),
  lat: z.number(),
  lng: z.number(),
  // Optional: the exact splitter output port (= fiber core) the technician chose.
  // When omitted the server allocates the first free port.
  portNo: z.number().int().positive().optional(),
});

export type CustomerDropInput = z.infer<typeof CustomerDropSchema>;

export class CustomerDropDto extends createZodDto(CustomerDropSchema) {}
