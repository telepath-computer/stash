import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out = ENCODING[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeBytes(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ENCODING[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    out += ENCODING[(value << (5 - bits)) & 31];
  }

  return out;
}

export function ulid(): string {
  const time = encodeBase32(Date.now(), 10);
  const randomness = encodeBytes(randomBytes(10)).slice(0, 16);
  return `${time}${randomness}`;
}
