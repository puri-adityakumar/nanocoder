import type {DroppedReviewFinding, VerifiedFinding} from './finding-format.js';
import type {DefaultReviewResult} from './run-default-review.js';

const SEVERITY_ORDER: Record<string, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};

function sortedBySeverity(findings: VerifiedFinding[]): VerifiedFinding[] {
	return [...findings].sort(
		(left, right) =>
			(SEVERITY_ORDER[left.severity] ?? 9) -
			(SEVERITY_ORDER[right.severity] ?? 9),
	);
}

function renderDroppedFinding(entry: DroppedReviewFinding): string {
	const confidence =
		entry.confidence === undefined ? '' : `, confidence ${entry.confidence}`;
	return `- **${entry.verdict}** \`${entry.finding.file}:${entry.finding.line}\` — ${entry.finding.issue} (${entry.reason}${confidence})`;
}

export function renderReviewReport(
	result: DefaultReviewResult,
	targetDescription: string,
): string {
	const sections = [`## Grounded review — ${targetDescription}`];

	if (result.confirmed.length === 0) {
		sections.push('**No verified issues found.**');
	} else {
		sections.push('### Verified findings');
		for (const finding of sortedBySeverity(result.confirmed)) {
			sections.push(
				[
					`- **${finding.severity.toUpperCase()}** \`${finding.file}:${finding.line}\` — ${finding.issue}`,
					`  Evidence: ${finding.evidence}`,
					`  Verification: ${finding.verificationReason} (confidence ${finding.confidence})`,
				].join('\n'),
			);
		}
	}

	if (result.dropped.length > 0) {
		sections.push('### Dropped findings');
		sections.push(result.dropped.map(renderDroppedFinding).join('\n'));
	}

	if (result.notes.length > 0) {
		sections.push('### Notes');
		sections.push(result.notes.map(note => `- ${note}`).join('\n'));
	}

	const totalTokens = result.usage.finder + result.usage.verifier;
	if (totalTokens > 0) {
		sections.push(
			`_Approximate token usage: finder ${result.usage.finder}, verifiers ${result.usage.verifier}._`,
		);
	}

	return sections.join('\n\n');
}
