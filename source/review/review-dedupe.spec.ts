import test from 'ava';
import {dedupeFindings} from './review-dedupe';
import type {ReviewFinding} from './review-findings';

function finding(
	issue: string,
	line = 3,
	file = 'src/file.ts',
): ReviewFinding {
	return {
		id: 'temp',
		file,
		line,
		severity: 'high',
		issue,
		evidence: 'return total / count;',
	};
}

test('keeps the first lens and renumbers the survivors', t => {
	const {unique, duplicates} = dedupeFindings([
		{finding: finding('Division by zero when count is 0'), lens: 'bugs'},
		{finding: finding('division by zero'), lens: 'standards and API misuse'},
		{
			finding: finding('Unused parameter total', 2),
			lens: 'intent and spec',
		},
	]);

	t.deepEqual(
		unique.map(entry => [entry.finding.id, entry.lens, entry.finding.issue]),
		[
			['F1', 'bugs', 'Division by zero when count is 0'],
			['F2', 'intent and spec', 'Unused parameter total'],
		],
	);
	t.deepEqual(duplicates, [
		{
			kept: 'bugs',
			dropped: 'standards and API misuse',
			finding: finding('division by zero'),
		},
	]);
});

test('does not merge different lines or unrelated issues', t => {
	const {unique, duplicates} = dedupeFindings([
		{finding: finding('Division by zero', 3), lens: 'bugs'},
		{finding: finding('Division by zero', 8), lens: 'bugs'},
		{finding: finding('Missing close()', 3), lens: 'standards and API misuse'},
	]);
	t.is(unique.length, 3);
	t.deepEqual(duplicates, []);
});
