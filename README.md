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

## Content types (MIME)

A file's content type decides whether the browser shows it inline (image, video,
PDF) or downloads it. Resolution order when serving a file:

1. A type set **explicitly** by the user (via `?type=`, see below) — used verbatim.
2. Otherwise the type stored at upload, if it's a real one.
3. Otherwise inferred from the file **extension** (`.mp4` → `video/mp4`, etc.).
4. Otherwise `application/octet-stream`.

Generic upload defaults — `application/octet-stream`, and curl's own
`application/x-www-form-urlencoded` (`--data-binary`) / `multipart/form-data`
(`-F`) — count as "no real type", so extension inference takes over. That means
plain curl uploads and correctly-named files just work without extra flags.

### curl endpoints

The request path is always the destination — there is no `/upload` prefix.
Uploads accept both `PUT` and `POST`. All of these are jailed to the caller's
own directory and require Basic auth.

```bash
# upload a file (type inferred from the .mp4 extension)
curl -u foo:pass -T ./clip.mp4            https://<host>/clip.mp4
curl -u foo:pass --data-binary @clip.mp4  https://<host>/clip.mp4   # POST works too

# upload and set the type explicitly
curl -u foo:pass --data-binary @blob "https://<host>/clip?type=video/mp4"

# change the type of an EXISTING file, without re-uploading (no body)
curl -u foo:pass -X POST "https://<host>/report.bin?type=application/pdf"

# read a file AS a different type, for this request only (nothing stored)
curl "https://<host>/about.html?type=text/plain"
```

`?type=` (alias `?content-type=`) takes a `type/subtype[; params]` string;
anything malformed returns `400`.

- On upload/`POST`, it sets the stored type: an explicit type sticks across
  serving and `PROPFIND`, and a later plain re-upload clears it and reverts to
  inference.
- On `GET`/`HEAD`, it overrides the served `Content-Type` for that one response
  only — nothing is stored. Handy for viewing an HTML page as `text/plain` in a
  browser. Works on the anonymous web view too (no auth needed to read).

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
