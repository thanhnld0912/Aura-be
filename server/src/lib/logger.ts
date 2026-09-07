import type { FastifyRequest, FastifyServerOptions } from 'fastify';
import type { Env } from '../config/env.js';

export type LoggerOptions = Exclude<FastifyServerOptions['logger'], boolean | undefined>;

/**
 * Structured JSON logs via pino, with the redaction list from SECURITY.md §9.
 *
 * Never logged: `Authorization` headers, API keys, cookies, raw prompts, meal photo
 * bytes, free-text notes, chat content. The `req` serializer is the main control —
 * it emits four named fields rather than the whole request, so a header or body
 * added later cannot start appearing in logs by accident.
 *
 * Logged: `reqId`, method, path, route, ip, status, duration.
 */
export function loggerOptions(env: Env): LoggerOptions {
  return {
    level: env.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
      ],
      remove: true,
    },
    serializers: {
      req(request: FastifyRequest) {
        return {
          method: request.method,
          // Path only. Query strings carry user-authored text — a food search term,
          // a note — and free text does not belong in application logs.
          path: request.url.split('?')[0],
          route: request.routeOptions?.url,
          ip: request.ip,
        };
      },
      res(reply: { statusCode: number }) {
        return { statusCode: reply.statusCode };
      },
    },
    ...(env.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };
}
