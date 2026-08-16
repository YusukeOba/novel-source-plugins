# Plugin format

A plugin is a single JavaScript file describing one site. It is not a module: the file
is evaluated as-is, and `manifest` plus the exported functions are picked up directly.

Plugins have no network access. They ask the host app to fetch a URL, and the app
performs the request. HTML parsing and ruby extraction are also done by the app.

## manifest

```js
const manifest = {
  id: "example",              // storage key; never change it after publishing
  name: "Example",
  version: "1.0.0",
  accent: "#18b7cd",          // label colour; the app adjusts lightness for contrast
  hosts: ["example.com"],     // requests outside these hosts are rejected
  urlPatterns: ["example\\.com/works/(\\d+)"],   // one capture group = novel id
  novelPageUrl: "https://example.com/works/{id}",
  rankingPeriods: [
    { key: "daily", label: "Daily" },
  ],
  emptyQuery: false,          // can list works without a search term
  tagFilterKey: "tag",        // which filter receives a tag when the user taps one
  filters: [],
};
```

`id` links bookmarks, read state and reading positions. Changing it after publishing
orphans all of that data.

`urlPatterns` is a list of regular expressions rather than a function because URL
matching happens when a share intent arrives, before any UI is shown. Starting the
JavaScript engine there would delay the screen.

`rankingPeriods` is free-form. Sites that use 累計 or 年間 instead of daily/weekly
declare exactly that; the app passes `key` back to `ranking()` and shows `label`.

## Functions

```js
async function search(query, page, filter)   // → [work]
async function ranking(periodKey)            // → [work]
async function summaries(ids)                // → [work]
async function detail(id)                    // → { summary, episodes, tocComplete }
async function episode(novelId, key, no)     // → { episodeNo, title, paragraphs }
```

### work

```js
{
  id: "123", title: "…", author: "…", synopsis: "…",
  episodeCount: 40,
  lastUpdatedAt: 1755200000000,   // epoch millis, or null
  revisedAt: null,                // when existing episodes were edited
  length: 120000,                 // total characters
  bookmarkCount: null,            // null when the site does not expose it
  allPoint: null,
  serializing: true, isShort: false, isR15: false, isCruel: false,
  tags: ["…"],
  isRemoved: false,               // set when the site reports the work as gone
}
```

Use `null` for values the site does not expose. `0` means "zero", which is a different
statement.

### detail

```js
{
  summary: { /* work */ },
  episodes: [
    { episodeNo: 1, episodeKey: "a", title: "…", chapter: "…",
      sourceUpdatedAt: 1755200000000 },
  ],
  tocComplete: true,
}
```

`tocComplete` defaults to `false` when omitted. Setting it to `true` while episodes are
missing causes the app to treat the absent ones as deleted and drop their read state and
downloaded text.

Episode numbers must increase. They need not be contiguous — authors delete episodes —
but they must never repeat or go backwards.

## host API

```js
await host.fetch(url, { headers, encoding })   // → { status, body, url, location }
host.select(html, "css")                       // → array of outerHTML strings
host.text(html)                                // → text content
host.attr(html, "href")                        // → attribute of the first element
host.paragraphs(html)                          // → paragraphs with ruby ranges
host.paragraphsByBr(html)                      // → same, for <br>-separated bodies
```

`encoding: "shift_jis"` decodes the response as Shift_JIS.

Redirects are not followed. On a 3xx the `location` header is returned; call
`host.fetch` again if you want to follow it. The new URL is validated the same way, so
a redirect cannot take a plugin outside its declared hosts.

4xx and 5xx responses are returned rather than thrown, so a plugin can distinguish a
deleted work from a failed request.

Requests are not retried automatically. Retrying is up to the plugin.

`host.text` returns the contents of `<script>` and `<style>` elements, which is how
plugins read embedded JSON payloads.

`host.paragraphs` descends into wrapper elements, so passing the container returned by
`host.select` yields the paragraphs inside it rather than one giant paragraph.

Do not build ruby ranges by hand. They index into the paragraph text, and an offset
error attaches the reading to the wrong characters.

## Limits

| | Limit | On exceeding |
| --- | --- | --- |
| One call | 60s | the plugin is dropped for the session |
| Memory | 64MB | throws |
| Return value (JSON) | 8MB | rejected before parsing |
| One response | 16MB | rejected |
| Headers | 20, name 64 chars, value 1024 chars | rejected |
| Episodes | 20,000 | truncated |
| Paragraphs | 20,000 | truncated |
| Title, author | 500 chars | truncated |
| Synopsis | 5,000 chars | truncated |
| Tags | 100 × 100 chars | truncated |
| Plugin file | 2MB | rejected |
| Index file | 256KB, 50 entries | rejected |

The time limit does not recover: a running script cannot be interrupted, so a plugin
that exceeds it is not called again until the app restarts.

Header values may not contain control characters. Hosts must be domains — single labels
(`com`), public suffixes (`co.jp`), IP addresses and `localhost` are rejected.
`novelPageUrl` must be `https://`.

## Distribution

List plugins in `sources.json` at the repository root:

```json
{ "sources": ["example.js"] }
```

Relative paths resolve against the index location.

## Testing

Plugins are plain JavaScript, so they run under Node with a stand-in `host`. See
[`test/host-shim.mjs`](../test/host-shim.mjs), which applies the same constraints as the
app. HTML parsing differs (the app uses a different parser), so ruby offsets can only be
verified on a device.
