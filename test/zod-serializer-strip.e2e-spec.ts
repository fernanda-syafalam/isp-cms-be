import { Controller, Get, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ZodSerializerDto, ZodSerializerInterceptor, createZodDto } from 'nestjs-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const SafeUserSchema = z.object({ id: z.uuid(), email: z.string() });
class SafeUserDto extends createZodDto(SafeUserSchema) {}

@Controller('probe')
class ProbeController {
  // Deliberately returns MORE than SafeUserSchema declares — the same
  // shape an under-mapped handler could leak (see UsersController's own
  // `toUserResponse`, which strips `passwordHash` by hand as a SECOND
  // line of defence). This handler does no manual stripping at all, so a
  // clean response here can only be explained by the global
  // ZodSerializerInterceptor actually running `@ZodSerializerDto`'s
  // schema against the return value — proving the decorator, previously
  // dead metadata, is now live and is the KYC/secret-stripping guarantee
  // the audit flagged as unenforced.
  @Get()
  @ZodSerializerDto(SafeUserDto)
  get() {
    return {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'a@b.test',
      passwordHash: 'super-secret-hash',
      npwp: '01.234.567.8-901.000',
      _internalDebug: 'should never leave the process',
    };
  }
}

@Module({
  controllers: [ProbeController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor }],
})
class ProbeModule {}

/**
 * Self-contained proof that registering `ZodSerializerInterceptor` (the
 * same way `AppModule` does) actually enforces `@ZodSerializerDto` at
 * runtime — the exact gap the audit found (100+ decorated handlers, no
 * interceptor wired, so the schema was dead metadata). Deliberately does
 * NOT import `AppModule`: this isolates the assertion to "does the
 * interceptor itself strip", independent of whether any given handler in
 * the real app also happens to hand-strip (most do, e.g. `UsersController`
 * — this test proves the enforcement no longer depends on that being done
 * correctly everywhere).
 */
describe('ZodSerializerInterceptor (e2e) — proves the global registration is live', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('strips every field the response schema does not declare (passwordHash, npwp, an internal field)', async () => {
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ id: '00000000-0000-4000-8000-000000000001', email: 'a@b.test' });
    expect(body.passwordHash).toBeUndefined();
    expect(body.npwp).toBeUndefined();
    expect(body._internalDebug).toBeUndefined();
  });
});
