#!/usr/bin/env node
/**
 * wodis-mcp – read-only MCP server for immo-erp.
 *
 *   wodis-mcp              start the MCP server (stdio)
 *   wodis-mcp login        interactive terminal login (username, password, TOTP)
 *   wodis-mcp login-page   serve the browser login page from the terminal, exit when logged in
 *   wodis-mcp status       show session status
 *   wodis-mcp keepalive    refresh once (for cron/launchd/systemd timers) – exit 1 if a login is needed
 *   wodis-mcp logout       end the session and delete stored tokens
 *   wodis-mcp version      print version and git commit (--check: also list available updates)
 *   wodis-mcp update       git pull --ff-only → npm ci → npm run build (then restart the MCP server)
 */
import { createInterface } from 'node:readline';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LoginPage } from './auth/login-page.js';
import { SessionStore } from './auth/session-store.js';
import { TokenManager, type LoginStep } from './auth/token-manager.js';
import { loadConfig, log } from './config.js';
import { registerTools } from './tools.js';
import { checkForUpdates, commit, selfUpdate, version } from './update.js';

const VERSION = version();

const INSTRUCTIONS = `Read-only access to Aareon Wodis Yuneo (property management): Objekte (houses by street), Wirtschaftseinheiten, Einheiten (units), Mietverträge and Kontakte (tenants).
Start with wodis_auth_status. If not logged in: call wodis_login (uses configured credentials if no parameters), then ask the user for the current 6-digit code from their authenticator app and call wodis_login_otp. If the user prefers not to share the password in chat, use wodis_login_page instead.
Typical path: wodis_search_objekte(strasse) -> wodis_get_objekt(id) -> wodis_get_einheit(id) -> wodis_get_mietvertrag(aktuellerMietvertrag.id) -> wodis_get_kontakt(hauptmieter.id).
Rent account (Mietkonto, Kontobewegungen, Rückstand/Guthaben): wodis_get_mietkonto(mietvertragId). Saldo = Soll − Haben: positive = arrears, negative = tenant credit.
Results contain personal data of tenants; only show what the user asked for.
Updates: wodis_server_info(checkForUpdates=true) lists new commits. Update with "npm run self-update" in the install directory (or wodis_self_update if enabled), then restart/reconnect this MCP server. The login session survives updates.`;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const tm = new TokenManager(cfg, new SessionStore(cfg.home, cfg.sessionKey));
  await tm.init();
  const cmd = process.argv[2] ?? 'serve';

  switch (cmd) {
    case 'serve':
      return serve(tm);
    case 'login':
      return cliLogin(tm);
    case 'login-page':
      return cliLoginPage(tm);
    case 'status':
      console.log(JSON.stringify(await tm.currentStatus(), null, 2));
      return;
    case 'keepalive': {
      const r = await tm.keepalive();
      console.log(JSON.stringify({ result: r, ...tm.status() }, null, 2));
      process.exitCode = r === 'not_logged_in' ? 1 : 0;
      return;
    }
    case 'logout':
      await tm.logout();
      console.log('Abgemeldet, Sitzung gelöscht.');
      return;
    case 'version':
    case '--version':
    case '-v':
      console.log(
        process.argv.includes('--check') ? JSON.stringify(checkForUpdates(), null, 2) : `${VERSION} (${commit() ?? 'no git checkout'})`,
      );
      return;
    case 'update': {
      const r = selfUpdate();
      for (const s of r.steps) console.error(`${s.ok ? '✔' : '✘'} ${s.step}${s.ok ? '' : `\n${s.output}`}`);
      console.log(
        r.ok
          ? `Update ${r.from} → ${r.to}.${r.restartRequired ? ' Bitte den MCP-Server neu starten/verbinden; die Sitzung bleibt erhalten.' : ' Bereits aktuell.'}`
          : 'Update fehlgeschlagen.',
      );
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    default:
      console.error('Usage: wodis-mcp [serve|login|login-page|status|keepalive|logout|version [--check]|update]');
      process.exitCode = 2;
  }
}

async function serve(tm: TokenManager): Promise<void> {
  const server = new McpServer({ name: 'wodis-mcp', version: VERSION }, { instructions: INSTRUCTIONS });
  const loginPage = new LoginPage(tm);
  registerTools(server, tm, loginPage);
  tm.startKeepalive();
  // refresh right away so a session that was idle (e.g. overnight) is renewed before the first call
  tm.keepalive()
    .then((r) => log('startup session check:', r))
    .catch((e) => log('startup session check failed:', (e as Error).message));
  await server.connect(new StdioServerTransport());
  log(`server ready (session file ${tm.status().sessionFile})`);
  const shutdown = () => {
    tm.stopKeepalive();
    loginPage.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ---- terminal login ------------------------------------------------------------

async function cliLogin(tm: TokenManager): Promise<void> {
  const username = tm.cfg.username ?? (await ask('Wodis-Benutzername / E-Mail: '));
  const password = tm.cfg.password ?? (await askHidden('Passwort: '));
  let step: LoginStep = await tm.login(username, password);
  for (let i = 0; i < 6 && step.status !== 'ok'; i++) {
    if (step.status === 'otp_required') {
      if (i > 0) console.error(step.message);
      step = await tm.submitOtp(await ask('Code aus der Authenticator-App: '));
    } else {
      console.error(`${step.message}\n  ${step.options.join('\n  ')}`);
      step = await tm.selectDatabase(await ask('Datenbank: '));
    }
  }
  if (step.status !== 'ok') throw new Error('Login nicht abgeschlossen.');
  console.error(step.message);
  console.log(JSON.stringify(step.auth, null, 2));
}

/** Serve the browser login page from the terminal; exits once the session is stored (max 15 min). */
async function cliLoginPage(tm: TokenManager): Promise<void> {
  const lp = new LoginPage(tm);
  const url = await lp.open();
  console.log(`Login-Seite: ${url}`);
  const deadline = Date.now() + 15 * 60_000;
  const startedLoggedIn = tm.status().loggedInAt;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = tm.status();
    if (st.loggedIn && st.loggedInAt !== startedLoggedIn) {
      console.log(`Angemeldet als ${st.username} (Datenbank ${st.database}). Sitzung gespeichert in ${st.sessionFile}.`);
      await new Promise((r) => setTimeout(r, 3000)); // let the browser load the success page
      lp.close();
      return;
    }
  }
  lp.close();
  throw new Error('Kein Login innerhalb von 15 Minuten.');
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    }),
  );
}

function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question);
  process.stderr.write(question);
  return new Promise((resolve, reject) => {
    let buf = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    const onData = (chunk: Buffer) => {
      for (const c of chunk.toString('utf8')) {
        if (c === '\r' || c === '\n') {
          cleanup();
          return resolve(buf);
        }
        if (c === '\u0003') {
          cleanup();
          return reject(new Error('Abgebrochen'));
        }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

main().catch((e) => {
  console.error(`[wodis-mcp] ${(e as Error).message}`);
  process.exit(1);
});
