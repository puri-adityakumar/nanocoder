import {createHash, randomUUID} from 'node:crypto';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {structuredPatch} from 'diff';
import type {ReviewActivityStore} from './review-activity';
import {
	defaultReviewFoundationTools,
	type ReviewFoundationTools,
	throwIfReviewAborted,
	trackReviewOperation,
} from './review-tools';

export type ReviewScopeKind =
	| 'branch'
	| 'recent-commits'
	| 'pull-request'
	| 'working-tree';

export interface ReviewSnapshotScope {
	kind: ReviewScopeKind;
	description: string;
	commitCount?: number;
}

export interface ReviewLineMap {
	changedBaseLines: number[];
	changedHeadLines: number[];
}

export interface ReviewFileSnapshot {
	path: string;
	status: 'added' | 'modified' | 'deleted';
	baseContent: string | null;
	headContent: string | null;
	isBinary: boolean;
	lineMap: ReviewLineMap;
}

export interface ReviewTargetSnapshot {
	repositoryRoot: string;
	remoteRepository?: string;
	baseTipOid?: string;
	baseOid: string;
	headOid: string;
	headKind: 'commit' | 'working-tree';
	headDigest?: string;
	scope: ReviewSnapshotScope;
	files: ReviewFileSnapshot[];
	capturedAt: number;
}

export interface ReviewSnapshotDependencies {
	tools?: ReviewFoundationTools;
	activity: ReviewActivityStore;
	signal?: AbortSignal;
	now?: () => number;
}

export interface TemporaryReviewRefSet {
	namespace: string;
	fetch: (
		remote: string,
		sourceRef: string,
		key: string,
		expectedOid?: string,
	) => Promise<string>;
	cleanup: () => Promise<void>;
}

export interface ReviewChangedPath {
	path: string;
	status: 'added' | 'modified' | 'deleted';
}

const REVIEW_REF_ROOT = 'refs/nanocoder/review';
const REVIEW_REF_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REVIEW_FILES = 250;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 5 * 1024 * 1024;

function assertOid(oid: string): string {
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)) {
		throw new Error(
			'Git returned an invalid revision ID; the review scope was not pinned.',
		);
	}
	return oid.toLowerCase();
}

export function assertSafeReviewPath(path: string): void {
	if (
		!path ||
		path.includes('\0') ||
		path.includes('\\') ||
		path.startsWith('/') ||
		/^[A-Za-z]:/.test(path) ||
		path.split('/').some(part => part === '..' || part === '')
	) {
		throw new Error(
			'Git returned an unsafe repository path; no files were read.',
		);
	}
}

function parseNameStatusZ(output: string): ReviewChangedPath[] {
	const values = output.split('\0');
	const changed: ReviewChangedPath[] = [];
	for (let index = 0; index < values.length; ) {
		const status = values[index++];
		if (!status) continue;
		if (status.startsWith('R') || status.startsWith('C')) {
			index += 2;
			continue;
		}
		const path = values[index++];
		if (!path) continue;
		assertSafeReviewPath(path);
		if (status === 'A') {
			changed.push({path, status: 'added'});
		} else if (status === 'D') {
			changed.push({path, status: 'deleted'});
		} else {
			changed.push({path, status: 'modified'});
		}
	}
	return changed;
}

function decodeText(buffer: Buffer): string | null {
	if (buffer.includes(0)) return null;
	try {
		return new TextDecoder('utf-8', {fatal: true}).decode(buffer);
	} catch {
		return null;
	}
}

function contentDigest(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex');
}

function absentContent(): {content: null; size: 0; digest: string} {
	return {
		content: null,
		size: 0,
		digest: createHash('sha256').update('[absent]').digest('hex'),
	};
}

function mapChangedLines(
	baseContent: string | null,
	headContent: string | null,
): ReviewLineMap {
	const patch = structuredPatch(
		'file',
		'file',
		baseContent ?? '',
		headContent ?? '',
		undefined,
		undefined,
		{context: 0},
	);
	const changedBaseLines: number[] = [];
	const changedHeadLines: number[] = [];
	for (const hunk of patch.hunks) {
		let baseLine = hunk.oldStart;
		let headLine = hunk.newStart;
		for (const line of hunk.lines) {
			if (line.startsWith('-')) {
				changedBaseLines.push(baseLine++);
			} else if (line.startsWith('+')) {
				changedHeadLines.push(headLine++);
			} else if (line.startsWith(' ')) {
				baseLine++;
				headLine++;
			}
		}
	}
	return {changedBaseLines, changedHeadLines};
}

function makeSnapshot(
	repositoryRoot: string,
	baseOid: string,
	headOid: string,
	headKind: ReviewTargetSnapshot['headKind'],
	scope: ReviewSnapshotScope,
	files: ReviewFileSnapshot[],
	now: () => number,
	headDigest?: string,
	remoteRepository?: string,
	baseTipOid?: string,
): ReviewTargetSnapshot {
	return {
		repositoryRoot,
		...(remoteRepository ? {remoteRepository} : {}),
		...(baseTipOid ? {baseTipOid: assertOid(baseTipOid)} : {}),
		baseOid: assertOid(baseOid),
		headOid: assertOid(headOid),
		headKind,
		...(headDigest ? {headDigest} : {}),
		scope,
		files,
		capturedAt: now(),
	};
}

async function getRepositoryRoot(
	tools: ReviewFoundationTools,
	activity: ReviewActivityStore,
	signal?: AbortSignal,
): Promise<string> {
	const path = await trackReviewOperation(
		activity,
		'tool',
		'git',
		['rev-parse', '--show-toplevel'],
		'Locating the repository root',
		signal,
		() => tools.execGit(['rev-parse', '--show-toplevel'], signal),
	);
	return tools.realpath(path);
}

async function readCommitBlob(
	oid: string,
	path: string,
	dependencies: ReviewSnapshotDependencies,
): Promise<{content: string | null; size: number; digest: string}> {
	const tools = dependencies.tools ?? defaultReviewFoundationTools;
	const objectName = `${assertOid(oid)}:${path}`;
	const objectType = await trackReviewOperation(
		dependencies.activity,
		'tool',
		'git',
		['cat-file', '-t', objectName],
		'Checking changed-file object type',
		dependencies.signal,
		() => tools.execGit(['cat-file', '-t', objectName], dependencies.signal),
	);
	if (objectType !== 'blob') {
		return {
			content: null,
			size: 0,
			digest: createHash('sha256')
				.update(`${objectType}:${objectName}`)
				.digest('hex'),
		};
	}
	const sizeText = await trackReviewOperation(
		dependencies.activity,
		'tool',
		'git',
		['cat-file', '-s', objectName],
		'Checking changed-file size',
		dependencies.signal,
		() => tools.execGit(['cat-file', '-s', objectName], dependencies.signal),
	);
	const size = Number(sizeText);
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new Error('Git returned an invalid changed-file size.');
	}
	if (size > MAX_FILE_BYTES) {
		throw new Error(
			`Changed file "${path}" exceeds the ${MAX_FILE_BYTES / 1024} KiB snapshot limit; no review was started.`,
		);
	}
	const bytes = await trackReviewOperation(
		dependencies.activity,
		'tool',
		'git',
		['cat-file', 'blob', objectName],
		'Reading changed-file content from the pinned revision',
		dependencies.signal,
		() =>
			tools.execGitBuffer(
				['cat-file', 'blob', objectName],
				dependencies.signal,
			),
	);
	return {content: decodeText(bytes), size, digest: contentDigest(bytes)};
}

async function readWorkingTreeContent(
	repositoryRoot: string,
	path: string,
	dependencies: ReviewSnapshotDependencies,
): Promise<{content: string | null; size: number; digest: string}> {
	const tools = dependencies.tools ?? defaultReviewFoundationTools;
	assertSafeReviewPath(path);
	const absolutePath = resolve(repositoryRoot, ...path.split('/'));
	const pathFromRoot = relative(repositoryRoot, absolutePath);
	if (
		!pathFromRoot ||
		pathFromRoot === '..' ||
		pathFromRoot.startsWith(`..${sep}`) ||
		isAbsolute(pathFromRoot)
	) {
		throw new Error(
			'Changed path escaped the repository root; no files were read.',
		);
	}
	const stat = await tools.lstat(absolutePath);
	if (stat.isSymbolicLink()) {
		const target = await tools.readlink(absolutePath);
		const content = Buffer.from(target);
		if (content.byteLength > MAX_FILE_BYTES) {
			throw new Error(`Changed symlink "${path}" exceeds the snapshot limit.`);
		}
		return {
			content: decodeText(content),
			size: content.byteLength,
			digest: contentDigest(content),
		};
	}
	if (!stat.isFile()) {
		throw new Error(
			`Changed path "${path}" is not a regular file; no review was started.`,
		);
	}
	if (stat.size > MAX_FILE_BYTES) {
		throw new Error(
			`Changed file "${path}" exceeds the ${MAX_FILE_BYTES / 1024} KiB snapshot limit; no review was started.`,
		);
	}
	const resolvedPath = await tools.realpath(absolutePath);
	const resolvedRelativePath = relative(repositoryRoot, resolvedPath);
	if (
		resolvedRelativePath === '..' ||
		resolvedRelativePath.startsWith(`..${sep}`) ||
		isAbsolute(resolvedRelativePath)
	) {
		throw new Error(
			'Changed path resolved outside the repository root; no files were read.',
		);
	}
	const content = await tools.readFile(resolvedPath);
	if (content.byteLength > MAX_FILE_BYTES) {
		throw new Error(
			`Changed file "${path}" exceeds the ${MAX_FILE_BYTES / 1024} KiB snapshot limit; no review was started.`,
		);
	}
	return {
		content: decodeText(content),
		size: content.byteLength,
		digest: contentDigest(content),
	};
}

function assertFileCount(files: ReviewChangedPath[]): void {
	if (files.length > MAX_REVIEW_FILES) {
		throw new Error(
			`Review scope has ${files.length} files; the safe snapshot limit is ${MAX_REVIEW_FILES}. Narrow the requested scope.`,
		);
	}
}

export async function createCommitSnapshot(
	input: {
		baseOid: string;
		headOid: string;
		scope: ReviewSnapshotScope;
		remoteRepository?: string;
		baseTipOid?: string;
	},
	dependencies: ReviewSnapshotDependencies,
): Promise<ReviewTargetSnapshot> {
	const tools = dependencies.tools ?? defaultReviewFoundationTools;
	throwIfReviewAborted(dependencies.signal);
	const baseOid = assertOid(input.baseOid);
	const headOid = assertOid(input.headOid);
	const repositoryRoot = await getRepositoryRoot(
		tools,
		dependencies.activity,
		dependencies.signal,
	);
	const nameStatus = await trackReviewOperation(
		dependencies.activity,
		'tool',
		'git',
		[
			'diff',
			'--name-status',
			'-z',
			'--no-renames',
			'--no-ext-diff',
			'--no-color',
			baseOid,
			headOid,
			'--',
		],
		'Finding changed files between pinned revisions',
		dependencies.signal,
		() =>
			tools.execGitBuffer(
				[
					'diff',
					'--name-status',
					'-z',
					'--no-renames',
					'--no-ext-diff',
					'--no-color',
					baseOid,
					headOid,
					'--',
				],
				dependencies.signal,
			),
	);
	const changed = parseNameStatusZ(nameStatus.toString('utf8'));
	assertFileCount(changed);
	const files: ReviewFileSnapshot[] = [];
	let totalBytes = 0;
	for (const file of changed) {
		throwIfReviewAborted(dependencies.signal);
		const base =
			file.status === 'added'
				? absentContent()
				: await readCommitBlob(baseOid, file.path, dependencies);
		const head =
			file.status === 'deleted'
				? absentContent()
				: await readCommitBlob(headOid, file.path, dependencies);
		totalBytes += base.size + head.size;
		if (totalBytes > MAX_TOTAL_FILE_BYTES) {
			throw new Error(
				`Review snapshot exceeds the ${MAX_TOTAL_FILE_BYTES / 1024 / 1024} MiB content limit; narrow the requested scope.`,
			);
		}
		const isBinary =
			(base.content === null && base.size > 0) ||
			(head.content === null && head.size > 0);
		const baseContent = isBinary ? null : base.content;
		const headContent = isBinary ? null : head.content;
		files.push({
			path: file.path,
			status: file.status,
			baseContent,
			headContent,
			isBinary,
			lineMap: mapChangedLines(baseContent, headContent),
		});
	}
	throwIfReviewAborted(dependencies.signal);
	return makeSnapshot(
		repositoryRoot,
		baseOid,
		headOid,
		'commit',
		input.scope,
		files,
		dependencies.now ?? Date.now,
		undefined,
		input.remoteRepository,
		input.baseTipOid,
	);
}

export async function createWorkingTreeSnapshot(
	input: {
		scope: ReviewSnapshotScope;
	},
	dependencies: ReviewSnapshotDependencies,
): Promise<ReviewTargetSnapshot> {
	const tools = dependencies.tools ?? defaultReviewFoundationTools;
	throwIfReviewAborted(dependencies.signal);
	const repositoryRoot = await getRepositoryRoot(
		tools,
		dependencies.activity,
		dependencies.signal,
	);
	const headOid = assertOid(
		await trackReviewOperation(
			dependencies.activity,
			'tool',
			'git',
			['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
			'Pinning the worktree base revision',
			dependencies.signal,
			() =>
				tools.execGit(
					['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
					dependencies.signal,
				),
		),
	);
	const tracked = await trackReviewOperation(
		dependencies.activity,
		'tool',
		'git',
		['diff', '--name-status', '-z', '--no-renames', 'HEAD', '--'],
		'Finding tracked worktree changes',
		dependencies.signal,
		() =>
			tools.execGitBuffer(
				['diff', '--name-status', '-z', '--no-renames', 'HEAD', '--'],
				dependencies.signal,
			),
	);
	const untrackedOutput = await trackReviewOperation(
		dependencies.activity,
		'tool',
		'git',
		['ls-files', '--others', '--exclude-standard', '-z'],
		'Finding untracked worktree files',
		dependencies.signal,
		() =>
			tools.execGitBuffer(
				['ls-files', '--others', '--exclude-standard', '-z'],
				dependencies.signal,
			),
	);
	const changed = parseNameStatusZ(tracked.toString('utf8'));
	const seen = new Set(changed.map(file => file.path));
	for (const path of untrackedOutput
		.toString('utf8')
		.split('\0')
		.filter(Boolean)) {
		assertSafeReviewPath(path);
		if (!seen.has(path)) changed.push({path, status: 'added'});
	}
	assertFileCount(changed);

	const files: ReviewFileSnapshot[] = [];
	let totalBytes = 0;
	const digest = createHash('sha256');
	for (const file of changed) {
		throwIfReviewAborted(dependencies.signal);
		const base =
			file.status === 'added'
				? absentContent()
				: await readCommitBlob(headOid, file.path, dependencies);
		const head =
			file.status === 'deleted'
				? absentContent()
				: await readWorkingTreeContent(repositoryRoot, file.path, dependencies);
		totalBytes += base.size + head.size;
		if (totalBytes > MAX_TOTAL_FILE_BYTES) {
			throw new Error(
				`Worktree snapshot exceeds the ${MAX_TOTAL_FILE_BYTES / 1024 / 1024} MiB content limit; narrow the requested scope.`,
			);
		}
		const isBinary =
			(base.content === null && base.size > 0) ||
			(head.content === null && head.size > 0);
		const baseContent = isBinary ? null : base.content;
		const headContent = isBinary ? null : head.content;
		digest.update(file.path).update('\0').update(file.status).update('\0');
		digest.update(base.digest).update('\0');
		digest.update(head.digest).update('\0');
		files.push({
			path: file.path,
			status: file.status,
			baseContent,
			headContent,
			isBinary,
			lineMap: mapChangedLines(baseContent, headContent),
		});
	}
	throwIfReviewAborted(dependencies.signal);
	return makeSnapshot(
		repositoryRoot,
		headOid,
		headOid,
		'working-tree',
		input.scope,
		files,
		dependencies.now ?? Date.now,
		digest.digest('hex'),
	);
}

function parseTemporaryRef(ref: string): {
	namespace: string;
	createdAt: number;
} | null {
	const match = ref.match(
		/^refs\/nanocoder\/review\/(\d{13}-[0-9a-f-]{36})(?:\/.*)?$/,
	);
	if (!match) return null;
	const createdAt = Number(match[1]?.slice(0, 13));
	if (!Number.isSafeInteger(createdAt)) return null;
	return {
		namespace: `${REVIEW_REF_ROOT}/${match[1]}`,
		createdAt,
	};
}

export async function cleanupStaleReviewRefs(
	tools: ReviewFoundationTools = defaultReviewFoundationTools,
	now: () => number = Date.now,
): Promise<string[]> {
	const refs = await tools.execGit([
		'for-each-ref',
		'--format=%(refname)',
		`${REVIEW_REF_ROOT}/`,
	]);
	const deleted: string[] = [];
	const namespaces = new Map<string, number>();
	for (const ref of refs.split(/\r?\n/).filter(Boolean)) {
		const parsed = parseTemporaryRef(ref);
		if (!parsed || now() - parsed.createdAt <= REVIEW_REF_TTL_MS) continue;
		namespaces.set(parsed.namespace, parsed.createdAt);
	}
	for (const namespace of namespaces.keys()) {
		for (const ref of refs
			.split(/\r?\n/)
			.filter(candidate => candidate.startsWith(`${namespace}/`))) {
			await tools.execGit(['update-ref', '-d', ref]);
			deleted.push(ref);
		}
	}
	return deleted;
}

export async function withTemporaryReviewRefs<T>(
	dependencies: ReviewSnapshotDependencies,
	operation: (refs: TemporaryReviewRefSet) => Promise<T>,
): Promise<T> {
	const tools = dependencies.tools ?? defaultReviewFoundationTools;
	const now = dependencies.now ?? Date.now;
	throwIfReviewAborted(dependencies.signal);
	await trackReviewOperation(
		dependencies.activity,
		'tool',
		'git',
		['for-each-ref', '--format=%(refname)', `${REVIEW_REF_ROOT}/`],
		'Checking for abandoned review refs',
		dependencies.signal,
		() => cleanupStaleReviewRefs(tools, now),
	);

	const namespace = `${REVIEW_REF_ROOT}/${String(now()).padStart(13, '0')}-${randomUUID()}`;
	const createdRefs: string[] = [];
	let operationError: unknown;
	const refs: TemporaryReviewRefSet = {
		namespace,
		fetch: async (remote, sourceRef, key, expectedOid) => {
			throwIfReviewAborted(dependencies.signal);
			if (
				!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/.test(key) ||
				key.includes('..') ||
				key.endsWith('/')
			) {
				throw new Error('Invalid internal snapshot ref name.');
			}
			if (
				!sourceRef.startsWith('refs/') ||
				sourceRef.includes('\0') ||
				sourceRef.includes('..')
			) {
				throw new Error('Remote revision name is not a valid ref.');
			}
			await tools.execGit(['check-ref-format', sourceRef], dependencies.signal);
			const destinationRef = `${namespace}/${key}`;
			createdRefs.push(destinationRef);
			const fetchArgs = [
				'fetch',
				'--no-tags',
				'--no-write-fetch-head',
				'--no-recurse-submodules',
				'--refmap=',
				'--',
				remote,
				`+${sourceRef}:${destinationRef}`,
			];
			await trackReviewOperation(
				dependencies.activity,
				'tool',
				'git fetch',
				fetchArgs,
				'Fetching a pinned remote revision without checkout',
				dependencies.signal,
				() => tools.execGit(fetchArgs, dependencies.signal),
			);
			const oid = assertOid(
				await trackReviewOperation(
					dependencies.activity,
					'tool',
					'git rev-parse',
					[
						'rev-parse',
						'--verify',
						'--end-of-options',
						`${destinationRef}^{commit}`,
					],
					'Verifying the fetched revision ID',
					dependencies.signal,
					() =>
						tools.execGit(
							[
								'rev-parse',
								'--verify',
								'--end-of-options',
								`${destinationRef}^{commit}`,
							],
							dependencies.signal,
						),
				),
			);
			if (expectedOid && oid !== assertOid(expectedOid)) {
				throw new Error(
					'The remote ref changed while the review snapshot was being pinned. Retry after the remote settles.',
				);
			}
			return oid;
		},
		cleanup: async () => {
			const errors: unknown[] = [];
			for (const ref of [...createdRefs].reverse()) {
				try {
					await tools.execGit(['update-ref', '-d', ref]);
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length > 0) {
				throw new AggregateError(
					errors,
					'One or more temporary review refs could not be removed.',
				);
			}
		},
	};

	try {
		return await operation(refs);
	} catch (error) {
		operationError = error;
		throw error;
	} finally {
		try {
			await refs.cleanup();
		} catch (cleanupError) {
			if (operationError) {
				throw new AggregateError(
					[operationError, cleanupError],
					'Review failed and temporary refs could not be removed; rerun /review after checking Git refs under refs/nanocoder/review/.',
				);
			}
			throw new Error(
				'Review completed but temporary refs could not be removed; rerun /review after checking Git refs under refs/nanocoder/review/.',
				{cause: cleanupError},
			);
		}
	}
}
