// Phase 07-G: Security headers middleware.
//
// Mounted FIRST in the chain (hub/src/index.ts) so every response — including
// errors thrown by later middleware — carries the full header set.
//
// CSP shape is built from a typed object so tests can assert each directive
// without string parsing. `'unsafe-inline'` remains on script-src ONLY if the
// React/Vite build genuinely requires it (Vite injects inline preload scripts
// in production HTML). If a future build drops the inline scripts, remove it
// from `scriptSrc` here — the policy is the single source of truth.

import type { Context, Next } from 'hono';

export interface CspDirectives {
  defaultSrc: string[];
  scriptSrc: string[];
  styleSrc: string[];
  imgSrc: string[];
  connectSrc: string[];
  fontSrc: string[];
  frameAncestors: string[];
  baseUri: string[];
  formAction: string[];
  objectSrc: string[];
}

export const DEFAULT_CSP: CspDirectives = {
  defaultSrc: ["'self'"],
  // 'unsafe-inline' kept on script-src for Vite's production inline preload
  // scripts. Tighten in a follow-up if those go away.
  scriptSrc: ["'self'", "'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'blob:'],
  connectSrc: ["'self'", 'wss:', 'https:'],
  fontSrc: ["'self'", 'data:'],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  objectSrc: ["'none'"],
};

export function renderCsp(d: CspDirectives): string {
  const parts: string[] = [
    `default-src ${d.defaultSrc.join(' ')}`,
    `script-src ${d.scriptSrc.join(' ')}`,
    `style-src ${d.styleSrc.join(' ')}`,
    `img-src ${d.imgSrc.join(' ')}`,
    `connect-src ${d.connectSrc.join(' ')}`,
    `font-src ${d.fontSrc.join(' ')}`,
    `frame-ancestors ${d.frameAncestors.join(' ')}`,
    `base-uri ${d.baseUri.join(' ')}`,
    `form-action ${d.formAction.join(' ')}`,
    `object-src ${d.objectSrc.join(' ')}`,
  ];
  return parts.join('; ');
}

export interface SecurityHeadersOptions {
  csp?: CspDirectives;
  // HSTS max-age default 2 years per OWASP recommendation.
  hstsMaxAgeSeconds?: number;
}

export function securityHeaders(opts: SecurityHeadersOptions = {}) {
  const cspValue = renderCsp(opts.csp ?? DEFAULT_CSP);
  const hstsMaxAge = opts.hstsMaxAgeSeconds ?? 63_072_000; // 2 years
  const hstsValue = `max-age=${hstsMaxAge}; includeSubDomains; preload`;

  return async (c: Context, next: Next) => {
    await next();
    c.header('Strict-Transport-Security', hstsValue);
    c.header('Content-Security-Policy', cspValue);
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header(
      'Permissions-Policy',
      [
        'camera=()',
        'microphone=()',
        'geolocation=()',
        'payment=()',
        'usb=()',
        'magnetometer=()',
        'gyroscope=()',
        'accelerometer=()',
      ].join(', '),
    );
    // Strip framework leaks. Hono doesn't set X-Powered-By; Bun.serve doesn't
    // set Server either, but be defensive — some reverse proxies inject.
    c.header('Server', '');
    c.header('X-Powered-By', '');
    // Empty-string headers are a no-op in Hono — explicitly delete them.
    c.res.headers.delete('Server');
    c.res.headers.delete('X-Powered-By');
  };
}
