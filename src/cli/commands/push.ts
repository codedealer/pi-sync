import fs from 'node:fs/promises';
import path from 'node:path';
import { GITATTRIBUTES_FILE, LOCK_FILE, MANIFEST_FILE, RESOURCE_RULES, isRecord, type RepositoryDeclarations } from '../manifest.js';
import os from 'node:os';
import { gitResult } from '../process.js';
import { findLikelySecrets, findLikelySecretsInText } from '../resource-operations.js';

// Error metadata typed at the push seam: the entry point maps `errorCode`
// to the existing exit-status and JSON error envelope behavior.
interface PushBlockedError extends Error {
  errorCode?: string;
  details?: unknown;
}

// One managed change in the push report: a staged working-tree change
// (status like `A`/`M`/`D`) or a previously committed managed path
// (status `committed`, with its commit id).
export interface PushChange {
  status: string;
  path: string;
  commit?: string;
}

export interface PushInput {
  repo: string;
  declarations: RepositoryDeclarations;
  // Preview mode is selected with --dry-run; otherwise the managed-only commit and fast-forward push run.
  publish?: boolean;
  // Optional subject for the new managed-only commit this run creates,
  // passed as a process argument. It never rewrites existing commits and
  // has no effect when no new commit is created.
  message?: string;
}

export interface PushOutput {
  apiVersion: 2;
  command: 'push';
  ok: true;
  exitCode: 0;
  repository: string;
  branch: string;
  upstream: string;
  mode: 'preview' | 'published';
  changes: PushChange[];
  // Preview mode.
  patch?: string;
  commitRequired?: boolean;
  publicationAuthorized?: boolean;
  // Published mode.
  commit?: string | null;
  // The subject used (preview: to be used) for the new managed-only commit
  // this run creates. Absent when no new commit is planned or created.
  commitMessage?: string;
  forcePush?: boolean;
  note?: string;
}

function gitFailure(message: string, details: Record<string, unknown> = {}): PushBlockedError {
  const error: PushBlockedError = new Error(message);
  error.errorCode = 'PUSH_BLOCKED';
  error.details = { message, ...details };
  return error;
}

async function requireGit(repo: string, args: string[], message: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const result = await gitResult(repo, args, extraEnv);
  if (result.status !== 0) throw gitFailure(message, { gitStatus: result.status });
  return result.output;
}

function managedGitPath(relative: string, resourceSources: string[]) {
  return relative === MANIFEST_FILE || relative === LOCK_FILE || relative === GITATTRIBUTES_FILE || resourceSources.some((source) => relative === source || relative.startsWith(`${source}/`));
}

// Returns the resource sources declared in the setup manifest at the given
// commit, or an empty list when that commit predates the manifest. Malformed
// manifests at ahead commits fail closed so they are reconciled manually.
async function managedSourcesAtCommit(repo: string, ref: string): Promise<string[]> {
  const listed = await gitResult(repo, ['ls-tree', ref, '--', MANIFEST_FILE]);
  if (listed.status !== 0) throw gitFailure('Could not inspect the setup manifest at an ahead commit; push stopped safely', { ref, gitStatus: listed.status });
  if (!listed.output) return [];
  const shown = await gitResult(repo, ['show', `${ref}:${MANIFEST_FILE}`]);
  if (shown.status !== 0) throw gitFailure('Could not read the setup manifest at an ahead commit; push stopped safely', { ref, gitStatus: shown.status });
  let manifest;
  try { manifest = JSON.parse(shown.output); } catch {
    throw gitFailure('The setup manifest at an ahead commit is not valid JSON; reconcile the branch manually before pushing', { ref });
  }
  if (!isRecord(manifest) || !Array.isArray(manifest.resources)) {
    throw gitFailure('The setup manifest at an ahead commit is malformed; reconcile the branch manually before pushing', { ref });
  }
  return manifest.resources.filter((item: any) => isRecord(item) && typeof item.source === 'string').map((item: any) => item.source);
}

function parseNameStatus(output: string): PushChange[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const changes: PushChange[] = [];
  for (let i = 0; i < fields.length; i += 2) changes.push({ status: fields[i], path: fields[i + 1] });
  return changes;
}

// Validates the repository state as of a single commit: the manifest and
// lockfile at that commit must form a valid, applyable setup repository and
// every declared resource source must exist in that commit's tree with the
// correct file/directory shape. This makes an intermediate ahead commit that
// leaves the repository broken (for example, managed content deleted without
// a matching manifest update) unpublishable even when a later commit repairs
// the state and HEAD itself validates. Commits that predate the manifest are
// accepted, mirroring managedSourcesAtCommit.
async function validateAheadCommitTree(repo: string, commit: string): Promise<void> {
  // -t includes directory entries: without it the recursive listing contains
  // only blobs, so a valid directory resource source would look missing.
  const treeResult = await gitResult(repo, ['ls-tree', '-r', '-t', '-z', commit]);
  if (treeResult.status !== 0) throw gitFailure('Could not inspect the tree of a local commit ahead of upstream; push stopped safely', { commit, gitStatus: treeResult.status });
  const tree = new Map<string, string>();
  for (const entry of treeResult.stdout.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const meta = entry.slice(0, tab).split(' ');
    tree.set(entry.slice(tab + 1), meta[0]);
  }
  if (!tree.has(MANIFEST_FILE)) return;
  if (!tree.has(LOCK_FILE)) throw gitFailure('The setup lockfile is missing at an ahead commit; reconcile the branch manually before pushing', { commit });
  const manifestText = (await gitResult(repo, ['show', `${commit}:${MANIFEST_FILE}`])).output;
  let manifest;
  try { manifest = JSON.parse(manifestText); } catch {
    throw gitFailure('The setup manifest at an ahead commit is not valid JSON; reconcile the branch manually before pushing', { commit });
  }
  if (!isRecord(manifest) || manifest.schemaVersion !== 1 || !Array.isArray(manifest.resources) || !Array.isArray(manifest.dependencies)) {
    throw gitFailure('The setup manifest at an ahead commit is invalid; reconcile the branch manually before pushing', { commit });
  }
  for (const [index, item] of manifest.resources.entries()) {
    if (!isRecord(item) || typeof item.type !== 'string' || typeof item.source !== 'string' || typeof item.target !== 'string') {
      throw gitFailure(`The setup manifest at an ahead commit has an invalid resource entry (resources[${index}]); reconcile the branch manually before pushing`, { commit });
    }
    const rule = RESOURCE_RULES[item.type];
    if (!rule) throw gitFailure(`The setup manifest at an ahead commit declares an unsupported resource type: ${item.type}`, { commit });
    const mode = tree.get(item.source);
    const isBlob = mode !== undefined && mode.startsWith('100');
    // A directory exists when the tree lists a directory entry at the exact
    // path, or when at least one blob lives under the path prefix.
    const isDirectory = mode === '040000' || [...tree.keys()].some((key) => key.startsWith(`${item.source}/`));
    if (!isBlob && !isDirectory) {
      throw gitFailure(`The setup manifest at an ahead commit declares a resource source that is missing from that commit's tree: ${item.source}`, { commit });
    }
    if (rule.shape === 'file' && !isBlob) throw gitFailure(`The resource source at an ahead commit must be a file: ${item.source}`, { commit });
    if (rule.shape === 'directory' && !isDirectory) throw gitFailure(`The resource source at an ahead commit must be a directory: ${item.source}`, { commit });
  }
  const lockText = (await gitResult(repo, ['show', `${commit}:${LOCK_FILE}`])).output;
  let lock;
  try { lock = JSON.parse(lockText); } catch {
    throw gitFailure('The setup lockfile at an ahead commit is not valid JSON; reconcile the branch manually before pushing', { commit });
  }
  if (!isRecord(lock) || lock.schemaVersion !== 1 || !Array.isArray(lock.packages)) {
    throw gitFailure('The setup lockfile at an ahead commit is invalid; reconcile the branch manually before pushing', { commit });
  }
  const dependencyIdentity = (item: unknown): string | null => isRecord(item) && item.type === 'npm' && typeof item.name === 'string' ? `npm:${item.name}`
    : isRecord(item) && item.type === 'github' && typeof item.repository === 'string' ? `github:${item.repository}` : null;
  const declared = new Set<string>();
  for (const [index, dep] of manifest.dependencies.entries()) {
    const identity = dependencyIdentity(dep);
    if (!identity || declared.has(identity)) {
      throw gitFailure(`The setup manifest at an ahead commit has an invalid or duplicate dependency (dependencies[${index}]); reconcile the branch manually before pushing`, { commit });
    }
    declared.add(identity);
  }
  const locked = new Set<string>();
  for (const [index, item] of lock.packages.entries()) {
    const identity = dependencyIdentity(item);
    if (!identity || !declared.has(identity) || locked.has(identity)) {
      throw gitFailure(`The setup lockfile at an ahead commit does not match the declared dependencies (packages[${index}]); reconcile the branch manually before pushing`, { commit });
    }
    locked.add(identity);
  }
  const missing = [...declared].filter((key) => !locked.has(key));
  if (missing.length) throw gitFailure(`The setup lockfile at an ahead commit is missing exact pins for declared dependencies: ${missing.join(', ')}`, { commit });
}

// The managed-only push workflow: it previews the managed-only commit, then
// by default stages and commits only managed paths (manifest, lockfile,
// declared resource sources, and deletions of previously managed paths),
// publishes already-committed managed-only ahead commits, and performs an
// ordinary fast-forward push. Every safeguard (secret review, unrelated
// commits, remote divergence, ignored paths, ahead-commit tree validation,
// push rejection) fails closed with a PUSH_BLOCKED error, preserving local
// state.
export async function runPush({ repo, declarations, publish = false, message }: PushInput): Promise<PushOutput> {
  const commitMessage = message ?? 'pi-sync: publish managed setup';
  const resourceSources = declarations.resources.map((item) => item.source);
  for (const managedFile of [MANIFEST_FILE, LOCK_FILE]) {
    const bytes = await fs.readFile(path.join(repo, managedFile));
    if (!bytes.includes(0)) {
      const findings = findLikelySecretsInText(bytes.toString('utf8'), managedFile);
      if (findings.length) throw gitFailure('Managed setup metadata contains suspected credential material; review and remove it before push', { reviewRequired: findings });
    }
  }
  for (const resource of declarations.resources) {
    const findings = await findLikelySecrets(resource.sourcePath, resource.source);
    if (findings.length) throw gitFailure('Managed resources contain suspected credential material; review and remove it before push', { reviewRequired: findings });
  }

  const top = await requireGit(repo, ['rev-parse', '--show-toplevel'], 'Push requires a Git working tree');
  if (path.resolve(top) !== path.resolve(repo)) throw gitFailure('The setup repository path must be the root of its Git working tree', { repository: repo, gitRoot: top });
  const branch = await requireGit(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 'Push requires a checked-out branch (detached HEAD is not supported)');
  const upstream = await requireGit(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 'Push requires a configured upstream branch');
  const slash = upstream.indexOf('/');
  if (slash < 1 || slash === upstream.length - 1) throw gitFailure('The configured upstream branch could not be resolved', { upstream });
  const remote = upstream.slice(0, slash);

  const fetched = await gitResult(repo, ['fetch', '--quiet', remote]);
  if (fetched.status !== 0) throw gitFailure('Could not check the upstream branch; no commit or push was attempted', { upstream, gitStatus: fetched.status });
  const counts = await requireGit(repo, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`], 'Could not compare the local branch with its upstream');
  const [ahead, behind] = counts.split(/\s+/).map(Number);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) throw gitFailure('Git returned an invalid upstream comparison', { upstream });
  if (behind > 0) throw gitFailure('The upstream has advanced; reconcile the remote changes before pushing (Pi Sync will not merge or rewrite history)', { upstream, ahead, behind });

  const allowed = (relative: string) => managedGitPath(relative, resourceSources);
  let existingAheadChanges: PushChange[] = [];
  if (ahead > 0) {
    const commits = (await requireGit(repo, ['rev-list', '--reverse', `${upstream}..HEAD`], 'Could not inspect local commits ahead of upstream')).split(/\r?\n/).filter(Boolean);
    for (const commit of commits) {
      const parentFields = (await requireGit(repo, ['rev-list', '--parents', '-n', '1', commit], 'Could not inspect a local commit ahead of upstream')).trim().split(/\s+/);
      if (parentFields.length > 2) throw gitFailure('Merge commits ahead of upstream require manual reconciliation before pushing', { upstream, ahead, commit });
      const output = await requireGit(repo, ['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', commit], 'Could not inspect a local commit ahead of upstream');
      const paths = output.split('\0').filter(Boolean);
      if (!paths.length) throw gitFailure('An empty local commit is ahead of upstream; reconcile the branch before pushing', { upstream, ahead, commit });
      // Validate the commit against the manifest as of that commit, the
      // manifest before the commit (its parent), and the current managed set.
      // Together these cover commits that add, edit, or remove managed paths,
      // including removal commits whose deleted paths the current manifest no
      // longer manages, while genuinely unrelated paths still stop the push.
      const commitSources = await managedSourcesAtCommit(repo, commit);
      const parentSources = parentFields.length > 1 ? await managedSourcesAtCommit(repo, parentFields[1]) : [];
      const commitAllowed = (relative: string) => managedGitPath(relative, [...new Set([...resourceSources, ...commitSources, ...parentSources])]);
      const unrelated = paths.filter((item) => !commitAllowed(item));
      if (unrelated.length) throw gitFailure('The branch contains unrelated local commits; reconcile them before pushing', { upstream, ahead, commit, unrelatedPaths: unrelated });
      // The commit itself must be a valid repository state, not just a set of
      // managed paths: an intermediate commit that leaves the repository broken
      // (for example, managed content deleted without a manifest update) is
      // rejected even when a later commit repairs it.
      await validateAheadCommitTree(repo, commit);
      for (const item of paths) {
        const ignored = await gitResult(repo, ['check-ignore', '--no-index', '--quiet', '--', path.resolve(repo, ...item.split('/'))]);
        if (ignored.status === 0) throw gitFailure('A local commit contains an ignored path; reconcile it manually before pushing', { upstream, path: item, commit });
        if (ignored.status !== 1) throw gitFailure('Could not determine whether an ahead-commit path is ignored; push stopped safely', { path: item, commit });
      }
      existingAheadChanges.push(...paths.map((item) => ({ status: 'committed', path: item, commit })));
    }
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-push-index-'));
  const indexFile = path.join(tempDir, 'index');
  const hooksPath = path.join(tempDir, 'hooks');
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await fs.mkdir(hooksPath);
    await requireGit(repo, ['read-tree', 'HEAD'], 'Could not prepare an isolated Git index', env);
    // A removal is published as a deletion of a previously managed path: the
    // current manifest no longer lists the source, but HEAD still does. Track
    // those sources separately so deletions of them can be staged, while
    // untracked content is still only accepted for currently managed paths.
    const headSources = await managedSourcesAtCommit(repo, 'HEAD');
    const removedSources = headSources.filter((source) => !resourceSources.includes(source));
    const removedSourcePath = (relative: string) => removedSources.some((source) => relative === source || relative.startsWith(`${source}/`));
    const pathspecs = [MANIFEST_FILE, LOCK_FILE, GITATTRIBUTES_FILE, ...resourceSources, ...removedSources].map((item) => `:(top,literal)${item}`);
    const currentPathspecs = [MANIFEST_FILE, LOCK_FILE, GITATTRIBUTES_FILE, ...resourceSources].map((item) => `:(top,literal)${item}`);
    const tracked = await requireGit(repo, ['ls-files', '--cached', '-z', '--', ...pathspecs], 'Could not enumerate managed files', env);
    const untracked = await requireGit(repo, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...currentPathspecs], 'Could not enumerate managed files', env);
    const candidates = [...new Set([...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean))];
    const stage: string[] = [];
    for (const item of candidates) {
      if (!allowed(item) && !removedSourcePath(item)) continue;
      const ignored = await gitResult(repo, ['check-ignore', '--no-index', '--quiet', '--', path.resolve(repo, ...item.split('/'))]);
      if (ignored.status === 0) continue;
      if (ignored.status !== 1) throw gitFailure('Could not determine whether a managed file is ignored; push stopped safely', { path: item });
      stage.push(item);
    }
    for (const item of stage) await requireGit(repo, ['add', '--all', '--', `:(top,literal)${item}`], `Could not stage managed path: ${item}`, env);
    const staged = await requireGit(repo, ['diff', '--cached', '--name-status', '--no-renames', '-z'], 'Could not preview the isolated commit', env);
    let changes = parseNameStatus(staged);
    // Previously managed paths are publishable only as deletions; re-adding
    // content under a removed source without re-declaring it is not.
    const stagedAllowed = (item: PushChange) => allowed(item.path) || (item.status === 'D' && removedSourcePath(item.path));
    const unrelated = changes.filter((item) => !stagedAllowed(item)).map((item) => item.path);
    if (unrelated.length) throw gitFailure('The isolated commit contains a path outside the managed allowlist', { unrelatedPaths: unrelated });
    changes = [...existingAheadChanges, ...changes];

    const cachedDiff = await gitResult(repo, ['diff', '--cached', '--quiet'], env);
    if (cachedDiff.status !== 0 && cachedDiff.status !== 1) throw gitFailure('Could not inspect staged managed changes', { gitStatus: cachedDiff.status });
    const commitRequired = cachedDiff.status === 1;
    const diffResult = await gitResult(repo, ['diff', '--cached', '--no-ext-diff', '--binary', upstream], env);
    if (diffResult.status !== 0) throw gitFailure('Could not render the managed-only commit preview', { gitStatus: diffResult.status });
    const patch = diffResult.stdout;
    const patchFindings = findLikelySecretsInText(patch, 'staged managed patch');
    if (patchFindings.length) throw gitFailure('Publishable managed changes contain suspected credential material; review and remove it before push', { reviewRequired: patchFindings });
    if (!publish) return { apiVersion: 2, command: 'push', ok: true, exitCode: 0, repository: repo, branch, upstream,
      mode: 'preview', changes, patch, commitRequired, publicationAuthorized: false,
      ...(commitRequired ? { commitMessage } : {}),
      note: 'Only these managed paths can be committed; rerun without --dry-run to commit and push.' };

    if (commitRequired) {
      const committedPaths = changes.filter((item) => item.status !== 'committed').map((item) => item.path);
      const commitResult = await gitResult(repo, ['-c', `core.hooksPath=${hooksPath}`, 'commit', '-m', commitMessage], env);
      if (commitResult.status !== 0) throw gitFailure('Could not create the managed-only commit; working-tree and index changes were preserved', { changes, gitStatus: commitResult.status });
      // The alternate index isolates unrelated staging. Rebase only the committed paths
      // in the user's index onto the new HEAD, leaving every unrelated staged change intact.
      for (const item of committedPaths) {
        const reset = await gitResult(repo, ['reset', '--quiet', 'HEAD', '--', `:(top,literal)${item}`]);
        if (reset.status !== 0) throw gitFailure('Managed commit was created, but the normal Git index could not be refreshed; no local changes were discarded', { changes, gitStatus: reset.status });
      }
    }
    if (!changes.length) return { apiVersion: 2, command: 'push', ok: true, exitCode: 0, repository: repo, branch, upstream,
      mode: 'published', changes: [], commit: null, note: 'No managed changes or managed-only commits were available to push.' };

    const pushed = await gitResult(repo, ['push', '--porcelain', remote, `HEAD:${upstream.slice(slash + 1)}`]);
    if (pushed.status !== 0) throw gitFailure('The ordinary fast-forward push was rejected; local managed changes and commits were preserved', {
      upstream, changes, gitStatus: pushed.status,
    });
    const commit = await requireGit(repo, ['rev-parse', 'HEAD'], 'Push succeeded but the local commit could not be identified');
    return { apiVersion: 2, command: 'push', ok: true, exitCode: 0, repository: repo, branch, upstream,
      mode: 'published', changes,
      commit, forcePush: false,
      ...(commitRequired ? { commitMessage } : {}) };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}