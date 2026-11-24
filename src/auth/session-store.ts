import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Everything needed to stay logged in. The password is never stored. */
export interface StoredSession {
  version: 1;
  username?: string;
  database?: string;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** epoch seconds */
  accessExp: number;
  refreshExp?: number;
  /** epoch seconds, hard end of the Keycloak SSO session (session_exp claim) if known */
  sessionExp?: number;
  /** tough-cookie serialized jar with the Keycloak SSO cookies (KEYCLOAK_IDENTITY, ...) */
  cookies?: unknown;
  loggedInAt: string;
  updatedAt: string;
}

interface EncryptedFile {
  enc: 'aes-256-gcm';
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

export class SessionStore {
  readonly file: string;

  constructor(
    private readonly dir: string,
    private readonly passphrase?: string,
  ) {
    this.file = join(dir, 'session.json');
  }

  async load(): Promise<StoredSession | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return undefined;
    }
    const parsed = JSON.parse(raw) as StoredSession | EncryptedFile;
    if ('enc' in parsed) {
      if (!this.passphrase) throw new Error(`${this.file} is encrypted but WODIS_SESSION_KEY is not set`);
      const key = scryptSync(this.passphrase, Buffer.from(parsed.salt, 'base64'), 32);
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
      d.setAuthTag(Buffer.from(parsed.tag, 'base64'));
      const plain = Buffer.concat([d.update(Buffer.from(parsed.data, 'base64')), d.final()]).toString('utf8');
      return JSON.parse(plain) as StoredSession;
    }
    return parsed;
  }

  async save(s: StoredSession): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700).catch(() => {});
    let body = JSON.stringify(s);
    if (this.passphrase) {
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const key = scryptSync(this.passphrase, salt, 32);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([c.update(body, 'utf8'), c.final()]);
      const enc: EncryptedFile = {
        enc: 'aes-256-gcm',
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: c.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      };
      body = JSON.stringify(enc);
    }
    // atomic write with 0600 from the start
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, this.file);
    await chmod(this.file, 0o600).catch(() => {});
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
