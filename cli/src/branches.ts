import { isOperatorChange, type Limit, type LimitChange, type LimitSwitch, type PublishedLimits } from "./limits.js";

/**
 * Branch concurrency, as an instance publishes it:
 * how many branches of one fan-out or Map loop run at once (the width per
 * node), how many all runs in one process share, and whether a tenant's
 * branches run concurrently at all, with the switches that decide. An
 * older instance publishes none, and nothing here is assumed.
 */

export const BRANCH_WIDTH_KEY = "orchestration_max_branch_concurrency";
export const BRANCH_PROCESS_KEY = "orchestration_process_max_branch_inflight";
export const PARALLEL_BRANCHES_KEY = "orchestration_parallel_branches";
export const BRANCH_KEYS = [BRANCH_WIDTH_KEY, BRANCH_PROCESS_KEY, PARALLEL_BRANCHES_KEY];

export interface BranchConcurrency {
  /** Branches of one node that run at once; a node's max_concurrency above it is capped. */
  width: number | null;
  width_setting: string | null;
  /** Branch slots every run in one process shares. */
  process_ceiling: number | null;
  process_setting: string | null;
  /** Whether this tenant's branches run concurrently; null when the instance does not say. */
  parallel: boolean | null;
  /** The setting that decides: with branches off, the switch that turned them off. */
  deciding_setting: string | null;
  switches: LimitSwitch[];
  /** The switches that are off. */
  off: string[];
  /** How the tenant's switch is changed (an operator's change), where the instance publishes it. */
  change: LimitChange | null;
  docs: string | null;
}

/** The published branch concurrency among `values` (all published limits by default); undefined when there is none. */
export function branchConcurrency(published: PublishedLimits | undefined, values?: Limit[]): BranchConcurrency | undefined {
  if (!published?.published) return undefined;
  const pick = (key: string) => (values ?? published.values).find((v) => v.key === key);
  const width = pick(BRANCH_WIDTH_KEY);
  const process = pick(BRANCH_PROCESS_KEY);
  const parallel = pick(PARALLEL_BRANCHES_KEY);
  if (!width && !process && !parallel) return undefined;
  const switches = parallel?.switches ?? [];
  return {
    width: typeof width?.value === "number" ? width.value : null,
    width_setting: width?.setting ?? null,
    process_ceiling: typeof process?.value === "number" ? process.value : null,
    process_setting: process?.setting ?? null,
    parallel: typeof parallel?.value === "boolean" ? parallel.value : null,
    deciding_setting: parallel?.setting ?? null,
    switches,
    off: switches.filter((s) => !s.enabled).map((s) => s.setting),
    change: parallel?.change ?? null,
    docs: (parallel ?? width ?? process)?.docs || null,
  };
}

/**
 * Who turns a switch back on, and how: the tenant's flag with the limit's
 * published change or in the Admin, the platform's with a deploy.
 */
export function switchOnText(item: LimitSwitch, change: LimitChange | null): string {
  if (item.source !== "tenant") return `the instance operator turns it on with ${item.setting} (a deploy)`;
  if (change && isOperatorChange(change)) {
    return (
      `an operator turns it on in the Admin (Configure › Feature Flags), or with cavelon limits set ${PARALLEL_BRANCHES_KEY} on ` +
      "--tenant <tenant> --confirm and a Platform-mode token"
    );
  }
  if (change) return `a tenant admin turns it on with cavelon limits set ${PARALLEL_BRANCHES_KEY} on --confirm`;
  return "the instance operator turns it on for this tenant in the Admin (Configure › Feature Flags)";
}

/** The switches that keep branches in sequence, in words: "feature_flags.X is off; the instance operator turns it on …". */
export function offText(branches: BranchConcurrency): string {
  const off = branches.switches.filter((s) => !s.enabled);
  if (!off.length) return branches.deciding_setting ? `${branches.deciding_setting} is off` : "a switch is off";
  return off.map((s) => `${s.setting} is off (${switchOnText(s, branches.change)})`).join("; ");
}

/** The lines `cavelon limits` prints. */
export function branchConcurrencyText(branches: BranchConcurrency): string {
  const lines: string[] = [];
  if (branches.width !== null) lines.push(`  width per node: ${branches.width} (${branches.width_setting}); a node's max_concurrency above it is capped`);
  if (branches.process_ceiling !== null) {
    lines.push(`  per process: ${branches.process_ceiling} (${branches.process_setting}), shared by every run in one worker or API process`);
  }
  if (branches.parallel === true) {
    const named = branches.switches.length ? ` (${branches.switches.map((s) => s.setting).join(" and ")} are on)` : "";
    lines.push(`  concurrent: yes${named}`);
  } else if (branches.parallel === false) {
    lines.push(`  concurrent: no, fan-outs and Map loops run one branch after another (same result, slower): ${offText(branches)}`);
  }
  return lines.join("\n");
}
