import { packageIdentity, packageRevision, type RepositoryDeclarations } from '../manifest.js';
import {
  buildPlan,
  deriveStatusSummary,
  repositoryPublishState,
  reportBlocks,
  syncClassification,
  type LocalState,
  type PlanOutputAction,
  type PublishState,
  type StaleReportItem,
  type StatusSummary,
  type SyncClassification,
} from '../reconciliation.js';

// Matches the entry point's operation-error exit status: status
// report it in the JSON output and the entry point mirrors it onto
// process.exitCode.
const OPERATION_ERROR = 1;

export interface InspectInput {
  command: 'status';
  repo: string;
  agentDir: string;
  declarations: RepositoryDeclarations;
  state: LocalState;
  // Refresh the configured upstream before deriving ahead/behind and the
  // remote-pending values (default true). `--no-fetch` turns this off for
  // consumers that accept last-known tracking refs.
  fetchUpstream?: boolean;
}

export interface InspectOutput {
  apiVersion: 2;
  command: 'status';
  ok: boolean;
  exitCode: number;
  repository?: PublishState;
  agentDirectory: string;
  actions: PlanOutputAction[];
  conflicts: PlanOutputAction[];
  staleResources: StaleReportItem[];
  sync: SyncClassification;
  summary: StatusSummary;
  packages: { package: string; pin: string; action: string }[];
}

// Read-only `status` reporting: status is the public read-only command.
// They gain the repository publish-state block (omitted when the setup
// directory is not a git working tree), the read-only sync classification
// (identical content to a `sync` preview), and the derived summary. The
// workflow never writes and takes no lock. Upstream state is refreshed with
// a bounded fetch of the configured upstream before ahead/behind are derived
// (metadata-only; a failed fetch reports an unavailable upstream instead of
// stale tracking-ref counts).
export async function inspectRepository({ command, repo, agentDir, declarations, state, fetchUpstream = true }: InspectInput): Promise<InspectOutput> {
  const plan = await buildPlan(repo, agentDir, declarations, state);
  const { actions, conflicts, staleResources } = reportBlocks(plan);
  const publishState = await repositoryPublishState(repo, { fetch: fetchUpstream });
  const sync = syncClassification(plan);
  const summary = deriveStatusSummary(publishState, sync, conflicts, actions);
  return { apiVersion: 2, command, ok: conflicts.length === 0, exitCode: conflicts.length ? OPERATION_ERROR : 0,
    ...(publishState ? { repository: publishState } : {}),
    agentDirectory: agentDir, actions, conflicts, staleResources, sync, summary,
    packages: declarations.lock.packages.map((item) => ({ package: packageIdentity(item), pin: packageRevision(item), action: 'locked' })) };
}