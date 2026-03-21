// -1 = unlimited (JSON cannot represent Infinity)
export const TIER_LIMITS: Record<string, number> = {
  free: 1,
  pro: 10,
  max: -1,
}

export const config = {
  port: Number(process.env.PORT || 3040),
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY!,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  allowedOrigins: (process.env.HUB_ALLOWED_ORIGINS || 'http://localhost:5173').split(',').map(s => s.trim()),
}
