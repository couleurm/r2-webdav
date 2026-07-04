// Everything content-type: serve-time resolution, extension inference, and
// validation of user-supplied MIME strings.

// Custom-metadata flag marking a content type the user set explicitly (via the
// `?type=` endpoint). When present, resolveContentType trusts the stored type
// verbatim instead of second-guessing it against the extension.
export const EXPLICIT_CONTENT_TYPE_KEY = 'ctExplicit';

// Extension -> MIME type for serve-time inference. Deliberately a small, common
// set; unknown extensions fall back to application/octet-stream.
const MIME_BY_EXT: Record<string, string> = {
	// images
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	svg: 'image/svg+xml',
	bmp: 'image/bmp',
	ico: 'image/x-icon',
	// video
	mp4: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
	mkv: 'video/x-matroska',
	avi: 'video/x-msvideo',
	// audio
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	ogg: 'audio/ogg',
	oga: 'audio/ogg',
	flac: 'audio/flac',
	m4a: 'audio/mp4',
	aac: 'audio/aac',
	// documents / text
	pdf: 'application/pdf',
	txt: 'text/plain',
	md: 'text/markdown',
	markdown: 'text/markdown',
	csv: 'text/csv',
	json: 'application/json',
	xml: 'application/xml',
	yaml: 'application/yaml',
	yml: 'application/yaml',
	// web
	html: 'text/html',
	htm: 'text/html',
	css: 'text/css',
	js: 'text/javascript',
	mjs: 'text/javascript',
	wasm: 'application/wasm',
	// archives
	zip: 'application/zip',
	gz: 'application/gzip',
	tar: 'application/x-tar',
	'7z': 'application/x-7z-compressed',
	rar: 'application/vnd.rar',
	// fonts
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	otf: 'font/otf',
};

// Types that mean "no meaningful type": R2/HTTP defaults plus curl's own
// defaults for `--data-binary` (x-www-form-urlencoded) and `-F` (multipart).
// Treating these as generic lets extension inference rescue files uploaded with
// plain curl, which would otherwise be served as an unplayable form body.
const GENERIC_CONTENT_TYPES = new Set([
	'application/octet-stream',
	'binary/octet-stream',
	'application/x-www-form-urlencoded',
	'multipart/form-data',
]);

function isGenericContentType(contentType: string | undefined): boolean {
	if (contentType === undefined || contentType === '') {
		return true;
	}
	let base = contentType.split(';')[0].trim().toLowerCase();
	return GENERIC_CONTENT_TYPES.has(base);
}

function inferContentType(key: string): string | undefined {
	let name = key.split('/').pop() ?? key;
	let dot = name.lastIndexOf('.');
	if (dot <= 0) {
		// No extension, or a dotfile like ".env" — nothing to infer from.
		return undefined;
	}
	return MIME_BY_EXT[name.slice(dot + 1).toLowerCase()];
}

// The single source of truth for a file's served content type, shared by GET,
// the public web view, and PROPFIND so they never disagree.
export function resolveContentType(object: R2Object): string {
	let stored = object.httpMetadata?.contentType;
	if (object.customMetadata?.[EXPLICIT_CONTENT_TYPE_KEY] === '1' && stored) {
		return stored;
	}
	if (!isGenericContentType(stored)) {
		return stored as string;
	}
	return inferContentType(object.key) ?? 'application/octet-stream';
}

// type/subtype with parameters and casing stripped, for comparing MIME types.
export function baseMimeType(value: string): string {
	return value.split(';')[0].trim().toLowerCase();
}

// Validates a user-supplied MIME string before it becomes a stored header
// value. Requires type/subtype, allows parameters after ';', forbids CRLF.
export function isValidMimeType(value: string): boolean {
	if (value.length === 0 || value.length > 255 || /[\r\n]/.test(value)) {
		return false;
	}
	return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*(;.*)?$/.test(value);
}
