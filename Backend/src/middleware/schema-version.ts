import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { unsupportedSchema } from '../utils/errors.js';

/**
 * Rejects payloads written against a schema version this deployment cannot interpret.
 *
 * The version is read from the body first and the `X-Schema-Version` header second. A
 * mismatch is a 422, not a 400: the request is well-formed, this server simply speaks a
 * different version — and 422 is not in the extension's retry set, so an unsupported
 * client backs off instead of hammering.
 */
export function requireSchemaVersion(supported: string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const body = req.body as { schema_version?: unknown } | undefined;
    const fromBody = typeof body?.schema_version === 'string' ? body.schema_version : null;
    const fromHeader = req.header('x-schema-version') ?? null;
    const version = fromBody ?? fromHeader;

    if (!version) {
      next(unsupportedSchema('A schema_version is required in the body or the X-Schema-Version header.', { supported }));
      return;
    }

    if (!supported.includes(version)) {
      next(unsupportedSchema(`Schema version '${version}' is not supported by this deployment.`, { supported }));
      return;
    }

    next();
  };
}
