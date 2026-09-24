import test from 'ava';
import {parseReviewArgs} from './review-tier.js';

test('parseReviewArgs defaults to grounded review', t => {
	t.deepEqual(parseReviewArgs([]), {tier: 'default', args: []});
	t.deepEqual(parseReviewArgs(['feature']), {
		tier: 'default',
		args: ['feature'],
	});
});

test('parseReviewArgs selects quick without consuming its target', t => {
	t.deepEqual(parseReviewArgs(['quick', 'feature']), {
		tier: 'quick',
		args: ['feature'],
	});
});

test('parseReviewArgs accepts an explicit default tier', t => {
	t.deepEqual(parseReviewArgs(['default', '42']), {
		tier: 'default',
		args: ['42'],
	});
});
