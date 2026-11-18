import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectRequiredTools, type PrerequisitesResult, type PrerequisiteTool } from '../../prerequisites.js';
import { MANIFEST_FILE, pathsOverlap, validateRepository, type RepositoryDeclarations } from '../manifest.js';
import { runCommand } from '../process.js';
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

type BundledDeclarationResult =
  | { ok: false; collision: BundledCollision }
  | { ok: true; added: boolean; addedResources: { type: string; source: string; target: string }[] };

interface PiSyncSubprocessResult {
  status: number;
  output: any;
}

export interface BootstrapInput {
  repoUrl: string;
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
  | 'APPLY_CONFLICT';

export interface BootstrapOutput {
  apiVersion: 1;
  command: 'bootstrap';
  ok: boolean;
  errorCode: BootstrapErrorCode | undefined;
  error: string | undefined;
  exitCode: number;
  repository: string;
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
  bundledResources?: { type: string; source: string; target: string; action?: 'declared-and-applied' | 'applied' }[];
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

function bootstrapResponse(ok: boolean, errorCode: BootstrapErrorCode | undefined, error: string | undefined, extra: { repository: string } & Partial<Omit<BootstrapOutput, 'apiVersion' | 'command' | 'ok' | 'errorCode' | 'error' | 'exitCode' | 'repository'>>): BootstrapOutput {
  return { apiVersion: 1 as const, command: 'bootstrap', ok, errorCode, error, exitCode: ok ? 0 : OPERATION_ERROR, ...extra };
}

async function installBundledResources(repo: string): Promise<BundledDeclarationResult> {
  const manifestPath = path.join(repo, MANIFEST_FILE);
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  const declarations = await validateRepository(repo);
  const bundled: BundledResource[] = [
    { type: 'skill', source: 'resources/skills/pi-sync', target: 'skills/pi-sync', root: BUNDLED_SKILL },
    { type: 'extension', source: 'resources/extensions/pi-sync', target: 'extensions/pi-sync', root: BUNDLED_EXTENSION },
  ];
  // Fail before materializing anything: a collision on any bundled resource
  // must not leave partially declared repository content behind.
  const toAdd: BundledResource[] = [];
  for (const item of bundled) {
    if (declarations.resources.some((resource) => resource.source === item.source && resource.target === item.target)) continue;
    const collision = declarations.resources.find((resource) => pathsOverlap(resource.target, item.target) || pathsOverlap(resource.source, item.source));
    if (collision) return { ok: false, collision: { source: collision.source, target: collision.target, bundled: { type: item.type, source: item.source, target: item.target } } };
    const sourcePath = path.join(repo, ...item.source.split('/'));
    const existingSource = await fs.lstat(sourcePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existingSource) return { ok: false, collision: { source: item.source, target: item.target, bundled: { type: item.type, source: item.source, target: item.target }, reason: 'setup repository source path already exists and is not declared as this resource' } };
    const info = await fs.lstat(item.root).catch((error) => { throw new Error(`Bundled pi-sync ${item.type} is unavailable: ${error.message}`); });
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Bundled pi-sync ${item.type} is not a real directory`);
    toAdd.push(item);
  }
  if (!toAdd.length) return { ok: true, added: false, addedResources: [] };
  const created: string[] = [];
  try {
    for (const item of toAdd) {
      const sourcePath = path.join(repo, ...item.source.split('/'));
      await ensureRealDirectory(repo, path.posix.dirname(item.source), true);
      await fs.mkdir(sourcePath);
      created.push(sourcePath);
      for (const entry of await fs.readdir(item.root)) {
        await fs.cp(path.join(item.root, entry), path.join(sourcePath, entry), { recursive: true, errorOnExist: true, force: false });
      }
    }
    const nextManifest = { ...manifest, resources: [...manifest.resources, ...toAdd.map(({ type, source, target }) => ({ type, source, target }))] };
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
  } catch (error) {
    for (const directory of created) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await validateRepository(repo);
  return { ok: true, added: true, addedResources: toAdd.map(({ type, source, target }) => ({ type, source, target })) };
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
// declares and materializes the bundled pi-sync skill and extension, then
// reaches the repository's desired local installation state through the
// ordinary plan/apply commands. A rerun with the same command resumes from an
// existing valid setup repository instead of requiring an empty path. Pi Sync
// never requests, prints, or stores credentials.
export async function runBootstrap({ repoUrl, repoDir, agentDir, binDir, approve = false }: BootstrapInput): Promise<BootstrapOutput> {
  const remote = validateBootstrapUrl(repoUrl);
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
      return bootstrapResponse(false, 'REPOSITORY_PATH_COLLISION', 'Setup repository destination exists and is not a directory; choose an empty path', { repository: destination });
    }
    // A previous bootstrap (or the user) may already have placed the setup
    // repository at the destination. Resume from it instead of requiring an
    // empty path so a failed first run is rerun with the same command.
    setup = await validateRepository(destination).catch(() => null);
    if (!setup) {
      return bootstrapResponse(false, 'REPOSITORY_PATH_COLLISION', 'Setup repository destination already exists but is not a valid Pi Sync setup repository; choose an empty path', { repository: destination });
    }
    checkout = destination;
    authenticationMethod = null;
  } else {
    const access = await runCommand('git', ['ls-remote', remote.value]);
    if (access.status !== 0) {
      let ghAuthenticated = false;
      let ghAvailable = false;
      let prerequisiteResult: PrerequisitesResult | null = null;
      if (remote.githubSlug) {
        prerequisiteResult = await inspectRequiredTools(['gh'], { binDir: bin });
        ghAvailable = prerequisiteResult.ok;
        if (!ghAvailable) return bootstrapResponse(false, 'PREREQUISITE_INSTALL_REQUIRED',
          'GitHub CLI is required for this authentication handoff but could not be installed automatically.', {
            repository: destination, prerequisites: prerequisiteResult.tools,
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
      ? await runCommand('git', ['clone', '--quiet', '--', remote.value, checkout], cloneEnv)
      : await runCommand('gh', ['repo', 'clone', remote.githubSlug as string, checkout], cloneEnv);
    if (clone.status !== 0) {
      return bootstrapResponse(false, 'FETCH_FAILED',
        authenticationMethod === 'git' ? 'GitHub access was detected but cloning the setup repository failed' : 'GitHub CLI authentication was detected but it could not fetch the setup repository',
        { repository: destination });
    }
    setup = await validateRepository(checkout);
  }
  try {
    const prerequisites = await inspectRequiredTools(setup.requiredTools, { binDir: bin });
    if (!prerequisites.ok) return bootstrapResponse(false, 'PREREQUISITE_INSTALL_REQUIRED',
      'One or more required setup tools are unavailable. Resolve the listed handoff before applying the setup.', {
        repository: destination, prerequisites: prerequisites.tools,
        missingPrerequisites: prerequisites.tools.filter((tool) => tool.status === 'failed'),
      });

    const declaration = await installBundledResources(checkout);
    if (!declaration.ok) return bootstrapResponse(false, 'RESOURCE_COLLISION', 'A bundled pi-sync resource conflicts with existing setup repository content; no installation was performed', {
      repository: destination, collision: declaration.collision,
    });

    await validateRepository(checkout);
    const plan = await runPiSync('plan', checkout, path.resolve(agentDir));
    if (plan.status !== 0 || !plan.output.ok) {
      return bootstrapResponse(false, 'APPLY_CONFLICT', 'Bootstrap plan found a collision or conflict; existing local content was left untouched', {
        repository: destination,
        bundledResources: [
          { type: 'skill', source: 'resources/skills/pi-sync', target: 'skills/pi-sync' },
          { type: 'extension', source: 'resources/extensions/pi-sync', target: 'extensions/pi-sync' },
        ], plan: plan.output,
      });
    }
    if (checkout !== destination) {
      if (await fs.lstat(destination).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))) {
        return bootstrapResponse(false, 'REPOSITORY_PATH_COLLISION', 'Setup repository destination appeared during bootstrap; no content was replaced', { repository: destination });
      }
      await fs.rename(checkout, destination);
    }
    const applied = await runPiSync('apply', destination, path.resolve(agentDir), approve);
    return bootstrapResponse(applied.status === 0 && applied.output.ok, applied.status === 0 && applied.output.ok ? undefined : 'APPLY_CONFLICT',
      applied.status === 0 && applied.output.ok ? undefined : 'Bootstrap apply did not complete cleanly; inspect the structured apply result and resume after resolving it', {
        repository: destination, authenticationMethod, prerequisites: prerequisites.tools,
        bundledResources: [
          { type: 'skill', source: 'resources/skills/pi-sync', target: 'skills/pi-sync' },
          { type: 'extension', source: 'resources/extensions/pi-sync', target: 'extensions/pi-sync' },
        ].map((item) => ({ ...item, action: declaration.addedResources.some((added) => added.source === item.source) ? 'declared-and-applied' : 'applied' })),
        apply: applied.output,
      });
  } finally {
    if (stagingRoot) await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}