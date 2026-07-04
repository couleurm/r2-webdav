/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { DOMParser } from '@xmldom/xmldom';

export interface Env {
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	bucket: R2Bucket;

	// KV namespace holding WebDAV accounts: key `user:<username>`, value
	// `{"password":"..."}`. Seeded directly by admins; there is no
	// registration or admin UI.
	users: KVNamespace;
}

// The subset of the R2 bucket API the WebDAV handlers use. Satisfied both by
// the raw R2Bucket binding (anonymous web mode) and by ScopedBucket
// (authenticated per-user mounts).
interface DavBucket {
	head(key: string): Promise<R2Object | null>;
	get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
	put(
		key: string,
		value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
		options?: R2PutOptions,
	): Promise<R2Object>;
	delete(keys: string | string[]): Promise<void>;
	list(options?: R2ListOptions): Promise<R2Objects>;
}

// Jails every bucket operation under `<username>/` by translating keys at the
// R2 boundary: user foo's `/` is the bucket prefix `foo/`. The WebDAV handlers
// above only ever see unprefixed keys, so hrefs, Location headers, and
// Destination parsing all come out mount-relative, and no key a user can
// produce (including `..` tricks, which are resolved before this layer)
// escapes the prefix.
class ScopedBucket implements DavBucket {
	constructor(
		private bucket: DavBucket,
		private prefix: string, // '<username>/'
	) {}

	private scopeKey(key: string): string {
		return this.prefix + key;
	}

	private stripKey(key: string): string {
		return key.slice(this.prefix.length);
	}

	// R2Object.key is read-only, so the unprefixed key is exposed through a
	// proxy; everything else (getters like `body`, methods like
	// `writeHttpMetadata`) delegates to the underlying native object.
	private stripObject<ObjectType extends R2Object>(object: ObjectType): ObjectType;
	private stripObject<ObjectType extends R2Object>(object: ObjectType | null): ObjectType | null;
	private stripObject<ObjectType extends R2Object>(object: ObjectType | null): ObjectType | null {
		if (object === null) {
			return null;
		}
		let strippedKey = this.stripKey(object.key);
		return new Proxy(object, {
			get(target, property) {
				if (property === 'key') {
					return strippedKey;
				}
				let value = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	}

	async head(key: string): Promise<R2Object | null> {
		return this.stripObject(await this.bucket.head(this.scopeKey(key)));
	}

	async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
		return this.stripObject(await this.bucket.get(this.scopeKey(key), options));
	}

	async put(
		key: string,
		value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
		options?: R2PutOptions,
	): Promise<R2Object> {
		return this.stripObject(await this.bucket.put(this.scopeKey(key), value, options));
	}

	async delete(keys: string | string[]): Promise<void> {
		await this.bucket.delete(Array.isArray(keys) ? keys.map((key) => this.scopeKey(key)) : this.scopeKey(keys));
	}

	async list(options?: R2ListOptions): Promise<R2Objects> {
		let listed = await this.bucket.list({
			...options,
			prefix: this.prefix + (options?.prefix ?? ''),
		});
		// An S3-style folder marker for the home directory itself (an object
		// whose key is exactly `<username>/`) would strip to '', i.e. the mount
		// root — never a member of any listing. Hiding it here also keeps
		// `DELETE /` from removing the mount point's marker.
		let objects = listed.objects
			.filter((object) => object.key !== this.prefix)
			.map((object) => this.stripObject(object));
		let delimitedPrefixes = listed.delimitedPrefixes.map((delimitedPrefix) => this.stripKey(delimitedPrefix));
		return listed.truncated
			? { objects, delimitedPrefixes, truncated: true, cursor: listed.cursor }
			: { objects, delimitedPrefixes, truncated: false };
	}
}

async function* listAll(bucket: DavBucket, prefix: string, isRecursive: boolean = false) {
	let cursor: string | undefined = undefined;
	do {
		var r2_objects = await bucket.list({
			prefix: prefix,
			delimiter: isRecursive ? undefined : '/',
			cursor: cursor,
			// @ts-ignore https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions
			include: ['httpMetadata', 'customMetadata'],
		});

		for (let object of r2_objects.objects) {
			yield object;
		}

		if (r2_objects.truncated) {
			cursor = r2_objects.cursor;
		}
	} while (r2_objects.truncated);
}

// R2 has no real directories. A directory exists in one of two forms: an
// explicit zero-byte marker object with `resourcetype: '<collection />'`
// custom metadata (created by MKCOL), or implicitly as a slash-separated key
// prefix of other objects (anything uploaded through the S3 API or the
// dashboard). Implicit directories have no backing R2Object, so listings
// represent them with this synthetic entry.
type DirectoryEntry = {
	kind: 'directory';
	key: string; // without trailing slash; '' is the bucket root
};

function isDirectoryEntry(entry: R2Object | DirectoryEntry): entry is DirectoryEntry {
	return 'kind' in entry && entry.kind === 'directory';
}

function isCollectionEntry(entry: R2Object | DirectoryEntry): boolean {
	return isDirectoryEntry(entry) || entry.customMetadata?.resourcetype === '<collection />';
}

// Lists the members of the collection at `prefix` (all descendants when
// `isRecursive`), including implicit directories. Non-recursive listings get
// them from `delimitedPrefixes`; recursive listings synthesize the ancestor
// directories of every key. Deduplication against explicit markers relies on
// R2's lexicographic list order: a marker key ("a/b") always sorts before the
// keys of its children ("a/b/..."), so it is recorded in `seenDirectories`
// before anything could synthesize the same directory — even across pages.
async function* listEntries(
	bucket: DavBucket,
	prefix: string,
	isRecursive: boolean = false,
): AsyncGenerator<R2Object | DirectoryEntry> {
	let seenDirectories = new Set<string>();
	const directoryEntries = function* (directoryKey: string): Generator<DirectoryEntry> {
		if (directoryKey + '/' !== prefix && !seenDirectories.has(directoryKey)) {
			seenDirectories.add(directoryKey);
			yield { kind: 'directory', key: directoryKey };
		}
	};

	let cursor: string | undefined = undefined;
	do {
		var r2_objects = await bucket.list({
			prefix: prefix,
			delimiter: isRecursive ? undefined : '/',
			cursor: cursor,
			// @ts-ignore https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions
			include: ['httpMetadata', 'customMetadata'],
		});

		for (let object of r2_objects.objects) {
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
		for (let delimitedPrefix of r2_objects.delimitedPrefixes) {
			yield* directoryEntries(delimitedPrefix.slice(0, -1));
		}

		if (r2_objects.truncated) {
			cursor = r2_objects.cursor;
		}
	} while (r2_objects.truncated);
}

type DavProperties = {
	creationdate: string | undefined;
	displayname: string | undefined;
	getcontentlanguage: string | undefined;
	getcontentlength: string | undefined;
	getcontenttype: string | undefined;
	getetag: string | undefined;
	getlastmodified: string | undefined;
	resourcetype: string;
	supportedlock: string;
	lockdiscovery: string;
};

type LockDetails = {
	token: string;
	owner: string | undefined;
	scope: 'exclusive' | 'shared';
	depth: '0' | 'infinity';
	timeout: string;
	expiresAt: number;
	root: string;
};

type DeadProperty = {
	namespaceURI: string;
	localName: string;
	prefix: string | null;
	valueXml: string;
};

type PropfindRequest =
	| {
			mode: 'allprop';
	  }
	| {
			mode: 'propname';
	  }
	| {
			mode: 'prop';
			properties: DeadProperty[];
	  };

type ProppatchOperation = {
	action: 'set' | 'remove';
	property: DeadProperty;
};

const DEFAULT_LOCK_TIMEOUT = 3600;
const MAX_LOCK_TIMEOUT = 365 * 24 * 60 * 60;
const VALID_LOCK_DEPTHS = ['0', 'infinity'] as const;
const LOCK_METADATA_KEYS = [
	'lock_token',
	'lock_owner',
	'lock_scope',
	'lock_depth',
	'lock_timeout',
	'lock_expires_at',
	'lock_root',
	'lock_records',
];
const INTERNAL_DELETE_FORWARD_HEADERS = ['If', 'Lock-Token'] as const;
const RAW_XML_DAV_PROPERTIES = new Set(['resourcetype', 'supportedlock', 'lockdiscovery']);
const DAV_NAMESPACE = 'DAV:';
const DEAD_PROPERTY_PREFIX = 'dead_property:';
const LOCK_RECORDS_METADATA_KEY = 'lock_records';

function escapeXml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

function extractHttpMetadata(headers: Headers): R2HTTPMetadata {
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

// Custom-metadata flag marking a content type the user set explicitly (via the
// `?type=` endpoint). When present, resolveContentType trusts the stored type
// verbatim instead of second-guessing it against the extension.
const EXPLICIT_CONTENT_TYPE_KEY = 'ctExplicit';

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
function resolveContentType(object: R2Object): string {
	let stored = object.httpMetadata?.contentType;
	if (object.customMetadata?.[EXPLICIT_CONTENT_TYPE_KEY] === '1' && stored) {
		return stored;
	}
	if (!isGenericContentType(stored)) {
		return stored as string;
	}
	return inferContentType(object.key) ?? 'application/octet-stream';
}

// Validates a user-supplied MIME string before it becomes a stored header
// value. Requires type/subtype, allows parameters after ';', forbids CRLF.
function isValidMimeType(value: string): boolean {
	if (value.length === 0 || value.length > 255 || /[\r\n]/.test(value)) {
		return false;
	}
	return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*(;.*)?$/.test(value);
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
function checkPreconditions(request: Request, object: R2Object | null): 412 | 304 | null {
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

function getResourceHref(key: string, isCollection: boolean): string {
	const encodeHrefPath = (href: string): string => {
		if (href === '/') {
			return '/';
		}
		return href
			.split('/')
			.map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
			.join('/');
	};

	if (key === '') {
		return '/';
	}
	return encodeHrefPath(`/${key + (isCollection ? '/' : '')}`);
}

function decodeResourcePath(pathname: string): string {
	let resourcePath = pathname.slice(1);
	resourcePath = resourcePath.endsWith('/') ? resourcePath.slice(0, -1) : resourcePath;
	if (resourcePath === '') {
		return '';
	}
	return resourcePath
		.split('/')
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		})
		.join('/');
}

function getParentPath(resourcePath: string): string {
	let normalizedPath = resourcePath.endsWith('/') ? resourcePath.slice(0, -1) : resourcePath;
	return normalizedPath.split('/').slice(0, -1).join('/');
}

// True when the path is a directory that exists only as a key prefix of other
// objects (no marker object of its own). The root always exists.
async function hasImplicitDirectory(bucket: DavBucket, resourcePath: string): Promise<boolean> {
	if (resourcePath === '') {
		return true;
	}
	let listed = await bucket.list({ prefix: resourcePath + '/', limit: 1 });
	return listed.objects.length > 0;
}

async function hasCollectionResource(bucket: DavBucket, resourcePath: string): Promise<boolean> {
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
async function resolveResource(bucket: DavBucket, resourcePath: string): Promise<R2Object | DirectoryEntry | null> {
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

function parseDestinationPath(destinationHeader: string, requestUrl: string): string | null {
	try {
		let destinationUrl = new URL(destinationHeader, requestUrl);
		if (destinationUrl.origin !== new URL(requestUrl).origin) {
			return null;
		}
		return decodeResourcePath(destinationUrl.pathname);
	} catch {
		return null;
	}
}

function isSameOrDescendantPath(resourcePath: string, destinationPath: string): boolean {
	if (destinationPath === resourcePath) {
		return true;
	}
	if (resourcePath === '') {
		return destinationPath !== '';
	}
	return destinationPath.startsWith(`${resourcePath}/`);
}

function createdResponse(
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

function renderDavProperty(propName: string, value: string): string {
	let content = RAW_XML_DAV_PROPERTIES.has(propName) ? value : escapeXml(value);
	return `<${propName}>${content}</${propName}>`;
}

function serializeNodeChildren(node: Node): string {
	let xml = '';
	for (let child = node.firstChild; child !== null; child = child.nextSibling) {
		xml += child.toString();
	}
	return xml;
}

function getDeadPropertyKey(namespaceURI: string, localName: string): string {
	return `${DEAD_PROPERTY_PREFIX}${encodeURIComponent(namespaceURI)}:${encodeURIComponent(localName)}`;
}

function getDeadProperty(
	metadata: Record<string, string> | undefined,
	namespaceURI: string,
	localName: string,
): DeadProperty | null {
	let value = metadata?.[getDeadPropertyKey(namespaceURI, localName)];
	if (value === undefined) {
		return null;
	}
	return JSON.parse(value) as DeadProperty;
}

function getDeadProperties(metadata: Record<string, string> | undefined): DeadProperty[] {
	if (metadata === undefined) {
		return [];
	}
	return Object.entries(metadata)
		.filter(([key]) => key.startsWith(DEAD_PROPERTY_PREFIX))
		.map(([, value]) => JSON.parse(value) as DeadProperty);
}

function renderPropertyElement(property: DeadProperty): string {
	let qualifiedName = property.prefix ? `${property.prefix}:${property.localName}` : property.localName;
	let namespaceDeclaration =
		property.namespaceURI === ''
			? ' xmlns=""'
			: property.prefix
				? ` xmlns:${property.prefix}="${escapeXml(property.namespaceURI)}"`
				: ` xmlns="${escapeXml(property.namespaceURI)}"`;
	return `<${qualifiedName}${namespaceDeclaration}>${property.valueXml}</${qualifiedName}>`;
}

function renderEmptyPropertyElement(property: DeadProperty): string {
	let qualifiedName = property.prefix ? `${property.prefix}:${property.localName}` : property.localName;
	let namespaceDeclaration =
		property.namespaceURI === ''
			? ' xmlns=""'
			: property.prefix
				? ` xmlns:${property.prefix}="${escapeXml(property.namespaceURI)}"`
				: ` xmlns="${escapeXml(property.namespaceURI)}"`;
	return `<${qualifiedName}${namespaceDeclaration} />`;
}

function getElementProperty(element: Element): DeadProperty | null {
	if (element.prefix && (element.namespaceURI === null || element.namespaceURI === '')) {
		return null;
	}
	return {
		namespaceURI: element.namespaceURI ?? '',
		localName: element.localName,
		prefix: element.prefix,
		valueXml: serializeNodeChildren(element),
	};
}

function parseXmlDocument(body: string): Document | null {
	let errors: string[] = [];
	let document = new DOMParser({
		errorHandler: {
			warning: () => {},
			error: (message) => errors.push(message),
			fatalError: (message) => errors.push(message),
		},
	}).parseFromString(body, 'application/xml');
	if (errors.length > 0) {
		return null;
	}
	return document;
}

function getChildElements(element: Element): Element[] {
	let children: Element[] = [];
	for (let child = element.firstChild; child !== null; child = child.nextSibling) {
		if (child.nodeType === child.ELEMENT_NODE) {
			children.push(child as Element);
		}
	}
	return children;
}

function parsePropfindRequest(body: string): PropfindRequest | null {
	if (body.trim() === '') {
		return { mode: 'allprop' };
	}
	let document = parseXmlDocument(body);
	if (document === null || document.documentElement.localName.toLowerCase() !== 'propfind') {
		return null;
	}
	let propfindChildren = getChildElements(document.documentElement);
	if (propfindChildren.some((child) => child.localName.toLowerCase() === 'propname')) {
		return { mode: 'propname' };
	}
	let propElement = propfindChildren.find((child) => child.localName.toLowerCase() === 'prop');
	if (propElement !== undefined) {
		let properties = getChildElements(propElement).map(getElementProperty);
		if (properties.some((property) => property === null)) {
			return null;
		}
		return {
			mode: 'prop',
			properties: properties as DeadProperty[],
		};
	}
	if (propfindChildren.some((child) => child.localName.toLowerCase() === 'allprop')) {
		return { mode: 'allprop' };
	}
	return null;
}

function parseProppatchRequest(body: string): { operations: ProppatchOperation[] } | null {
	let document = parseXmlDocument(body);
	if (document === null || document.documentElement.localName.toLowerCase() !== 'propertyupdate') {
		return null;
	}
	let operations: ProppatchOperation[] = [];
	for (const actionElement of getChildElements(document.documentElement)) {
		let action = actionElement.localName.toLowerCase();
		if (action !== 'set' && action !== 'remove') {
			continue;
		}
		let propElement = getChildElements(actionElement).find((child) => child.localName.toLowerCase() === 'prop');
		if (propElement === undefined) {
			continue;
		}
		for (const propertyElement of getChildElements(propElement)) {
			let property = getElementProperty(propertyElement);
			if (property === null) {
				return null;
			}
			operations.push({ action, property });
		}
	}
	return { operations };
}

function getSupportedLock(): string {
	return [
		'<lockentry><lockscope><exclusive /></lockscope><locktype><write /></locktype></lockentry>',
		'<lockentry><lockscope><shared /></lockscope><locktype><write /></locktype></lockentry>',
	].join('');
}

function determineLockDepth(
	resourceType: string | undefined,
	depthHeader: (typeof VALID_LOCK_DEPTHS)[number] | null,
): '0' | 'infinity' {
	if (resourceType === '<collection />') {
		return depthHeader ?? 'infinity';
	}
	return depthHeader === 'infinity' ? 'infinity' : '0';
}

function normalizeLockToken(lockToken: string): string {
	return lockToken
		.trim()
		.replace(/^<|>$/g, '')
		.replace(/^(?:urn:uuid:|opaquelocktoken:)/, '');
}

function normalizeLockDetails(lockDetails: Partial<LockDetails> & Pick<LockDetails, 'token'>): LockDetails | null {
	let expiresAt = Number(lockDetails.expiresAt ?? 0);
	if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
		expiresAt = Date.now() + DEFAULT_LOCK_TIMEOUT * 1000;
	}
	if (expiresAt <= Date.now()) {
		return null;
	}

	return {
		token: lockDetails.token,
		owner: lockDetails.owner,
		scope: lockDetails.scope === 'shared' ? 'shared' : 'exclusive',
		depth: lockDetails.depth === 'infinity' ? 'infinity' : '0',
		timeout: lockDetails.timeout ?? `Second-${DEFAULT_LOCK_TIMEOUT}`,
		expiresAt,
		root: lockDetails.root ?? '/',
	};
}

function getLockDetails(customMetadata: Record<string, string> | undefined): LockDetails[] {
	let records = customMetadata?.[LOCK_RECORDS_METADATA_KEY];
	if (records !== undefined) {
		try {
			let parsed = JSON.parse(records);
			if (Array.isArray(parsed)) {
				return parsed.flatMap((lockDetails) => {
					if (lockDetails && typeof lockDetails === 'object' && typeof lockDetails.token === 'string') {
						let normalized = normalizeLockDetails(lockDetails as Partial<LockDetails> & Pick<LockDetails, 'token'>);
						return normalized === null ? [] : [normalized];
					}
					return [];
				});
			}
		} catch {}
	}

	let token = customMetadata?.lock_token;
	if (token === undefined) {
		return [];
	}

	let normalized = normalizeLockDetails({
		token,
		owner: customMetadata?.lock_owner,
		scope: customMetadata?.lock_scope === 'shared' ? 'shared' : 'exclusive',
		depth: customMetadata?.lock_depth === 'infinity' ? 'infinity' : '0',
		timeout: customMetadata?.lock_timeout ?? `Second-${DEFAULT_LOCK_TIMEOUT}`,
		expiresAt: Number(customMetadata?.lock_expires_at ?? 0),
		root: customMetadata?.lock_root ?? '/',
	});
	return normalized === null ? [] : [normalized];
}

function getLockDiscovery(lockDetails: LockDetails | LockDetails[]): string {
	let lockDetailList = Array.isArray(lockDetails) ? lockDetails : [lockDetails];
	return lockDetailList
		.map(
			(lockDetail) =>
				`<activelock><locktype><write /></locktype><lockscope><${lockDetail.scope} /></lockscope><depth>${lockDetail.depth}</depth>${lockDetail.owner ? `<owner>${escapeXml(lockDetail.owner)}</owner>` : ''}<timeout>${escapeXml(lockDetail.timeout)}</timeout><locktoken><href>urn:uuid:${escapeXml(lockDetail.token)}</href></locktoken><lockroot><href>${escapeXml(lockDetail.root)}</href></lockroot></activelock>`,
		)
		.join('');
}

function stripLockMetadata(customMetadata: Record<string, string> | undefined): Record<string, string> {
	let metadata = customMetadata ? { ...customMetadata } : {};
	for (const key of LOCK_METADATA_KEYS) {
		delete metadata[key];
	}
	return metadata;
}

function withLockMetadata(
	customMetadata: Record<string, string> | undefined,
	lockDetails: LockDetails | LockDetails[],
): Record<string, string> {
	let lockDetailList = Array.isArray(lockDetails) ? lockDetails : [lockDetails];
	if (lockDetailList.length === 0) {
		return stripLockMetadata(customMetadata);
	}
	return {
		...stripLockMetadata(customMetadata),
		[LOCK_RECORDS_METADATA_KEY]: JSON.stringify(lockDetailList),
	};
}

function getPreservedCustomMetadata(customMetadata: Record<string, string> | undefined): Record<string, string> {
	let lockDetails = getLockDetails(customMetadata);
	if (lockDetails.length === 0) {
		return stripLockMetadata(customMetadata);
	}
	return withLockMetadata(customMetadata, lockDetails);
}

function isProtectedProperty(propName: string | DeadProperty): boolean {
	let localPropName = typeof propName === 'string' ? (propName.split(':').pop() ?? propName) : propName.localName;
	return (
		LOCK_METADATA_KEYS.includes(localPropName) || localPropName === 'supportedlock' || localPropName === 'lockdiscovery'
	);
}

function isValidXmlTagName(propName: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9._:-]*$/.test(propName);
}

function parseTimeout(timeoutHeader: string | null): { timeout: string; expiresAt: number } {
	if (timeoutHeader === null) {
		return {
			timeout: `Second-${DEFAULT_LOCK_TIMEOUT}`,
			expiresAt: Date.now() + DEFAULT_LOCK_TIMEOUT * 1000,
		};
	}

	for (const item of timeoutHeader.split(',').map((value) => value.trim())) {
		if (item.toLowerCase() === 'infinite') {
			return {
				timeout: 'Infinite',
				expiresAt: Date.now() + MAX_LOCK_TIMEOUT * 1000,
			};
		}

		let seconds = Number(item.match(/^Second-(\d+)$/i)?.[1] ?? NaN);
		if (Number.isFinite(seconds) && seconds > 0) {
			seconds = Math.min(seconds, MAX_LOCK_TIMEOUT);
			return {
				timeout: `Second-${seconds}`,
				expiresAt: Date.now() + seconds * 1000,
			};
		}
	}

	return {
		timeout: `Second-${DEFAULT_LOCK_TIMEOUT}`,
		expiresAt: Date.now() + DEFAULT_LOCK_TIMEOUT * 1000,
	};
}

function getRequestLockTokens(request: Request): string[] {
	let lockTokens: string[] = [];
	let directLockToken = request.headers.get('Lock-Token');
	if (directLockToken) {
		lockTokens.push(normalizeLockToken(directLockToken));
	}

	let ifHeader = request.headers.get('If');
	if (ifHeader) {
		for (const match of ifHeader.matchAll(/<([^>]+)>/g)) {
			let token = normalizeLockToken(match[1]);
			if (token !== '') {
				lockTokens.push(token);
			}
		}
	}

	return [...new Set(lockTokens)];
}

type IfHeaderCondition = { negate: boolean; token: string | null; etag: string | null };
type IfHeaderList = { resourceTag: string | null; conditions: IfHeaderCondition[] };

// RFC 4918 section 10.4: If = ( 1*No-tag-list | 1*Tagged-list ), where each
// list is "(" 1*( ["Not"] ( "<" state-token ">" | "[" entity-tag "]" ) ) ")"
// and a Tagged-list is preceded by a "<" resource ">" tag.
function parseIfHeader(ifHeader: string): IfHeaderList[] {
	let lists: IfHeaderList[] = [];
	let currentTag: string | null = null;
	for (const match of ifHeader.matchAll(/<([^>]*)>|\(([^)]*)\)/g)) {
		if (match[1] !== undefined) {
			currentTag = match[1];
			continue;
		}
		let conditions: IfHeaderCondition[] = [];
		for (const condition of match[2].matchAll(/(Not\s+)?(?:<([^>]*)>|\[([^\]]*)\])/gi)) {
			conditions.push({
				negate: condition[1] !== undefined,
				token: condition[2] ?? null,
				etag: condition[3] ?? null,
			});
		}
		lists.push({ resourceTag: currentTag, conditions });
	}
	return lists;
}

// Evaluates the WebDAV If header as a precondition: the request may proceed
// only if at least one list holds for its resource (untagged lists apply to
// the Request-URI resource). A state-token condition holds when the resource
// is covered by a lock with that token; an entity-tag condition holds when
// the resource's current etag matches.
async function evaluateIfHeader(request: Request, bucket: DavBucket): Promise<boolean> {
	let ifHeader = request.headers.get('If');
	if (ifHeader === null) {
		return true;
	}
	let lists = parseIfHeader(ifHeader);
	if (lists.length === 0) {
		return true;
	}

	let requestPath = make_resource_path(request);
	let resourceCache = new Map<string, R2Object | null>();
	const headResource = async (path: string): Promise<R2Object | null> => {
		if (!resourceCache.has(path)) {
			resourceCache.set(path, path === '' ? null : await bucket.head(path));
		}
		return resourceCache.get(path) ?? null;
	};
	// Tokens of locks covering the resource: its own locks plus depth-infinity
	// locks on ancestor collections.
	const effectiveLockTokens = async (path: string): Promise<string[]> => {
		let tokens: string[] = [];
		for (let current = path; current !== ''; current = getParentPath(current)) {
			let resource = await headResource(current);
			for (const lockDetail of getLockDetails(resource?.customMetadata)) {
				if (current === path || lockDetail.depth === 'infinity') {
					tokens.push(lockDetail.token);
				}
			}
		}
		return tokens;
	};

	for (const list of lists) {
		let path = list.resourceTag === null ? requestPath : parseDestinationPath(list.resourceTag, request.url);
		if (path === null || list.conditions.length === 0) {
			continue;
		}
		let resource = await headResource(path);
		let lockTokens: string[] | null = null;
		let listHolds = true;
		for (const condition of list.conditions) {
			let holds: boolean;
			if (condition.token !== null) {
				lockTokens = lockTokens ?? (await effectiveLockTokens(path));
				holds = lockTokens.includes(normalizeLockToken(condition.token));
			} else {
				let conditionETag = (condition.etag ?? '').replace(/^W\//, '').replace(/^"|"$/g, '');
				holds = resource !== null && conditionETag === resource.etag;
			}
			if (condition.negate) {
				holds = !holds;
			}
			if (!holds) {
				listHolds = false;
				break;
			}
		}
		if (listHolds) {
			return true;
		}
	}
	return false;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) {
		return false;
	}
	let mismatch = 0;
	for (let index = 0; index < left.byteLength; index++) {
		mismatch |= left[index] ^ right[index];
	}
	return mismatch === 0;
}

// Parses a LOCK request body. Clients differ in how they write the lockinfo
// XML: litmus uses the default namespace (<lockinfo xmlns="DAV:"><write/>),
// while Windows MiniRedir uses a prefix (<D:lockinfo xmlns:D="DAV:"><D:write/>).
// Matching on local names via a real XML parse handles both.
function parseLockRequest(
	body: string,
): { scope: LockDetails['scope']; hasWriteType: boolean; owner: string | undefined } | null {
	let doc = parseXmlDocument(body);
	let root = doc?.documentElement;
	if (!root || root.localName !== 'lockinfo') {
		return null;
	}

	let scope: LockDetails['scope'] = 'exclusive';
	let hasWriteType = false;
	let owner: string | undefined;
	for (const child of getChildElements(root)) {
		switch (child.localName) {
			case 'lockscope': {
				if (getChildElements(child).some((element) => element.localName === 'shared')) {
					scope = 'shared';
				}
				break;
			}
			case 'locktype': {
				if (getChildElements(child).some((element) => element.localName === 'write')) {
					hasWriteType = true;
				}
				break;
			}
			case 'owner': {
				let serialized = serializeNodeChildren(child).trim();
				owner = serialized === '' ? undefined : serialized;
				break;
			}
		}
	}
	return { scope, hasWriteType, owner };
}

// Properties for a collection with no backing object: the bucket root and
// implicit directories. R2 stores nothing for them, so timestamps fall back
// to the current time.
function directoryDavProperties(): DavProperties {
	return {
		// RFC 4918 section 15.1: creationdate is an ISO 8601 date-time.
		creationdate: new Date().toISOString(),
		displayname: undefined,
		getcontentlanguage: undefined,
		getcontentlength: '0',
		getcontenttype: undefined,
		getetag: undefined,
		getlastmodified: new Date().toUTCString(),
		resourcetype: '<collection />',
		supportedlock: getSupportedLock(),
		lockdiscovery: '',
	};
}

function fromR2Object(object: R2Object): DavProperties {
	let isCollection = object.customMetadata?.resourcetype === '<collection />';
	let lockDetails = getLockDetails(object.customMetadata);
	return {
		creationdate: object.uploaded.toISOString(),
		displayname: object.httpMetadata?.contentDisposition,
		getcontentlanguage: object.httpMetadata?.contentLanguage,
		getcontentlength: object.size.toString(),
		getcontenttype: isCollection ? undefined : resolveContentType(object),
		// RFC 4918 section 15.6: getetag uses the same format as the HTTP ETag
		// header, i.e. the quoted form. It must also match the ETag returned by
		// PUT/GET so clients (notably Windows MiniRedir) can correlate them.
		getetag: object.httpEtag,
		getlastmodified: object.uploaded.toUTCString(),
		resourcetype: object.customMetadata?.resourcetype ?? '',
		supportedlock: getSupportedLock(),
		lockdiscovery:
			lockDetails.length === 0
				? ''
				: getLockDiscovery(
						lockDetails.map((lockDetail) => ({
							...lockDetail,
							root: getResourceHref(object.key, isCollection),
						})),
					),
	};
}

function fromEntry(entry: R2Object | DirectoryEntry): DavProperties {
	return isDirectoryEntry(entry) ? directoryDavProperties() : fromR2Object(entry);
}

function getLivePropertyValue(entry: R2Object | DirectoryEntry, property: DeadProperty): string | undefined {
	if (property.namespaceURI !== DAV_NAMESPACE) {
		return undefined;
	}
	return fromEntry(entry)[property.localName as keyof DavProperties];
}

function renderPropstat(status: string, properties: string[]): string {
	if (properties.length === 0) {
		return '';
	}
	return `
		<propstat>
			<prop>
			${properties.join('\n				')}
			</prop>
			<status>${status}</status>
		</propstat>`;
}

function make_resource_path(request: Request): string {
	return decodeResourcePath(new URL(request.url).pathname);
}

async function assertLockPermission(
	request: Request,
	bucket: DavBucket,
	resourcePath: string,
	options: { ignoreSharedLocksOnTarget?: boolean } = {},
): Promise<Response | null> {
	if (!(await evaluateIfHeader(request, bucket))) {
		return new Response('Precondition Failed', { status: 412 });
	}
	let lockTokens = getRequestLockTokens(request);
	let candidates: string[] = [];

	for (let current = resourcePath; current !== ''; current = current.split('/').slice(0, -1).join('/')) {
		candidates.push(current);
	}

	for (const candidate of candidates) {
		let object = await bucket.head(candidate);
		let lockDetails = getLockDetails(object?.customMetadata).filter(
			(lockDetail) =>
				(candidate === resourcePath || lockDetail.depth === 'infinity') &&
				!(options.ignoreSharedLocksOnTarget && candidate === resourcePath && lockDetail.scope === 'shared'),
		);
		if (lockDetails.length === 0) {
			continue;
		}

		if (!lockDetails.some((lockDetail) => lockTokens.includes(lockDetail.token))) {
			return new Response('Locked', { status: 423 });
		}
	}

	return null;
}

async function assertRecursiveDeletePermission(
	request: Request,
	bucket: DavBucket,
	resourcePath: string,
): Promise<Response | null> {
	let lockResponse = await assertLockPermission(request, bucket, resourcePath);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let lockTokens = getRequestLockTokens(request);
	let prefix = resourcePath === '' ? '' : resourcePath + '/';
	for await (let descendant of listAll(bucket, prefix, true)) {
		let lockDetails = getLockDetails(descendant.customMetadata);
		if (lockDetails.length > 0 && !lockDetails.some((lockDetail) => lockTokens.includes(lockDetail.token))) {
			return new Response('Locked', { status: 423 });
		}
	}

	return null;
}

async function findMatchingLock(
	request: Request,
	bucket: DavBucket,
	resourcePath: string,
): Promise<{ resource: R2Object; lockDetails: LockDetails } | null> {
	let lockTokens = getRequestLockTokens(request);
	for (let current = resourcePath; ; current = current.split('/').slice(0, -1).join('/')) {
		let resource = await bucket.head(current);
		let lockDetails = getLockDetails(resource?.customMetadata).find(
			(lockDetail) =>
				lockTokens.includes(lockDetail.token) && (current === resourcePath || lockDetail.depth === 'infinity'),
		);
		if (resource !== null && lockDetails !== undefined) {
			return { resource, lockDetails };
		}
		if (current === '') {
			break;
		}
	}
	return null;
}

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
function redirectToCollection(resourcePath: string): Response {
	return new Response(null, {
		status: 301,
		headers: { Location: getResourceHref(resourcePath, true) },
	});
}

async function renderDirectoryListing(bucket: DavBucket, resource_path: string, url: URL): Promise<Response> {
	let prefix = resource_path === '' ? '' : resource_path + '/';

	type ListingRow = {
		name: string;
		href: string;
		isDirectory: boolean;
		sizeBytes: number | null;
		modifiedMs: number | null;
	};

	// A single recursive walk yields the same immediate children as the
	// non-recursive listing (a directory appears iff it has a marker or any
	// descendant), and additionally lets us aggregate each directory's total
	// size and newest upload time from its descendants. R2 has no directory
	// mtime, so "modified" is the max `uploaded` over everything inside,
	// including explicit MKCOL markers (which gives empty explicit dirs their
	// creation time).
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
	if (resource_path !== '') {
		rows.unshift({
			name: '../',
			href: getResourceHref(getParentPath(resource_path), true),
			isDirectory: true,
			sizeBytes: null,
			modifiedMs: null,
		});
	}

	let breadcrumbs = `<a href="/">root</a>`;
	let ancestorPath = '';
	for (let segment of resource_path === '' ? [] : resource_path.split('/')) {
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
<title>R2 Storage — /${escapeXml(resource_path)}</title>
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
<h1>R2 Storage</h1>
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

async function handle_head(request: Request, bucket: DavBucket): Promise<Response> {
	let response = await handle_get(request, bucket);
	return new Response(null, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

async function handle_get(request: Request, bucket: DavBucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let url = new URL(request.url);

	// Read-time Content-Type override: `?type=`/`?content-type=` on a GET (or
	// HEAD, which delegates here) serves the file with the caller's chosen type
	// for that one response only — nothing is persisted. Useful for e.g. viewing
	// an HTML file as text/plain in a browser. Applies to file reads, not
	// directory listings.
	let typeOverride = url.searchParams.get('type') ?? url.searchParams.get('content-type');
	if (typeOverride !== null && !isValidMimeType(typeOverride)) {
		return new Response('Invalid Content-Type', { status: 400 });
	}

	if (url.pathname.endsWith('/')) {
		let entry = await resolveResource(bucket, resource_path);
		if (entry === null || !isCollectionEntry(entry)) {
			return new Response('Not Found', { status: 404 });
		}
		return await renderDirectoryListing(bucket, resource_path, url);
	} else {
		let object = await bucket.get(resource_path, {
			range: request.headers,
		});

		let isR2ObjectBody = (object: R2Object | R2ObjectBody): object is R2ObjectBody => {
			return 'body' in object;
		};

		if (object === null) {
			if (await hasImplicitDirectory(bucket, resource_path)) {
				return redirectToCollection(resource_path);
			}
			return new Response('Not Found', { status: 404 });
		}
		if (object.customMetadata?.resourcetype === '<collection />') {
			return redirectToCollection(resource_path);
		}

		let preconditionStatus = checkPreconditions(request, object);
		if (preconditionStatus === 304) {
			return new Response(null, {
				status: 304,
				headers: {
					ETag: object.httpEtag,
					'Last-Modified': object.uploaded.toUTCString(),
				},
			});
		}
		if (preconditionStatus === 412 || !isR2ObjectBody(object)) {
			return new Response('Precondition Failed', { status: 412 });
		} else {
			const { rangeOffset, rangeEnd } = calcContentRange(object);
			const contentLength = rangeEnd - rangeOffset + 1;
			const rangeRequested = request.headers.has('Range') && object.range !== undefined;
			return new Response(object.body, {
				status: rangeRequested ? 206 : 200,
				headers: {
					'Accept-Ranges': 'bytes',
					'Content-Type': typeOverride ?? resolveContentType(object),
					'Content-Length': contentLength.toString(),
					ETag: object.httpEtag,
					'Last-Modified': object.uploaded.toUTCString(),
					...(rangeRequested ? { 'Content-Range': `bytes ${rangeOffset}-${rangeEnd}/${object.size}` } : {}),
					...(object.httpMetadata?.contentDisposition
						? {
								'Content-Disposition': object.httpMetadata.contentDisposition,
							}
						: {}),
					...(object.httpMetadata?.contentEncoding
						? {
								'Content-Encoding': object.httpMetadata.contentEncoding,
							}
						: {}),
					...(object.httpMetadata?.contentLanguage
						? {
								'Content-Language': object.httpMetadata.contentLanguage,
							}
						: {}),
					...(object.httpMetadata?.cacheControl
						? {
								'Cache-Control': object.httpMetadata.cacheControl,
							}
						: {}),
					...(object.httpMetadata?.cacheExpiry
						? {
								'Cache-Expiry': object.httpMetadata.cacheExpiry.toISOString(),
							}
						: {}),
				},
			});
		}
	}
}

function calcContentRange(object: R2ObjectBody) {
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

// Handles PUT and its curl-friendly POST alias. The request path is always the
// file destination (no /upload prefix). A `?type=`/`?content-type=` query sets
// an explicit MIME type; with no request body it becomes a metadata-only
// "set the type of this existing file" operation.
async function handle_put(request: Request, bucket: DavBucket): Promise<Response> {
	let url = new URL(request.url);
	if (url.pathname.endsWith('/')) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	let resource_path = make_resource_path(request);
	let lockResponse = await assertLockPermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let typeParam = url.searchParams.get('type') ?? url.searchParams.get('content-type');
	let explicitType: string | null = null;
	if (typeParam !== null) {
		let trimmed = typeParam.trim();
		if (!isValidMimeType(trimmed)) {
			return new Response('Invalid Content-Type', { status: 400 });
		}
		explicitType = trimmed;
	}

	let existing = await bucket.head(resource_path);

	if (checkPreconditions(request, existing) !== null) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let body = await request.arrayBuffer();

	// Metadata-only path: `?type=` with no body against an existing file changes
	// only its content type, preserving the bytes. R2 has no metadata patch, so
	// we re-put the object with its own body.
	if (explicitType !== null && body.byteLength === 0 && existing !== null) {
		if (existing.customMetadata?.resourcetype === '<collection />') {
			return new Response('Method Not Allowed', { status: 405 });
		}
		let src = await bucket.get(resource_path);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		let customMetadata = getPreservedCustomMetadata(existing.customMetadata);
		customMetadata[EXPLICIT_CONTENT_TYPE_KEY] = '1';
		let putResult = await bucket.put(resource_path, src.body, {
			httpMetadata: { ...existing.httpMetadata, contentType: explicitType },
			customMetadata: customMetadata,
		});
		return new Response(null, {
			status: 204,
			headers: {
				ETag: putResult.httpEtag,
				'Last-Modified': putResult.uploaded.toUTCString(),
			},
		});
	}

	// Check if the parent directory exists
	if (!(await hasCollectionResource(bucket, getParentPath(resource_path)))) {
		return new Response('Conflict', { status: 409 });
	}

	// Evaluate HTTP preconditions explicitly. Passing `request.headers` as
	// `onlyIf` is unsafe here: when the condition fails, R2 `put()` silently
	// returns null without writing, and this handler would still report
	// success — the client then ends up with the empty resource created by a
	// prior LOCK (the "0 KB file" seen from Windows MiniRedir, issue #14).

	let httpMetadata = extractHttpMetadata(request.headers);
	let customMetadata = getPreservedCustomMetadata(existing?.customMetadata);
	// A plain re-upload resets any prior explicit type; `?type=` re-arms it.
	delete customMetadata[EXPLICIT_CONTENT_TYPE_KEY];
	if (explicitType !== null) {
		httpMetadata.contentType = explicitType;
		customMetadata[EXPLICIT_CONTENT_TYPE_KEY] = '1';
	}
	let putResult = await bucket.put(resource_path, body, {
		httpMetadata: httpMetadata,
		customMetadata: customMetadata,
	});
	// Windows MiniRedir relies on the ETag of a PUT response to confirm the
	// write and invalidate its cached PROPFIND state.
	let responseHeaders = {
		ETag: putResult.httpEtag,
		'Last-Modified': putResult.uploaded.toUTCString(),
	};
	return existing === null
		? new Response('', { status: 201, headers: responseHeaders })
		: new Response(null, { status: 204, headers: responseHeaders });
}

async function deleteAllWithPrefix(bucket: DavBucket, prefix: string): Promise<void> {
	let r2_objects,
		cursor: string | undefined = undefined;
	do {
		r2_objects = await bucket.list({
			prefix: prefix,
			cursor: cursor,
		});
		let keys = r2_objects.objects.map((object) => object.key);
		if (keys.length > 0) {
			await bucket.delete(keys);
		}

		if (r2_objects.truncated) {
			cursor = r2_objects.cursor;
		}
	} while (r2_objects.truncated);
}

async function handle_delete(request: Request, bucket: DavBucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let lockResponse = await assertRecursiveDeletePermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}

	if (resource_path === '') {
		await deleteAllWithPrefix(bucket, '');
		return new Response(null, { status: 204 });
	}

	let resource = await bucket.head(resource_path);
	if (resource === null) {
		if (!(await hasImplicitDirectory(bucket, resource_path))) {
			return new Response('Not Found', { status: 404 });
		}
		await deleteAllWithPrefix(bucket, resource_path + '/');
		return new Response(null, { status: 204 });
	}
	if (resource.customMetadata?.resourcetype !== '<collection />') {
		await bucket.delete(resource_path);
		return new Response(null, { status: 204 });
	}

	await deleteAllWithPrefix(bucket, resource_path + '/');
	await bucket.delete(resource_path);
	return new Response(null, { status: 204 });
}

async function handle_mkcol(request: Request, bucket: DavBucket): Promise<Response> {
	if ((await request.clone().arrayBuffer()).byteLength > 0) {
		return new Response('Unsupported Media Type', { status: 415 });
	}

	let resource_path = make_resource_path(request);
	let lockResponse = await assertLockPermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}

	// Check if the resource already exists (as an object or an implicit directory)
	let resource = await bucket.head(resource_path);
	if (resource !== null || (await hasImplicitDirectory(bucket, resource_path))) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	// Check if the parent directory exists
	let parent_dir = getParentPath(resource_path);
	if (!(await hasCollectionResource(bucket, parent_dir))) {
		return new Response('Conflict', { status: 409 });
	}

	await bucket.put(resource_path, new Uint8Array(), {
		httpMetadata: extractHttpMetadata(request.headers),
		customMetadata: { resourcetype: '<collection />' },
	});
	return new Response('', { status: 201 });
}

function generate_propfind_response(entry: R2Object | DirectoryEntry, propfindRequest: PropfindRequest): string {
	let href = getResourceHref(entry.key, isCollectionEntry(entry));
	let customMetadata = isDirectoryEntry(entry) ? undefined : entry.customMetadata;
	let deadProperties = getDeadProperties(customMetadata);
	let liveProperties = Object.entries(fromEntry(entry)).flatMap(([key, value]) =>
		value === undefined ? [] : [renderDavProperty(key, value)],
	);

	let okProperties: string[] = [];
	let missingProperties: string[] = [];

	switch (propfindRequest.mode) {
		case 'allprop': {
			okProperties = [...liveProperties, ...deadProperties.map(renderPropertyElement)];
			break;
		}
		case 'propname': {
			okProperties = [
				...Object.entries(fromEntry(entry)).flatMap(([key, value]) =>
					value === undefined ? [] : [renderDavProperty(key, '')],
				),
				...deadProperties.map((property) => renderEmptyPropertyElement({ ...property, valueXml: '' })),
			];
			break;
		}
		case 'prop': {
			for (const property of propfindRequest.properties) {
				let liveValue = getLivePropertyValue(entry, property);
				if (liveValue !== undefined) {
					okProperties.push(renderDavProperty(property.localName, liveValue));
					continue;
				}
				let deadProperty = getDeadProperty(customMetadata, property.namespaceURI, property.localName);
				if (deadProperty !== null) {
					okProperties.push(renderPropertyElement(deadProperty));
				} else {
					missingProperties.push(renderEmptyPropertyElement({ ...property, valueXml: '' }));
				}
			}
			break;
		}
	}

	return `
	<response>
		<href>${escapeXml(href)}</href>${renderPropstat('HTTP/1.1 200 OK', okProperties)}${renderPropstat('HTTP/1.1 404 Not Found', missingProperties)}
	</response>`;
}

async function handle_propfind(request: Request, bucket: DavBucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let propfindRequest = parsePropfindRequest(await request.text());
	if (propfindRequest === null) {
		return new Response('Bad Request', { status: 400 });
	}

	let page = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">`;

	let entry = await resolveResource(bucket, resource_path);
	if (entry === null) {
		return new Response('Not Found', { status: 404 });
	}
	page += generate_propfind_response(entry, propfindRequest);

	if (isCollectionEntry(entry)) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case '0':
				break;
			case '1':
				{
					let prefix = resource_path === '' ? resource_path : resource_path + '/';
					for await (let member of listEntries(bucket, prefix)) {
						page += generate_propfind_response(member, propfindRequest);
					}
				}
				break;
			case 'infinity':
				{
					let prefix = resource_path === '' ? resource_path : resource_path + '/';
					for await (let member of listEntries(bucket, prefix, true)) {
						page += generate_propfind_response(member, propfindRequest);
					}
				}
				break;
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	}

	page += '\n</multistatus>\n';
	return new Response(page, {
		status: 207,
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
		},
	});
}

async function handle_proppatch(request: Request, bucket: DavBucket): Promise<Response> {
	const resource_path = make_resource_path(request);
	let lockResponse = await assertLockPermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}

	// 检查资源是否存在
	let object = await bucket.head(resource_path);
	if (object === null && resource_path !== '' && (await hasImplicitDirectory(bucket, resource_path))) {
		// Materialize the implicit directory as an explicit marker so the
		// properties have an object to live on.
		await bucket.put(resource_path, new Uint8Array(), {
			customMetadata: { resourcetype: '<collection />' },
		});
		object = await bucket.head(resource_path);
	}
	if (object === null) {
		return new Response('Not Found', { status: 404 });
	}

	const body = await request.text();
	let parsedRequest = parseProppatchRequest(body);
	if (parsedRequest === null) {
		return new Response('Bad Request', { status: 400 });
	}
	const { operations } = parsedRequest;

	// 复制原有的自定义元数据
	const customMetadata = getPreservedCustomMetadata(object.customMetadata);
	const successfulSetProperties: DeadProperty[] = [];
	const failedSetProperties: DeadProperty[] = [];
	const successfulRemoveProperties: DeadProperty[] = [];
	const failedRemoveProperties: DeadProperty[] = [];

	// 更新元数据
	for (const operation of operations) {
		if (isProtectedProperty(operation.property)) {
			if (operation.action === 'set') {
				failedSetProperties.push(operation.property);
			} else {
				failedRemoveProperties.push(operation.property);
			}
			continue;
		}
		if (operation.action === 'set') {
			customMetadata[getDeadPropertyKey(operation.property.namespaceURI, operation.property.localName)] =
				JSON.stringify(operation.property);
			successfulSetProperties.push(operation.property);
		} else {
			delete customMetadata[getDeadPropertyKey(operation.property.namespaceURI, operation.property.localName)];
			successfulRemoveProperties.push(operation.property);
		}
	}

	const hasFailures = failedSetProperties.length > 0 || failedRemoveProperties.length > 0;
	if (!hasFailures) {
		// 更新对象的元数据
		const src = await bucket.get(object.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}

		await bucket.put(object.key, src.body, {
			httpMetadata: object.httpMetadata,
			customMetadata: customMetadata,
		});
	}

	// 构造响应
	let propstats = new Map<string, string[]>();
	const appendPropstat = (property: DeadProperty, status: string) => {
		let props = propstats.get(status) ?? [];
		props.push(renderEmptyPropertyElement({ ...property, valueXml: '' }));
		propstats.set(status, props);
	};
	const successStatus = hasFailures ? 'HTTP/1.1 424 Failed Dependency' : 'HTTP/1.1 200 OK';

	for (const property of successfulSetProperties) {
		appendPropstat(property, successStatus);
	}

	for (const property of successfulRemoveProperties) {
		appendPropstat(property, successStatus);
	}

	for (const property of failedSetProperties) {
		appendPropstat(property, 'HTTP/1.1 403 Forbidden');
	}

	for (const property of failedRemoveProperties) {
		appendPropstat(property, 'HTTP/1.1 403 Forbidden');
	}

	let responseXML = `<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">\n\t<response>\n\t\t<href>${escapeXml(getResourceHref(object.key, object.customMetadata?.resourcetype === '<collection />'))}</href>`;
	for (const [status, propNames] of propstats) {
		responseXML += `\n\t\t<propstat>\n\t\t\t<prop>\n${propNames.map((propName) => `\t\t\t\t${propName}`).join('\n')}\n\t\t\t</prop>\n\t\t\t<status>${status}</status>\n\t\t</propstat>`;
	}
	responseXML += '\n\t</response>\n</multistatus>';

	return new Response(responseXML, {
		status: 207,
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
		},
	});
}

async function handle_copy(request: Request, bucket: DavBucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let dont_overwrite = request.headers.get('Overwrite') === 'F';
	let destination_header = request.headers.get('Destination');
	if (destination_header === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let destination = parseDestinationPath(destination_header, request.url);
	if (destination === null) {
		return new Response('Bad Request', { status: 400 });
	}
	if (isSameOrDescendantPath(resource_path, destination)) {
		return new Response('Bad Request', { status: 400 });
	}
	let lockResponse = await assertLockPermission(request, bucket, destination);
	if (lockResponse !== null) {
		return lockResponse;
	}

	// Check if the parent directory exists
	let destination_parent = getParentPath(destination);
	if (!(await hasCollectionResource(bucket, destination_parent))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	let destination_exists = await bucket.head(destination);
	if (dont_overwrite && destination_exists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let resource = await bucket.head(resource_path);
	let is_dir: boolean;
	if (resource !== null) {
		is_dir = resource.customMetadata?.resourcetype === '<collection />';
	} else if (await hasImplicitDirectory(bucket, resource_path)) {
		is_dir = true;
	} else {
		return new Response('Not Found', { status: 404 });
	}

	if (is_dir) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let prefix = resource_path + '/';
				const copy = async (object: R2Object) => {
					let target = destination + '/' + object.key.slice(prefix.length);
					target = target.endsWith('/') ? target.slice(0, -1) : target;
					let src = await bucket.get(object.key);
					if (src !== null) {
						await bucket.put(target, src.body, {
							httpMetadata: object.httpMetadata,
							customMetadata: stripLockMetadata(object.customMetadata),
						});
					}
				};
				// An implicit directory has no marker object of its own to copy.
				let promise_array = resource === null ? [] : [copy(resource)];
				for await (let object of listAll(bucket, prefix, true)) {
					promise_array.push(copy(object));
				}
				await Promise.all(promise_array);
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return createdResponse(destination, true);
				}
			}
			case '0': {
				if (resource === null) {
					// Depth 0 copies the collection without members; materialize it
					// as an explicit marker at the destination.
					await bucket.put(destination, new Uint8Array(), {
						customMetadata: { resourcetype: '<collection />' },
					});
				} else {
					let object = await bucket.get(resource.key);
					if (object === null) {
						return new Response('Not Found', { status: 404 });
					}
					await bucket.put(destination, object.body, {
						httpMetadata: object.httpMetadata,
						customMetadata: stripLockMetadata(object.customMetadata),
					});
				}
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return createdResponse(destination, true);
				}
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		let src = await bucket.get(resource_path);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: stripLockMetadata(src.customMetadata),
		});
		if (destination_exists) {
			return new Response(null, { status: 204 });
		} else {
			return createdResponse(destination, false);
		}
	}
}

async function handle_move(request: Request, bucket: DavBucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let overwrite = (request.headers.get('Overwrite') ?? 'T') !== 'F';
	let destination_header = request.headers.get('Destination');
	if (destination_header === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let destination = parseDestinationPath(destination_header, request.url);
	if (destination === null) {
		return new Response('Bad Request', { status: 400 });
	}
	if (isSameOrDescendantPath(resource_path, destination)) {
		return new Response('Bad Request', { status: 400 });
	}
	let sourceLockResponse = await assertLockPermission(request, bucket, resource_path);
	if (sourceLockResponse !== null) {
		return sourceLockResponse;
	}
	let destinationLockResponse = await assertLockPermission(request, bucket, destination);
	if (destinationLockResponse !== null) {
		return destinationLockResponse;
	}

	// Check if the parent directory exists
	let destination_parent = getParentPath(destination);
	if (!(await hasCollectionResource(bucket, destination_parent))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	let destination_exists = await bucket.head(destination);
	if (!overwrite && destination_exists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let resource = await bucket.head(resource_path);
	let is_dir: boolean;
	if (resource !== null) {
		is_dir = resource.customMetadata?.resourcetype === '<collection />';
	} else if (await hasImplicitDirectory(bucket, resource_path)) {
		is_dir = true;
	} else {
		return new Response('Not Found', { status: 404 });
	}

	if (destination_exists) {
		// Delete the destination first
		let deleteHeaders = new Headers();
		for (const headerName of INTERNAL_DELETE_FORWARD_HEADERS) {
			let headerValue = request.headers.get(headerName);
			if (headerValue !== null) {
				deleteHeaders.set(headerName, headerValue);
			}
		}
		let deleteResponse = await handle_delete(
			new Request(new URL(destination_header), {
				method: 'DELETE',
				headers: deleteHeaders,
			}),
			bucket,
		);
		if (!deleteResponse.ok) {
			return deleteResponse;
		}
	}

	if (is_dir) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let prefix = resource_path + '/';
				const move = async (object: R2Object) => {
					let target = destination + '/' + object.key.slice(prefix.length);
					target = target.endsWith('/') ? target.slice(0, -1) : target;
					let src = await bucket.get(object.key);
					if (src !== null) {
						await bucket.put(target, src.body, {
							httpMetadata: object.httpMetadata,
							customMetadata: getPreservedCustomMetadata(object.customMetadata),
						});
						await bucket.delete(object.key);
					}
				};
				// An implicit directory has no marker object of its own to move.
				let promise_array = resource === null ? [] : [move(resource)];
				for await (let object of listAll(bucket, prefix, true)) {
					promise_array.push(move(object));
				}
				await Promise.all(promise_array);
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return createdResponse(destination, true);
				}
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		let src = await bucket.get(resource_path);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: getPreservedCustomMetadata(src.customMetadata),
		});
		await bucket.delete(resource_path);
		if (destination_exists) {
			return new Response(null, { status: 204 });
		} else {
			return createdResponse(destination, false);
		}
	}
}

async function handle_lock(request: Request, bucket: DavBucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let depthHeader = request.headers.get('Depth');
	if (depthHeader !== null && !VALID_LOCK_DEPTHS.includes(depthHeader as (typeof VALID_LOCK_DEPTHS)[number])) {
		return new Response('Bad Request', { status: 400 });
	}
	let { timeout, expiresAt } = parseTimeout(request.headers.get('Timeout'));
	let body = await request.text();
	// Per WebDAV, an empty LOCK request body indicates a lock refresh operation.
	let lockRequest = body === '' ? null : parseLockRequest(body);
	if (body !== '' && (lockRequest === null || !lockRequest.hasWriteType)) {
		return new Response('Bad Request', { status: 400 });
	}
	let requestedScope: LockDetails['scope'] = lockRequest?.scope ?? 'exclusive';
	let requestLockTokens = getRequestLockTokens(request);
	let owner = lockRequest?.owner;
	let lockResponse = await assertLockPermission(request, bucket, resource_path, {
		ignoreSharedLocksOnTarget: body !== '' && requestedScope === 'shared',
	});
	if (lockResponse !== null) {
		return lockResponse;
	}

	let refreshTarget = body === '' ? await findMatchingLock(request, bucket, resource_path) : null;
	let resource = refreshTarget?.resource ?? (await bucket.head(resource_path));
	let currentLocks = getLockDetails(resource?.customMetadata);
	let existingLock = refreshTarget?.lockDetails;
	if (
		refreshTarget === null &&
		body === '' &&
		resource !== null &&
		currentLocks.length > 0 &&
		!currentLocks.some((currentLock) => requestLockTokens.includes(currentLock.token))
	) {
		return new Response('Locked', { status: 423 });
	}
	if (resource === null) {
		if (body === '') {
			return new Response('Bad Request', { status: 400 });
		}
		let isImplicitDirectory = resource_path !== '' && (await hasImplicitDirectory(bucket, resource_path));
		if (!isImplicitDirectory) {
			if (!(await hasCollectionResource(bucket, getParentPath(resource_path)))) {
				return new Response('Conflict', { status: 409 });
			}
			if (request.url.endsWith('/')) {
				return new Response('Conflict', { status: 409 });
			}
		}

		// Locking an implicit directory materializes its collection marker so
		// the lock metadata has an object to live on; otherwise this creates
		// the empty lock-null resource of RFC 4918 section 7.3.
		await bucket.put(resource_path, new Uint8Array(), {
			customMetadata: isImplicitDirectory ? { resourcetype: '<collection />' } : {},
		});
		resource = await bucket.head(resource_path);
		currentLocks = [];
	}

	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	if (existingLock === undefined) {
		if (requestedScope === 'exclusive' && currentLocks.length > 0) {
			return new Response('Locked', { status: 423 });
		}
		if (requestedScope === 'shared' && currentLocks.some((lockDetail) => lockDetail.scope === 'exclusive')) {
			return new Response('Locked', { status: 423 });
		}
	}
	let depth: (typeof VALID_LOCK_DEPTHS)[number];
	if (existingLock !== undefined && depthHeader === null && body === '') {
		// Refreshing an existing lock without an explicit Depth header:
		// preserve the original lock depth instead of broadening it.
		depth = existingLock.depth;
	} else {
		depth = determineLockDepth(
			resource.customMetadata?.resourcetype,
			depthHeader as (typeof VALID_LOCK_DEPTHS)[number] | null,
		);
	}

	let lockDetails: LockDetails = {
		token: existingLock?.token ?? crypto.randomUUID(),
		owner: owner ?? existingLock?.owner,
		scope: existingLock?.scope ?? requestedScope,
		depth,
		timeout,
		expiresAt,
		root: getResourceHref(resource.key, resource.customMetadata?.resourcetype === '<collection />'),
	};
	let updatedLocks =
		existingLock === undefined
			? [...currentLocks, lockDetails]
			: currentLocks.map((currentLock) => (currentLock.token === existingLock.token ? lockDetails : currentLock));

	let source = await bucket.get(resource.key);
	if (source === null) {
		return new Response('Not Found', { status: 404 });
	}

	let putResult = await bucket.put(resource.key, source.body, {
		httpMetadata: source.httpMetadata,
		customMetadata: withLockMetadata(resource.customMetadata, updatedLocks),
	});

	return new Response(
		`<?xml version="1.0" encoding="utf-8"?>\n<prop xmlns="DAV:"><lockdiscovery>${getLockDiscovery(updatedLocks)}</lockdiscovery></prop>`,
		{
			status: existingLock ? 200 : 201,
			headers: {
				'Content-Type': 'application/xml; charset=utf-8',
				'Lock-Token': `<urn:uuid:${lockDetails.token}>`,
				ETag: putResult.httpEtag,
				...(existingLock
					? {}
					: {
							Location: getResourceHref(resource.key, resource.customMetadata?.resourcetype === '<collection />'),
						}),
			},
		},
	);
}

async function handle_unlock(request: Request, bucket: DavBucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let resource = await bucket.head(resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}

	let lockToken = request.headers.get('Lock-Token');
	if (lockToken === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let lockResponse = await assertLockPermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let lockDetails = getLockDetails(resource.customMetadata);
	let normalizedToken = normalizeLockToken(lockToken);
	if (!lockDetails.some((lockDetail) => lockDetail.token === normalizedToken)) {
		return new Response('Conflict', { status: 409 });
	}

	let source = await bucket.get(resource.key);
	if (source === null) {
		return new Response('Not Found', { status: 404 });
	}

	await bucket.put(resource.key, source.body, {
		httpMetadata: source.httpMetadata,
		customMetadata: withLockMetadata(
			resource.customMetadata,
			lockDetails.filter((lockDetail) => lockDetail.token !== normalizedToken),
		),
	});

	return new Response(null, { status: 204 });
}

const DAV_CLASS = '1, 2';
const SUPPORT_METHODS = [
	'OPTIONS',
	'PROPFIND',
	'PROPPATCH',
	'MKCOL',
	'GET',
	'HEAD',
	'PUT',
	'POST',
	'DELETE',
	'COPY',
	'MOVE',
	'LOCK',
	'UNLOCK',
];

async function dispatch_handler(request: Request, bucket: DavBucket): Promise<Response> {
	switch (request.method) {
		case 'OPTIONS': {
			return new Response(null, {
				status: 200,
				headers: {
					Allow: SUPPORT_METHODS.join(', '),
					DAV: DAV_CLASS,
					// Microsoft clients (WebDAV MiniRedir, Office) check this
					// header to decide whether to author over WebDAV.
					'MS-Author-Via': 'DAV',
				},
			});
		}
		case 'HEAD': {
			return await handle_head(request, bucket);
		}
		case 'GET': {
			return await handle_get(request, bucket);
		}
		case 'PUT': {
			return await handle_put(request, bucket);
		}
		case 'POST': {
			// curl-friendly upload / set-type alias: the path is the destination.
			return await handle_put(request, bucket);
		}
		case 'DELETE': {
			return await handle_delete(request, bucket);
		}
		case 'MKCOL': {
			return await handle_mkcol(request, bucket);
		}
		case 'PROPFIND': {
			return await handle_propfind(request, bucket);
		}
		case 'PROPPATCH': {
			return await handle_proppatch(request, bucket);
		}
		case 'COPY': {
			return await handle_copy(request, bucket);
		}
		case 'MOVE': {
			return await handle_move(request, bucket);
		}
		case 'LOCK': {
			return await handle_lock(request, bucket);
		}
		case 'UNLOCK': {
			return await handle_unlock(request, bucket);
		}
		default: {
			return new Response('Method Not Allowed', {
				status: 405,
				headers: {
					Allow: SUPPORT_METHODS.join(', '),
					DAV: DAV_CLASS,
					'MS-Author-Via': 'DAV',
				},
			});
		}
	}
}

type UserRecord = {
	password: string;
};

function isValidUsername(username: string): boolean {
	return (
		username.length > 0 && username.length <= 128 && !username.includes('/') && username !== '.' && username !== '..'
	);
}

// Resolves Basic credentials against the `users` KV namespace. Returns the
// username, or null when the header is absent or malformed, the user is
// unknown (including a completely unseeded namespace), the stored value is
// not valid JSON, or the password does not match.
async function authenticate(request: Request, users: KVNamespace): Promise<string | null> {
	let header = request.headers.get('Authorization');
	if (header === null) {
		return null;
	}
	let encoded = header.match(/^Basic\s+(.+)$/i)?.[1];
	if (encoded === undefined) {
		return null;
	}
	let credentials: string;
	try {
		credentials = atob(encoded.trim());
	} catch {
		return null;
	}
	// Split at the first colon only: passwords may contain colons.
	let separator = credentials.indexOf(':');
	if (separator === -1) {
		return null;
	}
	let username = credentials.slice(0, separator);
	let password = credentials.slice(separator + 1);
	if (!isValidUsername(username)) {
		return null;
	}

	let record: UserRecord | null;
	try {
		record = await users.get<UserRecord>(`user:${username}`, { type: 'json', cacheTtl: 60 });
	} catch {
		return null;
	}
	if (record === null || typeof record.password !== 'string') {
		return null;
	}

	const encoder = new TextEncoder();
	if (!timingSafeEqual(encoder.encode(password), encoder.encode(record.password))) {
		return null;
	}
	return username;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		let response: Response;
		if (request.method === 'OPTIONS') {
			// Capability probe: static response, touches no data, so it needs no
			// auth and no scope. MiniRedir sends it before offering credentials.
			response = await dispatch_handler(request, env.bucket);
		} else {
			let username = await authenticate(request, env.users);
			if (username !== null) {
				// Authenticated WebDAV: `/` is mounted at `<username>/`.
				response = await dispatch_handler(request, new ScopedBucket(env.bucket, username + '/'));
			} else if (
				request.headers.get('Authorization') === null &&
				(request.method === 'GET' || request.method === 'HEAD')
			) {
				// Public web mode: anonymous read-only access to the whole bucket.
				// Deliberately no WWW-Authenticate here — browsers must never be
				// prompted to log in; auth exists only for WebDAV clients.
				response = await dispatch_handler(request, env.bucket);
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
