import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let debugFile: string | undefined;

/**
 * All settings come from environment variables so the server can be installed by an agent
 * (Claude, Grok, ...) with a plain MCP config block. Nothing secret has a default.
 */
export interface AppConfig {
  /** immo-erp web app, also the OIDC redirect target. */
  baseUrl: string;
  /** Keycloak base URL and realm that the SPA uses. */
  authUrl: string;
  realm: string;
  /** Public client id of the immo-erp SPA (no secret). */
  clientId: string;
  /** Redirect URI registered for that client. */
  redirectUri: string;
  /** Customer realm alias used as kc_idp_hint, e.g. "1234567_FIRMA". Optional: discovered via username step. */
  idpHint?: string;
  /** Preferred database for the post-login selection, e.g. "1234567_FIRMA_PRD". Optional. */
  database?: string;
  /** Optional credentials for agent logins (only the TOTP then goes through the chat). */
  username?: string;
  password?: string;
  /** Directory for session.json. */
  home: string;
  /** Optional passphrase: encrypts session.json with AES-256-GCM. */
  sessionKey?: string;
  /** Proactive refresh interval in minutes (keeps the Keycloak session alive). */
  keepaliveMinutes: number;
  /** Local login page. */
  loginHost: string;
  loginPort: number;
  /** Public URL of the login page if it sits behind a proxy (server deployments). */
  loginPublicUrl?: string;
  openBrowser: boolean;
  locale: string;
  debug: boolean;
  /** Exposes the wodis_self_update tool (pulls and builds code from the git remote). Off by default. */
  allowSelfUpdate: boolean;
}

const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
};

export function loadConfig(): AppConfig {
  const baseUrl = (env('WODIS_BASE_URL') ?? 'https://wodis-yuneo.de').replace(/\/+$/, '');
  const home = env('WODIS_MCP_HOME') ?? join(homedir(), '.wodis-mcp');
  if (env('WODIS_DEBUG') === '1') {
    // MCP clients often drop server stderr after startup, so debug output also goes to a file
    mkdirSync(home, { recursive: true, mode: 0o700 });
    debugFile = join(home, 'debug.log');
  }
  return {
    baseUrl,
    authUrl: (env('WODIS_AUTH_URL') ?? 'https://auth.asw.aareon.com').replace(/\/+$/, ''),
    realm: env('WODIS_AUTH_REALM') ?? 'global',
    clientId: env('WODIS_CLIENT_ID') ?? '0A11C238-F6A8-4A27-9C35-7C95009A0304.apps.wodis-yuneo.aareon.com',
    redirectUri: env('WODIS_REDIRECT_URI') ?? `${baseUrl}/de/?auth=v2`,
    idpHint: env('WODIS_IDP_HINT'),
    database: env('WODIS_DATABASE'),
    username: env('WODIS_USERNAME'),
    password: env('WODIS_PASSWORD'),
    home,
    sessionKey: env('WODIS_SESSION_KEY'),
    keepaliveMinutes: Number(env('WODIS_KEEPALIVE_MINUTES') ?? 30),
    loginHost: env('WODIS_LOGIN_HOST') ?? '127.0.0.1',
    loginPort: Number(env('WODIS_LOGIN_PORT') ?? 0),
    loginPublicUrl: env('WODIS_LOGIN_PUBLIC_URL')?.replace(/\/+$/, ''),
    openBrowser: (env('WODIS_OPEN_BROWSER') ?? '1') !== '0',
    locale: env('WODIS_LOCALE') ?? 'de',
    debug: env('WODIS_DEBUG') === '1',
    allowSelfUpdate: env('WODIS_ALLOW_SELF_UPDATE') === '1',
  };
}

/** stderr only: stdout belongs to the MCP stdio transport. */
export function log(...args: unknown[]): void {
  console.error('[wodis-mcp]', ...args);
  if (debugFile) {
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    try {
      appendFileSync(debugFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      /* debug logging must never break the server */
    }
  }
}
