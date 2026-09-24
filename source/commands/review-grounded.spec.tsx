import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import React from 'react';
import {
	resetSessionCwd,
	setProjectRoot,
} from '@/services/session-cwd';
import {renderWithTheme} from '@/test-utils/render-with-theme';
import type {Message} from '@/types/core';
import {createReviewCommand} from './review.js';

const metadata = {
	provider: 'test',
	model: 'test',
	tokens: 0,
	getMessageTokens: (message: Message) => message.content.length,
};

const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-export const value = safe.value;
+export const value = maybe.value;`;

test.serial('default review runs finder and verifier instead of one-shot chat', async t => {
	const root = mkdtempSync(join(tmpdir(), 'nanocoder-review-command-'));
	t.teardown(() => {
		resetSessionCwd();
		rmSync(root, {recursive: true, force: true});
	});
	writeFileSync(join(root, 'file.ts'), 'export const value = maybe.value;\n');
	setProjectRoot(root);

	const agents: string[] = [];
	const command = createReviewCommand({
		execGit: async args => {
			if (args[0] === 'rev-parse') return '';
			return diff;
		},
		getCurrentBranch: async () => 'feature',
		getDefaultBranch: async () => 'main',
		getExecutor: () => ({
			execute: async task => {
				agents.push(task.subagent_type);
				return {
					subagentName: task.subagent_type,
					success: true,
					executionTimeMs: 1,
					output:
						task.subagent_type === 'review-finder'
							? `FINDING
FILE: file.ts
LINE: 1
SEVERITY: high
ISSUE: maybe can be null
EVIDENCE: maybe.value is read without a guard
END`
							: `VERDICT: CONFIRM
ID: F1
CONFIDENCE: 95
REASON: The nullable value is accessed without a guard`,
				};
			},
		}),
	});

	const output = await command.handler([], [], {
		...metadata,
		client: {
			chat: async () => {
				throw new Error('one-shot chat must not run');
			},
		} as NonNullable<Parameters<typeof command.handler>[2]['client']>,
	});
	t.true(React.isValidElement(output));
	const frame = renderWithTheme(output as React.ReactElement).lastFrame() ?? '';

	t.deepEqual(agents, ['review-finder', 'review-verifier']);
	t.true(frame.includes('Grounded review'));
	t.true(frame.includes('maybe can be null'));
	t.true(frame.includes('confidence'));
	t.true(frame.includes('95'));
});

test.serial('/review quick preserves the one-shot path', async t => {
	let executorCalls = 0;
	let chatCalls = 0;
	const command = createReviewCommand({
		execGit: async args => {
			if (args[0] === 'rev-parse') return '';
			return diff;
		},
		getCurrentBranch: async () => 'feature',
		getDefaultBranch: async () => 'main',
		loadPrompt: () => 'Review prompt',
		getExecutor: () => ({
			execute: async () => {
				executorCalls++;
				throw new Error('executor must not run');
			},
		}),
	});

	const output = await command.handler(['quick'], [], {
		...metadata,
		client: {
			chat: async () => {
				chatCalls++;
				return {
					choices: [{message: {content: 'Quick review result'}}],
				};
			},
		} as NonNullable<Parameters<typeof command.handler>[2]['client']>,
	});
	t.true(React.isValidElement(output));
	const frame = renderWithTheme(output as React.ReactElement).lastFrame() ?? '';

	t.is(executorCalls, 0);
	t.is(chatCalls, 1);
	t.true(frame.includes('Quick review result'));
	t.false(frame.includes('Grounded review'));
});
