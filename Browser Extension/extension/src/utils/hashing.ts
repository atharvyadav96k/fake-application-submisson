const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let out = '';
  for (const b of view) out += b.toString(16).padStart(2, '0');
  return out;
}

function fallbackDigest(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return `fnv:${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fallbackDigest(input);
  try {
    const digest = await subtle.digest('SHA-256', encoder.encode(input));
    return toHex(digest);
  } catch {
    return fallbackDigest(input);
  }
}

const ZERO_WIDTH = new RegExp(
  '[' + [0x200b, 0x200c, 0x200d, 0xfeff].map((c) => String.fromCharCode(c)).join('') + ']',
  'g',
);

export function normalizeForCompare(value: string): string {
  return value
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function normalizePhone(value: string): string {
  const trimmed = value.trim();
  const plus = trimmed.startsWith('+') ? '+' : '';
  const digits = trimmed.replace(/\D+/g, '');
  return plus + digits;
}

export function normalizeEmail(value: string): string {
  return normalizeForCompare(value);
}

export function normalizeUrlValue(value: string): string {
  return normalizeForCompare(value)
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

export async function hashValue(value: string, salt: string): Promise<string> {
  const digest = await sha256Hex(`${salt}|${normalizeForCompare(value)}`);
  return digest.startsWith('fnv:') ? digest : `sha256:${digest}`;
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomSalt(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
