import type { EnvironmentInfo } from '@/models/payload';
import { nowIso, timezone, timezoneOffsetMinutes } from '@/utils/timestamps';


export function collectEnvironment(): EnvironmentInfo {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const { browser, version, engine } = parseUserAgent(ua);

  let extensionVersion = '0.0.0';
  try {
    extensionVersion = chrome?.runtime?.getManifest?.().version ?? '0.0.0';
  } catch {
    /* not running as an extension (tests) */
  }

  return {
    browser,
    browser_version: version,
    engine,
    platform: parsePlatform(ua),
    extension_version: extensionVersion,
    timestamp: nowIso(),
    timezone: timezone(),
    timezone_offset_minutes: timezoneOffsetMinutes(),
    language: typeof navigator !== 'undefined' ? navigator.language : null,
    viewport:
      typeof window !== 'undefined' && window.innerWidth
        ? { width: window.innerWidth, height: window.innerHeight }
        : null,
  };
}

export function parseUserAgent(ua: string): { browser: string; version: string; engine: string | null } {
  // Order matters: Chrome's UA also contains "Safari", Edge's contains "Chrome".
  const tests: { name: string; re: RegExp; engine: string }[] = [
    { name: 'Edge', re: /Edg(?:e|A|iOS)?\/(\d+[\d.]*)/, engine: 'Blink' },
    { name: 'Opera', re: /OPR\/(\d+[\d.]*)/, engine: 'Blink' },
    { name: 'Brave', re: /Brave\/(\d+[\d.]*)/, engine: 'Blink' },
    { name: 'Chrome', re: /Chrome\/(\d+[\d.]*)/, engine: 'Blink' },
    { name: 'Firefox', re: /Firefox\/(\d+[\d.]*)/, engine: 'Gecko' },
    { name: 'Safari', re: /Version\/(\d+[\d.]*).*Safari/, engine: 'WebKit' },
  ];
  for (const test of tests) {
    const match = test.re.exec(ua);
    if (match) return { browser: test.name, version: match[1] ?? 'unknown', engine: test.engine };
  }
  return { browser: 'unknown', version: 'unknown', engine: null };
}

function parsePlatform(ua: string): string | null {
  if (/Windows NT/.test(ua)) return 'Windows';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Android/.test(ua)) return 'Android';
  if (/(iPhone|iPad|iPod)/.test(ua)) return 'iOS';
  if (/Linux/.test(ua)) return 'Linux';
  return null;
}
