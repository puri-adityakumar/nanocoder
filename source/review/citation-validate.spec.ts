import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {
	changedLinesFromDiff,
	validateCitations,
} from './citation-validate.js';

const sampleDiff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,3 @@
 export const first = 1;
+export const inserted = 2;
 export const last = 3;`;

test('changedLinesFromDiff tracks new-file hunk lines', t => {
	const changed = changedLinesFromDiff(sampleDiff);
	t.deepEqual([...(changed.files.get('file.ts') ?? [])], [1, 2, 3]);
});

test('validateCitations requires an existing in-range changed location', t => {
	const root = mkdtempSync(join(tmpdir(), 'nanocoder-review-citations-'));
	t.teardown(() => rmSync(root, {recursive: true, force: true}));
	writeFileSync(
		join(root, 'file.ts'),
		'export const first = 1;\nexport const inserted = 2;\nexport const last = 3;\n',
	);

	const result = validateCitations(
		root,
		[
			{file: 'file.ts', line: 2},
			{file: 'file.ts', line: 99},
			{file: 'missing.ts', line: 1},
		],
		changedLinesFromDiff(sampleDiff),
	);

	t.deepEqual(result.valid, [{file: 'file.ts', line: 2}]);
	t.is(result.invalid.length, 2);
	t.regex(result.invalid[0]?.reason ?? '', /past end of file/);
	t.regex(result.invalid[1]?.reason ?? '', /file not found/);
});

test('validateCitations rejects files outside the reviewed diff', t => {
	const root = mkdtempSync(join(tmpdir(), 'nanocoder-review-citations-'));
	t.teardown(() => rmSync(root, {recursive: true, force: true}));
	writeFileSync(join(root, 'other.ts'), 'export const other = true;\n');

	const result = validateCitations(
		root,
		[{file: 'other.ts', line: 1}],
		changedLinesFromDiff(sampleDiff),
	);

	t.is(result.valid.length, 0);
	t.regex(result.invalid[0]?.reason ?? '', /not part of the reviewed changes/);
});
