export type ReviewTier = 'default' | 'quick';

export interface ParsedReviewArgs {
	tier: ReviewTier;
	args: string[];
}

/** `/review quick` selects v1; every other first argument remains a target. */
export function parseReviewArgs(args: string[]): ParsedReviewArgs {
	const [first, ...rest] = args;
	if (first?.toLowerCase() === 'quick') {
		return {tier: 'quick', args: rest};
	}
	if (first?.toLowerCase() === 'default') {
		return {tier: 'default', args: rest};
	}
	return {tier: 'default', args};
}
