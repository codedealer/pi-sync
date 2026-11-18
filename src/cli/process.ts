import { spawn } from 'node:child_process';
import { shellFor } from '../packages.js';

// The single owner of the CLI's process-execution and read-only Git
// inspection primitives. Command workflows (bootstrap, push, resources,
// update) and the reconciliation publish-state check all run external
// executables through these two functions, so the spawn/shell semantics
// (including Windows PATH resolution via shellFor) live in one module.
export interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: NodeJS.ErrnoException | null;
}

export function runCommand(executable: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: shellFor(executable) });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error: NodeJS.ErrnoException) => resolve({ status: null, stdout, stderr, error }));
    child.on('close', (status) => resolve({ status, stdout, stderr, error: null }));
  });
}

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
  errorText: string;
}

export async function gitResult(repo: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<GitResult> {
  const result = await runCommand('git', ['-C', repo, ...args], { ...process.env, ...extraEnv });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout.trim(), errorText: result.stderr.trim() };
}