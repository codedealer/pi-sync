import { spawn } from 'node:child_process';
import { shellFor } from '../packages.js';

// The single owner of the CLI's process-execution and read-only Git
// inspection primitives. Command workflows (bootstrap, push, resources,
// update) and the reconciliation publish-state check all run external
// executables through these two functions, so the spawn/shell semantics
// (Windows PATH resolution via shellFor and the Windows-only git executable
// resolution via gitExecutable) live in one module.
export interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: NodeJS.ErrnoException | null;
}

// A process killed by its timeout resolves with status null and this
// error marker, so callers distinguish "timed out" from a plain spawn error.
function timeoutError(timeoutMs: number): NodeJS.ErrnoException {
  return Object.assign(new Error(`command timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' });
}

export function runCommand(executable: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeoutMs?: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: shellFor(executable) });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // Optional hard bound: the child is killed at the deadline, and the
    // result carries the ETIMEDOUT marker instead of a process status.
    const timer = timeoutMs !== undefined ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : undefined;
    const finish = (result: ProcessResult) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error: NodeJS.ErrnoException) => finish({ status: null, stdout, stderr, error: timedOut ? timeoutError(timeoutMs!) : error }));
    child.on('close', (status) => {
      // Deterministic deadline semantics: the timeout wins only when the
      // kill actually took the child, which is observable as close with
      // status null. A child that completed on its own in the same instant
      // as the deadline reports its own status, never ETIMEDOUT.
      const killedByTimeout = timedOut && status === null;
      finish({ status, stdout, stderr, error: killedByTimeout ? timeoutError(timeoutMs!) : null });
    });
  });
}

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
  errorText: string;
}

// Windows-only: resolve `git` to a path-qualified executable so git invocations
// can be spawned without a shell. A bare name with `shell: true` makes Node
// concatenate the arguments unescaped, letting cmd.exe interpret metacharacters
// in user-supplied arguments (commit subjects, remote URLs, paths). `where` is
// a System32 binary Node can launch directly; the result is cached for the
// process lifetime. Only a path-qualified .exe is trusted (a .cmd/.bat shim
// cannot be launched shell-free, so the legacy shell behavior is kept in that
// case).
let resolvedGit: string | undefined;
export async function gitExecutable(): Promise<string> {
  if (resolvedGit !== undefined) return resolvedGit;
  if (process.platform !== 'win32') { resolvedGit = 'git'; return resolvedGit; }
  // `where` is a System32 binary Node can launch directly; it is spawned
  // shell-free (not through shellFor) so the lookup itself never depends on
  // a shell.
  const where = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
    const child = spawn('where', ['git'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.on('error', () => resolve({ status: null, stdout: '' }));
    child.on('close', (status) => resolve({ status, stdout }));
  });
  const candidate = where.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
  resolvedGit = candidate !== undefined && /[\\/]/.test(candidate) && candidate.toLowerCase().endsWith('.exe') ? candidate : 'git';
  return resolvedGit;
}

export async function gitResult(repo: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, timeoutMs?: number): Promise<GitResult> {
  const result = await runCommand(await gitExecutable(), ['-C', repo, ...args], { ...process.env, ...extraEnv }, timeoutMs);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout.trim(), errorText: result.stderr.trim() };
}