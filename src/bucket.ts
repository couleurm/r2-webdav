// The subset of the R2 bucket API the WebDAV handlers use. Satisfied both by
// the raw R2Bucket binding (anonymous web mode) and by ScopedBucket
// (authenticated per-user mounts).
export interface DavBucket {
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
// only ever see unprefixed keys, so hrefs, Location headers, and Destination
// parsing all come out mount-relative, and no key a user can produce
// (including `..` tricks, which are resolved before this layer) escapes the
// prefix.
export class ScopedBucket implements DavBucket {
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
