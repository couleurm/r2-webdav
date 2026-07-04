// Anonymous-browser UI: the HTML directory listing and the markdown-to-HTML
// document view. Only ever reached in web mode (unauthenticated GET/HEAD).

import { marked } from 'marked';

import type { DavBucket } from './bucket';
import { isCollectionEntry, isDirectoryEntry, listEntries } from './storage';
import { getParentPath, getResourceHref } from './paths';
import { escapeXml } from './xml';

function formatFileSize(size: number): string {
	let units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	let index = 0;
	while (size >= 1024 && index < units.length - 1) {
		size /= 1024;
		index++;
	}
	return `${index === 0 ? size : size.toFixed(1)} ${units[index]}`;
}

// Directories are served under their trailing-slash URL so that relative
// links in the listing resolve correctly.
export function redirectToCollection(resourcePath: string): Response {
	return new Response(null, {
		status: 301,
		headers: { Location: getResourceHref(resourcePath, true) },
	});
}

type ListingRow = {
	name: string;
	href: string;
	isDirectory: boolean;
	sizeBytes: number | null;
	modifiedMs: number | null;
};

// Aggregating a listing walks every descendant of the directory
// (ceil(N/1000) R2 list calls), so the resulting rows are cached in the
// colo-local HTTP cache under a synthetic URL per directory, independent of
// the sort parameters. Successful WebDAV mutations purge the affected
// ancestors (purgeListingCache, called from the worker entry), so writes
// through the worker are visible immediately; uploads that bypass it (S3
// API, dashboard) surface once the TTL expires.
const LISTING_CACHE_TTL_SECONDS = 60;

function listingCacheUrl(resourcePath: string): string {
	return `https://listing-cache.internal/${encodeURIComponent(resourcePath)}`;
}

// The Workers-specific default cache; this @cloudflare/workers-types version
// doesn't declare it on CacheStorage.
function defaultCache(): Cache {
	return (caches as unknown as { default: Cache }).default;
}

// Drops the cached listing rows of every ancestor directory of the given
// bucket-absolute paths (a mutation changes the size/modified aggregate of
// the whole ancestor chain, and root aggregates everything).
export async function purgeListingCache(resourcePaths: string[]): Promise<void> {
	let cache = defaultCache();
	let targets = new Set<string>();
	for (const resourcePath of resourcePaths) {
		for (let current = resourcePath; ; current = getParentPath(current)) {
			targets.add(current);
			if (current === '') {
				break;
			}
		}
	}
	await Promise.all([...targets].map((target) => cache.delete(listingCacheUrl(target))));
}

// A single recursive walk yields the same immediate children as the
// non-recursive listing (a directory appears iff it has a marker or any
// descendant), and additionally lets us aggregate each directory's total
// size and newest upload time from its descendants. R2 has no directory
// mtime, so "modified" is the max `uploaded` over everything inside,
// including explicit MKCOL markers (which gives empty explicit dirs their
// creation time).
async function collectListingRows(bucket: DavBucket, resourcePath: string): Promise<ListingRow[]> {
	let prefix = resourcePath === '' ? '' : resourcePath + '/';
	let directories = new Map<string, { sizeBytes: number; modifiedMs: number | null }>();
	let files: ListingRow[] = [];
	for await (let entry of listEntries(bucket, prefix, true)) {
		let relativeKey = entry.key.slice(prefix.length);
		let childName = relativeKey.split('/')[0];
		if (childName === '') {
			// An object whose key is literally the prefix + '/' (e.g. a stray
			// key of '/' at the root) has no name to list under.
			continue;
		}
		if (!isDirectoryEntry(entry) && !relativeKey.includes('/') && !isCollectionEntry(entry)) {
			files.push({
				name: childName,
				href: getResourceHref(entry.key, false),
				isDirectory: false,
				sizeBytes: entry.size,
				modifiedMs: entry.uploaded.getTime(),
			});
			continue;
		}
		let aggregate = directories.get(childName) ?? { sizeBytes: 0, modifiedMs: null };
		if (!isDirectoryEntry(entry)) {
			aggregate.sizeBytes += entry.size;
			aggregate.modifiedMs = Math.max(aggregate.modifiedMs ?? 0, entry.uploaded.getTime());
		}
		directories.set(childName, aggregate);
	}
	let rows: ListingRow[] = [...directories.entries()].map(([childName, aggregate]) => ({
		name: childName + '/',
		href: getResourceHref(prefix + childName, true),
		isDirectory: true,
		sizeBytes: aggregate.sizeBytes,
		modifiedMs: aggregate.modifiedMs,
	}));
	rows.push(...files);
	return rows;
}

async function getListingRows(bucket: DavBucket, resourcePath: string): Promise<ListingRow[]> {
	let cache = defaultCache();
	let cacheKey = listingCacheUrl(resourcePath);
	let cached = await cache.match(cacheKey);
	if (cached !== undefined) {
		return (await cached.json()) as ListingRow[];
	}
	let rows = await collectListingRows(bucket, resourcePath);
	await cache.put(
		cacheKey,
		new Response(JSON.stringify(rows), {
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': `max-age=${LISTING_CACHE_TTL_SECONDS}`,
			},
		}),
	);
	return rows;
}

export async function renderDirectoryListing(bucket: DavBucket, resourcePath: string, url: URL): Promise<Response> {
	let prefix = resourcePath === '' ? '' : resourcePath + '/';
	let rows = await getListingRows(bucket, resourcePath);

	type SortKey = 'name' | 'size' | 'modified';
	let sortParam = url.searchParams.get('sort');
	let sort: SortKey = sortParam === 'size' || sortParam === 'modified' ? sortParam : 'name';
	let order: 'asc' | 'desc' = url.searchParams.get('order') === 'desc' ? 'desc' : 'asc';
	let direction = order === 'desc' ? -1 : 1;
	const compareBySortKey = (left: ListingRow, right: ListingRow): number => {
		if (sort === 'size') return (left.sizeBytes ?? -1) - (right.sizeBytes ?? -1);
		if (sort === 'modified') return (left.modifiedMs ?? -1) - (right.modifiedMs ?? -1);
		return left.name.localeCompare(right.name);
	};
	// Directories always group before files; the sort applies within each group.
	rows.sort((left, right) =>
		left.isDirectory !== right.isDirectory
			? left.isDirectory
				? -1
				: 1
			: compareBySortKey(left, right) * direction || left.name.localeCompare(right.name),
	);
	if (resourcePath !== '') {
		rows.unshift({
			name: '../',
			href: getResourceHref(getParentPath(resourcePath), true),
			isDirectory: true,
			sizeBytes: null,
			modifiedMs: null,
		});
	}

	let breadcrumbs = `<a href="/">root</a>`;
	let ancestorPath = '';
	for (let segment of resourcePath === '' ? [] : resourcePath.split('/')) {
		ancestorPath = ancestorPath === '' ? segment : `${ancestorPath}/${segment}`;
		breadcrumbs += ` / <a href="${escapeXml(getResourceHref(ancestorPath, true))}">${escapeXml(segment)}</a>`;
	}

	let listing = rows
		.map((row) => {
			let size = row.sizeBytes === null ? '' : formatFileSize(row.sizeBytes);
			let modified =
				row.modifiedMs === null ? '' : new Date(row.modifiedMs).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
			return `<tr><td><a class="${row.isDirectory ? 'dir' : 'file'}" href="${escapeXml(row.href)}">${escapeXml(row.name)}</a></td><td class="size">${escapeXml(size)}</td><td class="modified">${escapeXml(modified)}</td></tr>`;
		})
		.join('\n');
	if (listing === '') {
		listing = '<tr><td class="empty" colspan="3">This directory is empty.</td></tr>';
	}

	// Each header is a link that sorts by its column; clicking the active
	// column again flips the order. Relative `?query` hrefs keep the current
	// directory path.
	const headerCell = (label: string, key: SortKey) => {
		let isActive = sort === key;
		let nextOrder = isActive && order === 'asc' ? 'desc' : 'asc';
		let arrow = isActive ? (order === 'asc' ? ' ▲' : ' ▼') : '';
		return `<th><a href="?sort=${key}&amp;order=${nextOrder}">${label}${arrow}</a></th>`;
	};
	let tableHeader = headerCell('Name', 'name') + headerCell('Size', 'size') + headerCell('Modified', 'modified');

	let pageSource = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>/${escapeXml(resourcePath)}</title>
<style>
*{box-sizing:border-box;}
body{margin:0;padding:24px;font-family:'Segoe UI','Roboto','Helvetica Neue',sans-serif;background:#f8fafc;color:#1e293b;}
h1{font-size:20px;margin:0 0 16px;}
.breadcrumbs{margin-bottom:16px;font-size:14px;color:#64748b;word-break:break-all;}
.breadcrumbs a{color:#2563eb;text-decoration:none;}
.breadcrumbs a:hover{text-decoration:underline;}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;}
th{text-align:left;padding:8px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;background:#f1f5f9;border-bottom:1px solid #e2e8f0;}
th a{color:inherit;text-decoration:none;}
th a:hover{color:#2563eb;}
td{padding:6px 12px;font-size:14px;border-bottom:1px solid #f1f5f9;}
tr:last-child td{border-bottom:none;}
tr:hover td{background:#f8fafc;}
td a{display:block;color:#1e293b;text-decoration:none;word-break:break-all;}
td a:hover{color:#2563eb;}
td a.dir{font-weight:600;}
td a.dir::before{content:'📁 ';}
td a.file::before{content:'📄 ';}
td.size,td.modified{width:1%;text-align:right;color:#64748b;white-space:nowrap;}
td.empty{padding:32px;text-align:center;color:#94a3b8;}
</style>
</head>
<body>
<div class="breadcrumbs">${breadcrumbs}</div>
<table>
<thead><tr>${tableHeader}</tr></thead>
<tbody>
${listing}
</tbody>
</table>
</body>
</html>`;

	return new Response(pageSource, {
		status: 200,
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
	});
}

// Serves a text/markdown object converted to HTML (see the conversion rules in
// handleGet). By default the converted fragment is wrapped in a minimal page
// shell styled like the directory listing; `?bare=1` skips the shell and
// returns just the fragment, for embedding (e.g. fetched by an SPA).
//
// Caching: the response reuses the source object's ETag/Last-Modified. The
// converted view lives at its own URL (`?type=text/html`), so sharing the
// ETag with the raw view is sound, and checkPreconditions has already run —
// browser revalidation 304s before any conversion work happens.
export async function renderMarkdownDocument(
	bucket: DavBucket,
	resourcePath: string,
	object: R2ObjectBody,
	url: URL,
): Promise<Response> {
	// A byte range of the markdown source is meaningless for the converted
	// document: ignore the range (RFC 9110 allows this) and render the whole
	// file, re-reading it if the ranged GET only fetched a slice.
	let body = object;
	if (object.range !== undefined) {
		let full = await bucket.get(resourcePath);
		if (full === null) {
			return new Response('Not Found', { status: 404 });
		}
		body = full;
	}
	let fragment = await marked.parse(await body.text());
	let bare = url.searchParams.get('bare') === '1';
	let fileName = resourcePath.split('/').pop() ?? resourcePath;
	return new Response(bare ? fragment : renderMarkdownShell(fileName, fragment), {
		status: 200,
		headers: {
			// Deliberately no passthrough of stored Content-Disposition /
			// Content-Encoding etc. — those describe the stored bytes, not
			// this converted document.
			'Content-Type': 'text/html; charset=utf-8',
			ETag: object.httpEtag,
			'Last-Modified': object.uploaded.toUTCString(),
		},
	});
}

// Page shell for rendered markdown: same palette/typeface as the directory
// listing, content in the same card style, plus basic typography for the
// elements markdown produces and listings don't have.
function renderMarkdownShell(fileName: string, fragment: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escapeXml(fileName)}</title>
<style>
body {font-family: sans-serif;margin: 5ex 10ex;}
tt, pre {font-family: WebKitWorkaround, monospace;}
#content {float: left;max-width: 65ex;margin-right: 5ex;}
#sidebar {float: left;max-width: 20ex;}
h1 {font-weight: normal;margin-bottom: 0;}
h2 {font-size: 100%;margin-bottom: 0;}
*{box-sizing:border-box;}
main>:first-child{margin-top:0;}
main>:last-child{margin-bottom:0;}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.4em 0 .5em;}
h1{font-size:26px;border-bottom:1px solid #e2e8f0;padding-bottom:.3em;}
h2{font-size:21px;border-bottom:1px solid #f1f5f9;padding-bottom:.3em;}
a{color:#2563eb;text-decoration:none;}
a:hover{text-decoration:underline;}
code{font-family:ui-monospace,'Cascadia Code',Menlo,Consolas,monospace;font-size:85%;background:#f1f5f9;padding:.15em .35em;border-radius:4px;}
pre{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;overflow-x:auto;}
pre code{background:none;padding:0;font-size:13px;}
blockquote{margin:1em 0;padding:0 1em;color:#64748b;border-left:3px solid #e2e8f0;}
table{border-collapse:collapse;display:block;overflow-x:auto;}
th,td{border:1px solid #e2e8f0;padding:6px 12px;font-size:14px;}
th{background:#f1f5f9;text-align:left;}
img{max-width:100%;}
hr{border:none;border-top:1px solid #e2e8f0;margin:24px 0;}
</style>
</head>
<body>
<main>
${fragment}
</main>
</body>
</html>`;
}
