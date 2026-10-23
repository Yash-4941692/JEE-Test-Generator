# Link Inspector

Paste a short link — `vplink.in`, `arolinks`, `bit.ly`, anything — and get the **direct final
destination**, plus the full redirect chain that got you there.

No dependencies, no database, no accounts. One Node process serves the UI and the resolver.

```bash
npm start          # http://localhost:3000
npm test           # 34 tests
```

Requires Node 20+ (uses the built-in `fetch`, `AbortSignal.timeout`, and `node:test`).

---

## What it does

You give it a short link. It behaves like a browser would, one hop at a time:

| Hop type | Example |
| --- | --- |
| HTTP redirects | `301`, `302`, `303`, `307`, `308` with `Location` headers |
| Meta refresh | `<meta http-equiv="refresh" content="0; url=…">` |
| Script redirects | `location.href = …`, `location.replace(…)`, `location.assign(…)` |
| Base64 payloads | `atob("aHR0cHM6…")`, `var dest = "aHR0cHM6…"` |
| JSON / text responses | `{"url": "https://…"}` or a body that is just a URL |
| Hidden params | `?url=https%3A%2F%2F…`, `?r=<base64>` |

For each hop it records the URL, the HTTP status, and *why* it moved on. The result screen
gives you the final URL with **Copy** and **Open** buttons, the destination host, the HTTP
status, the page title, and the content type — so a `.pdf` link is labelled as a PDF, not
just "a page".

It also lists the links found on the final page (labelled, never auto-clicked) and flags
destinations embedded directly in the short link's own query string.

## What it intentionally does not do

A resolver can follow redirects. It cannot become you.

- **No captcha / Cloudflare solving.** "Verify you are human", Turnstile, and reCAPTCHA
  pages need a real interactive browser. The tool detects these and says so plainly instead
  of faking a pass.
- **No countdown clicking.** Gateway pages that require a button press after a timer are
  reported, along with the links they contain.
- **No logins, no paywalls.** Content behind auth is behind auth.
- **No POST-based unlocks.** If the destination is only issued after a form submission with
  a token, it stays out of reach.

When it hits a gate, the UI labels the result **Gated** and shows the *last reachable URL* —
it never presents a gated page as if it were the destination.

## How it works

```
public/index.html ── UI
public/app.js     ── POST /api/resolve  { url }
server.js         ── static files, rate limit, SSRF guard
src/resolver.js   ── the redirect walker
```

`resolve()` walks up to 12 hops with a 35 s total budget (12 s per hop), `redirect: 'manual'`
so nothing is followed silently, capped body reads (512 KB), and a per-IP rate limit of
40 lookups/minute.

**SSRF protection:** before every hop, the hostname is resolved via DNS and rejected if it
is loopback, private, link-local, CGNAT, multicast, or `localhost` / `.internal` / metadata
addresses. A pasted link cannot be used to probe the server's own network.

**Privacy:** nothing is persisted server-side. No logs of resolved URLs, no database. The
UI keeps your last 8 lookups in `localStorage` only, and you can clear them with one click.

## Deploying

Any Node 20+ host works. The server must have **outbound internet access**, otherwise it
can't reach shorteners — it will say `Couldn't reach the site` rather than pretend.

```bash
docker build -t link-inspector .
docker run -p 3000:3000 link-inspector
```

or on Render / Railway / Fly / a VPS: `node server.js`, `PORT` respected.

## Using it as an API

```bash
curl -X POST http://localhost:3000/api/resolve \
  -H 'content-type: application/json' \
  -d '{"url":"https://vplink.in/snB67M"}'
```

```json
{
  "ok": true,
  "entryUrl": "https://vplink.in/snB67M",
  "finalUrl": "https://drive.google.com/file/d/abc123/view",
  "finalHost": "drive.google.com",
  "finalStatus": 200,
  "finalFileType": "Web page",
  "hops": [
    { "url": "https://vplink.in/snB67M", "status": 302, "kind": "http-redirect", "next": "https://…" }
  ],
  "hopCount": 1,
  "blocked": null,
  "warnings": [],
  "anchors": [],
  "embedded": [],
  "elapsedMs": 412
}
```

Errors return `{ "ok": false, "error": "…", "code": "INVALID_INPUT" }` with codes such as
`INVALID_INPUT`, `BAD_SCHEME`, `PRIVATE_HOST`, `DNS_FAILED`, `FETCH_FAILED`, `TIMEOUT`,
`RATE_LIMITED`.

Input is forgiving: a bare `vplink.in/snB67M`, a URL with a trailing `)`, or a whole pasted
message containing a link all work.

## The demo chain

`GET /demo/start` is a three-hop chain served by this app itself (HTTP redirect → meta
refresh → script redirect), and `POST /api/demo` resolves it through the real resolver. The
**Try a demo chain** button uses it, so the UI can be exercised even on a host with no
outbound internet. Demo results are always labelled as a demo.

## Tests

```
test/resolver.test.js   18  redirect walking, parsing, SSRF, gates, loops
test/ui.test.js          7  real UI in jsdom: rendering, copy, gate labels, errors
test/server.test.js      9  HTTP routes, demo chain, 404s, traversal, SSRF
```

The resolver tests spin up local mock servers that emit the exact response shapes real
shorteners use, so the suite runs offline.

## Licence

MIT.
