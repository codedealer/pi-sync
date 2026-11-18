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

// Matches the entry point's operation-error exit status: status and plan
// report it in the JSON output and the entry point mirrors it onto
// process.exitCode.
const OPERATION_ERROR = 1;

export interface InspectInput {
  command: 'status' | 'plan';
  repo: string;
  agentDir: string;
  declarations: RepositoryDeclarations;
  state: LocalState;
}

export interface InspectOutput {
  apiVersion: 1;
  command: 'status' | 'plan';
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

// Read-only `status` and `plan` reporting: both commands share this workflow.
// They gain the repository publish-state block (omitted when the setup
// directory is not a git working tree), the read-only sync classification
// (identical content to a `sync` preview), and the derived summary. The
// workflow never writes and takes no lock.
export async function inspectRepository({ command, repo, agentDir, declarations, state }: InspectInput): Promise<InspectOutput> {
  const plan = await buildPlan(repo, agentDir, declarations, state);
  const { actions, conflicts, staleResources } = reportBlocks(plan);
  const publishState = await repositoryPublishState(repo);
  const sync = syncClassification(plan);
  const summary = deriveStatusSummary(publishState, sync, conflicts, actions);
  return { apiVersion: 1, command, ok: conflicts.length === 0, exitCode: conflicts.length ? OPERATION_ERROR : 0,
    ...(publishState ? { repository: publishState } : {}),
    agentDirectory: agentDir, actions, conflicts, staleResources, sync, summary,
    packages: declarations.lock.packages.map((item) => ({ package: packageIdentity(item), pin: packageRevision(item), action: 'locked' })) };
}