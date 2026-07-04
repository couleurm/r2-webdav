// Plain-HTTP mechanics: header extraction, RFC 7232 conditional requests,
// range arithmetic, and common response shapes.

import { getResourceHref } from './paths';

export function extractHttpMetadata(headers: Headers): R2HTTPMetadata {
	let expires = headers.get('Expires');
	let cacheExpiry = expires === null ? NaN : new Date(expires).getTime();
	return {
		contentType: headers.get('Content-Type') ?? undefined,
		contentDisposition: headers.get('Content-Disposition') ?? undefined,
		contentEncoding: headers.get('Content-Encoding') ?? undefined,
		contentLanguage: headers.get('Content-Language') ?? undefined,
		cacheControl: headers.get('Cache-Control') ?? undefined,
		cacheExpiry: Number.isFinite(cacheExpiry) ? new Date(cacheExpiry) : undefined,
	};
}

function parseETagHeader(headerValue: string): { weak: boolean; tag: string }[] {
	return [...headerValue.matchAll(/(W\/)?"([^"]*)"/g)].map((match) => ({
		weak: match[1] !== undefined,
		tag: match[2],
	}));
}

function parseHttpDate(headerValue: string): number | null {
	let time = new Date(headerValue).getTime();
	return Number.isFinite(time) ? time : null;
}

// Evaluates If-Match / If-Unmodified-Since / If-None-Match / If-Modified-Since
// per RFC 7232 section 6. Returns 412, 304, or null when the request may proceed.
// The WebDAV `If` header (lock tokens) is handled separately by assertLockPermission
// and MUST NOT be treated as an HTTP precondition.
export function checkPreconditions(request: Request, object: R2Object | null): 412 | 304 | null {
	let isReadRequest = request.method === 'GET' || request.method === 'HEAD';
	let etag = object === null ? undefined : object.etag;
	// HTTP dates have second granularity; truncate the stored timestamp to match.
	let lastModified = object === null ? undefined : object.uploaded.getTime() - (object.uploaded.getTime() % 1000);

	let ifMatch = request.headers.get('If-Match');
	if (ifMatch !== null) {
		if (object === null) {
			return 412;
		}
		if (ifMatch.trim() !== '*' && !parseETagHeader(ifMatch).some((entry) => !entry.weak && entry.tag === etag)) {
			return 412;
		}
	} else {
		let ifUnmodifiedSince = request.headers.get('If-Unmodified-Since');
		if (ifUnmodifiedSince !== null && object !== null && lastModified !== undefined) {
			let time = parseHttpDate(ifUnmodifiedSince);
			if (time !== null && lastModified > time) {
				return 412;
			}
		}
	}

	let ifNoneMatch = request.headers.get('If-None-Match');
	if (ifNoneMatch !== null) {
		let matches =
			object !== null &&
			(ifNoneMatch.trim() === '*' || parseETagHeader(ifNoneMatch).some((entry) => entry.tag === etag));
		if (matches) {
			return isReadRequest ? 304 : 412;
		}
	} else if (isReadRequest) {
		let ifModifiedSince = request.headers.get('If-Modified-Since');
		if (ifModifiedSince !== null && object !== null && lastModified !== undefined) {
			let time = parseHttpDate(ifModifiedSince);
			if (time !== null && lastModified <= time) {
				return 304;
			}
		}
	}

	return null;
}

export function calcContentRange(object: R2ObjectBody) {
	let rangeOffset = 0;
	let rangeEnd = object.size - 1;
	if (object.range) {
		if ('suffix' in object.range) {
			// Case 3: {suffix: number}
			rangeOffset = object.size - object.range.suffix;
		} else {
			// Case 1: {offset: number, length?: number}
			// Case 2: {offset?: number, length: number}
			rangeOffset = object.range.offset ?? 0;
			let length = object.range.length ?? object.size - rangeOffset;
			rangeEnd = Math.min(rangeOffset + length - 1, object.size - 1);
		}
	}
	return { rangeOffset, rangeEnd };
}

export function createdResponse(
	resourcePath: string,
	isCollection: boolean,
	body: BodyInit | null = '',
	headers: HeadersInit = {},
): Response {
	let responseHeaders = new Headers(headers);
	responseHeaders.set('Location', getResourceHref(resourcePath, isCollection));
	return new Response(body, {
		status: 201,
		headers: responseHeaders,
	});
}
