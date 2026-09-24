import test from 'ava';
import {
	applyVerdicts,
	formatFinding,
	normalizeCitationPath,
	parseFindings,
	parseVerdicts,
} from './finding-format.js';

test('parseFindings assigns stable IDs to valid finding blocks', t => {
	const parsed = parseFindings(`FINDING
FILE: source/a.ts
LINE: 12
SEVERITY: high
ISSUE: Null access
EVIDENCE: value is used without a guard
END

FINDING
FILE: source/b.ts
LINE: 4
SEVERITY: low
ISSUE: Wrong fallback
EVIDENCE: fallback contradicts the API contract
END`);

	t.deepEqual(
		parsed.findings.map(finding => finding.id),
		['F1', 'F2'],
	);
	t.is(parsed.findings[0]?.file, 'source/a.ts');
	t.false(parsed.unparseable);
	t.deepEqual(parsed.discarded, []);
});

test('parseFindings separates markerless FILE blocks', t => {
	const parsed = parseFindings(`FILE: source/a.ts
LINE: 1
SEVERITY: high
ISSUE: First issue
EVIDENCE: First evidence
FILE: source/b.ts
LINE: 2
SEVERITY: medium
ISSUE: Second issue
EVIDENCE: Second evidence`);

	t.deepEqual(
		parsed.findings.map(finding => finding.file),
		['source/a.ts', 'source/b.ts'],
	);
});

test('parseFindings rejects malformed fields and unsafe paths', t => {
	const parsed = parseFindings(`FINDING
FILE: ../secret
LINE: zero
SEVERITY: urgent
ISSUE: Claim
EVIDENCE: Evidence
END`);

	t.is(parsed.findings.length, 0);
	t.is(parsed.discarded.length, 1);
	t.is(normalizeCitationPath('/absolute/file.ts'), null);
	t.is(normalizeCitationPath('C:\\absolute\\file.ts'), null);
	t.is(normalizeCitationPath('./source/file.ts'), 'source/file.ts');
});

test('parseVerdicts requires a bounded numeric confidence', t => {
	const valid = parseVerdicts(`VERDICT: CONFIRM
ID: F1
CONFIDENCE: 92
REASON: The unguarded access is reachable`);
	const invalid = parseVerdicts(`VERDICT: CONFIRM
ID: F1
CONFIDENCE: 101
REASON: Too confident`);

	t.deepEqual(valid.verdicts, [
		{
			id: 'F1',
			verdict: 'CONFIRM',
			confidence: 92,
			reason: 'The unguarded access is reachable',
		},
	]);
	t.is(invalid.verdicts.length, 0);
	t.is(invalid.discarded.length, 1);
});

test('applyVerdicts confirms only matching verdicts at the threshold', t => {
	const finding = parseFindings(`FINDING
FILE: source/a.ts
LINE: 12
SEVERITY: high
ISSUE: Null access
EVIDENCE: value is used without a guard
END`).findings[0];
	t.truthy(finding);
	if (!finding) return;

	const atThreshold = applyVerdicts(
		[finding],
		[
			{
				id: 'F1',
				verdict: 'CONFIRM',
				confidence: 80,
				reason: 'Reachable',
			},
		],
		80,
	);
	t.is(atThreshold.confirmed.length, 1);
	t.is(atThreshold.confirmed[0]?.confidence, 80);

	const belowThreshold = applyVerdicts(
		[finding],
		[
			{
				id: 'F1',
				verdict: 'CONFIRM',
				confidence: 79,
				reason: 'Probably reachable',
			},
		],
		80,
	);
	t.is(belowThreshold.confirmed.length, 0);
	t.regex(belowThreshold.dropped[0]?.reason ?? '', /below the 80 threshold/);
});

test('applyVerdicts does not transfer a verdict to another finding', t => {
	const findings = parseFindings(`FINDING
FILE: source/a.ts
LINE: 12
SEVERITY: high
ISSUE: First claim
EVIDENCE: First evidence
END
FINDING
FILE: source/a.ts
LINE: 12
SEVERITY: medium
ISSUE: Second claim
EVIDENCE: Second evidence
END`).findings;

	const applied = applyVerdicts(findings, [
		{
			id: 'F1',
			verdict: 'CONFIRM',
			confidence: 95,
			reason: 'First claim verified',
		},
	]);

	t.deepEqual(
		applied.confirmed.map(finding => finding.id),
		['F1'],
	);
	t.is(applied.dropped[0]?.finding.id, 'F2');
	t.is(formatFinding(findings[0]!).split('\n')[0], 'ID: F1');
});
