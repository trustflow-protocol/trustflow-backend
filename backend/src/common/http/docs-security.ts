import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';

const DOCS_PATH = /^\/api\/docs(?:-json)?(?:[/?]|$)/;

/** Swagger UI needs inline scripts/styles and remote images; only used for the docs paths. */
export const DOCS_HELMET_OPTIONS = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: [`'self'`],
      styleSrc: [`'self'`, `'unsafe-inline'`],
      imgSrc: [`'self'`, 'data:', 'https:'],
      scriptSrc: [`'self'`, `'unsafe-inline'`],
    },
  },
  crossOriginEmbedderPolicy: false,
} as const;

/** JSON API responses render nothing, so the policy denies everything. */
export const API_HELMET_OPTIONS = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: [`'none'`],
      scriptSrc: [`'none'`],
      styleSrc: [`'none'`],
      imgSrc: [`'none'`],
      connectSrc: [`'none'`],
      fontSrc: [`'none'`],
      objectSrc: [`'none'`],
      frameAncestors: [`'none'`],
    },
  },
  crossOriginEmbedderPolicy: false,
} as const;

/** Helmet with the relaxed CSP on `/api/docs*` and the strict CSP on every other route. */
export function createSecurityHeadersMiddleware(): RequestHandler {
  const docs = helmet(DOCS_HELMET_OPTIONS);
  const api = helmet(API_HELMET_OPTIONS);
  return (req, res, next) => (DOCS_PATH.test(req.path) ? docs : api)(req, res, next);
}

/** Default: on outside production, off in production; an explicit value always wins. */
export function isSwaggerEnabled(env: { NODE_ENV?: string; SWAGGER_ENABLED?: string }): boolean {
  if (env.SWAGGER_ENABLED === 'true') return true;
  if (env.SWAGGER_ENABLED === 'false') return false;
  return env.NODE_ENV !== 'production';
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** HTTP basic auth for the docs; returns undefined when no credentials are configured. */
export function createDocsBasicAuth(user?: string, password?: string): RequestHandler | undefined {
  if (!user || !password) return undefined;
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (
        i >= 0 &&
        safeEqual(decoded.slice(0, i), user) &&
        safeEqual(decoded.slice(i + 1), password)
      ) {
        return next();
      }
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="TrustFlow API docs"');
    res.status(401).send('Authentication required');
  };
}
