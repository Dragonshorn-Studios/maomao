import {
  PIPELINE_PROMPT_STAGES,
  buildAggregatorPrompt,
  buildBriefPrompt,
  buildExplainerPrompt,
  buildInternalEscalationPrompt,
  buildRouterPrompt,
  buildStackCumulativePrompt,
  buildVerifierPrompt,
} from "./prompts.js";
import type { RoutingSignals } from "./routing/types.js";

/**
 * Job-specific fields interpolated by the stage builders. Shown on
 * `/config/prompts` so operators can read the composed template without a
 * live PR, evidence dump, or secrets. Numeric PR counters stay `1` because
 * the builders type them as numbers (`0` is the health-scan sentinel).
 */
export const PROMPT_TEMPLATE_PLACEHOLDERS = {
  repository: "{{repository}}",
  prNumber: 1,
  prTitle: "{{pr_title}}",
  author: "{{author}}",
  baseSha: "{{base_sha}}",
  headSha: "{{head_sha}}",
  sha: "{{sha}}",
  stackId: "{{stack_id}}",
  roleId: "{{role_id}}",
  roleTitle: "{{role_title}}",
  roleDescription: "{{role_description}}",
  diff: "{{diff}}",
  hunks: "{{diff_hunks}}",
  memberDiff: "{{member_diff}}",
  humanDiscussion: "{{human_discussion}}",
  reviewerEvidence: "{{reviewer_evidence}}",
  priorFindings: "{{prior_findings}}",
  firstPass: "{{first_pass_findings}}",
  routingReason: "{{routing_reason}}",
  operatorQuestion: "{{operator_question}}",
  changeKind: "{{change_kind}}",
  language: "{{language}}",
  path: "{{path}}",
  fingerprint: "{{fingerprint}}",
  severity: "{{severity}}",
  findingSummary: "{{finding_summary}}",
} as const;

const PLACEHOLDER_SIGNALS: RoutingSignals = {
  fileCount: 0,
  addedLines: 0,
  removedLines: 0,
  languages: [PROMPT_TEMPLATE_PLACEHOLDERS.language],
  families: [],
  hardRiskFamilies: [],
  files: [
    {
      path: PROMPT_TEMPLATE_PLACEHOLDERS.path,
      language: PROMPT_TEMPLATE_PLACEHOLDERS.language,
      added: 0,
      removed: 0,
      families: [],
      isTest: false,
      isLockfile: false,
      isDocs: false,
    },
  ],
  testsAdded: false,
  testsMissing: false,
  lockfileChanged: false,
  titleHints: [],
  bodyHints: [],
};

export type PipelineStagePreview = (typeof PIPELINE_PROMPT_STAGES)[number] & { text: string };

function stageTemplate(id: (typeof PIPELINE_PROMPT_STAGES)[number]["id"]): string {
  const p = PROMPT_TEMPLATE_PLACEHOLDERS;
  switch (id) {
    case "router":
      return buildRouterPrompt({
        allowedRoles: [p.roleId],
        roleCatalog: [{ id: p.roleId, title: p.roleTitle, description: p.roleDescription }],
        signals: PLACEHOLDER_SIGNALS,
        diff: p.diff,
        maxDiffChars: 4_000,
        title: p.prTitle,
        body: p.humanDiscussion,
      });
    case "aggregator":
      return buildAggregatorPrompt({
        repoFullName: p.repository,
        prNumber: p.prNumber,
        prTitle: p.prTitle,
        baseSha: p.baseSha,
        headSha: p.headSha,
        reviewerEvidence: p.reviewerEvidence,
        humanOverrideDigest: p.humanDiscussion,
      });
    case "verifier":
      return buildVerifierPrompt({
        repoFullName: p.repository,
        prNumber: p.prNumber,
        prTitle: p.prTitle,
        headSha: p.headSha,
        findings: p.priorFindings,
      });
    case "poison-alert":
      return buildInternalEscalationPrompt({
        signals: PLACEHOLDER_SIGNALS,
        firstPass: p.firstPass,
        hunks: p.hunks,
        reason: p.routingReason,
      });
    case "stack_cumulative":
      return buildStackCumulativePrompt({
        repoFullName: p.repository,
        stackId: p.stackId,
        members: [
          {
            prNumber: p.prNumber,
            prTitle: p.prTitle,
            baseSha: p.baseSha,
            headSha: p.headSha,
            diff: p.memberDiff,
          },
        ],
      });
    case "repo-brief":
      return buildBriefPrompt({ repoFullName: p.repository, sha: p.sha });
    case "explainer":
      return buildExplainerPrompt({
        repoFullName: p.repository,
        changeKind: p.changeKind,
        author: p.author,
        title: p.prTitle,
        headSha: p.headSha,
        findings: [
          {
            fingerprint: p.fingerprint,
            severity: p.severity,
            path: p.path,
            line: null,
            summary: p.findingSummary,
          },
        ],
        question: p.operatorQuestion,
      });
    default: {
      const exhaustive: never = id;
      return exhaustive;
    }
  }
}

/** Inventory plus the composed builder text, with placeholders instead of live job fields. */
export function composedPipelineStages(): PipelineStagePreview[] {
  return PIPELINE_PROMPT_STAGES.map((stage) => ({ ...stage, text: stageTemplate(stage.id) }));
}
