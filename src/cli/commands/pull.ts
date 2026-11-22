import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gitResult } from '../process.js';
import { UPSTREAM_FETCH_TIMEOUT_MS } from '../reconciliation.js';

// Error metadata typed at the pull seam: the entry point maps `errorCode`
// onto the existing exit-status and JSON error envelope behavior
// (PULL_BLOCKED and PULL_CONFLICT are operational errors, exit 1).
interface PullBlockedError extends Error {
  errorCode?: string;
  details?: unknown;
}

function pullError(message: string, errorCode: 'PULL_BLOCKED' | 'PULL_CONFLICT', details: Record<string, unknown> = {}): PullBlockedError {
  const error: PullBlockedError = new Error(message);
  error.errorCode = errorCode;
  error.details = { message, ...details };
  return error;
}

function pullFailure(message: string, details: Record<string, unknown> = {}): PullBlockedError {
  return pullError(message, 'PULL_BLOCKED', details);
}

function pullConflict(message: string, details: Record<string, unknown> = {}): PullBlockedError {
  return pullError(message, 'PULL_CONFLICT', details);
}

// The supported workflow after the setup repository catches up with its
// upstream: reconcile the checkout with the local installation, then publish
// local managed changes. Included in successful results and in refusals so
// the JSON always points at the next step.
const NEXT_STEPS = ['pi-sync status', 'pi-sync apply'];

export interface PullInput {
  repo: string;
  apply: boolean;
}

export interface PullOutput {
  apiVersion: 2;
  command: 'pull';
  ok: boolean;
  exitCode: number;
  repository: string;
  branch: string;
  upstream: string;
  mode: 'preview' | 'applied';
  // Current, fetched upstream comparison (null-free: a failed fetch is a
  // structured refusal, never a null count).
  ahead: number;
  behind: number;
  upToDate: boolean;
  diverged: boolean;
  dirty: boolean;
  dirtyPaths: string[];
  // Paths that differ between the local branch and the fetched upstream tip.
  changedPaths: string[];
  // Applied mode only.
  fromCommit?: string;
  toCommit?: string;
  // Applied mode with local edits: the pre-pull recovery snapshot that was
  // discarded after a clean restore.
  snapshotDiscarded?: string;
  // A recovery snapshot that could not be discarded and is retained.
  snapshot?: { sha: string; ref: string; message: string };
  nextSteps: string[];
  note: string;
}

// One line of `git status --porcelain`: two status columns and the path.
interface PorcelainEntry {
  x: string;
  y: string;
  path: string;
}

function parsePorcelain(output: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  for (const line of output.split('\n')) {
    if (line.length < 4) continue;
    entries.push({ x: line[0], y: line[1], path: line.slice(3) });
  }
  return entries;
}

// Shared, re-runnable safety preconditions plus a fresh upstream comparison.
// Bare `pull` runs this after fetching, never reusing a preview's stale
// tracking refs, so the mutation decision is always made on current state.
interface CheckedState {
  branch: string;
  upstream: string;
  remote: string;
  ahead: number;
  behind: number;
  entries: PorcelainEntry[];
  changedPaths: string[];
}

async function checkRepository(repo: string): Promise<CheckedState> {
  const top = await gitResult(repo, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw pullFailure('Pull requires a Git working tree', { repository: repo });
  if (path.resolve(top.output) !== path.resolve(repo)) throw pullFailure('The setup repository path must be the root of its Git working tree', { repository: repo, gitRoot: top.output });
  const branch = await gitResult(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch.status !== 0) throw pullFailure('Pull requires a checked-out branch (detached HEAD is not supported)', { repository: repo });
  const upstream = await gitResult(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (upstream.status !== 0) throw pullFailure('Pull requires a configured upstream branch', { branch: branch.output });
  const slash = upstream.output.indexOf('/');
  if (slash < 1 || slash === upstream.output.length - 1) throw pullFailure('The configured upstream branch could not be resolved', { upstream: upstream.output });
  const remote = upstream.output.slice(0, slash);

  const merged = await gitResult(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (merged.status === 0) throw pullFailure('The repository has an unresolved merge in progress; resolve it before pulling', { branch: branch.output });

  const fetched = await gitResult(repo, ['fetch', '--quiet', remote, upstream.output.slice(slash + 1)], {}, UPSTREAM_FETCH_TIMEOUT_MS);
  if (fetched.status !== 0) throw pullFailure('Could not fetch the upstream branch; nothing was changed', { upstream: upstream.output, gitStatus: fetched.status });

  const counts = await gitResult(repo, ['rev-list', '--left-right', '--count', `HEAD...${upstream.output}`]);
  if (counts.status !== 0) throw pullFailure('Could not compare the local branch with its upstream; nothing was changed', { upstream: upstream.output, gitStatus: counts.status });
  const [ahead, behind] = counts.output.split(/\s+/).map(Number);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) throw pullFailure('Git returned an invalid upstream comparison', { upstream: upstream.output });

  const status = await gitResult(repo, ['status', '--porcelain']);
  if (status.status !== 0) throw pullFailure('Could not inspect the working tree; nothing was changed', { gitStatus: status.status });
  const entries = parsePorcelain(status.stdout);

  const changed = await gitResult(repo, ['diff', '--name-only', 'HEAD', upstream.output]);
  if (changed.status !== 0) throw pullFailure('Could not inspect the upstream changes; nothing was changed', { gitStatus: changed.status });
  const changedPaths = changed.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);

  return { branch: branch.output, upstream: upstream.output, remote, ahead, behind, entries, changedPaths };
}

// The pre-pull recovery snapshot: one `git stash` of the staged, unstaged,
// and non-ignored untracked working changes, uniquely identifiable by its
// message so a user can always find it in `git stash list`. Ignored files
// are never included.
interface PullSnapshot {
  sha: string;
  ref: string;
  message: string;
}

async function createSnapshot(repo: string): Promise<PullSnapshot> {
  const message = `pi-sync: pull snapshot ${new Date().toISOString()} ${randomUUID()}`;
  const pushed = await gitResult(repo, ['stash', 'push', '--include-untracked', '--quiet', '--message', message]);
  if (pushed.status !== 0) throw pullFailure('Could not snapshot the local changes before updating the branch; nothing was changed', { gitStatus: pushed.status, gitError: pushed.errorText });
  const sha = await gitResult(repo, ['rev-parse', '--verify', 'refs/stash']);
  const subject = await gitResult(repo, ['log', '-1', '--format=%s', 'refs/stash']);
  // The stash subject is `On <branch>: <message>`; the unique message
  // (timestamp + UUID) identifies this pull's snapshot.
  if (sha.status !== 0 || subject.status !== 0 || !subject.output.includes(message)) {
    // The stash push succeeded, so the local changes now sit in a stash and
    // the working tree is clean: report that accurately, and report the
    // snapshot's identity (message, ref, and sha when resolvable) so it can
    // be found and restored instead of claiming nothing was changed.
    throw pullFailure('The recovery snapshot could not be verified after it was created; the local changes are now in the stash and the branch was not changed', {
      snapshot: { sha: sha.status === 0 ? sha.output : undefined, ref: 'stash@{0}', message },
      recovery: [
        `Find the snapshot in \`git stash list\` as "${message}"${sha.status === 0 ? ` (sha ${sha.output})` : ''} and inspect it with \`git stash show -p\``,
        'Restore it with `git stash apply stash@{0}` to put the local changes back, then retry the pull.',
      ],
      gitStatus: sha.status === 0 ? subject.status : sha.status,
    });
  }
  return { sha: sha.output, ref: 'stash@{0}', message };
}

// Restores a snapshot with Git's native three-way behavior; Pi Sync does not
// implement a content merge algorithm. It first tries to preserve the index
// (staging) state, and when Git refuses that it retries with a plain apply
// after confirming the failed attempt left the worktree and index untouched:
// content is never lost, staging state is preserved where Git permits.
async function restoreSnapshot(repo: string, snapshot: PullSnapshot): Promise<{ clean: boolean; errorText: string }> {
  let applied = await gitResult(repo, ['stash', 'apply', '--index', snapshot.sha]);
  if (applied.status !== 0) {
    const status = await gitResult(repo, ['status', '--porcelain']);
    if (status.status === 0 && status.stdout === '') {
      // The failed --index attempt left no state behind.
      await gitResult(repo, ['reset', '--quiet', '--mixed', 'HEAD']);
      applied = await gitResult(repo, ['stash', 'apply', snapshot.sha]);
    }
}
  return { clean: applied.status === 0, errorText: applied.errorText };
}

// Drops the snapshot only when it is still the newest stash, so a user's own
// stashes are never touched: `git stash drop` accepts only stash reflog
// expressions, so the top of the list is verified against the snapshot sha.
async function dropSnapshot(repo: string, snapshot: PullSnapshot): Promise<boolean> {
  const top = await gitResult(repo, ['rev-parse', '--verify', 'refs/stash']);
  if (top.status !== 0 || top.output !== snapshot.sha) return false;
  const dropped = await gitResult(repo, ['stash', 'drop', 'stash@{0}']);
  if (dropped.status !== 0) return false;
  // The check-then-drop is not atomic (drop only accepts reflog expressions):
  // a user stash added in that window would be dropped instead, so confirm
  // after the drop that it was this snapshot that left the stash list. If the
  // top still resolves to this snapshot, the drop did not remove it and the
  // snapshot is reported as retained instead.
  const after = await gitResult(repo, ['rev-parse', '-q', '--verify', 'refs/stash']);
  return after.status !== 0 || after.output !== snapshot.sha;
}

// Status-column codes that mark an unmerged (conflicted) path.
const CONFLICT_CODES = new Set(['U', 'A', 'D', 'R', 'C', 'X']);

// The paths a failed restoration left affected, classified from structured
// Git state (never from localized Git prose): unmerged entries in the
// index/worktree, plus snapshot untracked files that now exist as tracked
// files (which Git refuses to overwrite). The collided set is the
// locale-independent signal for the untracked-collision case.
async function affectedPaths(repo: string, snapshot: PullSnapshot): Promise<{ unmerged: string[]; collided: string[] }> {
  const unmerged = new Set<string>();
  const collided = new Set<string>();
  const status = await gitResult(repo, ['status', '--porcelain']);
  if (status.status === 0) {
    for (const entry of parsePorcelain(status.stdout)) {
      if (CONFLICT_CODES.has(entry.x) && CONFLICT_CODES.has(entry.y)) unmerged.add(entry.path);
    }
  }
  const untrackedTree = await gitResult(repo, ['rev-parse', '-q', '--verify', `${snapshot.sha}^3`]);
  if (untrackedTree.status === 0) {
    const stashed = await gitResult(repo, ['ls-tree', '-r', '--name-only', '-z', `${snapshot.sha}^3`]);
    const tracked = await gitResult(repo, ['ls-files', '-z']);
    if (stashed.status === 0 && tracked.status === 0) {
      const trackedPaths = new Set(tracked.stdout.split('\0').filter(Boolean));
      for (const item of stashed.stdout.split('\0').filter(Boolean)) {
        if (trackedPaths.has(item)) collided.add(item);
      }
    }
  }
  return { unmerged: [...unmerged].sort(), collided: [...collided].sort() };
}

function recoveryGuidance(snapshot: PullSnapshot): string[] {
  return [
    'Resolve the conflicts in the working tree (see `git status`) and keep the result you want; Pi Sync does not resolve pull conflicts and does not run `apply` automatically.',
    `The pre-pull snapshot is retained as the recovery copy of your local changes: find it in \`git stash list\` as "${snapshot.message}", inspect it with \`git stash show -p ${snapshot.sha}\`, and drop it with \`git stash drop ${snapshot.sha}\` once you no longer need it.`,
  ];
}

// The pull workflow mutates by default; `--dry-run` previews the upstream
// changes and local checkout dirt (apart from the bounded, metadata-only
// fetch of the configured upstream). The mutating run re-fetches and rechecks
// before mutating, then if the branch is behind its upstream, saves the
// staged, unstaged, and non-ignored untracked working changes in a uniquely
// identifiable recovery snapshot, advances the branch to the fetched upstream
// tip using fast-forward-only semantics, and restores the snapshot with
// Git's native three-way behavior. Cleanly reconcilable changes are kept and
// only this pull's snapshot is discarded; conflicts leave Git's unresolved
// conflict state with the snapshot retained for manual recovery. It never
// merges or rewrites history, force-updates a ref, commits the restored
// changes, or silently discards a snapshot. Pulling does not touch the local
// installation; the result always guides the user to `pi-sync status` and
// `pi-sync apply` afterwards.
export async function runPull({ repo, apply }: PullInput): Promise<PullOutput> {
  const state = await checkRepository(repo);
  const dirty = state.entries.length > 0;
  const dirtyPaths = state.entries.map((entry) => entry.path);
  const upToDate = state.behind === 0;
  const diverged = state.ahead > 0 && state.behind > 0;

  if (!apply) {
    const note = diverged
      ? 'The branch has both local-only and upstream-only commits. Reconcile the branch manually; Pi Sync will not merge or rewrite history, and bare `pi-sync pull` will refuse it.'
      : upToDate
        ? state.ahead > 0
          ? 'The branch is up to date with its upstream and has local-only commits; publish them with `pi-sync push`.'
          : 'The branch is already at the upstream tip; run `pi-sync status` and `pi-sync apply` to reconcile the local installation.'
        : dirty
          ? 'The upstream has advanced and the working tree has local changes; bare `pi-sync pull` snapshots the local changes, fast-forwards the branch, and restores them with the native Git three-way merge. Genuinely conflicting edits remain for manual resolution with the recovery snapshot retained.'
          : 'The upstream has advanced and the checkout is clean; run bare `pi-sync pull` to fast-forward the branch, then run `pi-sync status` and `pi-sync apply` to reconcile the local installation.';
    return { apiVersion: 2, command: 'pull', ok: true, exitCode: 0, repository: repo,
      branch: state.branch, upstream: state.upstream, mode: 'preview',
      ahead: state.ahead, behind: state.behind, upToDate, diverged, dirty, dirtyPaths,
      changedPaths: state.changedPaths, nextSteps: NEXT_STEPS, note };
  }

  if (diverged) throw pullFailure('The branch has diverged from its upstream (local-only and upstream-only commits); reconcile it manually. Pi Sync will not merge or rewrite history', {
    branch: state.branch, upstream: state.upstream, ahead: state.ahead, behind: state.behind, nextSteps: NEXT_STEPS });
  if (upToDate) {
    // Nothing to advance, so there is nothing to snapshot: the working tree
    // is left exactly as found.
    return { apiVersion: 2, command: 'pull', ok: true, exitCode: 0, repository: repo,
      branch: state.branch, upstream: state.upstream, mode: 'applied',
      ahead: state.ahead, behind: state.behind, upToDate: true, diverged: false, dirty, dirtyPaths,
      changedPaths: [], nextSteps: NEXT_STEPS,
      note: state.ahead > 0
        ? 'The branch is up to date with its upstream; its local-only commits can be published with `pi-sync push`.'
        : 'The branch was already at the upstream tip; nothing was changed.' };
  }

  const fromCommit = await gitResult(repo, ['rev-parse', 'HEAD']);
  if (fromCommit.status !== 0) throw pullFailure('Could not identify the current commit; nothing was changed', { gitStatus: fromCommit.status });
  const snapshot = dirty ? await createSnapshot(repo) : null;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-pull-hooks-'));
  let merged: { status: number | null; errorText: string };
  try {
    await fs.mkdir(path.join(tempDir, 'hooks'));
    // Hooks are skipped exactly like the managed push commit, so they cannot
    // interfere with the fast-forward.
    merged = await gitResult(repo, ['-c', `core.hooksPath=${path.join(tempDir, 'hooks')}`, 'merge', '--ff-only', '--quiet', state.upstream]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
  if (merged.status !== 0) {
    // The branch was not advanced: restore the original working state from
    // the snapshot when possible, and retain it (reporting its recovery
    // identifier) if the restoration itself fails.
    let restored = true;
    if (snapshot) {
      const recovery = await restoreSnapshot(repo, snapshot);
      restored = recovery.clean;
      if (recovery.clean) await dropSnapshot(repo, snapshot);
    }
    throw pullFailure('The fast-forward could not be applied; the branch was not changed', {
      branch: state.branch, upstream: state.upstream, gitStatus: merged.status, gitError: merged.errorText,
      ...(snapshot ? { restored, ...(restored ? {} : { snapshot, recovery: recoveryGuidance(snapshot) }) } : {}),
    });
  }
  const toCommit = await gitResult(repo, ['rev-parse', 'HEAD']);
  if (toCommit.status !== 0) throw pullFailure('The fast-forward was applied, but the new commit could not be identified', { gitStatus: toCommit.status });

  let snapshotDiscarded: string | undefined;
  let retained: PullSnapshot | undefined;
  if (snapshot) {
    const recovery = await restoreSnapshot(repo, snapshot);
    if (!recovery.clean) {
      // Leave Git's unresolved conflict state for the user; retain the
      // snapshot and report the affected paths with recovery guidance. The
      // untracked-collision case is detected from structured Git state
      // (snapshot-untracked paths that the upstream now tracks), never from
      // localized Git prose.
      const affected = await affectedPaths(repo, snapshot);
      throw pullConflict(affected.collided.length > 0
        ? 'Pull advanced the branch, but restoring the local changes failed: untracked local file(s) collide with file(s) the upstream added; the recovery snapshot is retained'
        : 'Pull advanced the branch, but restoring the local changes left conflicts for manual resolution; Git left the conflict state in the working tree and the recovery snapshot is retained', {
        branch: state.branch, upstream: state.upstream, fromCommit: fromCommit.output, toCommit: toCommit.output,
        conflictedPaths: [...new Set([...affected.unmerged, ...affected.collided])].sort(),
        snapshot, recovery: recoveryGuidance(snapshot), nextSteps: NEXT_STEPS,
      });
    }
    if (await dropSnapshot(repo, snapshot)) {
      snapshotDiscarded = snapshot.sha;
    } else {
      retained = snapshot;
    }
  }

  const finalStatus = await gitResult(repo, ['status', '--porcelain']);
  if (finalStatus.status !== 0) throw pullFailure('The pull finished, but the working tree could not be inspected', { gitStatus: finalStatus.status });
  const finalEntries = parsePorcelain(finalStatus.stdout);
  const finalDirtyPaths = finalEntries.map((entry) => entry.path);

  return { apiVersion: 2, command: 'pull', ok: true, exitCode: 0, repository: repo,
    branch: state.branch, upstream: state.upstream, mode: 'applied',
    ahead: 0, behind: 0, upToDate: true, diverged: false, dirty: finalEntries.length > 0, dirtyPaths: finalDirtyPaths,
    changedPaths: state.changedPaths, fromCommit: fromCommit.output, toCommit: toCommit.output,
    ...(snapshotDiscarded ? { snapshotDiscarded } : {}),
    ...(retained ? { snapshot: retained } : {}),
    nextSteps: NEXT_STEPS,
    note: snapshot
      ? `The setup repository was fast-forwarded to the upstream tip and the local changes were restored from the pre-pull snapshot; ${finalEntries.length} path(s) remain dirty.${retained ? ` The recovery snapshot could not be discarded and is retained: find it in \`git stash list\` as "${retained.message}" (sha ${retained.sha}) and drop it with \`git stash drop ${retained.sha}\` once you no longer need it.` : ''} Run \`pi-sync status\` and \`pi-sync apply\` to reconcile the local installation.`
      : 'The setup repository was fast-forwarded to the upstream tip; run `pi-sync status` and `pi-sync apply` to reconcile the local installation.' };
}