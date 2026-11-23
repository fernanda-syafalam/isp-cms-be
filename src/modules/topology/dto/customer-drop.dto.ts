import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Request body for POST /v1/topology/customer-drop — "Pasang pelanggan": provision
// a subscriber's drop onto a target ODP. The server allocates the splitter port +
// drop cable + strand + circuit and returns the created customer node. Mirrors the
// FE CustomerDropSchema.
export const CustomerDropSchema = z
  .object({
    customerId: z.uuid(),
    odpId: z.string().min(1),
    // The map click. Optional (both or neither): used only to fill a customer that
    // has no stored coordinates; customers.lat/lng wins otherwise.
    lat: z.number().finite().min(-90).max(90).optional(),
    lng: z.number().finite().min(-180).max(180).optional(),
    // Optional: the exact splitter output port (= fiber core) the technician chose.
    // When omitted the server allocates the first free port.
    portNo: z.number().int().positive().optional(),
  })
  .refine((b) => (b.lat === undefined) === (b.lng === undefined), {
    message: 'lat and lng must be provided together',
    path: ['lat'],
  });

export type CustomerDropInput = z.infer<typeof CustomerDropSchema>;

export class CustomerDropDto extends createZodDto(CustomerDropSchema) {}
