# r2-webdav

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/abersheeran/r2-webdav)

Use Cloudflare Workers to provide a WebDav interface for Cloudflare R2.

Currently the server advertises WebDAV Class 1 and Class 2 (LOCK/UNLOCK) support.

The Worker serves two audiences from the same bucket:

- **Public web:** anonymous `GET`/`HEAD` requests browse the whole bucket
  read-only — directory listings as HTML, files as downloads. No login, no
  auth prompt, ever.
- **WebDAV (multi-user):** clients authenticate with HTTP Basic auth against
  accounts stored in a KV namespace. Each user is jailed to their own
  directory: user `foo` sees `/` mounted at the bucket prefix `foo/` and can
  only list, read, and write inside it. On the public web site that same data
  appears under `/foo/`.

There is no registration page, no admin panel, and no root account —
administrators manage accounts and data directly through KV and R2.

## Usage

Change wrangler.toml to your own.

```toml
[[r2_buckets]]
binding = 'bucket' # <~ valid JavaScript variable name, don't change this
bucket_name = 'webdav'

[[kv_namespaces]]
binding = 'users' # <~ don't change this
id = '<your namespace id>'
```

Create the KV namespace, then deploy.

```bash
wrangler kv namespace create users   # put the returned id into wrangler.toml
wrangler deploy
```

### Managing users

Accounts live in the `users` KV namespace: key `user:<username>`, value
`{"password":"<plaintext>"}`.

```bash
# create or update a user
wrangler kv key put "user:foo" '{"password":"s3cret"}' --binding=users --remote

# remove a user
wrangler kv key delete "user:foo" --binding=users --remote
```

Usernames must not contain `/` and may not be `.` or `..`. User lookups are
cached for up to 60 seconds per location, so password changes and deletions
can take up to a minute to apply. An empty namespace simply means every WebDAV
login fails with 401; public browsing keeps working.

## Development

With `wrangler`, you can run and deploy your Worker with the following commands:

```sh
# run your Worker in an ideal development workflow (with a local server, file watcher & more)
$ npm run dev

# deploy your Worker globally to the Cloudflare network (update your wrangler.toml file for configuration)
$ npm run deploy
```

## Test

Use [litmus](https://github.com/notroj/litmus) to test.

GitHub Actions runs the `basic`, `copymove`, `props`, and `locks` litmus suites against `wrangler dev --local`.
The `http` suite is currently excluded because local Workers runs still time out on the interim `Expect: 100-continue` response check.
