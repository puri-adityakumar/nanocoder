/**
 * Line-oriented contracts used between review finders, verifiers, and the
 * deterministic pipeline. Plain text is intentionally used instead of JSON
 * because it is more reliable across the local models Nanocoder supports.
 */

export const REVIEW_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export const REVIEW_VERDICTS = ['CONFIRM', 'REJECT', 'INSUFFICIENT'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const REVIEW_CONFIDENCE_THRESHOLD = 80;

export interface ReviewFinding {
	id: string;
	file: string;
	line: number;
	severity: ReviewSeverity;
	issue: string;
	evidence: string;
}

export interface ReviewVerdictResult {
	id: string;
	verdict: ReviewVerdict;
	confidence: number;
	reason: string;
}

export interface VerifiedFinding extends ReviewFinding {
	confidence: number;
	verificationReason: string;
}

export interface DroppedReviewFinding {
	finding: ReviewFinding;
	verdict: ReviewVerdict | 'UNVERIFIED';
	confidence?: number;
	reason: string;
}

export interface ParsedFindings {
	findings: ReviewFinding[];
	discarded: string[];
	unparseable: boolean;
}

export interface ParsedVerdicts {
	verdicts: ReviewVerdictResult[];
	discarded: string[];
}

/** Normalize and constrain a citation to a workspace-relative path. */
export function normalizeCitationPath(raw: string): string | null {
	const path = raw.trim().replaceAll('\\', '/');
	if (path.startsWith('./')) {
		return normalizeCitationPath(path.slice(2));
	}
	if (
		path.length === 0 ||
		path.startsWith('/') ||
		path.startsWith('~/') ||
		/^[a-zA-Z]:\//.test(path) ||
		path.split('/').includes('..')
	) {
		return null;
	}
	return path;
}

function cleanFieldValue(raw: string): string {
	return raw
		.trim()
		.replace(/^[-*+]\s+/, '')
		.replaceAll('**', '')
		.replaceAll('`', '')
		.trim();
}

function fieldValue(block: string[], key: string): string | null {
	const prefix = `${key}:`;
	for (const line of block) {
		const cleaned = cleanFieldValue(line);
		if (cleaned.toLowerCase().startsWith(prefix.toLowerCase())) {
			const value = cleaned.slice(prefix.length).trim();
			return value || null;
		}
	}
	return null;
}

function parseInteger(raw: string): number | null {
	const value = raw.trim();
	if (!/^\d+$/.test(value)) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseSeverity(raw: string): ReviewSeverity | null {
	const severity = raw.trim().toLowerCase();
	return (REVIEW_SEVERITIES as readonly string[]).includes(severity)
		? (severity as ReviewSeverity)
		: null;
}

function parseVerdict(raw: string): ReviewVerdict | null {
	const verdict = raw.trim().toUpperCase();
	return (REVIEW_VERDICTS as readonly string[]).includes(verdict)
		? (verdict as ReviewVerdict)
		: null;
}

/**
 * Split finder output into blocks. Explicit FINDING/END markers are preferred;
 * markerless FILE fields are accepted for less capable local models.
 */
function findingBlocks(output: string): string[][] {
	const blocks: string[][] = [];
	let current: string[] | null = null;
	let marked = false;

	for (const line of output.split(/\r?\n/)) {
		const trimmed = line.trim().toUpperCase();
		if (trimmed === 'FINDING') {
			if (current?.length) blocks.push(current);
			current = [];
			marked = true;
			continue;
		}
		if (trimmed === 'END' && marked) {
			if (current) blocks.push(current);
			current = null;
			marked = false;
			continue;
		}
		if (
			current &&
			!marked &&
			cleanFieldValue(line).toUpperCase().startsWith('FILE:')
		) {
			blocks.push(current);
			current = [line];
			continue;
		}
		if (current) {
			current.push(line);
		} else if (cleanFieldValue(line).toUpperCase().startsWith('FILE:')) {
			current = [line];
			marked = false;
		}
	}
	if (current?.length) blocks.push(current);
	return blocks;
}

export function parseFindings(output: string): ParsedFindings {
	const findings: ReviewFinding[] = [];
	const discarded: string[] = [];
	const blocks = findingBlocks(output);

	for (const block of blocks) {
		const fileRaw = fieldValue(block, 'FILE');
		const lineRaw = fieldValue(block, 'LINE');
		const severityRaw = fieldValue(block, 'SEVERITY');
		const issue = fieldValue(block, 'ISSUE');
		const evidence = fieldValue(block, 'EVIDENCE');
		const file = fileRaw ? normalizeCitationPath(fileRaw) : null;
		const line = lineRaw ? parseInteger(lineRaw) : null;
		const severity = severityRaw ? parseSeverity(severityRaw) : null;

		if (!file || !line || line <= 0 || !severity || !issue || !evidence) {
			discarded.push(block.join('\n').trim());
			continue;
		}

		findings.push({
			id: `F${findings.length + 1}`,
			file,
			line,
			severity,
			issue,
			evidence,
		});
	}

	return {findings, discarded, unparseable: blocks.length === 0};
}

export function parseVerdicts(output: string): ParsedVerdicts {
	const verdicts: ReviewVerdictResult[] = [];
	const discarded: string[] = [];

	for (const block of output.split(/\r?\n\r?\n/)) {
		const lines = block.split(/\r?\n/);
		const id = fieldValue(lines, 'ID');
		const verdictRaw = fieldValue(lines, 'VERDICT');
		const confidenceRaw = fieldValue(lines, 'CONFIDENCE');
		const reason = fieldValue(lines, 'REASON');
		const verdict = verdictRaw ? parseVerdict(verdictRaw) : null;
		const confidence = confidenceRaw ? parseInteger(confidenceRaw) : null;

		if (
			!id ||
			!verdict ||
			confidence === null ||
			confidence < 0 ||
			confidence > 100 ||
			!reason
		) {
			if (block.trim() && (id || verdictRaw || confidenceRaw)) {
				discarded.push(block.trim());
			}
			continue;
		}

		verdicts.push({id, verdict, confidence, reason});
	}

	return {verdicts, discarded};
}

export function applyVerdicts(
	findings: ReviewFinding[],
	verdicts: ReviewVerdictResult[],
	confidenceThreshold = REVIEW_CONFIDENCE_THRESHOLD,
): {confirmed: VerifiedFinding[]; dropped: DroppedReviewFinding[]} {
	const byId = new Map<string, ReviewVerdictResult>();
	for (const verdict of verdicts) {
		if (!byId.has(verdict.id)) byId.set(verdict.id, verdict);
	}

	const confirmed: VerifiedFinding[] = [];
	const dropped: DroppedReviewFinding[] = [];

	for (const finding of findings) {
		const result = byId.get(finding.id);
		if (!result) {
			dropped.push({
				finding,
				verdict: 'UNVERIFIED',
				reason: 'no valid verifier response',
			});
			continue;
		}
		if (
			result.verdict === 'CONFIRM' &&
			result.confidence >= confidenceThreshold
		) {
			confirmed.push({
				...finding,
				confidence: result.confidence,
				verificationReason: result.reason,
			});
			continue;
		}

		dropped.push({
			finding,
			verdict: result.verdict,
			confidence: result.confidence,
			reason:
				result.verdict === 'CONFIRM'
					? `confidence ${result.confidence} is below the ${confidenceThreshold} threshold: ${result.reason}`
					: result.reason,
		});
	}

	return {confirmed, dropped};
}

export function formatFinding(finding: ReviewFinding): string {
	return [
		`ID: ${finding.id}`,
		`FILE: ${finding.file}`,
		`LINE: ${finding.line}`,
		`SEVERITY: ${finding.severity}`,
		`ISSUE: ${finding.issue}`,
		`EVIDENCE: ${finding.evidence}`,
	].join('\n');
}
