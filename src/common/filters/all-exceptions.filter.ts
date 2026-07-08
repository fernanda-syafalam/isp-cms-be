import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PinoLogger } from 'nestjs-pino';
import { ZodSerializationException } from 'nestjs-zod';
import { ZodError } from 'zod';

/**
 * RFC 7807 Problem Details body. The `type` URI is a placeholder that
 * teams typically point at their internal error catalogue. `instance`
 * is the request URL so support can correlate without a request id.
 *
 * Optional, non-RFC fields: `requestId`, `code`. Standard problem+json
 * allows extension members; we add ours so support can grep logs without
 * passing the URL around, and so a client can branch on a stable
 * machine-readable `code` instead of parsing `title` (which is meant for
 * humans and may be localized later). `code` is opt-in per exception —
 * throw `new SomeHttpException({ message, code })` to set it; otherwise
 * it is simply omitted from the body.
 */
interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  errors?: unknown;
  requestId?: string;
  code?: string;
}

/**
 * Translates every uncaught error into a uniform `application/problem+json`
 * response. Internal details (stack, server-side error message) are
 * logged at the appropriate level and never sent to the client.
 *
 * Wired globally via APP_FILTER in AppModule so it has full DI access
 * (PinoLogger, etc.). See v2 doc, Pilar 2.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const req = ctx.getRequest<FastifyRequest>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = 'Internal Server Error';
    let detail: string | undefined;
    let errors: unknown;
    let code: string | undefined;

    if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      title = 'Validation Failed';
      errors = exception.flatten();
    } else if (exception instanceof ZodSerializationException) {
      // A handler's return value didn't match the `@ZodSerializerDto(...)`
      // response schema declared for it (e.g. a raw Date where the schema
      // expects an ISO string) — a server-side bug, not a client error, so
      // this stays a 500 with the generic InternalServerErrorException
      // title/status the exception already carries. Unlike a plain Error,
      // `ZodSerializationException` never falls into the `instanceof
      // Error` branch below (`InternalServerErrorException` IS an
      // `HttpException`), so without this branch a response-serialization
      // bug would 500 with ZERO server-side log line — exactly the kind of
      // silent failure this filter exists to prevent. Logs the Zod issue
      // list (never the response payload itself, which may carry a KYC/
      // secret field this exception was thrown while trying to strip).
      this.logger.error(
        { err: exception.getZodError() },
        'response failed schema validation (ZodSerializerDto mismatch)',
      );
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      title = exception.message;
      if (typeof res === 'object' && res !== null) {
        const obj = res as Record<string, unknown>;
        if (typeof obj.message === 'string') title = obj.message;
        if (typeof obj.detail === 'string') detail = obj.detail;
        if (typeof obj.code === 'string') code = obj.code;
        if ('errors' in obj) errors = obj.errors;
      }
    } else if (exception instanceof Error) {
      // Server-side log keeps the full stack; the client never sees it.
      this.logger.error({ err: exception }, 'unhandled exception');
    }

    const body: ProblemDetails = {
      type: `https://errors.example.com/${status}`,
      title,
      status,
      detail,
      instance: req.url,
      errors,
      requestId: req.id?.toString(),
      code,
    };

    reply.status(status).type('application/problem+json').send(body);
  }
}
