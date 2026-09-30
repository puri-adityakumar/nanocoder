import React from 'react';
import AssistantMessage from '@/components/assistant-message';
import {ReviewActivity} from '@/components/review-activity';
import {DELAY_COMMAND_COMPLETE_MS} from '@/constants';
import {ReviewActivityStore} from '@/review/review-activity';
import {renderGroundedReviewReport} from '@/review/review-report';
import {createReviewMessage} from '@/review/review-session';
import {resolveReviewToolMode} from '@/review/review-tool-mode';
import type {ReviewFoundationTools} from '@/review/review-tools';
import {runDeepReview} from '@/review/run-deep-review';
import {runGroundedReview} from '@/review/run-grounded-review';
import {generateKey} from '@/session/key-generator';
import type {MessageSubmissionOptions} from '@/types/index';
import {formatError} from '@/utils/error-formatter';
import {errorMsg, infoMsg} from '@/utils/message-factory';
import {markRunFailed} from '@/utils/run-outcome';

/** `/review` sub-forms that stay on the one-shot command module. */
const COMMAND_MODULE_FORMS = new Set(['quick', 'activity']);

/**
 * Handles the default grounded `/review`. It needs the live slot (activity
 * view with Escape to cancel) and the transcript (to save the result for
 * session resume), so it runs here instead of as a plain command handler.
 * Returns true if handled.
 */
export async function handleGroundedReviewCommand(
	message: string,
	options: MessageSubmissionOptions,
	dependencies: {tools?: ReviewFoundationTools} = {},
): Promise<boolean> {
	const trimmed = message.trim();
	const match = trimmed.match(/^\/review(?:\s+([\s\S]*))?$/);
	if (!match) return false;
	const request = (match[1] ?? '').trim();
	const firstWord = request.split(/\s+/)[0]?.toLowerCase() ?? '';
	if (COMMAND_MODULE_FORMS.has(firstWord)) return false;
	const deep = firstWord === 'deep';
	const reviewRequest = deep
		? request.split(/\s+/).slice(1).join(' ').trim()
		: request;

	const {
		onAddToChatQueue,
		onCommandComplete,
		setLiveComponent,
		setLiveComponentCapturesInput,
		setIsToolExecuting,
		client,
	} = options;

	onAddToChatQueue(infoMsg(`$ ${trimmed}`, 'command-invocation'));
	if (!client) {
		onAddToChatQueue(errorMsg('No active LLM client available.', 'review'));
		onCommandComplete?.();
		return true;
	}

	const tier = deep ? 'Deep' : 'Grounded';
	const activity = new ReviewActivityStore();
	const controller = new AbortController();
	setIsToolExecuting(true);
	setLiveComponentCapturesInput(true);
	setLiveComponent(
		React.createElement(ReviewActivity, {
			key: generateKey('review-activity-live'),
			store: activity,
			title: `${tier} review`,
			interactive: true,
			onCancel: () => controller.abort(),
		}),
	);

	try {
		const runReview = deep ? runDeepReview : runGroundedReview;
		const result = await runReview({
			request: reviewRequest,
			client,
			toolMode: resolveReviewToolMode(
				options.provider,
				options.model,
				options.tune,
			),
			activity,
			signal: controller.signal,
			...(dependencies.tools ? {tools: dependencies.tools} : {}),
		});
		const report = renderGroundedReviewReport(result, tier);
		if (result.status === 'failed') {
			markRunFailed(result.message ?? 'review failed');
		}
		setLiveComponent(null);
		onAddToChatQueue(
			React.createElement(ReviewActivity, {
				key: generateKey('review-activity-final'),
				summary: result.activity,
				title: `${tier} review`,
				recentCount: 0,
			}),
		);
		onAddToChatQueue(
			React.createElement(AssistantMessage, {
				key: generateKey('review-report'),
				message: report,
				model: options.model,
				showUsageFooter: false,
			}),
		);
		options.setMessages([
			...options.messages,
			createReviewMessage({
				report,
				tier,
				status: result.status,
				activity: result.activity,
			}),
		]);
	} catch (error) {
		markRunFailed(formatError(error));
		setLiveComponent(null);
		onAddToChatQueue(
			errorMsg(`Review failed: ${formatError(error)}`, 'review-error'),
		);
	} finally {
		setLiveComponentCapturesInput(false);
		setIsToolExecuting(false);
		setTimeout(() => onCommandComplete?.(), DELAY_COMMAND_COMPLETE_MS);
	}
	return true;
}
