import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Request body for POST /v1/topology — create an infrastructure node. Mirrors the
// FE CreateNodeSchema. Customers are NOT created here (they go through
// /topology/customer-drop); the infra directives (splitterRatio for an ODC/ODP,
// ipAddress/model for an OLT/ODC, maintenance) live alongside the core fields.
const NodeTypeSchema = z.enum(['olt', 'odc', 'odp', 'pole', 'customer']);
const NodeStatusSchema = z.enum(['up', 'down', 'unknown']);
const SplitterRatioSchema = z.enum(['1:2', '1:4', '1:8', '1:16', '1:32', '1:64']);

const InfraFieldsSchema = z.object({
  splitterRatio: SplitterRatioSchema.optional(),
  ipAddress: z.string().optional(),
  model: z.string().optional(),
  maintenance: z.boolean().optional(),
});

export const CreateNodeSchema = z
  .object({
    name: z.string().min(1, 'Nama wajib diisi').max(120),
    type: NodeTypeSchema,
    status: NodeStatusSchema,
    parentId: z.string().nullable(),
    lat: z.number(),
    lng: z.number(),
  })
  .extend(InfraFieldsSchema.shape);

export type CreateNodeInput = z.infer<typeof CreateNodeSchema>;

export class CreateNodeDto extends createZodDto(CreateNodeSchema) {}

export const UpdateNodeSchema = z
  .object({
    name: z.string().min(1, 'Nama wajib diisi').max(120).optional(),
    type: NodeTypeSchema.optional(),
    status: NodeStatusSchema.optional(),
    parentId: z.string().nullable().optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
  })
  .extend(InfraFieldsSchema.shape);

export type UpdateNodeInput = z.infer<typeof UpdateNodeSchema>;

export class UpdateNodeDto extends createZodDto(UpdateNodeSchema) {}
