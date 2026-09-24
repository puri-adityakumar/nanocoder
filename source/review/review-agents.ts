/**
 * Built-in read-only agents for the grounded review pipeline. Project and user
 * definitions with the same names take precedence over these defaults.
 */

import type {SubagentLoader} from '@/subagents/subagent-loader.js';
import {
	type SubagentConfigWithSource,
	SubagentLoadPriority,
} from '@/subagents/types.js';

export const REVIEW_READ_ONLY_TOOLS = [
	'git_diff',
	'git_log',
	'read_file',
	'search_file_contents',
	'lsp_get_diagnostics',
] as const;

export const REVIEW_FINDER_AGENT = 'review-finder';
export const REVIEW_VERIFIER_AGENT = 'review-verifier';

const FINDER_SYSTEM_PROMPT = `You are a meticulous code reviewer. Investigate the real code with your read-only tools before reporting an issue.

Rules:
- Report only correctness, security, reliability, or API-contract problems in changed code.
- Skip formatting, naming preferences, missing tests, and problems a compiler or linter already reports.
- Every finding must cite a workspace-relative file and a positive line number you inspected.
- EVIDENCE must quote or precisely describe the code that proves the issue.
- If there are no issues, return an empty final response. Never invent a finding.

Output one block per finding and nothing else:

FINDING
FILE: path/relative/to/project.ts
LINE: <positive line number>
SEVERITY: low | medium | high | critical
ISSUE: <one-line description>
EVIDENCE: <one-line proof from the code>
END`;

const VERIFIER_SYSTEM_PROMPT = `You independently verify one code-review finding. Open the cited code and related callers yourself; do not trust the finder's evidence.

Rules:
- CONFIRM only when the inspected code proves the issue.
- REJECT when code contradicts the claim, a guard prevents it, the behavior is intentional, or the issue predates the reviewed change.
- INSUFFICIENT when the available code cannot establish the truth.
- CONFIDENCE is an integer from 0 to 100 representing confidence in your verdict, not the issue's severity.

Output exactly one block:

VERDICT: CONFIRM | REJECT | INSUFFICIENT
ID: <finding ID, copied exactly>
CONFIDENCE: <integer from 0 to 100>
REASON: <one-line justification grounded in inspected code>`;

export interface ReviewAgentRegistration {
	registered: string[];
	skipped: string[];
}

export async function registerReviewAgents(
	loader: SubagentLoader,
): Promise<ReviewAgentRegistration> {
	await loader.initialize();

	const definitions: SubagentConfigWithSource[] = [
		{
			name: REVIEW_FINDER_AGENT,
			description:
				'Investigates changed code with read-only tools and emits cited findings',
			systemPrompt: FINDER_SYSTEM_PROMPT,
			tools: [...REVIEW_READ_ONLY_TOOLS],
			source: {priority: SubagentLoadPriority.BuiltIn, isBuiltIn: true},
		},
		{
			name: REVIEW_VERIFIER_AGENT,
			description:
				'Independently verifies one cited review finding against the code',
			systemPrompt: VERIFIER_SYSTEM_PROMPT,
			tools: [...REVIEW_READ_ONLY_TOOLS],
			source: {priority: SubagentLoadPriority.BuiltIn, isBuiltIn: true},
		},
	];

	const registered: string[] = [];
	const skipped: string[] = [];
	for (const definition of definitions) {
		const existing = await loader.getSubagent(definition.name);
		if (existing && !existing.source.isBuiltIn) {
			skipped.push(definition.name);
			continue;
		}
		loader.unregisterExternal(definition.name);
		loader.registerExternal(definition);
		registered.push(definition.name);
	}

	return {registered, skipped};
}
