import { mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CookieJar } from 'tough-cookie';
import type { AppConfig } from '../config.js';
import { log } from '../config.js';
import {
  decodeJwt,
  KeycloakFlow,
  keycloakLogout,
  LoginError,
  TokenError,
  tokenRequest,
  type FlowResult,
  type TokenSet,
} from './keycloak.js';
import type { SessionStore, StoredSession } from './session-store.js';

export class NotLoggedInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotLoggedInError';
  }
}

export type LoginStep =
  | { status: 'ok'; message: string; auth: AuthStatus }
  | { status: 'otp_required'; message: string }
  | { status: 'database_required'; message: string; options: string[] };

export interface AuthStatus {
  loggedIn: boolean;
  username?: string;
  database?: string;
  accessTokenValidUntil?: string;
  refreshTokenValidUntil?: string;
  ssoSessionValidUntil?: string;
  canSilentRelogin: boolean;
  loggedInAt?: string;
  pendingLogin?: 'otp' | 'database';
  pendingDatabaseOptions?: string[];
  sessionFile: string;
  encrypted: boolean;
}

const nowS = () => Math.floor(Date.now() / 1000);
const iso = (s?: number) => (s ? new Date(s * 1000).toISOString() : undefined);
const FLOW_TTL_MS = 10 * 60_000;

export class TokenManager {
  private session?: StoredSession;
  private flow?: KeycloakFlow;
  private lock: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;

  constructor(
    readonly cfg: AppConfig,
    private readonly store: SessionStore,
  ) {}

  async init(): Promise<void> {
    try {
      this.session = await this.store.load();
    } catch (e) {
      log('could not read session file:', (e as Error).message);
    }
  }

  /** Runs auth operations one at a time (refresh tokens rotate, parallel refreshes would race). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  status(): AuthStatus {
    const s = this.session;
    const now = nowS();
    const pending = this.activeFlow();
    return {
      loggedIn: !!s && (s.accessExp > now || (!!s.refreshToken && (s.refreshExp ?? Infinity) > now)),
      username: s?.username,
      database: s?.database,
      accessTokenValidUntil: iso(s?.accessExp),
      refreshTokenValidUntil: s?.refreshToken ? iso(s.refreshExp) : undefined,
      ssoSessionValidUntil: iso(s?.sessionExp),
      canSilentRelogin: !!s?.cookies,
      loggedInAt: s?.loggedInAt,
      pendingLogin: pending?.waitingFor,
      pendingDatabaseOptions: pending?.waitingFor === 'database' ? pending.options.map((o) => o.replace(/^yuneo_database:/, '')) : undefined,
      sessionFile: this.store.file,
      encrypted: !!this.cfg.sessionKey,
    };
  }

  loginHelp(): string {
    return (
      'Nicht bei Wodis angemeldet. Anmelden mit: (a) Tool "wodis_login" (Benutzername + Passwort oder ' +
      'WODIS_USERNAME/WODIS_PASSWORD), danach "wodis_login_otp" mit dem 6-stelligen Code aus der Authenticator-App; ' +
      '(b) Tool "wodis_login_page" für eine lokale Login-Seite (Passwort geht nicht durch den Chat); ' +
      '(c) im Terminal: "wodis-mcp login".'
    );
  }

  /** Status after picking up changes other processes (e.g. a second MCP client) wrote to session.json. */
  async currentStatus(): Promise<AuthStatus> {
    await this.syncFromDisk();
    return this.status();
  }

  /** Bearer token for API calls: cached → refresh → silent re-login → NotLoggedInError. */
  async getAccessToken(force = false): Promise<string> {
    return this.serial(async () => {
      if (!force && this.accessValid()) return this.session!.accessToken;
      return this.withFileLock(async () => {
        const before = this.session?.accessToken;
        await this.syncFromDisk();
        // another process may have refreshed meanwhile: use its token instead of spending ours
        if (this.accessValid() && (!force || this.session!.accessToken !== before)) return this.session!.accessToken;
        if ((await this.tryRefresh()) || (await this.trySilent())) return this.session!.accessToken;
        throw new NotLoggedInError(this.loginHelp());
      });
    });
  }

  private accessValid(): boolean {
    return !!this.session && this.session.accessExp - nowS() > 60;
  }

  // ---- interactive login (tools, login page, CLI) ----------------------------

  async login(username?: string, password?: string): Promise<LoginStep> {
    const u = username?.trim() || this.cfg.username;
    const p = password || this.cfg.password;
    if (!u || !p) {
      throw new LoginError('Benutzername und Passwort fehlen (als Parameter oder über WODIS_USERNAME / WODIS_PASSWORD).');
    }
    return this.serial(async () => {
      const flow = new KeycloakFlow(this.cfg);
      this.flow = flow;
      return this.step(flow, () => flow.start({ username: u, password: p }));
    });
  }

  async submitOtp(code: string): Promise<LoginStep> {
    return this.serial(async () => {
      const flow = this.requireFlow('otp');
      return this.step(flow, () => flow.submitOtp(code));
    });
  }

  async selectDatabase(db: string): Promise<LoginStep> {
    return this.serial(async () => {
      const flow = this.requireFlow('database');
      return this.step(flow, () => flow.selectDatabase(db));
    });
  }

  async logout(): Promise<void> {
    return this.serial(() =>
      this.withFileLock(async () => {
        await this.syncFromDisk();
        if (this.session?.refreshToken) await keycloakLogout(this.cfg, this.session.refreshToken);
        this.session = undefined;
        this.flow = undefined;
        await this.store.clear();
      }),
    );
  }

  // ---- keepalive --------------------------------------------------------------

  /** Refresh proactively so the Keycloak SSO session never idles out while the server runs. */
  startKeepalive(): void {
    const minutes = Number.isFinite(this.cfg.keepaliveMinutes) ? Math.max(5, this.cfg.keepaliveMinutes) : 30;
    this.timer = setInterval(() => {
      this.keepalive()
        .then((r) => this.cfg.debug && log('keepalive:', r))
        .catch((e) => log('keepalive failed:', (e as Error).message));
    }, minutes * 60_000);
    this.timer.unref();
  }

  stopKeepalive(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async keepalive(): Promise<'refreshed' | 'fresh' | 'silent_relogin' | 'not_logged_in'> {
    return this.serial(() =>
      this.withFileLock(async () => {
        await this.syncFromDisk();
        if (!this.session) return 'not_logged_in';
        // another process refreshed recently: nothing to do
        const ageMin = (Date.now() - Date.parse(this.session.updatedAt)) / 60_000;
        if (this.accessValid() && this.session.refreshToken && ageMin < Math.max(5, this.cfg.keepaliveMinutes) / 2) return 'fresh';
        if (await this.tryRefresh()) return 'refreshed';
        if (await this.trySilent()) return 'silent_relogin';
        return 'not_logged_in';
      }),
    );
  }

  // ---- internals ------------------------------------------------------------------

  private activeFlow(): KeycloakFlow | undefined {
    if (this.flow && Date.now() - this.flow.createdAt > FLOW_TTL_MS) this.flow = undefined;
    return this.flow?.waitingFor ? this.flow : undefined;
  }

  private requireFlow(kind: 'otp' | 'database'): KeycloakFlow {
    const flow = this.activeFlow();
    if (!flow || flow.waitingFor !== kind) {
      throw new LoginError(
        kind === 'otp'
          ? 'Kein Login wartet auf einen TOTP-Code (nicht gestartet oder nach 10 Minuten abgelaufen). Bitte "wodis_login" erneut aufrufen.'
          : 'Kein Login wartet auf eine Datenbankauswahl.',
      );
    }
    return flow;
  }

  private async step(flow: KeycloakFlow, run: () => Promise<FlowResult>): Promise<LoginStep> {
    let r: FlowResult;
    try {
      r = await run();
    } catch (e) {
      this.flow = undefined;
      throw e;
    }
    switch (r.kind) {
      case 'done': {
        await this.withFileLock(() => this.apply(r.tokens, flow.jar, true));
        this.flow = undefined;
        const auth = this.status();
        return {
          status: 'ok',
          message: `Angemeldet als ${auth.username ?? '?'} (Datenbank ${auth.database ?? '?'}). Die Sitzung wird automatisch verlängert.`,
          auth,
        };
      }
      case 'need_otp':
        return { status: 'otp_required', message: r.message ?? 'Bitte den 6-stelligen Code aus der Authenticator-App senden (Tool "wodis_login_otp").' };
      case 'need_database':
        return {
          status: 'database_required',
          message: r.message ?? 'Bitte eine Datenbank auswählen (Tool "wodis_login_select_database").',
          options: r.options,
        };
      case 'need_credentials':
        this.flow = undefined;
        throw new LoginError(r.message ?? 'Keycloak verlangt erneut Benutzername und Passwort.');
    }
  }

  /** Adopt session.json if another process wrote a newer one (or logged out). */
  private async syncFromDisk(): Promise<void> {
    try {
      const disk = await this.store.load();
      if (!disk) this.session = undefined;
      else if (!this.session || disk.updatedAt > this.session.updatedAt) this.session = disk;
    } catch (e) {
      log('could not re-read session file:', (e as Error).message);
    }
  }

  /** Cross-process lock around refresh/login writes (refresh tokens rotate). Not reentrant. */
  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = join(this.cfg.home, 'session.lock');
    await mkdir(this.cfg.home, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const h = await open(lock, 'wx', 0o600);
        await h.writeFile(String(process.pid));
        await h.close();
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const st = await stat(lock).catch(() => undefined);
        if (!st || Date.now() - st.mtimeMs > 90_000) {
          await rm(lock, { force: true }); // stale lock of a crashed process
          continue;
        }
        if (Date.now() > deadline) throw new Error(`${lock} ist blockiert (läuft ein anderer wodis-mcp-Prozess?)`);
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { force: true });
    }
  }

  private async tryRefresh(): Promise<boolean> {
    const s = this.session;
    if (!s?.refreshToken) return false;
    if (s.refreshExp && s.refreshExp - nowS() < 5) return false;
    try {
      const t = await tokenRequest(this.cfg, {
        grant_type: 'refresh_token',
        client_id: this.cfg.clientId,
        refresh_token: s.refreshToken,
      });
      await this.apply(t);
      return true;
    } catch (e) {
      if (e instanceof TokenError) {
        log('token refresh rejected:', e.message);
        s.refreshToken = undefined;
        await this.store.save(s);
        return false;
      }
      throw e;
    }
  }

  private async trySilent(): Promise<boolean> {
    const s = this.session;
    if (!s?.cookies) return false;
    try {
      const jar = await CookieJar.deserialize(s.cookies as string);
      const flow = new KeycloakFlow(this.cfg, jar);
      const r = await flow.start();
      if (r.kind === 'done') {
        await this.apply(r.tokens, jar);
        log('silent re-login with stored SSO session succeeded');
        return true;
      }
      log(`silent re-login not possible (${r.kind}); interactive login needed`);
    } catch (e) {
      log('silent re-login failed:', (e as Error).message);
    }
    return false;
  }

  private async apply(t: TokenSet, jar?: CookieJar, freshLogin = false): Promise<void> {
    const claims = decodeJwt(t.access_token);
    const now = nowS();
    const prev = this.session;
    const scope = t.scope ?? (typeof claims.scope === 'string' ? claims.scope : '');
    const stamp = new Date().toISOString();
    this.session = {
      version: 1,
      username: (claims.preferred_username as string | undefined) ?? prev?.username,
      database: scope.match(/yuneo_database:(\S+)/)?.[1] ?? prev?.database,
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? prev?.refreshToken,
      idToken: t.id_token ?? prev?.idToken,
      accessExp: typeof claims.exp === 'number' ? claims.exp : now + t.expires_in,
      refreshExp: t.refresh_expires_in ? now + t.refresh_expires_in : prev?.refreshExp,
      sessionExp: typeof claims.session_exp === 'number' ? claims.session_exp : prev?.sessionExp,
      cookies: jar ? await jar.serialize() : prev?.cookies,
      loggedInAt: freshLogin || !prev ? stamp : prev.loggedInAt,
      updatedAt: stamp,
    };
    await this.store.save(this.session);
  }
}
