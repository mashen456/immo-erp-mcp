/**
 * Version info and git-based self-update (git pull --ff-only → npm ci → npm run build).
 * The session in WODIS_MCP_HOME is untouched by an update, so no new login is needed afterwards.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Repository root (dist/ and src/ both sit directly below it). */
export const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export function version(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

function run(cmd: string, args: string[], timeoutMs = 120_000): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: process.platform === 'win32', // npm is npm.cmd on Windows
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // never hang on a credential prompt
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

export function commit(): string | undefined {
  const r = run('git', ['rev-parse', '--short', 'HEAD'], 10_000);
  return r.ok ? r.out : undefined;
}

export interface UpdateCheck {
  version: string;
  commit?: string;
  branch?: string;
  updateAvailable?: boolean;
  newCommits?: string[];
  error?: string;
}

/** Fetches the remote (read-only) and lists commits that a self-update would pull. */
export function checkForUpdates(): UpdateCheck {
  const base: UpdateCheck = { version: version(), commit: commit() };
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], 10_000);
  if (!branch.ok) return { ...base, error: 'Kein Git-Checkout – Updates nur bei Installation per git clone.' };
  base.branch = branch.out;
  const fetch = run('git', ['fetch', '--quiet'], 60_000);
  if (!fetch.ok) return { ...base, error: `git fetch fehlgeschlagen: ${fetch.out.slice(0, 300)}` };
  const log = run('git', ['log', '--oneline', 'HEAD..@{u}'], 10_000);
  if (!log.ok) return { ...base, error: `Kein Upstream-Branch: ${log.out.slice(0, 200)}` };
  const newCommits = log.out ? log.out.split('\n') : [];
  return { ...base, updateAvailable: newCommits.length > 0, newCommits };
}

export interface UpdateResult {
  ok: boolean;
  from: string;
  to: string;
  steps: { step: string; ok: boolean; output: string }[];
  restartRequired: boolean;
}

/** git pull --ff-only → npm ci → npm run build. Refuses to run on local changes. */
export function selfUpdate(): UpdateResult {
  const from = `${version()} (${commit() ?? '?'})`;
  const steps: UpdateResult['steps'] = [];
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=no'], 10_000);
  if (!dirty.ok || dirty.out) {
    steps.push({ step: 'git status', ok: false, output: dirty.ok ? `Lokale Änderungen, Update abgebrochen:\n${dirty.out}` : dirty.out });
    return { ok: false, from, to: from, steps, restartRequired: false };
  }
  for (const [step, cmd, args, t] of [
    ['git pull --ff-only', 'git', ['pull', '--ff-only'], 120_000],
    ['npm ci', 'npm', ['ci', '--no-audit', '--no-fund'], 300_000],
    ['npm run build', 'npm', ['run', 'build'], 180_000],
  ] as const) {
    const r = run(cmd, [...args], t);
    steps.push({ step, ok: r.ok, output: r.out.split('\n').slice(-15).join('\n') });
    if (!r.ok) return { ok: false, from, to: `${version()} (${commit() ?? '?'})`, steps, restartRequired: false };
  }
  const to = `${version()} (${commit() ?? '?'})`;
  return { ok: true, from, to, steps, restartRequired: from !== to };
}
