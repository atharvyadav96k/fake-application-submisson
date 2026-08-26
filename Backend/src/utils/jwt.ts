import jwt from 'jsonwebtoken';
import type { AppConfig } from '../config/env.js';

export type UserRole = 'admin' | 'manager' | 'user';

export interface AuthTokenClaims {
  sub: string;
  email: string;
  role: UserRole;
  name: string;
}

export function signAuthToken(config: AppConfig, claims: AuthTokenClaims): string {
  return jwt.sign(claims, config.auth.jwtSecret, { expiresIn: config.auth.jwtExpiresIn as jwt.SignOptions['expiresIn'] });
}

/** Returns the decoded claims, or null when the token is missing/invalid/expired. */
export function verifyAuthToken(config: AppConfig, token: string): AuthTokenClaims | null {
  try {
    const decoded = jwt.verify(token, config.auth.jwtSecret);
    if (typeof decoded !== 'object' || decoded === null) return null;
    const { sub, email, role, name } = decoded as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof email !== 'string' || typeof role !== 'string' || typeof name !== 'string') {
      return null;
    }
    return { sub, email, role: role as UserRole, name };
  } catch {
    return null;
  }
}
