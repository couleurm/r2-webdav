// Basic-auth account lookup against the `users` KV namespace: key
// `user:<username>`, value `{"password":"..."}`. Seeded directly by admins;
// there is no registration or admin UI.

type UserRecord = {
	password: string;
};

function isValidUsername(username: string): boolean {
	return (
		username.length > 0 && username.length <= 128 && !username.includes('/') && username !== '.' && username !== '..'
	);
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

// Resolves Basic credentials against the `users` KV namespace. Returns the
// username, or null when the header is absent or malformed, the user is
// unknown (including a completely unseeded namespace), the stored value is
// not valid JSON, or the password does not match.
export async function authenticate(request: Request, users: KVNamespace): Promise<string | null> {
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
