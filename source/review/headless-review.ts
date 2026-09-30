/**
 * Non-TTY `nanocoder review`.
 *
 * Runs the same grounded, deep, and quick tiers as the TUI without Ink.
 * The report (markdown, or JSON with --output-format json) is the only
 * thing written to stdout. Progress and errors go to stderr.
 */

import {createReviewCommand, type ReviewDependencies} from '@/commands/review';
import {writeStatus} from '@/plain/writer';
import type {TuneConfig} from '@/types/config';
import type {LLMClient} from '@/types/core';
import {ReviewActivityStore} from './review-activity';
import {renderGroundedReviewReport} from './review-report';
import {resolveReviewToolMode} from './review-tool-mode';
import type {ReviewFoundationTools} from './review-tools';
import {runDeepReview} from './run-deep-review';
import {
	type GroundedReviewResult,
	type GroundedReviewStatus,
	runGroundedReview,
} from './run-grounded-review';

export type HeadlessReviewTier = 'grounded' | 'deep' | 'quick';

export interface HeadlessReviewJson {
	tier: HeadlessReviewTier;
	status: GroundedReviewStatus | 'completed' | 'failed';
	scope?: string;
	message?: string;
	text?: string;
	findings: GroundedReviewResult['findings'];
	dropped: GroundedReviewResult['dropped'];
	unverified: GroundedReviewResult['unverified'];
	incompleteReasons: string[];
	notes: string[];
	stats: GroundedReviewResult['stats'];
	reviewId?: string;
}

export interface HeadlessReviewOptions {
	/** Words after `review` (`deep`, `quick`, and the target). */
	args: string[];
	client: LLMClient;
	provider: string;
	model: string;
	tune?: TuneConfig;
	outputFormat?: 'text' | 'json';
	tools?: ReviewFoundationTools;
	/** Git and prompt seams for the one-shot tier. */
	quickDependencies?: ReviewDependencies;
	signal?: AbortSignal;
	/** Status lines. Defaults to stderr. */
	writeProgress?: (line: string) => void;
}

const TIER_WORDS = new Set(['quick', 'deep']);

export function splitHeadlessReviewArgs(args: string[]): {
	tier: HeadlessReviewTier;
	request: string;
} {
	const [first, ...rest] = args;
	if (first && TIER_WORDS.has(first.toLowerCase())) {
		return {
			tier: first.toLowerCase() === 'deep' ? 'deep' : 'quick',
			request: rest.join(' ').trim(),
		};
	}
	return {tier: 'grounded', request: args.join(' ').trim()};
}

export function buildHeadlessReviewJson(
	result: GroundedReviewResult,
	tier: Exclude<HeadlessReviewTier, 'quick'>,
): HeadlessReviewJson {
	return {
		tier,
		status: result.status,
		...(result.scope ? {scope: result.scope} : {}),
		...(result.message ? {message: result.message} : {}),
		findings: result.findings,
		dropped: result.dropped,
		unverified: result.unverified,
		incompleteReasons: result.incompleteReasons,
		notes: result.notes,
		stats: result.stats,
		reviewId: result.reviewId,
	};
}

function exitCodeFor(status: GroundedReviewStatus): number {
	return status === 'failed' ||
		status === 'cancelled' ||
		status === 'clarification'
		? 1
		: 0;
}

function watchProgress(
	activity: ReviewActivityStore,
	writeProgress: (line: string) => void,
): () => void {
	let previous = '';
	return activity.subscribe(() => {
		const summary = activity.toSummary();
		const latest = summary.events.at(-1);
		const line = latest
			? `${latest.source}: ${latest.name} — ${latest.updates.at(-1)?.summary ?? latest.status}`
			: `review — ${summary.status}`;
		if (line === previous) return;
		previous = line;
		writeProgress(line);
	});
}

function componentMessage(node: unknown): {text: string; failed: boolean} {
	if (!node || typeof node !== 'object' || !('props' in node)) {
		return {text: 'Review failed.', failed: true};
	}
	const props = (node as {props?: {message?: unknown}; type?: {name?: string}})
		.props;
	const text =
		typeof props?.message === 'string' ? props.message : 'Review failed.';
	const name = (node as {type?: {name?: string}}).type?.name ?? '';
	return {text, failed: name === 'ErrorMessage'};
}

/**
 * Run one review without the TUI. Stdout receives only the finished report.
 */
export async function runHeadlessReview(
	options: HeadlessReviewOptions,
): Promise<{exitCode: number; stdout: string}> {
	const writeProgress = options.writeProgress ?? writeStatus;
	const {tier, request} = splitHeadlessReviewArgs(options.args);
	const format = options.outputFormat ?? 'text';

	if (tier === 'quick') {
		writeProgress('Running the one-shot review');
		const command = createReviewCommand(options.quickDependencies);
		const rendered = await command.handler(
			['quick', ...request.split(/\s+/).filter(Boolean)],
			[],
			{
				provider: options.provider,
				model: options.model,
				tokens: 0,
				getMessageTokens: () => 0,
				client: options.client,
				...(options.tune ? {tune: options.tune} : {}),
			},
		);
		const {text, failed} = componentMessage(rendered);
		if (failed) {
			writeProgress(text);
			return {exitCode: 1, stdout: ''};
		}
		if (format === 'json') {
			const body: HeadlessReviewJson = {
				tier: 'quick',
				status: 'completed',
				text,
				findings: [],
				dropped: [],
				unverified: [],
				incompleteReasons: [],
				notes: [],
				stats: {reported: 0, verifierRuns: 0, modelCalls: 0, toolCalls: 0},
			};
			return {exitCode: 0, stdout: `${JSON.stringify(body, null, 2)}\n`};
		}
		return {exitCode: 0, stdout: `${text}\n`};
	}

	const activity = new ReviewActivityStore();
	const stopWatching = watchProgress(activity, writeProgress);
	try {
		const run = tier === 'deep' ? runDeepReview : runGroundedReview;
		const result = await run({
			request,
			client: options.client,
			toolMode: resolveReviewToolMode(
				options.provider,
				options.model,
				options.tune,
			),
			activity,
			...(options.tools ? {tools: options.tools} : {}),
			...(options.signal ? {signal: options.signal} : {}),
		});
		writeProgress(`review — ${result.status}`);
		if (format === 'json') {
			return {
				exitCode: exitCodeFor(result.status),
				stdout: `${JSON.stringify(buildHeadlessReviewJson(result, tier), null, 2)}\n`,
			};
		}
		const report = renderGroundedReviewReport(
			result,
			tier === 'deep' ? 'Deep' : 'Grounded',
		);
		return {exitCode: exitCodeFor(result.status), stdout: `${report}\n`};
	} finally {
		stopWatching();
	}
}
