import jwt from "jsonwebtoken";
import { config } from "../config.ts";

export interface JwtPayload {
  sub: string;   // user UUID
  email: string;
  role: string;
}

export function signJwt(payload: JwtPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "30d" });
}

export function verifyJwt(token: string): JwtPayload {
  return jwt.verify(token, config.jwtSecret) as JwtPayload;
}
