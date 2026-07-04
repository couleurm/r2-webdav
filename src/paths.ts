// Path and href handling: translating between request URLs and bucket keys.
// Keys are always mount-relative (never prefixed), with no trailing slash;
// hrefs are percent-encoded and carry a trailing slash for collections.

export function getResourceHref(key: string, isCollection: boolean): string {
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

export function decodeResourcePath(pathname: string): string {
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

export function getParentPath(resourcePath: string): string {
	let normalizedPath = resourcePath.endsWith('/') ? resourcePath.slice(0, -1) : resourcePath;
	return normalizedPath.split('/').slice(0, -1).join('/');
}

export function makeResourcePath(request: Request): string {
	return decodeResourcePath(new URL(request.url).pathname);
}

export function parseDestinationPath(destinationHeader: string, requestUrl: string): string | null {
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

export function isSameOrDescendantPath(resourcePath: string, destinationPath: string): boolean {
	if (destinationPath === resourcePath) {
		return true;
	}
	if (resourcePath === '') {
		return destinationPath !== '';
	}
	return destinationPath.startsWith(`${resourcePath}/`);
}
