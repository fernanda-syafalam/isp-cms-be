import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const LoginSchema = z
  .object({
    email: z.email(),
    password: z.string().min(1).max(128),
  })
  .strict();

export type LoginInput = z.infer<typeof LoginSchema>;

export class LoginDto extends createZodDto(LoginSchema) {}
