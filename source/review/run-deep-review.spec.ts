import test from 'ava';
import {FINDER_LENSES} from './review-lenses';
import {
	createScriptedReviewClient,
	findingBlock,
	type ReviewScript,
	verdictBlock,
} from './review-test-client';
import {
	createReviewFixtureTools,
	createReviewGitFixture,
	type ReviewGitFixture,
} from './review-test-helpers';
import {
	DEFAULT_GROUNDED_REVIEW_BUDGETS,
	type GroundedReviewOptions,
} from './run-grounded-review';
import {runDeepReview} from './run-deep-review';

function featureFixture(t: {teardown: (fn: () => void) => void}): ReviewGitFixture {
	const fixture = createReviewGitFixture();
	t.teardown(fixture.cleanup);
	fixture.runGit(['checkout', '-b', 'feature/deep']);
	fixture.write(
		'src/file.ts',
		[
			'export const value = 1;',
			'export function average(total: number, count: number) {',
			'\treturn total / count;',
			'}',
			'',
		].join('\n'),
	);
	fixture.runGit(['add', '--all']);
	fixture.runGit(['commit', '-m', 'add average']);
	return fixture;
}

async function review(
	fixture: ReviewGitFixture,
	script: ReviewScript,
	options: Partial<GroundedReviewOptions> = {},
) {
	const {client, calls} = createScriptedReviewClient(script);
	const result = await runDeepReview({
		request: 'branch feature/deep',
		client,
		toolMode: {disabled: false, format: 'xml'},
		tools: createReviewFixtureTools(fixture),
		...options,
	});
	return {result, calls};
}

test('deep review runs one finder per lens and verifies a deduped finding once', async t => {
	const fixture = featureFixture(t);
	let finderIndex = 0;
	const {result, calls} = await review(fixture, call => {
		if (call.role !== 'finder') return {content: verdictBlock({})};
		const focus = FINDER_LENSES[finderIndex]?.focus ?? '';
		finderIndex++;
		t.true(call.messages[1]?.content.includes(focus));
		if (finderIndex === 1) {
			return {
				content: findingBlock({
					file: 'src/file.ts',
					line: 3,
					issue: 'Division by zero when count is 0',
				}),
			};
		}
		if (finderIndex === 2) {
			return {
				content: findingBlock({
					file: 'src/file.ts',
					line: 3,
					issue: 'division by zero',
				}),
			};
		}
		return {content: 'NO FINDINGS'};
	});

	t.is(calls.filter(call => call.role === 'finder').length, FINDER_LENSES.length);
	t.is(calls.filter(call => call.role === 'verifier').length, 1);
	t.is(result.status, 'completed');
	t.is(result.findings.length, 1);
	t.is(result.findings[0]?.id, 'F1');
	t.true(
		result.notes.some(note =>
			note.includes('standards and API misuse already covered by bugs'),
		),
	);
	t.true(
		result.activity.events.some(event => event.name === 'finder (bugs)'),
	);
	t.true(
		result.activity.events.some(
			event => event.name === 'finder (standards and API misuse)',
		),
	);
	t.true(result.activity.events.some(event => event.name === 'Deep review'));
});

test('a specialist that misses the report format makes the deep review incomplete', async t => {
	const fixture = featureFixture(t);
	let index = 0;
	const {result} = await review(fixture, call => {
		if (call.role !== 'finder') return {content: verdictBlock({})};
		index++;
		return {content: index === 2 ? 'Looks fine.' : 'NO FINDINGS'};
	});
	t.is(result.status, 'incomplete');
	t.deepEqual(result.findings, []);
	t.true(
		result.incompleteReasons.some(reason =>
			reason.includes('standards and API misuse finder did not report'),
		),
	);
});

test('one failed specialist does not discard the others, and all failing fails the review', async t => {
	const fixture = featureFixture(t);
	let index = 0;
	const partial = await review(fixture, call => {
		if (call.role !== 'finder') return {content: verdictBlock({})};
		index++;
		if (index === 1) throw new Error('connection refused');
		if (index === 2) {
			return {
				content: findingBlock({file: 'src/file.ts', line: 3, issue: 'Division by zero'}),
			};
		}
		return {content: 'NO FINDINGS'};
	});
	t.is(partial.result.status, 'incomplete');
	t.is(partial.result.findings.length, 1);
	t.true(partial.result.incompleteReasons[0]?.includes('bugs finder failed'));

	const failed = await review(fixture, call => {
		if (call.role === 'finder') throw new Error('connection refused');
		return {content: verdictBlock({})};
	});
	t.is(failed.result.status, 'failed');
	t.is(failed.result.activity.status, 'failed');
	t.is(failed.calls.filter(call => call.role === 'verifier').length, 0);
});

test('cancelling during a later finder keeps earlier findings unverified', async t => {
	const fixture = featureFixture(t);
	const controller = new AbortController();
	let index = 0;
	const {result} = await review(
		fixture,
		call => {
			if (call.role !== 'finder') return {content: verdictBlock({})};
			index++;
			if (index === 2) {
				controller.abort();
				const error = new Error('aborted');
				error.name = 'AbortError';
				throw error;
			}
			return {
				content: findingBlock({file: 'src/file.ts', line: 3}),
			};
		},
		{
			signal: controller.signal,
			budgets: {
				...DEFAULT_GROUNDED_REVIEW_BUDGETS,
				finder: {maxTurns: 4, maxToolCalls: 4},
			},
		},
	);
	t.is(result.status, 'cancelled');
	t.is(result.unverified.length, 1);
	t.is(result.unverified[0]?.reason, 'not verified: review cancelled');
	t.is(result.findings.length, 0);
});

test('a specialist cut off at the output limit makes the deep review incomplete', async t => {
	const fixture = featureFixture(t);
	let index = 0;
	const {result} = await review(fixture, call => {
		if (call.role !== 'finder') return {content: verdictBlock({})};
		index++;
		return index === 1
			? {content: 'NO FINDINGS', finishReason: 'length'}
			: {content: 'NO FINDINGS'};
	});
	t.is(result.status, 'incomplete');
	t.regex(result.incompleteReasons.join('\n'), /output was cut off at the model output limit/);
});

test('a partial read of an omitted file leaves the deep review incomplete', async t => {
	const fixture = featureFixture(t);
	fixture.write(
		'src/large.ts',
		`${Array.from({length: 1600}, (_, index) => `export const v${index} = ${index};`).join('\n')}\n`,
	);
	fixture.runGit(['add', '--all']);
	fixture.runGit(['commit', '-m', 'add large file']);
	const {result} = await review(fixture, call => {
		if (call.role !== 'finder') return {content: verdictBlock({})};
		const inspected = call.messages.some(message => message.role === 'tool');
		return inspected
			? {content: 'NO FINDINGS'}
			: {
					toolCalls: [
						{
							name: 'review_read_file',
							args: {path: 'src/large.ts', start_line: 1, end_line: 1},
						},
					],
				};
	});
	t.is(result.status, 'incomplete');
	t.regex(result.incompleteReasons.join('\n'), /src\/large.ts was only partially inspected/);
	t.false(result.incompleteReasons.join('\n').includes('never inspected'));
});
