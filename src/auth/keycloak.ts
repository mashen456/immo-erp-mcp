/**
 * Headless Keycloak login for immo-erp (Authorization Code + PKCE, public client).
 *
 * Captured flow (see scripts/wodis_client/AUTH.md):
 *   global realm: username  ->  broker to customer realm: username+password  ->  TOTP
 *   ->  post-broker-login (database selection)  ->  redirect_uri#code=...  ->  token exchange
 *
 * The flow is driven page by page: every HTML page is classified by its form fields, so the
 * same engine handles a fresh login, the TOTP step and a silent re-login from stored SSO cookies.
 * Secrets (password, OTP, code, tokens) are never logged.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { parse, type HTMLElement } from 'node-html-parser';
import { CookieJar } from 'tough-cookie';
import type { AppConfig } from '../config.js';
import { log } from '../config.js';

export interface TokenSet {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  id_token?: string;
  scope?: string;
  token_type?: string;
}

export type FlowResult =
  | { kind: 'done'; tokens: TokenSet }
  | { kind: 'need_credentials'; message?: string }
  | { kind: 'need_otp'; message?: string }
  | { kind: 'need_database'; options: string[]; message?: string };

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginError';
  }
}

interface FormInput {
  name: string;
  type: string;
  value: string;
}

interface Page {
  url: string;
  html: string;
  root: HTMLElement;
  title: string;
}

const UA = 'Mozilla/5.0 (compatible; wodis-mcp/0.1; +https://github.com/modelcontextprotocol)';
const KNOWN_FIELDS = new Set([
  'username', 'password', 'rememberMe', 'credentialId', 'otp', 'totp', 'login',
  'selectedValue', 'search_terms', 'tab_id', 'session_code', 'execution', 'client_id',
]);

const b64url = (b: Buffer) => b.toString('base64url');

export function decodeJwt(token: string): Record<string, unknown> {
  try {
    const p = token.split('.')[1] ?? '';
    return JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Keeps the state of one login attempt (in memory only). */
export class KeycloakFlow {
  readonly jar: CookieJar;
  readonly createdAt = Date.now();
  private readonly verifier = b64url(randomBytes(48));
  private readonly state = randomBytes(18).toString('hex');
  private readonly nonce = randomBytes(18).toString('hex');
  /**
   * The global realm's "Auto Persist Tab ID" page runs JS that reads sessionStorage.tab_id, finds nothing,
   * generates a fresh UUID, stores it and auto-posts it as `tab_id` (captured 2026-11-24). An empty value → HTTP 400
   * "Ungültiger Benutzername oder Passwort". One UUID per flow = one browser tab.
   */
  private readonly browserTabId = randomUUID();
  private username?: string;
  private password?: string;
  private pendingPage?: Page;
  private pendingForm?: HTMLElement;
  private pendingKind?: 'otp' | 'database';
  private databaseOptions: string[] = [];
  private submitted = { username: 0, password: 0, otp: 0, database: 0, hidden: 0 };

  constructor(
    private readonly cfg: AppConfig,
    jar?: CookieJar,
  ) {
    this.jar = jar ?? new CookieJar();
  }

  get realmUrl(): string {
    return `${this.cfg.authUrl}/realms/${this.cfg.realm}`;
  }

  get waitingFor(): 'otp' | 'database' | undefined {
    return this.pendingKind;
  }

  get options(): string[] {
    return this.databaseOptions;
  }

  /** Start the flow. Without credentials this is a silent attempt using the SSO cookies in the jar. */
  async start(creds?: { username?: string; password?: string }): Promise<FlowResult> {
    this.username = creds?.username;
    this.password = creds?.password;
    const challenge = b64url(createHash('sha256').update(this.verifier).digest());
    const q = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      state: this.state,
      response_mode: 'fragment',
      response_type: 'code',
      scope: 'openid',
      nonce: this.nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ui_locales: this.cfg.locale,
    });
    // Like the SPA: no login_hint – the username is posted on the global realm's first page (home realm discovery).
    if (this.cfg.idpHint) q.set('kc_idp_hint', this.cfg.idpHint);
    return this.drive(`${this.realmUrl}/protocol/openid-connect/auth?${q}`);
  }

  async submitOtp(code: string): Promise<FlowResult> {
    if (this.pendingKind !== 'otp' || !this.pendingPage || !this.pendingForm) {
      throw new LoginError('Es wartet kein Login auf einen TOTP-Code. Bitte zuerst den Login starten.');
    }
    const clean = code.replace(/\s+/g, '');
    if (!/^\d{6,8}$/.test(clean)) throw new LoginError('Der TOTP-Code muss aus 6–8 Ziffern bestehen.');
    const form = this.pendingForm;
    const fields = this.hiddenFields(form);
    const otpName = this.inputs(form).find((i) => i.name === 'otp' || i.name === 'totp')?.name ?? 'otp';
    fields.set(otpName, clean);
    this.addSubmit(form, fields);
    this.submitted.otp++;
    this.pendingKind = undefined;
    return this.submit(this.pendingPage, form, fields);
  }

  async selectDatabase(db: string): Promise<FlowResult> {
    if (this.pendingKind !== 'database' || !this.pendingPage) {
      throw new LoginError('Es wartet kein Login auf eine Datenbankauswahl.');
    }
    const choice = this.matchDatabase(db);
    if (!choice) throw new LoginError(`Unbekannte Datenbank "${db}". Möglich: ${this.databaseOptions.map(stripDb).join(', ')}`);
    this.pendingKind = undefined;
    return this.postDatabase(this.pendingPage, choice);
  }

  // ---- engine --------------------------------------------------------------

  private async drive(startUrl: string, init?: { method: string; body: URLSearchParams }): Promise<FlowResult> {
    let url = startUrl;
    let req = init;
    for (let hop = 0; hop < 30; hop++) {
      const res = await this.fetch(url, req);
      const location = res.headers.get('location');
      if (this.cfg.debug) {
        log('hop', req ? `POST[${[...req.body.keys()].join(',')}]` : 'GET', redactUrl(url), res.status, location ? `-> ${redactUrl(new URL(location, url).toString())}` : '');
      }
      req = undefined;
      if (res.status >= 300 && res.status < 400 && location) {
        const next = new URL(location, url).toString();
        if (next.startsWith(this.cfg.redirectUri)) return this.callback(next);
        url = next;
        continue;
      }
      const html = await res.text();
      if (res.status === 200 || res.status === 400 || res.status === 401) {
        if (!/<form|<html/i.test(html)) throw new LoginError(`Unerwartete Antwort HTTP ${res.status} von ${redactUrl(url)}`);
        const root = parse(html);
        const page: Page = { url, html, root, title: root.querySelector('title')?.text.trim() ?? '' };
        return this.handlePage(page);
      }
      throw new LoginError(`Unerwartete Antwort HTTP ${res.status} von ${redactUrl(url)}`);
    }
    throw new LoginError('Zu viele Weiterleitungen im Login.');
  }

  private async handlePage(page: Page): Promise<FlowResult> {
    const forms = page.root.querySelectorAll('form');
    const errorText = this.errorText(page.root);
    if (this.cfg.debug) {
      log('login page', redactUrl(page.url), JSON.stringify({
        title: page.title,
        error: errorText,
        forms: forms.map((f) => ({ action: redactUrl(f.getAttribute('action') ?? ''), inputs: this.inputs(f).map((i) => `${i.name}:${i.type}`) })),
        hasSelectedValue: page.html.includes('selectedValue'),
      }));
    }

    // 1) database selection after the broker login
    if (page.html.includes('selectedValue') || /yuneo_database:/i.test(page.html)) {
      this.databaseOptions = this.findDatabaseOptions(page);
      if (this.databaseOptions.length === 0 && this.cfg.database) {
        // captured selectedValue had the form "yuneo_database:<DB>" (e.g. yuneo_database:1234567_FIRMA_PRD)
        this.databaseOptions = [`yuneo_database:${stripDb(this.cfg.database)}`];
      }
      if (this.cfg.debug) {
        const ctx = (page.html.match(/.{0,80}selectedValue.{0,120}/gs) ?? []).slice(0, 4).map((s) => s.replace(/\s+/g, ' '));
        log('database selection page', JSON.stringify({ options: this.databaseOptions, htmlLength: page.html.length, selectedValueContext: ctx }));
      }
      const preferred =
        (this.cfg.database && this.matchDatabase(this.cfg.database)) ||
        (this.databaseOptions.length === 1 ? this.databaseOptions[0] : undefined);
      if (preferred && this.submitted.database < 2) return this.postDatabase(page, preferred);
      this.pendingPage = page;
      this.pendingForm = forms[0];
      this.pendingKind = 'database';
      return { kind: 'need_database', options: this.databaseOptions.map(stripDb), message: errorText };
    }

    const form = this.pickForm(forms);
    if (!form) {
      throw new LoginError(
        `Keycloak-Fehlerseite "${page.title}"${errorText ? `: ${errorText}` : ''} (bei ${redactUrl(page.url)}). ` +
          'Falls die Zugangsdaten stimmen, liegt es am Login-Ablauf – mit WODIS_DEBUG=1 steht der Verlauf in ~/.wodis-mcp/debug.log.',
      );
    }
    const inputs = this.inputs(form);
    const has = (n: string) => inputs.some((i) => i.name === n);

    // 2) TOTP
    if (has('otp') || has('totp')) {
      this.pendingPage = page;
      this.pendingForm = form;
      this.pendingKind = 'otp';
      const msg = this.submitted.otp > 0 ? errorText ?? 'Der Code wurde nicht akzeptiert. Bitte neuen Code eingeben.' : undefined;
      return { kind: 'need_otp', message: msg };
    }

    // 3) username + password
    if (has('password')) {
      if (this.submitted.password > 0) throw new LoginError(errorText ?? 'Benutzername oder Passwort wurden nicht akzeptiert.');
      if (!this.password || !(this.username || this.prefilled(form, 'username'))) {
        return { kind: 'need_credentials', message: errorText };
      }
      // browser sends: username, password, rememberMe=on, credentialId (hidden) – no "login" (button is disabled on submit)
      const fields = this.hiddenFields(form);
      if (has('username')) fields.set('username', this.username ?? this.prefilled(form, 'username') ?? '');
      fields.set('password', this.password);
      if (has('rememberMe')) fields.set('rememberMe', 'on');
      this.submitted.password++;
      return this.submit(page, form, fields);
    }

    // 4) username only (home realm discovery)
    if (has('username')) {
      if (this.submitted.username > 1) throw new LoginError(errorText ?? 'Der Benutzername wurde nicht akzeptiert.');
      if (!this.username) return { kind: 'need_credentials', message: errorText };
      // browser sends: username, rememberMe=on
      const fields = this.hiddenFields(form);
      fields.set('username', this.username);
      if (has('rememberMe')) fields.set('rememberMe', 'on');
      this.submitted.username++;
      return this.submit(page, form, fields);
    }

    // 5) auto-submit / hidden-only forms (e.g. post-broker-login with tab_id)
    const visible = inputs.filter((i) => !['hidden', 'submit', 'button'].includes(i.type));
    if (visible.length === 0) {
      if (this.submitted.hidden++ > 5) throw new LoginError(`Login hängt auf Seite "${page.title}" fest.`);
      const fields = this.hiddenFields(form);
      if (inputs.some((i) => i.name === 'tab_id')) fields.set('tab_id', this.browserTabId); // "Auto Persist Tab ID"
      return this.submit(page, form, fields);
    }

    const unknown = visible.map((i) => i.name).filter((n) => !KNOWN_FIELDS.has(n));
    throw new LoginError(
      `Keycloak verlangt einen unbekannten Login-Schritt ("${page.title}", Felder: ${unknown.join(', ') || visible.map((i) => i.name).join(', ')}). ` +
        'Bitte einmal im Browser unter wodis-yuneo.de anmelden und den Schritt dort abschließen.',
    );
  }

  private async postDatabase(page: Page, value: string): Promise<FlowResult> {
    // captured: <form id="kc-scope-selector-form"> with a JS-filled <select name="selectedValue"> (choices.js);
    // browser posts selectedValue=yuneo_database:<DB> and search_terms= (empty)
    const form = page.root.querySelector('#kc-scope-selector-form') ?? page.root.querySelector('form');
    const fields = form ? this.hiddenFields(form) : new URLSearchParams();
    fields.set('selectedValue', value);
    if (!fields.has('search_terms')) fields.set('search_terms', '');
    this.submitted.database++;
    const action = form?.getAttribute('action');
    const target = action ? new URL(decodeEntities(action), page.url).toString() : page.url;
    return this.drive(target, { method: 'POST', body: fields });
  }

  private async submit(page: Page, form: HTMLElement, fields: URLSearchParams): Promise<FlowResult> {
    const action = decodeEntities(form.getAttribute('action') ?? page.url);
    const method = (form.getAttribute('method') ?? 'POST').toUpperCase();
    const target = new URL(action, page.url).toString();
    if (method === 'GET') {
      const u = new URL(target);
      fields.forEach((v, k) => u.searchParams.set(k, v));
      return this.drive(u.toString());
    }
    return this.drive(target, { method: 'POST', body: fields });
  }

  private async callback(url: string): Promise<FlowResult> {
    const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : new URL(url).search.slice(1);
    const p = new URLSearchParams(hash);
    const error = p.get('error');
    if (error) {
      if (error === 'login_required' || error === 'interaction_required') return { kind: 'need_credentials' };
      throw new LoginError(`Keycloak meldet ${error}: ${p.get('error_description') ?? ''}`);
    }
    if (p.get('state') !== this.state) throw new LoginError('Login-Antwort passt nicht zum gestarteten Login (state).');
    const code = p.get('code');
    if (!code) throw new LoginError('Login-Antwort ohne Code.');
    const tokens = await tokenRequest(this.cfg, {
      grant_type: 'authorization_code',
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      code,
      code_verifier: this.verifier,
    });
    this.pendingKind = undefined;
    this.password = undefined;
    return { kind: 'done', tokens };
  }

  // ---- helpers ---------------------------------------------------------------

  private async fetch(url: string, init?: { method: string; body: URLSearchParams }): Promise<Response> {
    const cookie = await this.jar.getCookieString(url);
    const headers: Record<string, string> = {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': `${this.cfg.locale},en;q=0.5`,
    };
    if (cookie) headers.cookie = cookie;
    if (init) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(url, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    for (const sc of res.headers.getSetCookie()) {
      await this.jar.setCookie(sc, url, { ignoreError: true });
    }
    return res;
  }

  private pickForm(forms: HTMLElement[]): HTMLElement | undefined {
    return (
      forms.find((f) => f.getAttribute('id') === 'kc-form-login') ??
      forms.find((f) => this.inputs(f).some((i) => ['username', 'password', 'otp', 'totp'].includes(i.name))) ??
      forms[0]
    );
  }

  private inputs(form: HTMLElement): FormInput[] {
    return form
      .querySelectorAll('input, select, textarea, button')
      .filter((el) => el.getAttribute('name'))
      .map((el) => ({
        name: el.getAttribute('name') as string,
        type: (el.tagName === 'INPUT' ? el.getAttribute('type') ?? 'text' : el.tagName === 'BUTTON' ? el.getAttribute('type') ?? 'submit' : el.tagName.toLowerCase()).toLowerCase(),
        value: decodeEntities(el.getAttribute('value') ?? ''),
      }));
  }

  private hiddenFields(form: HTMLElement): URLSearchParams {
    const p = new URLSearchParams();
    for (const i of this.inputs(form)) if (i.type === 'hidden') p.set(i.name, i.value);
    return p;
  }

  private addSubmit(form: HTMLElement, fields: URLSearchParams): void {
    const btn = this.inputs(form).find((i) => i.type === 'submit' && i.name);
    if (btn && !fields.has(btn.name)) fields.set(btn.name, btn.value);
  }

  private prefilled(form: HTMLElement, name: string): string | undefined {
    const v = this.inputs(form).find((i) => i.name === name)?.value;
    return v ? v : undefined;
  }

  private errorText(root: HTMLElement): string | undefined {
    const sel = [
      '#input-error', '#input-error-username', '#input-error-password', '#input-error-otp-code',
      '#kc-error-message', '.kc-feedback-text', '.alert-error', '.pf-c-alert__title', '.pf-v5-c-alert__title',
      '.kcFeedbackErrorIcon',
    ];
    for (const s of sel) {
      const t = root.querySelector(s)?.text.replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, 200);
    }
    return undefined;
  }

  private findDatabaseOptions(page: Page): string[] {
    const found = new Set<string>(page.html.match(/yuneo_database:[A-Za-z0-9_.-]+/g) ?? []);
    if (found.size === 0) {
      for (const el of page.root.querySelectorAll('[data-value], option[value], input[type=radio][value], button[value]')) {
        const v = el.getAttribute('data-value') ?? el.getAttribute('value');
        if (v && v.length > 2) found.add(decodeEntities(v));
      }
    }
    return [...found];
  }

  private matchDatabase(db: string): string | undefined {
    const want = db.trim().toLowerCase();
    return this.databaseOptions.find((o) => {
      const l = o.toLowerCase();
      return l === want || stripDb(l) === want || l.endsWith(`:${want}`);
    });
  }
}

/** Token endpoint call (authorization_code / refresh_token). */
export async function tokenRequest(cfg: AppConfig, form: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(`${cfg.authUrl}/realms/${cfg.realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      origin: cfg.baseUrl,
      'user-agent': UA,
    },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let err = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { error?: string; error_description?: string };
      err = `${j.error ?? res.status}${j.error_description ? `: ${j.error_description}` : ''}`;
    } catch {
      /* keep raw */
    }
    throw new TokenError(res.status, err);
  }
  return JSON.parse(text) as TokenSet;
}

export class TokenError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TokenError';
  }
  get invalidGrant(): boolean {
    return this.message.startsWith('invalid_grant') || this.status === 400;
  }
}

export async function keycloakLogout(cfg: AppConfig, refreshToken: string): Promise<void> {
  await fetch(`${cfg.authUrl}/realms/${cfg.realm}/protocol/openid-connect/logout`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: cfg.baseUrl, 'user-agent': UA },
    body: new URLSearchParams({ client_id: cfg.clientId, refresh_token: refreshToken }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
}

export const stripDb = (v: string): string => v.replace(/^yuneo_database:/i, '');

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url, 'https://x.invalid');
    return `${u.host}${u.pathname}`;
  } catch {
    return '<url>';
  }
}
