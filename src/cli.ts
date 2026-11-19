#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommandRequest } from './cli/arguments.js';
import { readJson, validateRepository } from './cli/manifest.js';
import { loadState } from './cli/local-state.js';
import { inspectRepository } from './cli/commands/inspect.js';
import { runAdd, runRemove, runRegister } from './cli/commands/resources.js';
import { runApply } from './cli/commands/apply.js';
import { runPrune } from './cli/commands/prune.js';
import { runSync } from './cli/commands/sync.js';
import { runBootstrap } from './cli/commands/bootstrap.js';
import { runUpdate } from './cli/commands/update.js';
import { runPiUpdate } from './cli/commands/pi-update.js';
import { runPush } from './cli/commands/push.js';
import { runPull } from './cli/commands/pull.js';

const VALIDATION_ERROR = 2;
const OPERATION_ERROR = 1;

function fail(error: any, code: any = VALIDATION_ERROR) {
  const command = process.argv[2] ?? null;
  const message = error instanceof Error ? error.message : String(error);
  const errorCode = error?.errorCode ?? (code === OPERATION_ERROR ? 'OPERATION_FAILED' : 'VALIDATION_ERROR');
  console.log(JSON.stringify({ apiVersion: 1, command, ok: false, error: message, errorCode,
    details: error?.details ?? { message }, exitCode: code }, null, 2));
  process.exitCode = code;
}

async function main() {
  const request = parseCommandRequest(process.argv.slice(2));
  const command = request.command;

  if (command === 'version') {
    const packageJson: any = await readJson(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'package metadata');
    console.log(JSON.stringify({ apiVersion: 1, command: 'version', ok: true, exitCode: 0, name: packageJson.name, version: packageJson.version }, null, 2));
    return;
  }
  if (command === 'bootstrap') {
    const output = await runBootstrap({ repoUrl: request.repoUrl, repoDir: request.repoDir, agentDir: request.agentDir, binDir: request.binDir, approve: request.approve });
    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) process.exitCode = output.exitCode;
    return;
  }
  // Repository commands resolve the setup repository exactly like the pi-sync
  // extension: an explicit --repo flag first, then PI_SYNC_REPO_DIR used
  // verbatim (no ~ expansion), then the built-in default under the user home.
  // The former current-working-directory fallback is removed on purpose: a
  // repository command run from an unrelated directory operates on the
  // environment or default repository.
  const repo = path.resolve(request.repo);
  const agentDir = path.resolve(request.agentDir);
  if (command === 'pi-update') {
    const output = await runPiUpdate({ repo, agentDir, apply: request.apply });
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (command === 'status' || command === 'plan') {
    const declarations = await validateRepository(repo);
    // status and plan are read-only inspection: they take no lock and never
    // write. The agent directory, when present, must still be a real
    // directory, matching the repository commands' check.
    const agentInfo = await fs.lstat(agentDir).catch((error: any) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (agentInfo?.isSymbolicLink() || (agentInfo && !agentInfo.isDirectory())) throw new Error(`Pi agent directory must be a real directory: ${agentDir}`);
    const output = await inspectRepository({ command, repo, agentDir, declarations, state: await loadState(agentDir), fetchUpstream: !request.noFetch });
    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) process.exitCode = output.exitCode;
    return;
  }
  if (command === 'pull') {
    // Pull only updates the setup-repository checkout: it dispatches before
    // repository manifest validation and the agent-directory check, and it
    // neither requires nor uses --agent-dir.
    const output = await runPull({ repo, apply: request.apply });
    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) process.exitCode = output.exitCode;
    return;
  }
  // remove tolerates missing pins up front so that removing an unpinned
  // dependency reaches its dedicated REMOVE_DEPENDENCY_NOT_PINNED error
  // instead of the generic repository validation failure. removeResource
  // keeps its own strict repository validation for resource removals.
  const declarations = await validateRepository(repo, { allowMissingPins: command === 'update' || command === 'remove' });
  if (command === 'push') {
    const output = await runPush({ repo, declarations, publish: request.publish, message: request.message, previewWriter: (preview) => process.stderr.write(preview) });
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (command === 'remove') {
    const output = await runRemove(request.type === 'dependency'
      ? { repo, agentDir, type: request.type, source: request.source, uninstall: request.uninstall }
      : { repo, agentDir, type: request.type, target: request.target, uninstall: request.uninstall });
    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) process.exitCode = output.exitCode;
    return;
  }
  // register declares repository-present content as managed by writing
  // the manifest entry only: no import or copy, no local-installation
  // write, and no commit or push. The three exclusive modes are --source
  // (single registration), --list (read-only discovery), and --all (batch
  // registration). It dispatches before the agent directory check, exactly
  // like remove, and none of the modes requires or uses --agent-dir.
  if (command === 'register') {
    const output = await runRegister({ repo, mode: request.mode });
    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) process.exitCode = output.exitCode;
    return;
  }
  let agentInfo = await fs.lstat(agentDir).catch((error: any) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (agentInfo?.isSymbolicLink() || (agentInfo && !agentInfo.isDirectory())) throw new Error(`Pi agent directory must be a real directory: ${agentDir}`);
  if (command === 'add') {
    if (request.type !== 'dependency' && !agentInfo) throw new Error(`Pi agent directory does not exist: ${agentDir}`);
    const output = await runAdd({ repo, agentDir, type: request.type, source: request.source });
    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) process.exitCode = output.exitCode;
    return;
  }
  if (command === 'update') {
    const output = await runUpdate({ repo, agentDir, declarations, apply: request.apply, approve: request.approve, push: request.push, message: request.message, previewWriter: (preview) => process.stderr.write(preview) });
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (command === 'sync') {
    const output = await runSync({ repo, agentDir, declarations, apply: request.apply });
    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) process.exitCode = output.exitCode;
    return;
  }
  if (command === 'apply') {
    const output = await runApply({ repo, agentDir, declarations, approve: request.approve });
    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) process.exitCode = output.exitCode;
    return;
  }
  if (command === 'prune') {
    const output = await runPrune({ repo, agentDir, declarations, confirm: request.confirm });
    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) process.exitCode = output.exitCode;
    return;
  }
}

main().catch((error: any) => fail(error, ['PACKAGE_INSTALL_FAILED', 'APPROVAL_REQUIRED', 'UPDATE_TRANSACTION_FAILED', 'PUSH_BLOCKED', 'SYNC_BLOCKED', 'PULL_BLOCKED', 'PULL_CONFLICT', 'PI_UPDATE_FAILED'].includes(error?.errorCode) || /update (?:discovery )?stopped closed|^(Another Pi Sync|A stale Pi Sync)/.test(error.message) ? OPERATION_ERROR : VALIDATION_ERROR));
