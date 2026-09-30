import {Box, Text, useInput} from 'ink';
import {useEffect, useReducer, useRef, useState} from 'react';
import {useTheme} from '@/hooks/useTheme';
import type {
	ReviewActivityEvent,
	ReviewActivityStore,
	ReviewActivitySummary,
} from '@/review/review-activity';

export type ReviewActivityProps = {
	title?: string;
	onCancel?: () => void;
	interactive?: boolean;
	/** Start with details shown (used by `/review activity`). */
	expanded?: boolean;
	/** Events shown in the collapsed view. */
	recentCount?: number;
	/** Upper bound on events shown when expanded. */
	maxExpandedEvents?: number;
} & (
	| {store: ReviewActivityStore; summary?: never}
	| {summary: ReviewActivitySummary; store?: never}
);

function elapsedLabel(durationMs: number | undefined): string {
	if (durationMs === undefined) return 'running';
	if (durationMs < 1000) return `${durationMs}ms`;
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function statusLabel(event: ReviewActivityEvent): string {
	return `${event.status} · ${elapsedLabel(event.durationMs)}`;
}

function latestSummary(event: ReviewActivityEvent): string {
	return event.updates[event.updates.length - 1]?.summary ?? event.name;
}

function countBySource(
	events: readonly ReviewActivityEvent[],
	source: ReviewActivityEvent['source'],
): number {
	return events.filter(event => event.source === source).length;
}

export function ReviewActivity({
	store,
	summary: staticSummary,
	title = 'Review',
	onCancel,
	interactive = false,
	expanded: initiallyExpanded = false,
	recentCount = 3,
	maxExpandedEvents = 80,
}: ReviewActivityProps): React.ReactElement {
	const {colors} = useTheme();
	const [, forceRender] = useReducer((value: number) => value + 1, 0);
	const [expanded, setExpanded] = useState(initiallyExpanded);
	const [cancelRequestedView, setCancelling] = useState(false);
	const cancelRequested = useRef(false);

	useEffect(() => {
		cancelRequested.current = false;
		setCancelling(false);
		return store?.subscribe(forceRender);
	}, [store]);

	useInput(
		(input, key) => {
			if (input === 'd' || input === 'D') {
				setExpanded(value => !value);
				return;
			}
			if (
				key.escape &&
				store?.getStatus() === 'running' &&
				onCancel &&
				!cancelRequested.current
			) {
				cancelRequested.current = true;
				setCancelling(true);
				onCancel();
			}
		},
		{isActive: interactive},
	);

	const summary = store ? store.toSummary() : staticSummary;
	const expandedEvents = summary.events.slice(-maxExpandedEvents);
	const hiddenByLimit = summary.events.length - expandedEvents.length;
	const events = expanded ? expandedEvents : summary.events.slice(-recentCount);
	const running = summary.status === 'running';
	const statusColor =
		summary.status === 'completed'
			? colors.success
			: summary.status === 'failed'
				? colors.error
				: summary.status === 'cancelled'
					? colors.warning
					: colors.primary;
	const agents = countBySource(summary.events, 'agent');
	const toolCalls = countBySource(summary.events, 'tool');
	const apiCalls = countBySource(summary.events, 'api');
	const cancelling = running && cancelRequestedView;

	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<Text color={colors.secondary}>{title} · </Text>
				<Text color={statusColor}>
					{cancelling ? 'cancelling' : summary.status}
				</Text>
				<Text color={colors.secondary}>
					{' '}
					· {agents} agent{agents === 1 ? '' : 's'} · {toolCalls} tool call
					{toolCalls === 1 ? '' : 's'} · {apiCalls} API call
					{apiCalls === 1 ? '' : 's'}
				</Text>
				{summary.droppedEventCount + (expanded ? hiddenByLimit : 0) > 0 && (
					<Text color={colors.secondary}>
						{' '}
						· {summary.droppedEventCount + (expanded ? hiddenByLimit : 0)}{' '}
						earlier steps omitted
					</Text>
				)}
			</Box>

			{events.map(event => (
				<Box
					key={event.id}
					flexDirection="column"
					marginLeft={event.parentId ? 4 : 2}
				>
					<Box>
						<Text color={colors.secondary}>
							{event.source}: {event.name}
						</Text>
						<Text color={colors.secondary}> — {statusLabel(event)}</Text>
					</Box>
					<Text color={colors.primary}>{latestSummary(event)}</Text>
					{expanded && event.safeArgs && (
						<Text color={colors.secondary}>
							args: {event.safeArgs.join(' ')}
						</Text>
					)}
					{expanded &&
						event.updates.length > 1 &&
						event.updates.slice(0, -1).map((update, index) => (
							<Text
								key={`${event.id}:update:${index}`}
								color={colors.secondary}
							>
								{new Date(update.at).toLocaleTimeString()} · {update.summary}
							</Text>
						))}
					{expanded && event.error && (
						<Text color={colors.error}>Error: {event.error}</Text>
					)}
				</Box>
			))}

			{interactive && (
				<Text color={colors.secondary} dimColor>
					{running
						? `D details${onCancel ? ' · Esc cancel' : ''}`
						: 'D details'}
				</Text>
			)}
		</Box>
	);
}
