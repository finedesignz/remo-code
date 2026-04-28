export const config = {
  port: parseInt(process.env.PORT || "3040"),
  databaseUrl: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/remocode",
  jwtSecret: process.env.JWT_SECRET || "",
  allowedOrigins: (process.env.HUB_ALLOWED_ORIGINS || "http://localhost:5173").split(",").map(s => s.trim()),
};
