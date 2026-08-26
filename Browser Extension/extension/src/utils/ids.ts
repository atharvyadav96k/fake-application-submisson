const HEX = '0123456789abcdef';

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const cryptoObj: Crypto | undefined = globalThis.crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

export function uuid(): string {
  const cryptoObj: Crypto | undefined = globalThis.crypto;
  if (typeof cryptoObj?.randomUUID === 'function') return cryptoObj.randomUUID();
  const b = randomBytes(16);
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  let s = '';
  for (let i = 0; i < 16; i++) {
    const byte = b[i] as number;
    s += HEX[byte >> 4]! + HEX[byte & 0x0f]!;
    if (i === 3 || i === 5 || i === 7 || i === 9) s += '-';
  }
  return s;
}

export function shortId(prefix: string): string {
  const b = randomBytes(6);
  let s = '';
  for (const byte of b) s += HEX[byte >> 4]! + HEX[byte & 0x0f]!;
  return `${prefix}_${s}`;
}

let counter = 0;
export function nextSequence(): number {
  return ++counter;
}

export function resetSequence(): void {
  counter = 0;
}
