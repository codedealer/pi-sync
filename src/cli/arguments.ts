import path from 'node:path';
import os from 'node:os';

// Typed command requests produced from raw CLI arguments. Parsing resolves
// defaults and validates command/option combinations without filesystem access.
export const DEFAULT_SETUP_REPO = path.join(os.homedir(), '.pi-sync', 'setup');
export const RESOURCE_TYPES = ['skill', 'extension', 'prompt', 'agent', 'role', 'workflow'] as const;

export interface RequestBase { agentDir: string }

export interface StatusRequest extends RequestBase {
  command: 'status'; repo: string; noFetch: boolean;
}
export interface ApplyRequest extends RequestBase {
  command: 'apply'; repo: string; dryRun: boolean; approveInstalls: boolean;
}
export interface AddDependencyRequest extends RequestBase {
  command: 'add'; repo: string; type: 'dependency'; source: string; dryRun: boolean;
}
export interface AddResourceRequest extends RequestBase {
  command: 'add'; repo: string; type: (typeof RESOURCE_TYPES)[number]; target: string; dryRun: boolean;
}
export type AddRequest = AddDependencyRequest | AddResourceRequest | AddResourceDiscoveryRequest;

export interface RemoveDependencyRequest extends RequestBase {
  command: 'remove'; repo: string; type: 'dependency'; source: string; uninstall: boolean; dryRun: boolean;
}
export interface RemoveResourceRequest extends RequestBase {
  command: 'remove'; repo: string; type: (typeof RESOURCE_TYPES)[number]; target: string; keepLocal: boolean; dryRun: boolean;
}
export interface RemoveStaleRequest extends RequestBase {
  command: 'remove'; repo: string; type: 'stale'; dryRun: boolean;
}
export type RemoveRequest = RemoveDependencyRequest | RemoveResourceRequest | RemoveStaleRequest;
export interface AddResourceDiscoveryRequest extends RequestBase {
  command: 'add'; repo: string; type: 'resource-discovery'; mode: { list: true } | { all: true };
}
export interface PullRequest extends RequestBase { command: 'pull'; repo: string; apply: boolean }
export interface PushRequest extends RequestBase { command: 'push'; repo: string; publish: boolean; message?: string }
export interface UpdateRequest extends RequestBase { command: 'update'; repo: string; apply: boolean; approveInstalls: boolean }
export interface PiUpdateRequest extends RequestBase { command: 'pi-update'; repo: string; apply: boolean }
export interface SyncRequest extends RequestBase { command: 'sync'; repo: string; apply: boolean }
export interface BootstrapRequest {
  command: 'bootstrap'; repo: string; repoUrl?: string; agentDir: string; binDir: string;
  approveInstalls: boolean; dryRun: boolean;
}
export interface VersionRequest { command: 'version' }
export type CommandRequest = StatusRequest | ApplyRequest | AddRequest | RemoveRequest |
  PullRequest | PushRequest | UpdateRequest | PiUpdateRequest | SyncRequest | BootstrapRequest | VersionRequest;

const RESOURCE_TARGET_ROOTS: Record<(typeof RESOURCE_TYPES)[number], string> = {
  skill: 'skills', extension: 'extensions', prompt: 'prompts', agent: 'agents', role: 'roles', workflow: 'workflows',
};
function resourceTypeForTarget(target: string): (typeof RESOURCE_TYPES)[number] | undefined {
  return RESOURCE_TYPES.find((type) => target === RESOURCE_TARGET_ROOTS[type] || target.startsWith(`${RESOURCE_TARGET_ROOTS[type]}/`));
}

interface Options {
  repo: string; repoUrl?: string; agentDir: string; binDir: string;
  source?: string; target?: string; approveInstalls: boolean; dryRun: boolean;
  pushUpdate: boolean; message?: string; uninstall: boolean; list: boolean;
  all: boolean; noFetch: boolean; stale: boolean; keepLocal: boolean;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    repo: process.env.PI_SYNC_REPO_DIR ?? DEFAULT_SETUP_REPO,
    agentDir: process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'),
    binDir: path.join(os.homedir(), '.local', 'bin'),
    approveInstalls: false, dryRun: false, pushUpdate: false,
    uninstall: false, list: false, all: false, noFetch: false, stale: false, keepLocal: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--repo', '--repo-url', '--agent-dir', '--bin-dir', '--source', '--target', '--message'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--repo') options.repo = value;
      else if (arg === '--repo-url') options.repoUrl = value;
      else if (arg === '--agent-dir') options.agentDir = value;
      else if (arg === '--bin-dir') options.binDir = value;
      else if (arg === '--target') options.target = value;
      else if (arg === '--message') options.message = value;
      else options.source = value;
    } else if (arg === '--dry-run') options.dryRun = true;
    else if (['--apply', '--confirm', '--publish', '--approve'].includes(arg)) throw new Error(`${arg} is no longer supported`);
    else if (arg === '--approve-installs') options.approveInstalls = true;
    else if (arg === '--push') options.pushUpdate = true;
    else if (arg === '--uninstall') options.uninstall = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--no-fetch') options.noFetch = true;
    else if (arg === '--stale') options.stale = true;
    else if (arg === '--keep-local') options.keepLocal = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function buildRequest(command: string, options: Options): CommandRequest {
  if (options.dryRun && command === 'status') throw new Error(`--dry-run is not supported by ${command}`);
  if (options.list && command !== 'add') throw new Error('--list is only supported by add');
  if (options.all && command !== 'add') throw new Error('--all is only supported by add');
  if (options.approveInstalls && !['apply', 'update', 'bootstrap'].includes(command)) throw new Error('--approve-installs is only supported by apply, update, or bootstrap');
  if (options.pushUpdate) throw new Error(command === 'update' ? 'update --push is no longer supported; run pi-sync push separately' : '--push is no longer supported; run pi-sync push separately');
  if (options.noFetch && command !== 'status') throw new Error('--no-fetch is only supported by status');
  if (options.message !== undefined && command !== 'push') throw new Error('--message is only supported by push');
  if (options.message !== undefined && !options.message.trim()) throw new Error('--message must not be empty');

  if (command === 'add') {
    if (options.list && options.all) throw new Error('add --list and --all are mutually exclusive; select exactly one of --target, --list, or --all');
    if (options.dryRun && (options.list || options.all)) throw new Error(`add --dry-run is not supported with ${options.list ? '--list' : '--all'}; discovery is already read-only`);
    if (options.source !== undefined && options.target !== undefined) throw new Error('add accepts either --target for a resource or --source for a dependency, not both');
    if (options.source !== undefined && (options.list || options.all)) throw new Error('add --source cannot be combined with --list or --all');
    if (options.target !== undefined && (options.list || options.all)) throw new Error('add --target cannot be combined with --list or --all');
    if (options.source !== undefined) return { command, repo: options.repo, agentDir: options.agentDir, type: 'dependency', source: options.source, dryRun: options.dryRun };
    if (options.list || options.all) return { command, repo: options.repo, agentDir: options.agentDir, type: 'resource-discovery', mode: options.list ? { list: true } : { all: true } };
    if (options.target === undefined) throw new Error('add requires --target for a resource, --source for a dependency, --list, or --all');
    const type = resourceTypeForTarget(options.target);
    if (!type) throw new Error('--target must identify a resource under skills/, extensions/, prompts/, agents/, roles/, or workflows/');
    return { command, repo: options.repo, agentDir: options.agentDir, type, target: options.target, dryRun: options.dryRun };
  }
  if (command === 'remove') {
    const selectorCount = [options.target !== undefined, options.source !== undefined, options.stale].filter(Boolean).length;
    if (selectorCount !== 1) throw new Error('remove requires exactly one of --target for a resource, --source for a dependency, or --stale for the stale batch');
    if (options.target !== undefined) {
      if (options.uninstall) throw new Error('--uninstall is only supported for dependency removal via --source');
      const type = resourceTypeForTarget(options.target);
      if (!type) throw new Error('--target must identify a resource under skills/, extensions/, prompts/, agents/, roles/, or workflows/');
      return { command, repo: options.repo, agentDir: options.agentDir, type, target: options.target, keepLocal: options.keepLocal, dryRun: options.dryRun };
    }
    if (options.source !== undefined) {
      if (options.keepLocal) throw new Error('--keep-local is only supported for resource removal via --target');
      return { command, repo: options.repo, agentDir: options.agentDir, type: 'dependency', source: options.source, uninstall: options.uninstall, dryRun: options.dryRun };
    }
    if (options.uninstall) throw new Error('--uninstall is only supported for dependency removal via --source');
    if (options.keepLocal) throw new Error('--keep-local is only supported for resource removal via --target');
    return { command, repo: options.repo, agentDir: options.agentDir, type: 'stale', dryRun: options.dryRun };
  }
  if (options.stale && command !== 'remove') throw new Error('--stale is only supported by remove');
  if (options.keepLocal && command !== 'remove') throw new Error('--keep-local is only supported by remove');
  if (options.source !== undefined && command !== 'add' && command !== 'remove') throw new Error('--source is only supported by add and remove');
  if (options.target !== undefined && command !== 'add' && command !== 'remove') throw new Error('--target is only supported by add and remove');
  if (options.uninstall && command !== 'remove') throw new Error('--uninstall is only supported by remove');

  switch (command) {
    case 'status': return { command, repo: options.repo, agentDir: options.agentDir, noFetch: options.noFetch };
    case 'apply': return { command, repo: options.repo, agentDir: options.agentDir, dryRun: options.dryRun, approveInstalls: options.approveInstalls };
    case 'pull': return { command, repo: options.repo, agentDir: options.agentDir, apply: !options.dryRun };
    case 'push': return { command, repo: options.repo, agentDir: options.agentDir, publish: !options.dryRun, message: options.message };
    case 'update': return { command, repo: options.repo, agentDir: options.agentDir, apply: !options.dryRun, approveInstalls: options.approveInstalls };
    case 'pi-update': return { command, repo: options.repo, agentDir: options.agentDir, apply: !options.dryRun };
    case 'sync': return { command, repo: options.repo, agentDir: options.agentDir, apply: !options.dryRun };
    case 'bootstrap': return { command, repo: options.repo, repoUrl: options.repoUrl, agentDir: options.agentDir, binDir: options.binDir, approveInstalls: options.approveInstalls, dryRun: options.dryRun };
    default: throw new Error(`Unknown command: ${command}`);
  }
}

export function parseCommandRequest(argv: string[]): CommandRequest {
  const command = argv[0];
  if (command === '--version') {
    if (argv.length > 1) throw new Error('--version does not accept additional arguments');
    return { command: 'version' };
  }
  const commands = ['status', 'pull', 'apply', 'add', 'remove', 'bootstrap', 'update', 'push', 'pi-update', 'sync'];
  if (!commands.includes(command)) {
    throw new Error('Usage: pi-sync --version | pi-sync <status|pull|apply|add|remove|update|pi-update|push|bootstrap|sync> [--repo PATH] [--repo-url URL] [--agent-dir PATH] [--no-fetch] [--target RESOURCE-PATH | --source PACKAGE | --stale] [--list] [--all] [--keep-local] [--dry-run] [--approve-installs] [--uninstall] [--message TEXT] [--json] [--pretty]');
  }
  return buildRequest(command, parseOptions(argv.slice(1)));
}
