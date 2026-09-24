import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import type {SubagentResult} from '@/subagents/types.js';
import {
	type ReviewSubagentExecutor,
	runDefaultReview,
} from './run-default-review.js';

const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-export const value = safe.value;
+export const value = maybe.value;`;

const finding = `FINDING
FILE: file.ts
LINE: 1
SEVERITY: high
ISSUE: maybe can be null
EVIDENCE: maybe.value is read without a guard
END`;

function result(
	output: string,
	overrides: Partial<SubagentResult> = {},
): SubagentResult {
	return {
		subagentName: 'review-agent',
		output,
		success: true,
		executionTimeMs: 1,
		...overrides,
	};
}

function projectRoot(t: {teardown: (fn: () => void) => void}): string {
	const root = mkdtempSync(join(tmpdir(), 'nanocoder-grounded-review-'));
	t.teardown(() => rmSync(root, {recursive: true, force: true}));
	writeFileSync(join(root, 'file.ts'), 'export const value = maybe.value;\n');
	return root;
}

test('runDefaultReview confirms a cited high-confidence finding', async t => {
	const calls: Array<{agent: string; limits: unknown}> = [];
	const executor: ReviewSubagentExecutor = {
		execute: async (task, _signal, _depth, _agentId, _context, limits) => {
			calls.push({agent: task.subagent_type, limits});
			return task.subagent_type === 'review-finder'
				? result(finding, {tokensUsed: 10})
				: result(`VERDICT: CONFIRM
ID: F1
CONFIDENCE: 93
REASON: maybe is nullable and no guard dominates the access`, {tokensUsed: 4});
		},
	};

	const review = await runDefaultReview(executor, {
		diff,
		targetDescription: 'test target',
		projectRoot: projectRoot(t),
	});

	t.is(review.confirmed.length, 1);
	t.is(review.confirmed[0]?.confidence, 93);
	t.deepEqual(review.usage, {finder: 10, verifier: 4});
	t.deepEqual(
		calls.map(call => call.agent),
		['review-finder', 'review-verifier'],
	);
	const finderLimits = calls[0]?.limits as {
		allowedTools: string[];
		maxToolCalls: number;
		maxTurns: number;
	};
	t.deepEqual(finderLimits.allowedTools, [
		'git_diff',
		'git_log',
		'read_file',
		'search_file_contents',
		'lsp_get_diagnostics',
	]);
	t.is(finderLimits.maxToolCalls, 24);
	t.is(finderLimits.maxTurns, 16);
});

test('runDefaultReview drops low-confidence confirmations', async t => {
	const executor: ReviewSubagentExecutor = {
		execute: async task =>
			task.subagent_type === 'review-finder'
				? result(finding)
				: result(`VERDICT: CONFIRM
ID: F1
CONFIDENCE: 79
REASON: The type is unclear`),
	};

	const review = await runDefaultReview(executor, {
		diff,
		targetDescription: 'test target',
		projectRoot: projectRoot(t),
	});

	t.is(review.confirmed.length, 0);
	t.is(review.dropped[0]?.verdict, 'CONFIRM');
	t.regex(review.dropped[0]?.reason ?? '', /below the 80 threshold/);
});

test('runDefaultReview rejects invalid citations before verification', async t => {
	let calls = 0;
	const executor: ReviewSubagentExecutor = {
		execute: async () => {
			calls++;
			return result(finding.replace('LINE: 1', 'LINE: 99'));
		},
	};

	const review = await runDefaultReview(executor, {
		diff,
		targetDescription: 'test target',
		projectRoot: projectRoot(t),
	});

	t.is(calls, 1);
	t.is(review.confirmed.length, 0);
	t.is(review.dropped.length, 1);
	t.regex(review.dropped[0]?.reason ?? '', /citation rejected/);
});

test('runDefaultReview preserves parseable partial finder output', async t => {
	const executor: ReviewSubagentExecutor = {
		execute: async task =>
			task.subagent_type === 'review-finder'
				? result(finding, {
						success: false,
						error: 'tool-call budget reached',
					})
				: result(`VERDICT: REJECT
ID: F1
CONFIDENCE: 98
REASON: maybe is non-null by construction`),
	};

	const review = await runDefaultReview(executor, {
		diff,
		targetDescription: 'test target',
		projectRoot: projectRoot(t),
	});

	t.is(review.confirmed.length, 0);
	t.is(review.dropped[0]?.verdict, 'REJECT');
	t.true(review.notes.some(note => note.includes('tool-call budget reached')));
});

test('runDefaultReview accepts citations from the full validation diff', async t => {
	const executor: ReviewSubagentExecutor = {
		execute: async task =>
			task.subagent_type === 'review-finder'
				? result(finding)
				: result(`VERDICT: CONFIRM
ID: F1
CONFIDENCE: 90
REASON: The cited line proves the issue`),
	};

	const review = await runDefaultReview(executor, {
		diff: '... [Diff truncated] ...',
		citationDiff: diff,
		targetDescription: 'large target',
		projectRoot: projectRoot(t),
	});

	t.is(review.confirmed.length, 1);
});

test('runDefaultReview ignores a verdict for the wrong finding ID', async t => {
	const executor: ReviewSubagentExecutor = {
		execute: async task =>
			task.subagent_type === 'review-finder'
				? result(finding)
				: result(`VERDICT: CONFIRM
ID: F99
CONFIDENCE: 99
REASON: This verdict belongs to another finding`),
	};

	const review = await runDefaultReview(executor, {
		diff,
		targetDescription: 'test target',
		projectRoot: projectRoot(t),
	});

	t.is(review.confirmed.length, 0);
	t.is(review.dropped[0]?.verdict, 'UNVERIFIED');
	t.true(review.notes.some(note => note.includes('invalid verdict')));
});
