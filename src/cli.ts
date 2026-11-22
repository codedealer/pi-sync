#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommandRequest } from './cli/arguments.js';
import { readJson, validateRepository } from './cli/manifest.js';
import { loadState } from './cli/local-state.js';
import { inspectRepository } from './cli/commands/inspect.js';
import { runAdd, runRemove } from './cli/commands/resources.js';
import { runApply } from './cli/commands/apply.js';
import { runSync } from './cli/commands/sync.js';
import { runBootstrap } from './cli/commands/bootstrap.js';
import { runUpdate } from './cli/commands/update.js';
import { runPiUpdate } from './cli/commands/pi-update.js';
import { runPush } from './cli/commands/push.js';
import { runPull } from './cli/commands/pull.js';

const VALIDATION_ERROR = 2;
const OPERATION_ERROR = 1;
type OutputFormat = { json: boolean; pretty: boolean };


function splitOutputFlags(argv: string[]): { args: string[]; format: OutputFormat } {
  const args: string[] = [];
  let json = false;
  let pretty = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--pretty') pretty = true;
    else args.push(arg);
  }
  return { args, format: { json, pretty } };
}

function quote(value: unknown): string {
  if (typeof value === 'string') return value.includes('\n') || value.includes('\r') ? JSON.stringify(value) : value;
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function renderText(output: Record<string, any>): string {
  const lines: string[] = [output.ok ? 'ok' : `error ${output.errorCode ?? 'OPERATION_FAILED'}`];
  const skipped = new Set(['apiVersion', 'ok', 'exitCode', 'errorCode']);
  const emit = (key: string, value: any, depth: number, listItem = false) => {
    const indent = '  '.repeat(depth);
    const prefix = listItem ? `${indent}- ${key}: ` : `${indent}${key}: `;
    if (Array.isArray(value)) {
      if (value.length === 0) { lines.push(`${prefix}none`); return; }
      if (value.every((item) => item === null || typeof item !== 'object')) {
        lines.push(`${indent}${key}: ${value.length}`);
        for (const item of value) lines.push(`${indent}  - ${quote(item)}`);
        return;
      }
      lines.push(`${indent}${key}: ${value.length}`);
      for (const item of value) {
        if (item !== null && typeof item === 'object') {
          const entries = Object.entries(item);
          if (!entries.length) lines.push(`${indent}- {}`);
          else entries.forEach(([childKey, childValue], index) => emit(childKey, childValue, depth + (index === 0 ? 1 : 2), index === 0));
        } else lines.push(`${indent}- ${quote(item)}`);
      }
      return;
    }
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value);
      if (!entries.length) { lines.push(`${prefix}none`); return; }
      lines.push(`${indent}${key}:`);
      for (const [childKey, childValue] of entries) emit(childKey, childValue, depth + 1);
      return;
    }
    lines.push(`${prefix}${quote(value)}`);
  };
  const entries = Object.entries(output).filter(([key]) => !skipped.has(key));
  const next = entries.filter(([key]) => key === 'next');
  for (const [key, value] of entries.filter(([key]) => key !== 'next')) emit(key, value, 0);
  for (const [key, value] of next) emit(key, value, 0);
  return lines.join('\n');
}

function writeOutput(value: Record<string, any>, format: OutputFormat) {
  const output = { apiVersion: 2, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'apiVersion')) };
  if (format.json) console.log(JSON.stringify(output, null, format.pretty ? 2 : undefined));
  else console.log(renderText(output));
}

function fail(error: any, code: any, format: OutputFormat) {
  const command = process.argv[2] === '--version' ? 'version' : process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? null;
  const message = error instanceof Error ? error.message : String(error);
  const errorCode = error?.errorCode ?? (code === OPERATION_ERROR ? 'OPERATION_FAILED' : 'VALIDATION_ERROR');
  writeOutput({ command, ok: false, error: message, errorCode, details: error?.details ?? { message }, exitCode: code }, format);
  process.exitCode = code;
}

async function main(args: string[], format: OutputFormat) {
  if (format.pretty && !format.json) throw new Error('--pretty requires --json');
  const emitOutput = (value: Record<string, any>) => writeOutput(value, format);
  const request = parseCommandRequest(args);
  const command = request.command;

  if (command === 'version') {
    const packageJson: any = await readJson(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'package metadata');
    emitOutput({ command: 'version', ok: true, exitCode: 0, name: packageJson.name, version: packageJson.version });
    return;
  }
  if (command === 'bootstrap') {
    if (request.repoUrl === undefined) {
      const destination = path.resolve(request.repo);
      const existing = await validateRepository(destination).catch(() => null);
      if (!existing) throw new Error(`bootstrap requires --repo-url to fetch a new setup repository (no valid setup repository at ${destination})`);
    }
    const output = await runBootstrap({ repoUrl: request.repoUrl, repoDir: request.repo, agentDir: request.agentDir, binDir: request.binDir, approveInstalls: request.approveInstalls, dryRun: request.dryRun });
    emitOutput(output);
    if (!output.ok) process.exitCode = output.exitCode;
    return;
  }
  const repo = path.resolve(request.repo);
  const agentDir = path.resolve(request.agentDir);
  if (command === 'pi-update') {
    emitOutput(await runPiUpdate({ repo, agentDir, apply: request.apply }));
    return;
  }
  if (command === 'status') {
    const declarations = await validateRepository(repo);
    const agentInfo = await fs.lstat(agentDir).catch((error: any) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (agentInfo?.isSymbolicLink() || (agentInfo && !agentInfo.isDirectory())) throw new Error(`Pi agent directory must be a real directory: ${agentDir}`);
    const output = await inspectRepository({ command, repo, agentDir, declarations, state: await loadState(agentDir), fetchUpstream: !request.noFetch });
    emitOutput(output);
    if (!output.ok) process.exitCode = output.exitCode;
    return;
  }
  if (command === 'pull') {
    const output = await runPull({ repo, apply: request.apply });
    emitOutput(output);
    if (!output.ok) process.exitCode = output.exitCode;
    return;
  }
  const declarations = await validateRepository(repo, { allowMissingPins: command === 'update' || command === 'remove' });
  if (command === 'push') {
    emitOutput(await runPush({ repo, declarations, publish: request.publish, message: request.message }));
    return;
  }
  if (command === 'remove') {
    const output = await runRemove(request.type === 'stale'
      ? { repo, agentDir, type: 'stale', dryRun: request.dryRun }
      : request.type === 'dependency'
        ? { repo, agentDir, type: 'dependency', source: request.source, uninstall: request.uninstall, dryRun: request.dryRun }
        : { repo, agentDir, type: request.type, target: request.target, keepLocal: request.keepLocal, dryRun: request.dryRun });
    emitOutput(output);
    if (!output.ok) process.exitCode = output.exitCode;
    return;
  }
  if (command === 'add') {
    if (request.type !== 'dependency' && request.type !== 'resource-discovery') {
      const agentInfo = await fs.lstat(agentDir).catch((error: any) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (agentInfo?.isSymbolicLink() || (agentInfo && !agentInfo.isDirectory())) throw new Error(`Pi agent directory must be a real directory: ${agentDir}`);
    }
    const output = await runAdd(request.type === 'dependency'
      ? { repo, agentDir, type: request.type, source: request.source, dryRun: request.dryRun }
      : request.type === 'resource-discovery'
        ? { repo, agentDir, type: request.type, mode: request.mode }
        : { repo, agentDir, type: request.type, target: request.target, dryRun: request.dryRun });
    emitOutput(output);
    if (!output.ok) process.exitCode = output.exitCode;
    return;
  }
  const agentInfo = await fs.lstat(agentDir).catch((error: any) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (agentInfo?.isSymbolicLink() || (agentInfo && !agentInfo.isDirectory())) throw new Error(`Pi agent directory must be a real directory: ${agentDir}`);
  if (command === 'update') {
    emitOutput(await runUpdate({ repo, agentDir, declarations, apply: request.apply, approveInstalls: request.approveInstalls }));
    return;
  }
  if (command === 'sync') {
    const output = await runSync({ repo, agentDir, declarations, apply: request.apply });
    emitOutput(output);
    if (!output.ok) process.exitCode = output.exitCode;
    return;
  }
  if (command === 'apply') {
    const output = request.dryRun
      ? await inspectRepository({ command: 'status', repo, agentDir, declarations, state: await loadState(agentDir) })
      : await runApply({ repo, agentDir, declarations, approve: request.approveInstalls });
    emitOutput(output);
    if (!output.ok) process.exitCode = output.exitCode;
    return;
  }
}

const parsedArgs = splitOutputFlags(process.argv.slice(2));
main(parsedArgs.args, parsedArgs.format).catch((error: any) => fail(error, ['PACKAGE_INSTALL_FAILED', 'APPROVAL_REQUIRED', 'UPDATE_TRANSACTION_FAILED', 'PUSH_BLOCKED', 'SYNC_BLOCKED', 'PULL_BLOCKED', 'PULL_CONFLICT', 'PI_UPDATE_FAILED'].includes(error?.errorCode) || /update (?:discovery )?stopped closed|^(Another Pi Sync|A stale Pi Sync)/.test(error.message) ? OPERATION_ERROR : VALIDATION_ERROR, parsedArgs.format));
