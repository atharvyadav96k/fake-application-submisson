import { beforeEach, vi } from 'vitest';
import { resetConfig } from '@/common/config';
import { resetSequence } from '@/utils/ids';

/**
 * Minimal chrome API surface. Tests that need real storage behaviour use
 * `MemoryDriver` directly rather than mocking `chrome.storage` deeply.
 */
const chromeMock = {
  runtime: {
    getManifest: () => ({ version: '1.0.0' }),
    sendMessage: vi.fn(async () => ({ ok: true })),
    onMessage: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    lastError: undefined,
  },
  alarms: {
    create: vi.fn(async () => undefined),
    onAlarm: { addListener: vi.fn() },
  },
  tabs: {
    query: vi.fn(async () => []),
    sendMessage: vi.fn(async () => undefined),
  },
};

Object.defineProperty(globalThis, 'chrome', { value: chromeMock, writable: true, configurable: true });

// jsdom lacks WebCrypto's subtle in some versions; provide getRandomValues at minimum.
if (!globalThis.crypto?.getRandomValues) {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
        return arr;
      },
    },
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  resetConfig();
  resetSequence();
  document.body.innerHTML = '';
  document.title = '';
  vi.clearAllMocks();
});

/** Sets the jsdom URL without reloading the document. */
export function setUrl(url: string): void {
  window.history.replaceState({}, '', url);
}

/** Dispatches a trusted-looking event; jsdom events report `isTrusted: false`, so
 *  tests that need a trusted event override the property explicitly. */
export function fireEvent(target: EventTarget, event: Event, trusted = true): void {
  if (trusted) Object.defineProperty(event, 'isTrusted', { value: true, configurable: true });
  target.dispatchEvent(event);
}

export function flushTimers(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for the tracker's debounced settle step (hashing + candidate matching) to run.
 * Tests shorten `dom.fill_settle_ms`, so a short real delay is enough.
 */
export async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 3; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
