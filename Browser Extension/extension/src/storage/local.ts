/**
 * Thin storage driver over `chrome.storage`, with an in-memory implementation so the
 * stores can be unit-tested outside a browser.
 */

export interface StorageDriver {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export class MemoryDriver implements StorageDriver {
  private readonly map = new Map<string, string>();

  async get<T>(key: string): Promise<T | null> {
    const raw = this.map.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }

  clear(): void {
    this.map.clear();
  }
}

type Area = 'local' | 'session';

export class ChromeDriver implements StorageDriver {
  constructor(private readonly area: Area = 'local') {}

  private get store(): chrome.storage.StorageArea {
    const s = chrome.storage as unknown as Record<Area, chrome.storage.StorageArea>;
    return s[this.area] ?? chrome.storage.local;
  }

  async get<T>(key: string): Promise<T | null> {
    const result = await this.store.get(key);
    const value = (result as Record<string, unknown>)[key];
    return value === undefined ? null : (value as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.store.set({ [key]: value });
  }

  async remove(key: string): Promise<void> {
    await this.store.remove(key);
  }

  async keys(): Promise<string[]> {
    const all = await this.store.get(null);
    return Object.keys(all ?? {});
  }
}

const hasChromeStorage = (): boolean =>
  typeof chrome !== 'undefined' && typeof chrome.storage?.local?.get === 'function';

export function createDriver(area: Area = 'local'): StorageDriver {
  return hasChromeStorage() ? new ChromeDriver(area) : new MemoryDriver();
}

/**
 * Serializes writes per key so concurrent read-modify-write cycles (very common in a
 * service worker handling parallel messages) cannot lose updates.
 */
export class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}
