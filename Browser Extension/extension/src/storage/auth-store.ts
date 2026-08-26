import { createDriver, type StorageDriver } from './local';

/**
 * Persists the operator's signed-in identity (JWT + basic profile) across service-worker
 * restarts. Lives in `local` storage — deliberately not `session` storage, since staying
 * signed in across a browser restart is the point (unlike the candidate PII cache in
 * `SessionStore`, which is intentionally wiped when the browser closes).
 */

const AUTH_KEY = 'aav.auth';

export interface AuthState {
  token: string;
  role: string;
  email: string;
  name: string;
}

export class AuthStore {
  constructor(private readonly driver: StorageDriver = createDriver('local')) {}

  async get(): Promise<AuthState | null> {
    return this.driver.get<AuthState>(AUTH_KEY);
  }

  async set(auth: AuthState): Promise<void> {
    await this.driver.set(AUTH_KEY, auth);
  }

  async clear(): Promise<void> {
    await this.driver.remove(AUTH_KEY);
  }
}
