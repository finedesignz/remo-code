// Typed Hono context variables shared by the auth / rate-limit middlewares.
// Without this, `c.get('userId')` resolves to `never` under TS 7 (hundreds of
// TS2769 errors in `hub/tsc`). Optional keys are only set on some auth paths.
import 'hono'

declare module 'hono' {
  interface ContextVariableMap {
    userId: string
    userRole?: string
    userEmail?: string
    authMethod?: string
    apiKeyId?: string
    actor?: string
    rateLimited?: boolean
    requestId?: string
  }
}
