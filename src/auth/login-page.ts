/**
 * Small local login page so the password never passes through a chat or an LLM.
 * Reachable only under a random secret path; binds to 127.0.0.1 unless configured otherwise.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { log } from '../config.js';
import type { LoginStep, TokenManager } from './token-manager.js';

const IDLE_CLOSE_MS = 15 * 60_000;

export class LoginPage {
  private server?: Server;
  private url?: string;
  private readonly secret = randomBytes(18).toString('base64url');
  private closeTimer?: NodeJS.Timeout;
  private lastMessage?: { text: string; error: boolean };

  constructor(private readonly tm: TokenManager) {}

  /** Starts the page if needed and returns its URL. Opens the browser when configured. */
  async open(): Promise<string> {
    if (!this.server) await this.listen();
    this.touch();
    const url = this.url!;
    if (this.tm.cfg.openBrowser) openInBrowser(url);
    return url;
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
    this.url = undefined;
    if (this.closeTimer) clearTimeout(this.closeTimer);
  }

  private touch(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
    this.closeTimer.unref();
  }

  private async listen(): Promise<void> {
    const cfg = this.tm.cfg;
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        log('login page error:', (e as Error).message);
        if (!res.headersSent) send(res, 500, page('Fehler', `<p class="err">${esc((e as Error).message)}</p>`));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.loginPort, cfg.loginHost, () => resolve());
    });
    server.unref();
    const { port } = server.address() as AddressInfo;
    const base = cfg.loginPublicUrl ?? `http://${cfg.loginHost === '0.0.0.0' ? '127.0.0.1' : cfg.loginHost}:${port}`;
    this.server = server;
    this.url = `${base}/${this.secret}/`;
    log(`login page listening on ${cfg.loginHost}:${port}`);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const prefix = `/${this.secret}/`;
    if (!path.startsWith(prefix)) return send(res, 404, 'Not found');
    this.touch();
    const action = path.slice(prefix.length);

    if (req.method === 'POST') {
      const form = await readForm(req);
      let step: LoginStep | undefined;
      try {
        if (action === 'login') step = await this.tm.login(form.get('username') ?? '', form.get('password') ?? '');
        else if (action === 'otp') step = await this.tm.submitOtp(form.get('otp') ?? '');
        else if (action === 'database') step = await this.tm.selectDatabase(form.get('database') ?? '');
        else if (action === 'logout') await this.tm.logout();
        this.lastMessage = step && step.status !== 'ok' ? { text: step.message, error: /nicht|ungültig|invalid/i.test(step.message) } : undefined;
      } catch (e) {
        this.lastMessage = { text: (e as Error).message, error: true };
      }
      res.writeHead(303, { location: prefix });
      res.end();
      return;
    }
    if (req.method !== 'GET' || action !== '') return send(res, 404, 'Not found');

    const st = await this.tm.currentStatus();
    const msg = this.lastMessage;
    this.lastMessage = undefined;
    const note = msg ? `<p class="${msg.error ? 'err' : 'info'}">${esc(msg.text)}</p>` : '';

    if (st.pendingLogin === 'otp') {
      return send(res, 200, page('Bestätigungscode', `${note}
        <form method="post" action="otp">
          <label>Code aus der Authenticator-App
            <input name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,9}" required autofocus></label>
          <button>Weiter</button>
        </form>`));
    }
    if (st.pendingLogin === 'database') {
      const opts = (st.pendingDatabaseOptions ?? [])
        .map((o, i) => `<label class="radio"><input type="radio" name="database" value="${esc(o)}" ${i === 0 ? 'checked' : ''}> ${esc(o)}</label>`)
        .join('');
      return send(res, 200, page('Datenbank wählen', `${note}
        <form method="post" action="database">${opts || '<input name="database" required placeholder="z. B. 1234567_FIRMA_PRD">'}
          <button>Weiter</button>
        </form>`));
    }
    if (st.loggedIn) {
      return send(res, 200, page('Angemeldet', `${note}
        <p class="ok">Angemeldet als <b>${esc(st.username ?? '?')}</b>, Datenbank <b>${esc(st.database ?? '?')}</b>.</p>
        <p>Die Sitzung wird automatisch verlängert. Dieses Fenster kann geschlossen werden.</p>
        <dl><dt>Token gültig bis</dt><dd>${esc(st.accessTokenValidUntil ?? '-')}</dd>
        <dt>Refresh bis</dt><dd>${esc(st.refreshTokenValidUntil ?? '-')}</dd>
        <dt>SSO-Sitzung bis</dt><dd>${esc(st.ssoSessionValidUntil ?? 'unbekannt')}</dd></dl>
        <form method="post" action="logout"><button class="secondary">Abmelden</button></form>`));
    }
    return send(res, 200, page('Wodis Yuneo Anmeldung', `${note}
      <form method="post" action="login">
        <label>Benutzername / E-Mail
          <input name="username" autocomplete="username" value="${esc(this.tm.cfg.username ?? '')}" required autofocus></label>
        <label>Passwort
          <input name="password" type="password" autocomplete="current-password" required></label>
        <button>Anmelden</button>
      </form>
      <p class="hint">Die Daten gehen direkt an den Aareon-Login (auth.asw.aareon.com). Das Passwort wird nicht gespeichert.</p>`));
  }
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': status === 200 || status === 500 ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  });
  res.end(body);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw new Error('Anfrage zu groß');
  }
  return new URLSearchParams(body);
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · wodis-mcp</title><style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--mut:#5b6475;--acc:#0b6bcb;--err:#b42318;--ok:#067647;--bd:#d8dde6}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1b2029;--fg:#e8ecf3;--mut:#9aa4b5;--acc:#4ea1ff;--err:#ff8a80;--ok:#6ee7a8;--bd:#2c3442}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:28px;width:100%;max-width:400px;box-sizing:border-box}
h1{font-size:20px;margin:0 0 16px}label{display:block;margin:0 0 14px;font-size:14px;color:var(--mut)}
input:not([type=radio]){display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:10px 12px;border:1px solid var(--bd);border-radius:8px;background:transparent;color:var(--fg);font-size:16px}
label.radio{color:var(--fg);font-size:16px}button{width:100%;padding:11px;border:0;border-radius:8px;background:var(--acc);color:#fff;font-size:16px;cursor:pointer}
button.secondary{background:transparent;color:var(--mut);border:1px solid var(--bd);margin-top:8px}
.err{color:var(--err)}.ok{color:var(--ok)}.info{color:var(--mut)}.hint{color:var(--mut);font-size:13px;margin-top:16px}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:14px}dt{color:var(--mut)}dd{margin:0}
</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => undefined);
    p.unref();
  } catch {
    /* headless environment: the URL is returned to the caller anyway */
  }
}
