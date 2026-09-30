import test from 'ava';
import {
	buildHeadlessReviewJson,
	runHeadlessReview,
	splitHeadlessReviewArgs,
} from './headless-review';
import {
	createScriptedReviewClient,
	findingBlock,
	verdictBlock,
} from './review-test-client';
import {createReviewFixtureTools, createReviewGitFixture} from './review-test-helpers';

test('splits a tier word from the review target', t => {
	t.deepEqual(splitHeadlessReviewArgs([]), {tier: 'grounded', request: ''});
	t.deepEqual(splitHeadlessReviewArgs(['feature/auth']), {
		tier: 'grounded',
		request: 'feature/auth',
	});
	t.deepEqual(splitHeadlessReviewArgs(['deep', 'last', '2', 'commits']), {
		tier: 'deep',
		request: 'last 2 commits',
	});
	t.deepEqual(splitHeadlessReviewArgs(['quick', '42']), {
		tier: 'quick',
		request: '42',
	});
});

test('headless review writes the report to stdout and progress elsewhere', async t => {
	const fixture = createReviewGitFixture();
	t.teardown(fixture.cleanup);
	fixture.runGit(['checkout', '-b', 'feature/headless']);
	fixture.write(
		'src/file.ts',
		'export function average(total: number, count: number) {\n\treturn total / count;\n}\n',
	);
	fixture.runGit(['add', '--all']);
	fixture.runGit(['commit', '-m', 'add average']);

	const {client} = createScriptedReviewClient(call =>
		call.role === 'finder'
			? {content: findingBlock({file: 'src/file.ts', line: 2})}
			: {content: verdictBlock({})},
	);
	const progress: string[] = [];
	const outcome = await runHeadlessReview({
		args: ['branch', 'feature/headless'],
		client,
		provider: 'review-test',
		model: 'review-test-model',
		tools: createReviewFixtureTools(fixture),
		writeProgress: line => progress.push(line),
	});

	t.is(outcome.exitCode, 0);
	t.true(outcome.stdout.includes('## Grounded review · completed'));
	t.true(outcome.stdout.includes('`src/file.ts:2`'));
	t.false(outcome.stdout.includes('finder: turn'));
	t.true(progress.some(line => line.includes('finder')));
	t.true(progress.some(line => line.startsWith('review — completed')));
});

test('headless JSON keeps the status and findings and stays off the progress stream', async t => {
	const fixture = createReviewGitFixture();
	t.teardown(fixture.cleanup);
	fixture.write('src/file.ts', 'export const value = 2;\n');
	const {client} = createScriptedReviewClient(() => ({content: 'NO FINDINGS'}));
	const progress: string[] = [];
	const outcome = await runHeadlessReview({
		args: ['working', 'tree'],
		client,
		provider: 'review-test',
		model: 'review-test-model',
		outputFormat: 'json',
		tools: createReviewFixtureTools(fixture),
		writeProgress: line => progress.push(line),
	});

	t.is(outcome.exitCode, 0);
	const parsed = JSON.parse(outcome.stdout) as ReturnType<
		typeof buildHeadlessReviewJson
	>;
	t.is(parsed.tier, 'grounded');
	t.is(parsed.status, 'completed');
	t.deepEqual(parsed.findings, []);
	t.false(progress.some(line => line.includes('NO FINDINGS')));
	t.true(outcome.stdout.endsWith('\n'));
});

test('a failed headless review exits non-zero and still prints the report', async t => {
	const fixture = createReviewGitFixture();
	t.teardown(fixture.cleanup);
	fixture.runGit(['checkout', '-b', 'feature/headless-fail']);
	fixture.write('src/file.ts', 'export const value = 2;\n');
	fixture.runGit(['add', '--all']);
	fixture.runGit(['commit', '-m', 'change']);
	const {client} = createScriptedReviewClient(() => {
		throw new Error('connection refused');
	});
	const outcome = await runHeadlessReview({
		args: ['deep', 'branch', 'feature/headless-fail'],
		client,
		provider: 'review-test',
		model: 'review-test-model',
		tools: createReviewFixtureTools(fixture),
		writeProgress: () => {},
	});
	t.is(outcome.exitCode, 1);
	t.true(outcome.stdout.includes('## Deep review · failed'));
	t.false(outcome.stdout.includes('tool: git'));
});

test('the quick tier prints the one-shot text and does not start a finder', async t => {
	const {client, calls} = createScriptedReviewClient(() => ({
		content: 'Ship it.',
	}));
	const progress: string[] = [];
	const outcome = await runHeadlessReview({
		args: ['quick'],
		client,
		provider: 'review-test',
		model: 'review-test-model',
		writeProgress: line => progress.push(line),
		quickDependencies: {
			execGit: async args => {
				if (args[0] === 'rev-parse') return '';
				return 'diff --git a/file.ts b/file.ts\n+const x = 1;\n';
			},
			getCurrentBranch: async () => 'feature',
			getDefaultBranch: async () => 'main',
		},
	});
	t.is(outcome.exitCode, 0);
	t.true(outcome.stdout.includes('Ship it.'));
	t.is(calls.length, 1);
	t.deepEqual(calls[0]?.tools, {});
	t.true(progress.some(line => line.includes('one-shot')));
});
