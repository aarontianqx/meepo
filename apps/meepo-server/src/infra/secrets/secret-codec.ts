import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Encrypt only at the storage boundary. The key never leaves the server. */
export class SecretCodec {
  private readonly key?: Buffer;
  constructor(key?: string, production = false) {
    if (key) {
      this.key = Buffer.from(key, /^[a-f\d]{64}$/i.test(key) ? 'hex' : 'base64');
      if (this.key.length !== 32)
        throw new Error('MEEPO_SECRET_KEY must encode 32 bytes (hex or base64)');
    } else if (production) throw new Error('MEEPO_SECRET_KEY is required in production');
    else console.warn('MEEPO_SECRET_KEY is unset: development secrets are stored in plaintext');
  }
  encode(value: string): string {
    if (!this.key) return `plain:${value}`;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `gcm:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
  }
  decode(value: string): string {
    if (value.startsWith('plain:')) return value.slice(6);
    if (!this.key) throw new Error('Encrypted secrets require MEEPO_SECRET_KEY');
    const [prefix, iv, tag, body] = value.split(':');
    if (prefix !== 'gcm' || !iv || !tag || body === undefined)
      throw new Error('Invalid encrypted secret');
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    cipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([cipher.update(Buffer.from(body, 'base64')), cipher.final()]).toString(
      'utf8'
    );
  }
}
