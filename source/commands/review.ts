import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {renderReviewReport} from '@/review/review-report.js';
import {
	type ReviewSubagentExecutor,
	runDefaultReview,
} from '@/review/run-default-review.js';
import {getProjectRoot} from '@/services/session-cwd';
import {getSubagentLoader} from '@/subagents/subagent-loader.js';
import {getAgentToolExecutor} from '@/tools/agent-tool';
import {
	execGh,
	execGit,
	getCurrentBranch,
	getDefaultBranch,
	isGhAvailable,
	truncateDiff,
} from '@/tools/git/utils';
import type {Command} from '@/types/commands';
import {formatError} from '@/utils/error-formatter';
import {getLogger} from '@/utils/logging';
import {errorMsg, successMsg, warningMsg} from '@/utils/message-factory';
import {loadSection} from '@/utils/prompt-builder';
import {parseReviewArgs} from './review-tier';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Maximum number of diff lines to send to the model. truncateDiff keeps
// the first and last half of this budget; keep in sync with the test
// assertion that checks the truncation note.
const REVIEW_MAX_DIFF_LINES = 1000;
const GROUNDED_REVIEW_MAX_DIFF_LINES = 4000;

export type ReviewDependencies = {
	execGit: (args: string[]) => Promise<string>;
	getCurrentBranch: () => Promise<string>;
	getDefaultBranch: () => Promise<string>;
	isGhAvailable?: () => boolean;
	execGh?: (args: string[]) => Promise<string>;
	loadPrompt?: () => string;
	/** Test seam for the executor initialized by the app. */
	getExecutor?: () => ReviewSubagentExecutor | null;
};

const defaultDependencies: ReviewDependencies = {
	execGit,
	getCurrentBranch,
	getDefaultBranch,
	isGhAvailable,
	execGh,
};

function loadReviewPrompt(): string {
	const content = loadSection('review');
	if (content) return content;

	const logger = getLogger();
	const promptPath = join(
		__dirname,
		'../../source/app/prompts/sections/review.md',
	);
	logger.warn(
		'Review prompt not found at %s — falling back to built-in default',
		promptPath,
	);
	return 'You are a senior software engineer performing a code review. Review the diff for bugs, security issues, and style violations. Be concise and actionable.';
}

function validateTarget(target: string): string | null {
	if (target.startsWith('-')) {
		return 'Target must not start with "-". Pass a branch name or PR number.';
	}
	return null;
}

type ResolvedReviewTarget =
	| {ok: true; diff: string; targetDescription: string}
	| {ok: false; error: string};

async function resolveReviewTarget(
	dependencies: ReviewDependencies,
	args: string[],
): Promise<ResolvedReviewTarget> {
	const defaultBranch = await dependencies.getDefaultBranch();
	const currentBranch = await dependencies.getCurrentBranch();

	if (args.length === 0) {
		return {
			ok: true,
			diff: await getBranchDiff(dependencies, currentBranch, defaultBranch),
			targetDescription: `current branch "${currentBranch}" against "${defaultBranch}"`,
		};
	}

	const target = args[0] as string;
	const validationError = validateTarget(target);
	if (validationError) return {ok: false, error: validationError};

	if (/^\d+$/.test(target)) {
		if (!(dependencies.isGhAvailable?.() ?? false) || !dependencies.execGh) {
			return {
				ok: false,
				error:
					'PR review requires the gh CLI. Install it from https://cli.github.com or use a branch name instead.',
			};
		}
		try {
			const remote = await dependencies.execGit([
				'remote',
				'get-url',
				'origin',
			]);
			const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
			if (!match?.[1]) {
				throw new Error(
					'Cannot determine GitHub repository slug from remote URL.',
				);
			}
			return {
				ok: true,
				diff: await dependencies.execGh([
					'pr',
					'diff',
					target,
					'--repo',
					match[1],
				]),
				targetDescription: `PR #${target}`,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				error: `Failed to fetch PR #${target} diff: ${message}`,
			};
		}
	}

	const branch = target === defaultBranch ? currentBranch : target;
	return {
		ok: true,
		diff: await getBranchDiff(dependencies, branch, defaultBranch),
		targetDescription:
			target === defaultBranch
				? `current branch "${currentBranch}" against "${defaultBranch}"`
				: `branch "${target}" against "${defaultBranch}"`,
	};
}

type QuickReviewOutcome =
	| {kind: 'no-changes'}
	| {kind: 'empty'}
	| {kind: 'review'; text: string};

async function runQuickReview(
	dependencies: ReviewDependencies,
	diff: string,
	targetDescription: string,
	client: NonNullable<Parameters<Command['handler']>[2]['client']>,
): Promise<QuickReviewOutcome> {
	const truncated = truncateDiff(diff, REVIEW_MAX_DIFF_LINES);
	if (!truncated.content.trim()) return {kind: 'no-changes'};

	const parts = [`Reviewing changes from ${targetDescription}:\n`];
	if (truncated.truncated) {
		const halfLines = Math.ceil(REVIEW_MAX_DIFF_LINES / 2);
		parts.push(
			`[Note: diff truncated — reviewed first and last ${halfLines} of ${truncated.totalLines} lines]\n`,
		);
	}
	parts.push(truncated.content);

	const response = await client.chat(
		[
			{
				role: 'system',
				content: dependencies.loadPrompt?.() ?? loadReviewPrompt(),
			},
			{role: 'user', content: parts.join('\n')},
		],
		{},
		{},
	);
	const review = response?.choices?.[0]?.message?.content?.trim();
	return review ? {kind: 'review', text: review} : {kind: 'empty'};
}

function renderQuickOutcome(
	outcome: QuickReviewOutcome,
	targetDescription: string,
	fallback = false,
): React.ReactElement {
	if (outcome.kind === 'no-changes') {
		return warningMsg(`No changes found in ${targetDescription}.`, 'review');
	}
	if (outcome.kind === 'empty') {
		return warningMsg('Model returned an empty review.', 'review');
	}
	const fallbackNote = fallback
		? '\n\n_(Ran as one-shot review because the subagent executor is unavailable in this session.)_'
		: '';
	return successMsg(`${outcome.text}${fallbackNote}`, 'review');
}

export function createReviewCommand(
	dependencies: ReviewDependencies = defaultDependencies,
): Command {
	return {
		name: 'review',
		description:
			'Review a branch or PR diff for bugs, security issues, and style violations',
		progressLabel: 'Reviewing code',
		handler: async (args, _messages, metadata) => {
			const client = metadata.client;
			if (!client) {
				return errorMsg('No active LLM client available.', 'review');
			}

			try {
				const parsed = parseReviewArgs(args);
				const resolved = await resolveReviewTarget(dependencies, parsed.args);
				if (!resolved.ok) return errorMsg(resolved.error, 'review');

				const {diff, targetDescription} = resolved;
				if (parsed.tier === 'quick') {
					return renderQuickOutcome(
						await runQuickReview(dependencies, diff, targetDescription, client),
						targetDescription,
					);
				}

				if (!diff.trim()) {
					return warningMsg(
						`No changes found in ${targetDescription}.`,
						'review',
					);
				}

				const executor = dependencies.getExecutor?.() ?? getAgentToolExecutor();
				if (!executor) {
					return renderQuickOutcome(
						await runQuickReview(dependencies, diff, targetDescription, client),
						targetDescription,
						true,
					);
				}

				const truncated = truncateDiff(diff, GROUNDED_REVIEW_MAX_DIFF_LINES);
				const result = await runDefaultReview(executor, {
					diff: truncated.content,
					citationDiff: diff,
					targetDescription,
					projectRoot: getProjectRoot(),
					loader: getSubagentLoader(getProjectRoot()),
				});
				if (truncated.truncated) {
					result.notes.unshift(
						`diff truncated to the first and last ${Math.ceil(
							GROUNDED_REVIEW_MAX_DIFF_LINES / 2,
						)} of ${truncated.totalLines} lines`,
					);
				}
				return successMsg(
					renderReviewReport(result, targetDescription),
					'review',
				);
			} catch (error) {
				return errorMsg(formatError(error), 'review');
			}
		},
	};
}

async function getBranchDiff(
	dependencies: ReviewDependencies,
	branch: string,
	defaultBranch: string,
): Promise<string> {
	await dependencies.execGit(['rev-parse', '--verify', branch]);

	// defaultBranch...branch shows changes on `branch` since it diverged
	// from defaultBranch — exactly what a reviewer wants to see.
	return dependencies.execGit([
		'diff',
		'--no-ext-diff',
		'--no-color',
		`${defaultBranch}...${branch}`,
	]);
}

export const reviewCommand = createReviewCommand();
