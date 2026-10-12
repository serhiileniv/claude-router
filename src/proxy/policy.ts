import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StepResult } from './platform.js';

/**
 * Install/inspect the orchestration plugin — the role agents and session
 * policy under `plugin/` — through the `claude` CLI's own plugin commands.
 *
 * Installed from the GitHub marketplace rather than from the npm package's
 * copy of `plugin/`: what `claude plugin marketplace add <dir>` does with a
 * directory inside a global `node_modules` (and on `npm update -g`) is not
 * documented, while the GitHub form is, and it updates with
 * `claude plugin marketplace update`. The package still ships `plugin/` so
 * `claude --plugin-dir` works for development and the sandbox.
 */
export const PLUGIN_NAME = 'claude-router';
export const MARKETPLACE_NAME = 'claude-router';
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
export const MARKETPLACE_SOURCE = 'serhiileniv/claude-router';

export interface ExecResult {
  ok: boolean;
  output: string;
}
/** Runs `claude <args>`; injectable so the install flow is testable without the CLI. */
export type Exec = (args: string[]) => ExecResult;

/**
 * One cmd.exe command line for a `.cmd` shim. Node refuses to spawn `.cmd`
 * without a shell, but `shell: true` plus an args array concatenates the args
 * unescaped (DEP0190). So the shell gets a single string whose args are
 * double-quoted here; cmd metacharacters and quotes inside an arg are rejected.
 */
export function winCmdLine(bin: string, args: string[]): string {
  const q = (a: string) => {
    if (/["%^&|<>\r\n]/.test(a)) throw new Error(`unsafe argument for cmd.exe: ${a}`);
    return /^[\w./:@=+-]+$/.test(a) ? a : `"${a}"`;
  };
  return [bin, ...args.map(q)].join(' ');
}

export function defaultExec(args: string[]): ExecResult {
  const win = process.platform === 'win32';
  try {
    const opts = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'], timeout: 60_000 };
    const output = win ? execSync(winCmdLine('claude.cmd', args), opts) : execFileSync('claude', args, opts);
    return { ok: true, output: output.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim() };
  }
}

export function claudeAvailable(exec: Exec = defaultExec): boolean {
  return exec(['--version']).ok;
}

const MANUAL = `claude plugin marketplace add --scope user ${MARKETPLACE_SOURCE} && claude plugin install --scope user ${PLUGIN_ID}`;

export function installPolicyPlugin(exec: Exec = defaultExec): StepResult {
  if (!claudeAvailable(exec)) {
    return { ok: false, skipped: true, detail: `Orchestration plugin skipped: \`claude\` is not on PATH. Later: ${MANUAL}` };
  }
  const add = exec(['plugin', 'marketplace', 'add', '--scope', 'user', MARKETPLACE_SOURCE]);
  // Re-adding a known marketplace is not a failure; only an unknown error is.
  if (!add.ok && !/already/i.test(add.output)) {
    return { ok: false, detail: `Could not add the ${MARKETPLACE_NAME} marketplace: ${firstLine(add.output)}` };
  }
  const install = exec(['plugin', 'install', '--scope', 'user', PLUGIN_ID]);
  if (!install.ok && !/already/i.test(install.output)) {
    return { ok: false, detail: `Could not install ${PLUGIN_ID}: ${firstLine(install.output)}` };
  }
  return { ok: true, detail: `Orchestration plugin installed (${PLUGIN_ID}) — restart Claude Code to load it` };
}

export function uninstallPolicyPlugin(exec: Exec = defaultExec): StepResult {
  if (!claudeAvailable(exec)) {
    return { ok: false, skipped: true, detail: `Orchestration plugin left in place: \`claude\` is not on PATH` };
  }
  const result = exec(['plugin', 'uninstall', '--scope', 'user', PLUGIN_ID]);
  if (!result.ok && !/not installed|not found/i.test(result.output)) {
    return { ok: false, detail: `Could not uninstall ${PLUGIN_ID}: ${firstLine(result.output)}` };
  }
  return { ok: true, detail: `Orchestration plugin removed (${PLUGIN_ID})` };
}

export interface PolicyPluginStatus {
  installed: boolean;
  version: string | null;
  installPath: string | null;
}

/** Read Claude Code's plugin registry directly — no CLI needed for `status`/`doctor`. */
export function policyPluginStatus(
  pluginsDir: string = path.join(process.env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude'), 'plugins'),
): PolicyPluginStatus {
  try {
    const raw = fs.readFileSync(path.join(pluginsDir, 'installed_plugins.json'), 'utf8');
    const registry = JSON.parse(raw) as { plugins?: Record<string, Array<{ version?: string; installPath?: string }>> };
    const entries = registry.plugins?.[PLUGIN_ID];
    const entry = Array.isArray(entries) ? entries[0] : undefined;
    if (!entry) return { installed: false, version: null, installPath: null };
    return { installed: true, version: entry.version ?? null, installPath: entry.installPath ?? null };
  } catch {
    return { installed: false, version: null, installPath: null };
  }
}

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim()) ?? '(no output)';
}
