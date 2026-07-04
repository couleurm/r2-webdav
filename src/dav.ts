// The WebDAV protocol layer: live and dead properties, locking (RFC 4918
// class 2), the PROPFIND/PROPPATCH/LOCK request-body parsers, the eleven
// method handlers, and the method dispatcher.

import type { DavBucket } from './bucket';
import {
	type DirectoryEntry,
	deleteAllWithPrefix,
	hasCollectionResource,
	hasImplicitDirectory,
	isCollectionEntry,
	isDirectoryEntry,
	listAll,
	listEntries,
	resolveResource,
} from './storage';
import {
	getParentPath,
	getResourceHref,
	isSameOrDescendantPath,
	makeResourcePath,
	parseDestinationPath,
} from './paths';
import { calcContentRange, checkPreconditions, createdResponse, extractHttpMetadata } from './http';
import { EXPLICIT_CONTENT_TYPE_KEY, baseMimeType, isValidMimeType, resolveContentType } from './mime';
import { escapeXml, getChildElements, parseXmlDocument, serializeNodeChildren } from './xml';
import { redirectToCollection, renderDirectoryListing, renderMarkdownDocument } from './web';

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

function renderDavProperty(propName: string, value: string): string {
	let content = RAW_XML_DAV_PROPERTIES.has(propName) ? value : escapeXml(value);
	return `<${propName}>${content}</${propName}>`;
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

function propertyElementParts(property: DeadProperty): { qualifiedName: string; namespaceDeclaration: string } {
	let qualifiedName = property.prefix ? `${property.prefix}:${property.localName}` : property.localName;
	let namespaceDeclaration =
		property.namespaceURI === ''
			? ' xmlns=""'
			: property.prefix
				? ` xmlns:${property.prefix}="${escapeXml(property.namespaceURI)}"`
				: ` xmlns="${escapeXml(property.namespaceURI)}"`;
	return { qualifiedName, namespaceDeclaration };
}

function renderPropertyElement(property: DeadProperty): string {
	let { qualifiedName, namespaceDeclaration } = propertyElementParts(property);
	return `<${qualifiedName}${namespaceDeclaration}>${property.valueXml}</${qualifiedName}>`;
}

function renderEmptyPropertyElement(property: DeadProperty): string {
	let { qualifiedName, namespaceDeclaration } = propertyElementParts(property);
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

	let requestPath = makeResourcePath(request);
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

async function handleHead(request: Request, bucket: DavBucket, webMode = false): Promise<Response> {
	let response = await handleGet(request, bucket, webMode);
	return new Response(null, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

async function handleGet(request: Request, bucket: DavBucket, webMode = false): Promise<Response> {
	let resourcePath = makeResourcePath(request);
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
		let entry = await resolveResource(bucket, resourcePath);
		if (entry === null || !isCollectionEntry(entry)) {
			return new Response('Not Found', { status: 404 });
		}
		return await renderDirectoryListing(bucket, resourcePath, url);
	} else {
		let object = await bucket.get(resourcePath, {
			range: request.headers,
		});

		let isR2ObjectBody = (object: R2Object | R2ObjectBody): object is R2ObjectBody => {
			return 'body' in object;
		};

		if (object === null) {
			if (await hasImplicitDirectory(bucket, resourcePath)) {
				return redirectToCollection(resourcePath);
			}
			return new Response('Not Found', { status: 404 });
		}
		if (object.customMetadata?.resourcetype === '<collection />') {
			return redirectToCollection(resourcePath);
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
			// Browser-facing markdown rendering: a file whose *stored* type is
			// text/markdown, requested with `?type=text/html`, is converted
			// instead of relabeled. Every other (stored, requested) combination
			// keeps plain relabel semantics — which double as the "raw" view
			// (e.g. `?type=text/plain` on an HTML or markdown file). Never
			// applies to authenticated/jailed WebDAV traffic.
			if (
				webMode &&
				typeOverride !== null &&
				baseMimeType(typeOverride) === 'text/html' &&
				baseMimeType(resolveContentType(object)) === 'text/markdown'
			) {
				return await renderMarkdownDocument(bucket, resourcePath, object, url);
			}
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

// Handles PUT and its curl-friendly POST alias. The request path is always the
// file destination (no /upload prefix). A `?type=`/`?content-type=` query sets
// an explicit MIME type; with no request body it becomes a metadata-only
// "set the type of this existing file" operation.
async function handlePut(request: Request, bucket: DavBucket): Promise<Response> {
	let url = new URL(request.url);
	if (url.pathname.endsWith('/')) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	let resourcePath = makeResourcePath(request);
	let lockResponse = await assertLockPermission(request, bucket, resourcePath);
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

	let existing = await bucket.head(resourcePath);

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
		let src = await bucket.get(resourcePath);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		let customMetadata = getPreservedCustomMetadata(existing.customMetadata);
		customMetadata[EXPLICIT_CONTENT_TYPE_KEY] = '1';
		let putResult = await bucket.put(resourcePath, src.body, {
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
	if (!(await hasCollectionResource(bucket, getParentPath(resourcePath)))) {
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
	let putResult = await bucket.put(resourcePath, body, {
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

async function handleDelete(request: Request, bucket: DavBucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let lockResponse = await assertRecursiveDeletePermission(request, bucket, resourcePath);
	if (lockResponse !== null) {
		return lockResponse;
	}

	if (resourcePath === '') {
		await deleteAllWithPrefix(bucket, '');
		return new Response(null, { status: 204 });
	}

	let resource = await bucket.head(resourcePath);
	if (resource === null) {
		if (!(await hasImplicitDirectory(bucket, resourcePath))) {
			return new Response('Not Found', { status: 404 });
		}
		await deleteAllWithPrefix(bucket, resourcePath + '/');
		return new Response(null, { status: 204 });
	}
	if (resource.customMetadata?.resourcetype !== '<collection />') {
		await bucket.delete(resourcePath);
		return new Response(null, { status: 204 });
	}

	await deleteAllWithPrefix(bucket, resourcePath + '/');
	await bucket.delete(resourcePath);
	return new Response(null, { status: 204 });
}

async function handleMkcol(request: Request, bucket: DavBucket): Promise<Response> {
	if ((await request.clone().arrayBuffer()).byteLength > 0) {
		return new Response('Unsupported Media Type', { status: 415 });
	}

	let resourcePath = makeResourcePath(request);
	let lockResponse = await assertLockPermission(request, bucket, resourcePath);
	if (lockResponse !== null) {
		return lockResponse;
	}

	// Check if the resource already exists (as an object or an implicit directory)
	let resource = await bucket.head(resourcePath);
	if (resource !== null || (await hasImplicitDirectory(bucket, resourcePath))) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	// Check if the parent directory exists
	let parentDir = getParentPath(resourcePath);
	if (!(await hasCollectionResource(bucket, parentDir))) {
		return new Response('Conflict', { status: 409 });
	}

	await bucket.put(resourcePath, new Uint8Array(), {
		httpMetadata: extractHttpMetadata(request.headers),
		customMetadata: { resourcetype: '<collection />' },
	});
	return new Response('', { status: 201 });
}

function renderPropfindResponse(entry: R2Object | DirectoryEntry, propfindRequest: PropfindRequest): string {
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

async function handlePropfind(request: Request, bucket: DavBucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let propfindRequest = parsePropfindRequest(await request.text());
	if (propfindRequest === null) {
		return new Response('Bad Request', { status: 400 });
	}

	let page = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">`;

	let entry = await resolveResource(bucket, resourcePath);
	if (entry === null) {
		return new Response('Not Found', { status: 404 });
	}
	page += renderPropfindResponse(entry, propfindRequest);

	if (isCollectionEntry(entry)) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case '0':
				break;
			case '1':
				{
					let prefix = resourcePath === '' ? resourcePath : resourcePath + '/';
					for await (let member of listEntries(bucket, prefix)) {
						page += renderPropfindResponse(member, propfindRequest);
					}
				}
				break;
			case 'infinity':
				{
					let prefix = resourcePath === '' ? resourcePath : resourcePath + '/';
					for await (let member of listEntries(bucket, prefix, true)) {
						page += renderPropfindResponse(member, propfindRequest);
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

async function handleProppatch(request: Request, bucket: DavBucket): Promise<Response> {
	const resourcePath = makeResourcePath(request);
	let lockResponse = await assertLockPermission(request, bucket, resourcePath);
	if (lockResponse !== null) {
		return lockResponse;
	}

	// Check that the resource exists.
	let object = await bucket.head(resourcePath);
	if (object === null && resourcePath !== '' && (await hasImplicitDirectory(bucket, resourcePath))) {
		// Materialize the implicit directory as an explicit marker so the
		// properties have an object to live on.
		await bucket.put(resourcePath, new Uint8Array(), {
			customMetadata: { resourcetype: '<collection />' },
		});
		object = await bucket.head(resourcePath);
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

	// Start from the existing custom metadata.
	const customMetadata = getPreservedCustomMetadata(object.customMetadata);
	const successfulSetProperties: DeadProperty[] = [];
	const failedSetProperties: DeadProperty[] = [];
	const successfulRemoveProperties: DeadProperty[] = [];
	const failedRemoveProperties: DeadProperty[] = [];

	// Apply the operations to the metadata.
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
		// Persist the updated metadata: R2 has no metadata patch, so re-put the
		// object with its own body.
		const src = await bucket.get(object.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}

		await bucket.put(object.key, src.body, {
			httpMetadata: object.httpMetadata,
			customMetadata: customMetadata,
		});
	}

	// Build the multistatus response.
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

async function handleCopy(request: Request, bucket: DavBucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let dontOverwrite = request.headers.get('Overwrite') === 'F';
	let destinationHeader = request.headers.get('Destination');
	if (destinationHeader === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let destination = parseDestinationPath(destinationHeader, request.url);
	if (destination === null) {
		return new Response('Bad Request', { status: 400 });
	}
	if (isSameOrDescendantPath(resourcePath, destination)) {
		return new Response('Bad Request', { status: 400 });
	}
	let lockResponse = await assertLockPermission(request, bucket, destination);
	if (lockResponse !== null) {
		return lockResponse;
	}

	// Check if the parent directory exists
	let destinationParent = getParentPath(destination);
	if (!(await hasCollectionResource(bucket, destinationParent))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	let destinationExists = await bucket.head(destination);
	if (dontOverwrite && destinationExists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let resource = await bucket.head(resourcePath);
	let isDir: boolean;
	if (resource !== null) {
		isDir = resource.customMetadata?.resourcetype === '<collection />';
	} else if (await hasImplicitDirectory(bucket, resourcePath)) {
		isDir = true;
	} else {
		return new Response('Not Found', { status: 404 });
	}

	if (isDir) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let prefix = resourcePath + '/';
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
				let copyPromises = resource === null ? [] : [copy(resource)];
				for await (let object of listAll(bucket, prefix, true)) {
					copyPromises.push(copy(object));
				}
				await Promise.all(copyPromises);
				if (destinationExists) {
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
				if (destinationExists) {
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
		let src = await bucket.get(resourcePath);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: stripLockMetadata(src.customMetadata),
		});
		if (destinationExists) {
			return new Response(null, { status: 204 });
		} else {
			return createdResponse(destination, false);
		}
	}
}

async function handleMove(request: Request, bucket: DavBucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let overwrite = (request.headers.get('Overwrite') ?? 'T') !== 'F';
	let destinationHeader = request.headers.get('Destination');
	if (destinationHeader === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let destination = parseDestinationPath(destinationHeader, request.url);
	if (destination === null) {
		return new Response('Bad Request', { status: 400 });
	}
	if (isSameOrDescendantPath(resourcePath, destination)) {
		return new Response('Bad Request', { status: 400 });
	}
	let sourceLockResponse = await assertLockPermission(request, bucket, resourcePath);
	if (sourceLockResponse !== null) {
		return sourceLockResponse;
	}
	let destinationLockResponse = await assertLockPermission(request, bucket, destination);
	if (destinationLockResponse !== null) {
		return destinationLockResponse;
	}

	// Check if the parent directory exists
	let destinationParent = getParentPath(destination);
	if (!(await hasCollectionResource(bucket, destinationParent))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	let destinationExists = await bucket.head(destination);
	if (!overwrite && destinationExists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let resource = await bucket.head(resourcePath);
	let isDir: boolean;
	if (resource !== null) {
		isDir = resource.customMetadata?.resourcetype === '<collection />';
	} else if (await hasImplicitDirectory(bucket, resourcePath)) {
		isDir = true;
	} else {
		return new Response('Not Found', { status: 404 });
	}

	if (destinationExists) {
		// Delete the destination first
		let deleteHeaders = new Headers();
		for (const headerName of INTERNAL_DELETE_FORWARD_HEADERS) {
			let headerValue = request.headers.get(headerName);
			if (headerValue !== null) {
				deleteHeaders.set(headerName, headerValue);
			}
		}
		let deleteResponse = await handleDelete(
			new Request(new URL(destinationHeader), {
				method: 'DELETE',
				headers: deleteHeaders,
			}),
			bucket,
		);
		if (!deleteResponse.ok) {
			return deleteResponse;
		}
	}

	if (isDir) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let prefix = resourcePath + '/';
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
				let movePromises = resource === null ? [] : [move(resource)];
				for await (let object of listAll(bucket, prefix, true)) {
					movePromises.push(move(object));
				}
				await Promise.all(movePromises);
				if (destinationExists) {
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
		let src = await bucket.get(resourcePath);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: getPreservedCustomMetadata(src.customMetadata),
		});
		await bucket.delete(resourcePath);
		if (destinationExists) {
			return new Response(null, { status: 204 });
		} else {
			return createdResponse(destination, false);
		}
	}
}

async function handleLock(request: Request, bucket: DavBucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
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
	let lockResponse = await assertLockPermission(request, bucket, resourcePath, {
		ignoreSharedLocksOnTarget: body !== '' && requestedScope === 'shared',
	});
	if (lockResponse !== null) {
		return lockResponse;
	}

	let refreshTarget = body === '' ? await findMatchingLock(request, bucket, resourcePath) : null;
	let resource = refreshTarget?.resource ?? (await bucket.head(resourcePath));
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
		let isImplicitDirectory = resourcePath !== '' && (await hasImplicitDirectory(bucket, resourcePath));
		if (!isImplicitDirectory) {
			if (!(await hasCollectionResource(bucket, getParentPath(resourcePath)))) {
				return new Response('Conflict', { status: 409 });
			}
			if (request.url.endsWith('/')) {
				return new Response('Conflict', { status: 409 });
			}
		}

		// Locking an implicit directory materializes its collection marker so
		// the lock metadata has an object to live on; otherwise this creates
		// the empty lock-null resource of RFC 4918 section 7.3.
		await bucket.put(resourcePath, new Uint8Array(), {
			customMetadata: isImplicitDirectory ? { resourcetype: '<collection />' } : {},
		});
		resource = await bucket.head(resourcePath);
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

async function handleUnlock(request: Request, bucket: DavBucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let resource = await bucket.head(resourcePath);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}

	let lockToken = request.headers.get('Lock-Token');
	if (lockToken === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let lockResponse = await assertLockPermission(request, bucket, resourcePath);
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
export const SUPPORT_METHODS = [
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

// `webMode` is true only for anonymous browser-facing requests (never for
// authenticated/jailed WebDAV): it enables browser sugar like the
// markdown-to-HTML conversion in handleGet. A routing decision made in
// fetch(), deliberately not inferred from the bucket implementation.
export async function dispatchHandler(request: Request, bucket: DavBucket, webMode = false): Promise<Response> {
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
			return await handleHead(request, bucket, webMode);
		}
		case 'GET': {
			return await handleGet(request, bucket, webMode);
		}
		case 'PUT': {
			return await handlePut(request, bucket);
		}
		case 'POST': {
			// curl-friendly upload / set-type alias: the path is the destination.
			return await handlePut(request, bucket);
		}
		case 'DELETE': {
			return await handleDelete(request, bucket);
		}
		case 'MKCOL': {
			return await handleMkcol(request, bucket);
		}
		case 'PROPFIND': {
			return await handlePropfind(request, bucket);
		}
		case 'PROPPATCH': {
			return await handleProppatch(request, bucket);
		}
		case 'COPY': {
			return await handleCopy(request, bucket);
		}
		case 'MOVE': {
			return await handleMove(request, bucket);
		}
		case 'LOCK': {
			return await handleLock(request, bucket);
		}
		case 'UNLOCK': {
			return await handleUnlock(request, bucket);
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
