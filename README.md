# novel-source-plugins

JavaScript plugins that describe how to read Japanese web novel sites.

Each plugin declares which hosts it connects to and exposes a small set of functions
(`search`, `ranking`, `summaries`, `detail`, `episode`). A reader app loads them and
performs the actual network requests on their behalf.

## Installation

Add this repository's URL in the reader app that supports this plugin format:

```
https://github.com/YusukeOba/novel-source-plugins
```

The app shows which hosts a plugin connects to before you add it.

## Included

| Site | File |
| --- | --- |
| 小説家になろう | `narou.js` |
| カクヨム | `kakuyomu.js` |
| エブリスタ | `estar.js` |

## Development

```bash
npm install
npm run check:manifests   # validate manifests (no network)
npm run check             # run against the live sites
```

`npm run check` exercises search through body retrieval. GitHub Actions runs it daily
so that layout changes on the sites surface quickly.

See [docs/API.md](docs/API.md) for the plugin format and the `host` API.

Bump `manifest.version` when you change a plugin. Apps use it to tell users that a
newer version is available.

## Disclaimer

This repository has no affiliation with any of the sites listed above, and hosts no
content from them.

It contains only code describing how to read those sites. Retrieval is performed by
whoever installs a plugin.

Some sites prohibit automated retrieval. Check their terms before installing.

## License

MIT ([LICENSE](LICENSE))
