// Worker entry point: decides who the request acts as (authenticated
// per-user mount, anonymous public web view, or rejected) and applies CORS.
// Everything protocol-shaped lives in dav.ts.

import { authenticate } from './auth';
import { ScopedBucket } from './bucket';
import { SUPPORT_METHODS, dispatchHandler } from './dav';
import { makeResourcePath, parseDestinationPath } from './paths';
import { purgeListingCache } from './web';

// Methods that may change bucket contents or object metadata (LOCK/PROPPATCH
// re-put the object, which refreshes its `uploaded` time), and therefore the
// cached directory-listing aggregates of the ancestor chain.
const MUTATING_METHODS = new Set(['PUT', 'POST', 'DELETE', 'MKCOL', 'COPY', 'MOVE', 'PROPPATCH', 'LOCK', 'UNLOCK']);

// Bucket-absolute paths a jailed request may have touched: its own path,
// plus the Destination of a COPY/MOVE.
function affectedBucketPaths(request: Request, username: string): string[] {
	const scope = (path: string): string => (path === '' ? username : `${username}/${path}`);
	let affected = [scope(makeResourcePath(request))];
	let destinationHeader = request.headers.get('Destination');
	if (destinationHeader !== null) {
		let destination = parseDestinationPath(destinationHeader, request.url);
		if (destination !== null) {
			affected.push(scope(destination));
		}
	}
	return affected;
}

export interface Env {
	bucket: R2Bucket;

	// KV namespace holding WebDAV accounts: key `user:<username>`, value
	// `{"password":"..."}`. Seeded directly by admins; there is no
	// registration or admin UI.
	users: KVNamespace;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		let response: Response;
		if (request.method === 'OPTIONS') {
			// Capability probe: static response, touches no data, so it needs no
			// auth and no scope. MiniRedir sends it before offering credentials.
			response = await dispatchHandler(request, env.bucket);
		} else {
			let username = await authenticate(request, env.users);
			if (username !== null) {
				// Authenticated WebDAV: `/` is mounted at `<username>/`.
				response = await dispatchHandler(request, new ScopedBucket(env.bucket, username + '/'));
				if (MUTATING_METHODS.has(request.method) && response.status < 400) {
					ctx.waitUntil(purgeListingCache(affectedBucketPaths(request, username)));
				}
			} else if (
				request.headers.get('Authorization') === null &&
				(request.method === 'GET' || request.method === 'HEAD')
			) {
				// Public web mode: anonymous read-only access to the whole bucket.
				// Deliberately no WWW-Authenticate here — browsers must never be
				// prompted to log in; auth exists only for WebDAV clients.
				response = await dispatchHandler(request, env.bucket, true);
			} else {
				response = new Response('Unauthorized', {
					status: 401,
					headers: {
						'WWW-Authenticate': 'Basic realm="webdav"',
					},
				});
			}
		}

		// Set CORS headers
		response.headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') ?? '*');
		response.headers.set('Access-Control-Allow-Methods', SUPPORT_METHODS.join(', '));
		response.headers.set(
			'Access-Control-Allow-Headers',
			[
				'authorization',
				'content-type',
				'depth',
				'overwrite',
				'destination',
				'range',
				'if',
				'lock-token',
				'timeout',
			].join(', '),
		);
		response.headers.set(
			'Access-Control-Expose-Headers',
			[
				'content-type',
				'content-length',
				'dav',
				'etag',
				'last-modified',
				'location',
				'date',
				'content-range',
				'lock-token',
			].join(', '),
		);
		response.headers.set('Access-Control-Allow-Credentials', 'false');
		response.headers.set('Access-Control-Max-Age', '86400');

		return response;
	},
};
