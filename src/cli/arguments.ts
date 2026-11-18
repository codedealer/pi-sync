import path from 'node:path';
import os from 'node:os';

// Typed command requests produced from raw CLI arguments. Argument parsing is
// deliberately repository-agnostic: it resolves option defaults, validates
// the option/command combinations, and returns a discriminated union that
// the entry point dispatches on. No filesystem or git access happens here.

export const DEFAULT_SETUP_REPO = path.join(os.homedir(), '.pi-sync', 'setup');

export const RESOURCE_TYPES = ['skill', 'extension', 'prompt', 'agent', 'role'] as const;
export const REMOVABLE_TYPES = ['skill', 'extension', 'prompt', 'agent', 'role', 'dependency'] as const;

export interface RequestBase {
  agentDir: string;
}

export interface StatusPlanRequest extends RequestBase {
  command: 'status' | 'plan';
  repo: string;
}

export interface ApplyRequest extends RequestBase {
  command: 'apply';
  repo: string;
  approve: boolean;
}

export interface PruneRequest extends RequestBase {
  command: 'prune';
  repo: string;
  confirm: boolean;
}

export interface AddRequest extends RequestBase {
  command: 'add';
  repo: string;
  type: 'skill' | 'extension' | 'prompt' | 'agent' | 'role' | 'dependency';
  source: string;
}

// Discriminated per removal kind: the parser guarantees that dependency
// removals carry --source (and reject --target) and resource removals carry
// --target (and reject --source), so each variant exposes only the selector
// it requires.
export interface RemoveDependencyRequest extends RequestBase {
  command: 'remove';
  repo: string;
  type: 'dependency';
  source: string;
  uninstall: boolean;
}

export interface RemoveResourceRequest extends RequestBase {
  command: 'remove';
  repo: string;
  type: 'skill' | 'extension' | 'prompt' | 'agent' | 'role';
  target: string;
  uninstall: boolean;
}

export type RemoveRequest = RemoveDependencyRequest | RemoveResourceRequest;

// The single-registration mode carries a required type: the parser rejects a
// source registration without --type before this request is built.
export type RegisterMode = { source: string; type: string } | { list: true; type?: string } | { all: true; type?: string };

export interface RegisterRequest extends RequestBase {
  command: 'register';
  repo: string;
  mode: RegisterMode;
}

export interface PushRequest extends RequestBase {
  command: 'push';
  repo: string;
  publish: boolean;
}

export interface UpdateRequest extends RequestBase {
  command: 'update';
  repo: string;
  apply: boolean;
  push: boolean;
  approve: boolean;
}

export interface PiUpdateRequest extends RequestBase {
  command: 'pi-update';
  repo: string;
  apply: boolean;
}

export interface SyncRequest extends RequestBase {
  command: 'sync';
  repo: string;
  apply: boolean;
}

export interface BootstrapRequest {
  command: 'bootstrap';
  repoUrl: string;
  repoDir: string;
  agentDir: string;
  binDir: string;
  approve: boolean;
}

export interface VersionRequest {
  command: 'version';
}

export type CommandRequest =
  | StatusPlanRequest | ApplyRequest | PruneRequest | AddRequest | RemoveRequest | RegisterRequest
  | PushRequest | UpdateRequest | PiUpdateRequest | SyncRequest | BootstrapRequest | VersionRequest;

// Parsed option bag, mirroring the entry point's former `options` object.
interface Options {
  repo: string;
  repoUrl?: string;
  repoDir: string;
  agentDir: string;
  binDir: string;
  type?: string;
  source?: string;
  target?: string;
  confirm: boolean;
  approve: boolean;
  applyUpdate: boolean;
  pushUpdate: boolean;
  publish: boolean;
  uninstall: boolean;
  list: boolean;
  all: boolean;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    repo: process.env.PI_SYNC_REPO_DIR ?? DEFAULT_SETUP_REPO,
    repoDir: DEFAULT_SETUP_REPO,
    agentDir: process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'),
    binDir: path.join(os.homedir(), '.local', 'bin'),
    confirm: false, approve: false, applyUpdate: false, pushUpdate: false,
    publish: false, uninstall: false, list: false, all: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--repo', '--repo-url', '--repo-dir', '--agent-dir', '--bin-dir', '--type', '--source', '--target'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--repo') options.repo = value;
      else if (arg === '--repo-url') options.repoUrl = value;
      else if (arg === '--repo-dir') options.repoDir = value;
      else if (arg === '--agent-dir') options.agentDir = value;
      else if (arg === '--bin-dir') options.binDir = value;
      else if (arg === '--type') options.type = value;
      else if (arg === '--target') options.target = value;
      else options.source = value;
    } else if (arg === '--confirm') options.confirm = true;
    else if (arg === '--approve') options.approve = true;
    else if (arg === '--apply') options.applyUpdate = true;
    else if (arg === '--push') options.pushUpdate = true;
    else if (arg === '--publish') options.publish = true;
    else if (arg === '--uninstall') options.uninstall = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--all') options.all = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

// Builds the typed request for a known command. The caller is responsible for
// dispatching on `request.command` after this returns.
function buildRequest(command: string, options: Options, argv: string[]): CommandRequest {
  // Cross-command flag restrictions, checked in the entry point's original
  // order so error precedence is unchanged.
  if (options.confirm && command !== 'prune') throw new Error('--confirm is only supported by prune');
  if (options.list && command !== 'register') throw new Error('--list is only supported by register');
  if (options.all && command !== 'register') throw new Error('--all is only supported by register');
  if (options.approve && !['apply', 'update', 'bootstrap'].includes(command)) throw new Error('--approve is only supported by apply, update, or bootstrap');
  if (options.applyUpdate && !['update', 'sync', 'pi-update'].includes(command)) throw new Error('--apply is only supported by update, sync, or pi-update');
  if (options.pushUpdate && command !== 'update') throw new Error('--push is only supported by update');
  if (options.pushUpdate && !options.applyUpdate) throw new Error('update --push requires --apply so package updates are explicitly approved');
  if (options.publish && command !== 'push') throw new Error('--publish is only supported by push');
  if (command === 'add' && (!options.type || !options.source)) throw new Error('add requires explicit --type and --source options');
  if (command === 'add' && !REMOVABLE_TYPES.includes(options.type as any)) throw new Error(`Unsupported resource type: ${options.type}`);
  // Exactly one of the three register modes is selected: a single
  // registration via --source, --list, or --all. --type is required for
  // single registration and optional (narrowing the roots scanned) for
  // --list and --all.
  if (command === 'register' && options.type && !RESOURCE_TYPES.includes(options.type as any)) throw new Error(`Unsupported resource type: ${options.type}`);
  if (command === 'register' && options.list && options.all) throw new Error('register --list and --all are mutually exclusive; select exactly one of --source, --list, or --all');
  if (command === 'register' && options.source && (options.list || options.all)) throw new Error('register --source cannot be combined with --list or --all; select exactly one of --source, --list, or --all');
  if (command === 'register' && !options.list && !options.all && (!options.type || !options.source)) throw new Error('register requires explicit --type and --source options');
  if (command === 'remove' && !options.type) throw new Error('remove requires explicit --type and --target (or --source for dependencies)');
  if (command === 'remove' && !REMOVABLE_TYPES.includes(options.type as any)) throw new Error(`Unsupported resource type: ${options.type}`);
  if (command === 'remove' && options.type === 'dependency') {
    if (!options.source) throw new Error('remove --type dependency requires --source npm:PACKAGE or github:OWNER/REPOSITORY');
    if (options.target) throw new Error('--target is only supported for resource types; remove --type dependency uses --source');
  }
  if (command === 'remove' && options.type && options.type !== 'dependency') {
    if (!options.target) throw new Error('remove requires --target for resource types (for example, skills/NAME)');
    if (options.source) throw new Error('--source is only supported by remove --type dependency; resource removal uses --target');
  }
  if (options.uninstall && (command !== 'remove' || options.type !== 'dependency')) throw new Error('--uninstall is only supported by remove --type dependency');
  if (options.target !== undefined && !(command === 'remove' && options.type && options.type !== 'dependency')) throw new Error('--target is only supported by remove for resource types');
  if (command === 'bootstrap') {
    if (!options.repoUrl) throw new Error('bootstrap requires --repo-url');
    // --repo is rejected for bootstrap wherever it appears in the arguments.
    // The check inspects the argv handed to this parser (not process.argv)
    // so the parser stays self-contained for any call site or test argv.
    if (argv.includes('--repo')) throw new Error('bootstrap uses --repo-dir, not --repo');
  }

  switch (command) {
    case 'status':
    case 'plan':
      return { command, repo: options.repo, agentDir: options.agentDir };
    case 'apply':
      return { command, repo: options.repo, agentDir: options.agentDir, approve: options.approve };
    case 'prune':
      return { command, repo: options.repo, agentDir: options.agentDir, confirm: options.confirm };
    case 'add':
      return { command, repo: options.repo, agentDir: options.agentDir, type: options.type as AddRequest['type'], source: options.source as string };
    case 'remove':
      // The validation above guarantees the selector each removal kind
      // requires, so each typed variant is constructed with it present.
      return options.type === 'dependency'
        ? { command, repo: options.repo, agentDir: options.agentDir, type: 'dependency', source: options.source as string, uninstall: options.uninstall }
        : { command, repo: options.repo, agentDir: options.agentDir, type: options.type as RemoveResourceRequest['type'], target: options.target as string, uninstall: options.uninstall };
    case 'register':
      return { command: 'register', repo: options.repo, agentDir: options.agentDir,
        // Single registration is validated above to carry --type, so the
        // source mode keeps its type as a required, typed field.
        mode: options.source
          ? { source: options.source, type: options.type as string }
          : options.list
            ? { list: true, ...(options.type !== undefined ? { type: options.type } : {}) }
            : { all: true, ...(options.type !== undefined ? { type: options.type } : {}) } };
    case 'push':
      return { command, repo: options.repo, agentDir: options.agentDir, publish: options.publish };
    case 'update':
      return { command, repo: options.repo, agentDir: options.agentDir, apply: options.applyUpdate, push: options.pushUpdate, approve: options.approve };
    case 'pi-update':
      return { command, repo: options.repo, agentDir: options.agentDir, apply: options.applyUpdate };
    case 'sync':
      return { command, repo: options.repo, agentDir: options.agentDir, apply: options.applyUpdate };
    case 'bootstrap':
      return { command, repoUrl: options.repoUrl as string, repoDir: options.repoDir, agentDir: options.agentDir, binDir: options.binDir, approve: options.approve };
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// Parses `argv` (everything after the script name) into a typed command
// request. Unknown commands fail with the usage error; option defaults come
// from the environment (PI_SYNC_REPO_DIR, PI_CODING_AGENT_DIR) and the
// built-in setup repository default.
export function parseCommandRequest(argv: string[]): CommandRequest {
  const command = argv[0];
  if (command === '--version') {
    if (argv.length > 1) throw new Error('--version does not accept additional arguments');
    return { command: 'version' };
  }
  if (!['status', 'plan', 'apply', 'add', 'remove', 'register', 'prune', 'bootstrap', 'update', 'push', 'pi-update', 'sync'].includes(command as any)) {
    throw new Error('Usage: pi-sync --version | pi-sync <status|plan|apply|add|remove|register|prune|update|pi-update|push|bootstrap|sync> [--repo PATH] [--repo-url URL --repo-dir PATH] [--agent-dir PATH] [--type skill|extension|prompt|agent|role|dependency --target VALUE | --source VALUE] [--list] [--all] [--confirm] [--approve] [--apply] [--push] [--publish] [--uninstall]');
  }
  return buildRequest(command as 'status' | 'plan' | 'apply' | 'add' | 'remove' | 'register' | 'prune' | 'bootstrap' | 'update' | 'pi-update' | 'push' | 'sync', parseOptions(argv.slice(1)), argv);
}