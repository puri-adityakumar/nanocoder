/**
 * Default grounded review: one finder, deterministic citation validation, and
 * one independent verifier for each surviving finding.
 */

import type {SubagentExecutionLimits} from '@/subagents/subagent-executor.js';
import type {SubagentLoader} from '@/subagents/subagent-loader.js';
import type {SubagentResult} from '@/subagents/types.js';
import {changedLinesFromDiff, validateCitations} from './citation-validate.js';
import {
	applyVerdicts,
	type DroppedReviewFinding,
	formatFinding,
	parseFindings,
	parseVerdicts,
	REVIEW_CONFIDENCE_THRESHOLD,
	type ReviewVerdictResult,
	type VerifiedFinding,
} from './finding-format.js';
import {
	REVIEW_FINDER_AGENT,
	REVIEW_READ_ONLY_TOOLS,
	REVIEW_VERIFIER_AGENT,
	registerReviewAgents,
} from './review-agents.js';

const DEFAULT_FINDER_MAX_TOOL_CALLS = 24;
const DEFAULT_FINDER_MAX_TURNS = 16;
const DEFAULT_VERIFIER_MAX_TOOL_CALLS = 4;
const DEFAULT_VERIFIER_MAX_TURNS = 4;
const DEFAULT_MAX_VERIFIED_FINDINGS = 10;

export interface ReviewSubagentExecutor {
	execute(
		task: {
			subagent_type: string;
			description: string;
			prompt?: string;
		},
		signal?: AbortSignal,
		depth?: number,
		agentId?: string,
		executionContext?: unknown,
		limits?: SubagentExecutionLimits,
	): Promise<SubagentResult>;
}

export interface DefaultReviewOptions {
	/** Diff sent to the agents, possibly truncated by the command layer. */
	diff: string;
	/** Full diff used only by deterministic citation validation. */
	citationDiff?: string;
	targetDescription: string;
	projectRoot?: string;
	signal?: AbortSignal;
	finderMaxToolCalls?: number;
	finderMaxTurns?: number;
	verifierMaxToolCalls?: number;
	verifierMaxTurns?: number;
	maxVerifiedFindings?: number;
	confidenceThreshold?: number;
	loader?: SubagentLoader;
}

export interface DefaultReviewResult {
	confirmed: VerifiedFinding[];
	dropped: DroppedReviewFinding[];
	notes: string[];
	/** Approximate streamed token counts; not billing usage. */
	usage: {finder: number; verifier: number};
}

const readOnlyTools = [...REVIEW_READ_ONLY_TOOLS];

function tokensUsed(result: SubagentResult): number {
	return result.tokensUsed ?? 0;
}

export async function runDefaultReview(
	executor: ReviewSubagentExecutor,
	options: DefaultReviewOptions,
): Promise<DefaultReviewResult> {
	const notes: string[] = [];
	const usage = {finder: 0, verifier: 0};

	if (!options.diff.trim()) {
		return {
			confirmed: [],
			dropped: [],
			notes: ['review target contains no changes'],
			usage,
		};
	}
	if (options.loader) {
		const registration = await registerReviewAgents(options.loader);
		for (const name of registration.skipped) {
			notes.push(`using custom ${name} definition`);
		}
	}

	const finderMaxToolCalls =
		options.finderMaxToolCalls ?? DEFAULT_FINDER_MAX_TOOL_CALLS;
	const finderRun = await executor.execute(
		{
			subagent_type: REVIEW_FINDER_AGENT,
			description: `Review changes for ${options.targetDescription}`,
			prompt: [
				`You have a hard budget of ${finderMaxToolCalls} tool calls.`,
				'Stop investigating before the budget is exhausted and return your',
				'FINDING blocks. A reasoned empty response is acceptable.',
				'',
				`Review target: ${options.targetDescription}`,
				'```diff',
				options.diff,
				'```',
			].join('\n'),
		},
		options.signal,
		0,
		undefined,
		undefined,
		{
			allowedTools: readOnlyTools,
			maxToolCalls: finderMaxToolCalls,
			maxTurns: options.finderMaxTurns ?? DEFAULT_FINDER_MAX_TURNS,
		},
	);
	usage.finder = tokensUsed(finderRun);

	if (!finderRun.success) {
		notes.push(
			`finder stopped before completing: ${finderRun.error ?? 'unknown error'}`,
		);
	}

	const parsed = parseFindings(finderRun.output);
	for (const malformed of parsed.discarded) {
		notes.push(`discarded malformed finding: ${malformed}`);
	}
	if (parsed.findings.length === 0) {
		if (finderRun.success) {
			if (parsed.unparseable && finderRun.output.trim()) {
				notes.push('finder output did not follow the FINDING contract');
			} else {
				notes.push('finder reported no issues');
			}
		}
		return {confirmed: [], dropped: [], notes, usage};
	}

	const citationResults = validateCitations(
		options.projectRoot ?? process.cwd(),
		parsed.findings,
		changedLinesFromDiff(options.citationDiff ?? options.diff),
	);
	const invalidReasons = new Map<string, string>();
	for (const invalid of citationResults.invalid) {
		invalidReasons.set(`${invalid.file}\0${invalid.line}`, invalid.reason);
	}

	const citationValid = parsed.findings.filter(
		finding => !invalidReasons.has(`${finding.file}\0${finding.line}`),
	);
	const cap = Math.max(
		0,
		options.maxVerifiedFindings ?? DEFAULT_MAX_VERIFIED_FINDINGS,
	);
	const toVerify = citationValid.slice(0, cap);
	const dropped: DroppedReviewFinding[] = parsed.findings
		.filter(finding => invalidReasons.has(`${finding.file}\0${finding.line}`))
		.map(finding => ({
			finding,
			verdict: 'UNVERIFIED',
			reason: `citation rejected: ${invalidReasons.get(
				`${finding.file}\0${finding.line}`,
			)}`,
		}));
	for (const finding of citationValid.slice(cap)) {
		dropped.push({
			finding,
			verdict: 'UNVERIFIED',
			reason: `verification cap (${cap}) reached`,
		});
	}

	const verdicts: ReviewVerdictResult[] = [];
	for (const finding of toVerify) {
		if (options.signal?.aborted) {
			dropped.push({
				finding,
				verdict: 'UNVERIFIED',
				reason: 'review cancelled before verification',
			});
			continue;
		}

		const verifierRun = await executor.execute(
			{
				subagent_type: REVIEW_VERIFIER_AGENT,
				description: `Verify finding ${finding.id}`,
				prompt: [
					`Review target: ${options.targetDescription}`,
					'',
					'Diff under review:',
					'```diff',
					options.diff,
					'```',
					'',
					'Finding to verify:',
					formatFinding(finding),
				].join('\n'),
			},
			options.signal,
			0,
			undefined,
			undefined,
			{
				allowedTools: readOnlyTools,
				maxToolCalls:
					options.verifierMaxToolCalls ?? DEFAULT_VERIFIER_MAX_TOOL_CALLS,
				maxTurns: options.verifierMaxTurns ?? DEFAULT_VERIFIER_MAX_TURNS,
			},
		);
		usage.verifier += tokensUsed(verifierRun);
		if (!verifierRun.success) {
			notes.push(
				`verifier for ${finding.id} stopped before completing: ${
					verifierRun.error ?? 'unknown error'
				}`,
			);
		}

		const parsedVerdicts = parseVerdicts(verifierRun.output);
		const matchingVerdict = parsedVerdicts.verdicts.find(
			verdict => verdict.id === finding.id,
		);
		if (matchingVerdict) {
			verdicts.push(matchingVerdict);
		}
		if (parsedVerdicts.discarded.length > 0 || !matchingVerdict) {
			notes.push(`verifier for ${finding.id} returned an invalid verdict`);
		}
	}

	const applied = applyVerdicts(
		toVerify,
		verdicts,
		options.confidenceThreshold ?? REVIEW_CONFIDENCE_THRESHOLD,
	);
	return {
		confirmed: applied.confirmed,
		dropped: [...dropped, ...applied.dropped],
		notes,
		usage,
	};
}
