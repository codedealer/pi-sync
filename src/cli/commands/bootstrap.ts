import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectRequiredTools, type PrerequisitesResult, type PrerequisiteTool } from '../../prerequisites.js';
import { MANIFEST_FILE, pathsOverlap, readJson, validateRepository, type RepositoryDeclarations } from '../manifest.js';
import { gitExecutable, gitResult, runCommand } from '../process.js';
import { ensureRealDirectory } from '../resource-operations.js';

// Matches the entry point's operation-error exit status: bootstrap reports it
// in the JSON output and the entry point mirrors it onto process.exitCode.
const OPERATION_ERROR = 1;
const BUNDLED_SKILL = fileURLToPath(new URL('../../../resources/skills/pi-sync', import.meta.url));
const BUNDLED_EXTENSION = fileURLToPath(new URL('../../../resources/extensions/pi-sync', import.meta.url));

interface BundledResource {
  type: 'skill' | 'extension';
  source: string;
  target: string;
  root: string;
}

interface BundledCollision {
  source: string;
  target: string;
  bundled: { type: string; source: string; target: string };
  reason?: string;
}

type BundledAction = 'declared' | 'refreshed' | 'already-current';

interface BundledActionReport {
  type: string;
  source: string;
  target: string;
  action: BundledAction;
}

interface BundledRefreshResult {
  ok: boolean;
  collision?: BundledCollision;
  actions: BundledActionReport[];
}

interface PiSyncSubprocessResult {
  status: number;
  output: any;
}

export interface BootstrapInput {
  // Optional: when absent, the entry point has already verified the
  // destination holds a valid setup repository, and the URL is inferred
  // from that checkout's origin remote.
  repoUrl?: string;
  repoDir: string;
  agentDir: string;
  binDir: string;
  approve?: boolean;
}

export type BootstrapErrorCode =
  | 'REPOSITORY_PATH_COLLISION'
  | 'PREREQUISITE_INSTALL_REQUIRED'
  | 'AUTH_REQUIRED'
  | 'FETCH_FAILED'
  | 'RESOURCE_COLLISION'
  | 'APPLY_CONFLICT'
  | 'REPOSITORY_REMOTE_UNRESOLVABLE';

export interface BootstrapOutput {
  apiVersion: 1;
  command: 'bootstrap';
  ok: boolean;
  errorCode: BootstrapErrorCode | undefined;
  error: string | undefined;
  exitCode: number;
  repository: string;
  packageVersion: string;
  // The resolved repository URL and its source: the explicit --repo-url
  // flag or the destination checkout's origin remote. Present on all
  // success responses and on failure responses reached after the URL was
  // resolved.
  repoUrl?: string;
  repoUrlSource?: 'flag' | 'remote';
  prerequisites?: PrerequisiteTool[];
  missingPrerequisites?: PrerequisiteTool[];
  authentication?: {
    required: true;
    cliAvailable: boolean;
    command: string;
    commandArgs: string[];
    credentialHandling: string;
  };
  resumeArgs?: string[];
  collision?: BundledCollision;
  plan?: unknown;
  bundledResources?: { type: string; source: string; target: string; action: BundledAction }[];
  authenticationMethod?: 'git' | 'github-cli' | null;
  apply?: unknown;
}

function validateBootstrapUrl(value: string) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) throw new Error('--repo-url must be a GitHub URL');
  const scp = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
  if (scp) return { value, githubSlug: scp[1] };
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('--repo-url must be an HTTPS, SSH, or local file Git URL'); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('--repo-url must not contain credentials, query parameters, or fragments');
  if (parsed.protocol === 'file:') return { value, githubSlug: null };
  if (!['https:', 'ssh:'].includes(parsed.protocol) || parsed.hostname.toLowerCase() !== 'github.com') {
    throw new Error('--repo-url must use github.com (or a local file URL for testing)');
  }
  const slug = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) throw new Error('--repo-url must identify a GitHub owner/repository');
  return { value, githubSlug: slug };
}

// Resolves the repository URL when --repo-url was not passed, by reading
// the destination checkout's origin remote. Only ever called after the
// destination has passed validateRepository: a URL is never trusted from an
// invalid directory, and a missing remote or a URL that fails validation
// fails closed (the caller reports REPOSITORY_REMOTE_UNRESOLVABLE).
async function inferOriginRemoteUrl(repoDir: string): Promise<{ value: string; githubSlug: string | null }> {
  const result = await gitResult(repoDir, ['remote', 'get-url', 'origin']);
  if (result.status !== 0 || result.output.length === 0) {
    throw new Error('The setup repository at the destination has no readable origin remote; pass --repo-url explicitly or repair the remote');
  }
  try {
    return validateBootstrapUrl(result.output);
  } catch {
    throw new Error('The setup repository origin remote URL is not an allowed GitHub (or local file) URL; pass --repo-url explicitly or repair the remote');
  }
}

function bootstrapResponse(ok: boolean, errorCode: BootstrapErrorCode | undefined, error: string | undefined, extra: { repository: string; packageVersion: string } & Partial<Omit<BootstrapOutput, 'apiVersion' | 'command' | 'ok' | 'errorCode' | 'error' | 'exitCode' | 'repository' | 'packageVersion'>>): BootstrapOutput {
  return { apiVersion: 1 as const, command: 'bootstrap', ok, errorCode, error, exitCode: ok ? 0 : OPERATION_ERROR, ...extra };
}

// The version of the package currently executing bootstrap: the bundle it
// ships is authoritative for the first-party resources it refreshes.
async function readPackageVersion(): Promise<string> {
  const meta = await readJson(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'package metadata');
  const version = (meta as { version?: unknown }).version;
  if (typeof version !== 'string' || version.length === 0) throw new Error('The executing Pi Sync package has no readable version');
  return version;
}

async function requireBundledRoot(item: BundledResource): Promise<void> {
  const info = await fs.lstat(item.root).catch((error) => { throw new Error(`Bundled pi-sync ${item.type} is unavailable: ${error.message}`); });
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Bundled pi-sync ${item.type} is not a real directory`);
}

// Relative file paths and content digests of one bundle directory, used to
// decide whether a declared bundle already matches the executing package.
async function bundledInventory(root: string, label: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported in bundled pi-sync ${label} content: ${relative}`);
      if (entry.isDirectory()) await visit(entryPath, relative);
      else if (entry.isFile()) files.set(relative, crypto.createHash('sha256').update(await fs.readFile(entryPath)).digest('hex'));
      else throw new Error(`Unsupported file type in bundled pi-sync ${label} content: ${relative}`);
    }
  }
  await visit(root, '');
  return files;
}

function inventoriesEqual(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [file, digest] of left) if (right.get(file) !== digest) return false;
  return true;
}

// Seeds or refreshes the Pi Sync-owned bundled resources in the setup
// repository. A freshly needed declaration is seeded from the executing
// package and appended to the manifest; an exact existing declaration is
// mirrored from the executing package's bundle, including removing files the
// package no longer ships. The complete bundled set is prefetched before any
// source path changes so one collision cannot leave a partial refresh:
// overlapping or non-exact declarations and undeclared pre-existing source
// paths fail without touching any bundled content.
async function refreshBundledResources(repo: string): Promise<BundledRefreshResult> {
  const manifestPath = path.join(repo, MANIFEST_FILE);
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  const declarations = await validateRepository(repo);
  const bundled: BundledResource[] = [
    { type: 'skill', source: 'resources/skills/pi-sync', target: 'skills/pi-sync', root: BUNDLED_SKILL },
    { type: 'extension', source: 'resources/extensions/pi-sync', target: 'extensions/pi-sync', root: BUNDLED_EXTENSION },
  ];

  type Plan = { item: BundledResource; mode: 'seed' | 'mirror' };
  const plans: Plan[] = [];
  for (const item of bundled) {
    await requireBundledRoot(item);
    const sourcePath = path.join(repo, ...item.source.split('/'));
    const bundledRef = { type: item.type, source: item.source, target: item.target };
    if (declarations.resources.some((resource) => resource.source === item.source && resource.target === item.target)) {
      const existing = await fs.lstat(sourcePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!existing || existing.isSymbolicLink() || !existing.isDirectory()) {
        return { ok: false, collision: { source: item.source, target: item.target, bundled: bundledRef, reason: 'the declared pi-sync bundle source must be a real directory so it can be mirrored from the executing package' }, actions: [] };
      }
      plans.push({ item, mode: 'mirror' });
      continue;
    }
    const collision = declarations.resources.find((resource) => pathsOverlap(resource.target, item.target) || pathsOverlap(resource.source, item.source));
    if (collision) return { ok: false, collision: { source: collision.source, target: collision.target, bundled: bundledRef }, actions: [] };
    const preexisting = await fs.lstat(sourcePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (preexisting) return { ok: false, collision: { source: item.source, target: item.target, bundled: bundledRef, reason: 'setup repository source path already exists and is not declared as this resource' }, actions: [] };
    plans.push({ item, mode: 'seed' });
  }

  const actions: BundledActionReport[] = [];
  const toMirror: Plan[] = [];
  const toSeed: Plan[] = [];
  for (const plan of plans) {
    const report: BundledActionReport = { type: plan.item.type, source: plan.item.source, target: plan.item.target, action: 'already-current' };
    if (plan.mode === 'seed') {
      report.action = 'declared';
      toSeed.push(plan);
    } else {
      const sourcePath = path.join(repo, ...plan.item.source.split('/'));
      const shipped = await bundledInventory(plan.item.root, plan.item.type);
      const installed = await bundledInventory(sourcePath, plan.item.type);
      if (!inventoriesEqual(shipped, installed)) {
        report.action = 'refreshed';
        toMirror.push(plan);
      }
    }
    actions.push(report);
  }
  if (!toSeed.length && !toMirror.length) return { ok: true, actions };

  const created: string[] = [];
  try {
    for (const plan of toMirror) {
      const sourcePath = path.join(repo, ...plan.item.source.split('/'));
      await fs.rm(sourcePath, { recursive: true, force: true });
      await fs.cp(plan.item.root, sourcePath, { recursive: true });
    }
    for (const plan of toSeed) {
      const sourcePath = path.join(repo, ...plan.item.source.split('/'));
      await ensureRealDirectory(repo, path.posix.dirname(plan.item.source), true);
      await fs.mkdir(sourcePath);
      created.push(sourcePath);
      for (const entry of await fs.readdir(plan.item.root)) {
        await fs.cp(path.join(plan.item.root, entry), path.join(sourcePath, entry), { recursive: true, errorOnExist: true, force: false });
      }
    }
    if (toSeed.length) {
      const nextManifest = { ...manifest, resources: [...manifest.resources, ...toSeed.map(({ item }) => ({ type: item.type, source: item.source, target: item.target }))] };
      const temporary = `${manifestPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        const info = await fs.stat(manifestPath);
        await fs.writeFile(temporary, `${JSON.stringify(nextManifest, null, 2)}\n`, { flag: 'wx', mode: info.mode & 0o777 });
        if (await fs.readFile(manifestPath, 'utf8') !== manifestText) throw new Error('Setup manifest changed during bootstrap; refusing to overwrite concurrent changes');
        await fs.rename(temporary, manifestPath);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    }
  } catch (error) {
    for (const directory of created) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await validateRepository(repo);
  return { ok: true, actions };
}

// Runs a sibling pi-sync command (plan/apply) as a subprocess of this CLI
// build so bootstrap drives the exact established workflows, including the
// apply/reconciliation path, with their own locking and error envelopes.
async function runPiSync(command: 'plan' | 'apply', repo: string, agentDir: string, approve: boolean = false): Promise<PiSyncSubprocessResult> {
  const entry = fileURLToPath(new URL('../../cli.js', import.meta.url));
  const result = await runCommand(process.execPath, [entry, command, '--repo', repo, '--agent-dir', agentDir, ...(approve ? ['--approve'] : [])]);
  let output;
  try { output = JSON.parse(result.stdout); } catch {
    const detail = (result.stderr || '').trim() || (result.stdout || '').trim() || (result.error ? result.error.message : '');
    return { status: result.status ?? 1, output: { apiVersion: 1, command, ok: false, errorCode: 'CLI_FAILED',
      error: `Pi Sync command returned no valid JSON output${detail ? `: ${detail.slice(0, 2000)}` : ''}`, exitCode: OPERATION_ERROR } };
  }
  return { status: result.status ?? output.exitCode ?? 1, output };
}

// The bootstrap workflow: fetches the setup repository (git directly, or the
// GitHub CLI when the authentication handoff has been completed), pauses with
// structured handoffs for authentication or prerequisite installation,
// ensures the bundled pi-sync skill and extension match the executing
// package's bundle (seeding new declarations, mirroring exact ones), then
// reaches the repository's desired local installation state through the
// ordinary plan/apply commands. A rerun with the same command resumes from an
// existing valid setup repository instead of requiring an empty path. Pi Sync
// never requests, prints, or stores credentials.
export async function runBootstrap({ repoUrl, repoDir, agentDir, binDir, approve = false }: BootstrapInput): Promise<BootstrapOutput> {
  // An explicit --repo-url is validated up front, exactly as before; when
  // it is absent, inference is deferred until the destination has proven
  // to be a valid setup repository (resume path).
  let remote: { value: string; githubSlug: string | null } | null = repoUrl !== undefined ? validateBootstrapUrl(repoUrl) : null;
  let repoUrlSource: 'flag' | 'remote' = 'flag';
  // Resolution is auditable on every response reached after the URL is
  // known: the resolved URL and whether it came from the flag or the
  // destination checkout's origin remote.
  const urlFields = () => (remote === null ? {} : { repoUrl: remote.value, repoUrlSource });
  const packageVersion = await readPackageVersion();
  const destination = path.resolve(repoDir);
  // `binDir` always arrives resolved: the parser applies the `~/.local/bin`
  // default (BootstrapInput.binDir is non-optional), so there is no fallback
  // to apply here.
  const bin = path.resolve(binDir);
  const existing = await fs.lstat(destination).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  let setup: RepositoryDeclarations | null = null;
  let checkout: string | null = null;
  let stagingRoot: string | null = null;
  let authenticationMethod: 'git' | 'github-cli' | null = 'git';
  if (existing) {
    if (!existing.isDirectory()) {
      return bootstrapResponse(false, 'REPOSITORY_PATH_COLLISION', 'Setup repository destination exists and is not a directory; choose an empty path', { repository: destination, packageVersion, ...urlFields() });
    }
    // A previous bootstrap (or the user) may already have placed the setup
    // repository at the destination. Resume from it instead of requiring an
    // empty path so a failed first run is rerun with the same command.
    setup = await validateRepository(destination).catch(() => null);
    if (!setup) {
      return bootstrapResponse(false, 'REPOSITORY_PATH_COLLISION', 'Setup repository destination already exists but is not a valid Pi Sync setup repository; choose an empty path', { repository: destination, packageVersion, ...urlFields() });
    }
    checkout = destination;
    authenticationMethod = null;
    if (remote === null) {
      // The destination has just passed validateRepository, so it is safe
      // to read its origin remote; a missing or invalid remote fails
      // closed and tells the user to pass --repo-url explicitly.
      try {
        remote = await inferOriginRemoteUrl(destination);
        repoUrlSource = 'remote';
      } catch (error) {
        return bootstrapResponse(false, 'REPOSITORY_REMOTE_UNRESOLVABLE', error instanceof Error ? error.message : String(error), { repository: destination, packageVersion });
      }
    }
  } else {
    // The entry point preflights the missing-URL case, so a first-time fetch
    // always carries an explicit URL; this guard keeps runBootstrap
    // self-contained for any future call site.
    if (remote === null) {
      return bootstrapResponse(false, 'REPOSITORY_REMOTE_UNRESOLVABLE', 'Bootstrap requires --repo-url to fetch a new setup repository; no valid setup repository exists at the destination to infer the URL from', { repository: destination, packageVersion });
    }
    const access = await runCommand(await gitExecutable(), ['ls-remote', remote.value]);
    if (access.status !== 0) {
      let ghAuthenticated = false;
      let ghAvailable = false;
      let prerequisiteResult: PrerequisitesResult | null = null;
      if (remote.githubSlug) {
        prerequisiteResult = await inspectRequiredTools(['gh'], { binDir: bin });
        ghAvailable = prerequisiteResult.ok;
        if (!ghAvailable) return bootstrapResponse(false, 'PREREQUISITE_INSTALL_REQUIRED',
          'GitHub CLI is required for this authentication handoff but could not be installed automatically.', {
            repository: destination, packageVersion, prerequisites: prerequisiteResult.tools, ...urlFields(),
            missingPrerequisites: prerequisiteResult.tools.filter((tool) => tool.status === 'failed'),
          });
        const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
        const status = await runCommand('gh', ['auth', 'status', '--hostname', 'github.com'], env);
        ghAuthenticated = status.status === 0;
      }
      if (!ghAuthenticated) {
        const resumeArgs = ['bootstrap', '--repo-url', remote.value, '--repo-dir', destination, '--agent-dir', path.resolve(agentDir), '--bin-dir', bin, ...(approve ? ['--approve'] : [])];
        const ghTool = prerequisiteResult?.tools.find((tool) => tool.name === 'gh');
        const ghExecutable = ghTool?.installPath ?? 'gh';
        const authArgs = [ghExecutable, 'auth', 'login', '--hostname', 'github.com'];
        return bootstrapResponse(false, 'AUTH_REQUIRED', 'Private setup repository access is unavailable. Complete the GitHub authentication handoff, then resume bootstrap.', {
          repository: destination,
          packageVersion, ...urlFields(),
          prerequisites: prerequisiteResult?.tools ?? [],
          authentication: {
            required: true,
            cliAvailable: ghAvailable,
            command: authArgs.join(' '),
            commandArgs: authArgs,
            credentialHandling: 'Pi Sync does not request, print, or store credentials',
          },
          resumeArgs,
        });
      }
      authenticationMethod = 'github-cli';
    }
    const parent = path.dirname(destination);
    await fs.mkdir(parent, { recursive: true });
    stagingRoot = await fs.mkdtemp(path.join(parent, '.pi-sync-bootstrap-'));
    checkout = path.join(stagingRoot, 'checkout');
    const cloneEnv = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
    // The GitHub CLI branch is only reached when remote.githubSlug was
    // present (gh authentication is only probed for GitHub slugs), so the
    // slug is defined whenever the github-cli method is selected.
    const clone = authenticationMethod === 'git'
      ? await runCommand(await gitExecutable(), ['clone', '--quiet', '--', remote.value, checkout], cloneEnv)
      : await runCommand('gh', ['repo', 'clone', remote.githubSlug as string, checkout], cloneEnv);
    if (clone.status !== 0) {
      return bootstrapResponse(false, 'FETCH_FAILED',
        authenticationMethod === 'git' ? 'GitHub access was detected but cloning the setup repository failed' : 'GitHub CLI authentication was detected but it could not fetch the setup repository',
        { repository: destination, packageVersion, ...urlFields() });
    }
    setup = await validateRepository(checkout);
  }
  try {
    const prerequisites = await inspectRequiredTools(setup.requiredTools, { binDir: bin });
    if (!prerequisites.ok) return bootstrapResponse(false, 'PREREQUISITE_INSTALL_REQUIRED',
      'One or more required setup tools are unavailable. Resolve the listed handoff before applying the setup.', {
        repository: destination, packageVersion, prerequisites: prerequisites.tools, ...urlFields(),
        missingPrerequisites: prerequisites.tools.filter((tool) => tool.status === 'failed'),
      });

    const declaration = await refreshBundledResources(checkout);
    if (!declaration.ok) return bootstrapResponse(false, 'RESOURCE_COLLISION', 'A bundled pi-sync resource conflicts with existing setup repository content; no bundled resource was changed', {
      repository: destination, packageVersion, collision: declaration.collision, ...urlFields(),
    });

    await validateRepository(checkout);
    const plan = await runPiSync('plan', checkout, path.resolve(agentDir));
    if (plan.status !== 0 || !plan.output.ok) {
      const refreshed = declaration.actions.some((action) => action.action !== 'already-current');
      return bootstrapResponse(false, 'APPLY_CONFLICT',
        `Bootstrap plan found a collision or conflict; existing local content was left untouched${refreshed ? ' The setup repository was already refreshed to the executing package\'s bundled resources; resolve the conflict and rerun bootstrap.' : ''}`, {
        repository: destination, packageVersion, ...urlFields(),
        bundledResources: declaration.actions, plan: plan.output,
      });
    }
    if (checkout !== destination) {
      if (await fs.lstat(destination).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))) {
        return bootstrapResponse(false, 'REPOSITORY_PATH_COLLISION', 'Setup repository destination appeared during bootstrap; no content was replaced', { repository: destination, packageVersion, ...urlFields() });
      }
      await fs.rename(checkout, destination);
    }
    const applied = await runPiSync('apply', destination, path.resolve(agentDir), approve);
    const succeeded = applied.status === 0 && applied.output.ok;
    return bootstrapResponse(succeeded, succeeded ? undefined : 'APPLY_CONFLICT',
      succeeded ? undefined : 'Bootstrap apply did not complete cleanly; inspect the structured apply result and resume after resolving it', {
        repository: destination, authenticationMethod, prerequisites: prerequisites.tools, ...urlFields(),
        packageVersion,
        bundledResources: declaration.actions,
        apply: applied.output,
      });
  } finally {
    if (stagingRoot) await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}