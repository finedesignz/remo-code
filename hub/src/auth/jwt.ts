import jwt from "jsonwebtoken";
import { config } from "../config.ts";

if (config.jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters");
}

export interface JwtPayload {
  sub: string;   // user UUID
  email: string;
  role: string;
}

export function signJwt(payload: JwtPayload, expiresInSeconds?: number): string {
  const expiresIn = expiresInSeconds ? `${expiresInSeconds}s` : "30d";
  return jwt.sign(payload, config.jwtSecret, { expiresIn });
}

export function verifyJwt(token: string): JwtPayload {
  return jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] }) as JwtPayload;
}
