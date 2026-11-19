/** RFC 6238 TOTP (HMAC-SHA1/256/512) – erzeugt Codes für in Einträgen hinterlegte 2FA-Secrets. */

function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = alphabet.indexOf(c);
    if (idx < 0) throw new Error('INVALID_BASE32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export interface TotpConfig {
  secret: string;
  digits: number;
  period: number;
  algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512';
}

export function parseTotp(value: string): TotpConfig | null {
  try {
    if (value.startsWith('otpauth://')) {
      const u = new URL(value);
      const secret = u.searchParams.get('secret');
      if (!secret) return null;
      const alg = (u.searchParams.get('algorithm') ?? 'SHA1').toUpperCase();
      return {
        secret,
        digits: parseInt(u.searchParams.get('digits') ?? '6', 10),
        period: parseInt(u.searchParams.get('period') ?? '30', 10),
        algorithm: alg === 'SHA256' ? 'SHA-256' : alg === 'SHA512' ? 'SHA-512' : 'SHA-1',
      };
    }
    base32Decode(value);
    return { secret: value, digits: 6, period: 30, algorithm: 'SHA-1' };
  } catch {
    return null;
  }
}

export async function totpCode(cfg: TotpConfig, now = Date.now()): Promise<string> {
  const counter = Math.floor(now / 1000 / cfg.period);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey('raw', base32Decode(cfg.secret), { name: 'HMAC', hash: cfg.algorithm }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** cfg.digits).padStart(cfg.digits, '0');
}
