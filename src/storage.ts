// The directory model on top of R2's flat keyspace.
//
// R2 has no real directories. A directory exists in one of two forms: an
// explicit zero-byte marker object with `resourcetype: '<collection />'`
// custom metadata (created by MKCOL), or implicitly as a slash-separated key
// prefix of other objects (anything uploaded through the S3 API or the
// dashboard). Implicit directories have no backing R2Object, so listings
// represent them with the synthetic DirectoryEntry.

import type { DavBucket } from './bucket';

export type DirectoryEntry = {
	kind: 'directory';
	key: string; // without trailing slash; '' is the bucket root
};

export function isDirectoryEntry(entry: R2Object | DirectoryEntry): entry is DirectoryEntry {
	return 'kind' in entry && entry.kind === 'directory';
}

export function isCollectionEntry(entry: R2Object | DirectoryEntry): boolean {
	return isDirectoryEntry(entry) || entry.customMetadata?.resourcetype === '<collection />';
}

export async function* listAll(bucket: DavBucket, prefix: string, isRecursive: boolean = false) {
	let cursor: string | undefined = undefined;
	let listed: R2Objects;
	do {
		listed = await bucket.list({
			prefix: prefix,
			delimiter: isRecursive ? undefined : '/',
			cursor: cursor,
			// @ts-ignore https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions
			include: ['httpMetadata', 'customMetadata'],
		});

		for (let object of listed.objects) {
			yield object;
		}

		if (listed.truncated) {
			cursor = listed.cursor;
		}
	} while (listed.truncated);
}

// Lists the members of the collection at `prefix` (all descendants when
// `isRecursive`), including implicit directories. Non-recursive listings get
// them from `delimitedPrefixes`; recursive listings synthesize the ancestor
// directories of every key. Deduplication against explicit markers relies on
// R2's lexicographic list order: a marker key ("a/b") always sorts before the
// keys of its children ("a/b/..."), so it is recorded in `seenDirectories`
// before anything could synthesize the same directory — even across pages.
export async function* listEntries(
	bucket: DavBucket,
	prefix: string,
	isRecursive: boolean = false,
): AsyncGenerator<R2Object | DirectoryEntry> {
	let seenDirectories = new Set<string>();
	const directoryEntries = function* (directoryKey: string): Generator<DirectoryEntry> {
		// Never yield the listed collection as a member of itself: its own
		// marker (directoryKey + '/' === prefix), and at the root a pathological
		// object whose key is literally '/' (directoryKey === ''), which used to
		// surface the root inside its own listing.
		if (directoryKey !== '' && directoryKey + '/' !== prefix && !seenDirectories.has(directoryKey)) {
			seenDirectories.add(directoryKey);
			yield { kind: 'directory', key: directoryKey };
		}
	};

	let cursor: string | undefined = undefined;
	let listed: R2Objects;
	do {
		listed = await bucket.list({
			prefix: prefix,
			delimiter: isRecursive ? undefined : '/',
			cursor: cursor,
			// @ts-ignore https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions
			include: ['httpMetadata', 'customMetadata'],
		});

		for (let object of listed.objects) {
			if (isRecursive) {
				let segments = object.key.slice(prefix.length).split('/');
				for (let index = 1; index < segments.length; index++) {
					yield* directoryEntries(prefix + segments.slice(0, index).join('/'));
				}
			}
			if (object.key.endsWith('/')) {
				// Zero-byte "folder marker" convention used by some S3 clients.
				yield* directoryEntries(object.key.slice(0, -1));
				continue;
			}
			if (object.customMetadata?.resourcetype === '<collection />') {
				seenDirectories.add(object.key);
			}
			yield object;
		}
		for (let delimitedPrefix of listed.delimitedPrefixes) {
			yield* directoryEntries(delimitedPrefix.slice(0, -1));
		}

		if (listed.truncated) {
			cursor = listed.cursor;
		}
	} while (listed.truncated);
}

// True when the path is a directory that exists only as a key prefix of other
// objects (no marker object of its own). The root always exists.
export async function hasImplicitDirectory(bucket: DavBucket, resourcePath: string): Promise<boolean> {
	if (resourcePath === '') {
		return true;
	}
	let listed = await bucket.list({ prefix: resourcePath + '/', limit: 1 });
	return listed.objects.length > 0;
}

export async function hasCollectionResource(bucket: DavBucket, resourcePath: string): Promise<boolean> {
	if (resourcePath === '') {
		return true;
	}

	let resource = await bucket.head(resourcePath);
	if (resource?.customMetadata?.resourcetype === '<collection />') {
		return true;
	}
	return await hasImplicitDirectory(bucket, resourcePath);
}

// Maps a path to the resource it names: an R2 object (file or explicit
// collection marker), a synthetic entry for the root or an implicit
// directory, or null when nothing exists there.
export async function resolveResource(
	bucket: DavBucket,
	resourcePath: string,
): Promise<R2Object | DirectoryEntry | null> {
	if (resourcePath === '') {
		return { kind: 'directory', key: '' };
	}
	let object = await bucket.head(resourcePath);
	if (object !== null) {
		return object;
	}
	if (await hasImplicitDirectory(bucket, resourcePath)) {
		return { kind: 'directory', key: resourcePath };
	}
	return null;
}

export async function deleteAllWithPrefix(bucket: DavBucket, prefix: string): Promise<void> {
	let cursor: string | undefined = undefined;
	let listed: R2Objects;
	do {
		listed = await bucket.list({
			prefix: prefix,
			cursor: cursor,
		});
		let keys = listed.objects.map((object) => object.key);
		if (keys.length > 0) {
			await bucket.delete(keys);
		}

		if (listed.truncated) {
			cursor = listed.cursor;
		}
	} while (listed.truncated);
}
