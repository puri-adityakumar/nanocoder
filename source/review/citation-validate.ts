/**
 * Deterministic validation for model-produced file:line citations. Invalid
 * citations are rejected before they consume a verifier run.
 */

import {readFileSync, realpathSync} from 'node:fs';
import {isAbsolute, relative, resolve, sep} from 'node:path';

export interface ChangedLines {
	files: Map<string, Set<number>>;
}

export interface Citation {
	file: string;
	line: number;
}

export interface CitationValidationResult {
	valid: Citation[];
	invalid: Array<Citation & {reason: string}>;
}

function lineCount(projectRoot: string, file: string): number | null {
	try {
		const root = realpathSync(resolve(projectRoot));
		const absolute = realpathSync(resolve(root, file));
		const pathFromRoot = relative(root, absolute);
		if (
			pathFromRoot === '..' ||
			pathFromRoot.startsWith(`..${sep}`) ||
			isAbsolute(pathFromRoot)
		) {
			return null;
		}
		const lines = readFileSync(absolute, 'utf8').split('\n');
		if (lines.at(-1) === '') lines.pop();
		return lines.length;
	} catch {
		return null;
	}
}

/** Parse new-file line numbers from a unified diff. */
export function changedLinesFromDiff(diff: string): ChangedLines {
	const files = new Map<string, Set<number>>();
	let currentFile: string | null = null;
	let newLine = 0;

	for (const line of diff.split('\n')) {
		if (line.startsWith('+++ b/')) {
			currentFile = line.slice(6).trim();
			continue;
		}
		if (line.startsWith('+++ ')) {
			currentFile = null;
			continue;
		}
		if (line.startsWith('@@')) {
			const match = line.match(/\+(\d+)/);
			if (match?.[1] && currentFile) {
				newLine = Number.parseInt(match[1], 10);
			}
			continue;
		}
		if (!currentFile) continue;

		if (line.startsWith('+') || line.startsWith(' ')) {
			if (!line.startsWith('+++')) {
				const changed = files.get(currentFile) ?? new Set<number>();
				changed.add(newLine);
				files.set(currentFile, changed);
				newLine++;
			}
		} else if (!line.startsWith('-') && !line.startsWith('\\')) {
			currentFile = null;
		}
	}

	return {files};
}

export function validateCitations(
	projectRoot: string,
	citations: Citation[],
	changed?: ChangedLines,
): CitationValidationResult {
	const valid: Citation[] = [];
	const invalid: CitationValidationResult['invalid'] = [];

	for (const citation of citations) {
		const totalLines = lineCount(projectRoot, citation.file);
		if (totalLines === null) {
			invalid.push({
				...citation,
				reason: `file not found under project root: ${citation.file}`,
			});
			continue;
		}
		if (citation.line > totalLines) {
			invalid.push({
				...citation,
				reason: `line ${citation.line} is past end of file (${totalLines} lines)`,
			});
			continue;
		}

		if (changed) {
			const changedSet = changed.files.get(citation.file);
			const nearChange =
				changedSet &&
				[...changedSet].some(line => Math.abs(line - citation.line) <= 3);
			if (!nearChange) {
				invalid.push({
					...citation,
					reason: changedSet
						? `line ${citation.line} is not in or near the changed hunks`
						: `file is not part of the reviewed changes: ${citation.file}`,
				});
				continue;
			}
		}

		valid.push(citation);
	}

	return {valid, invalid};
}
