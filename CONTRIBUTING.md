# Contributing

Issues and pull requests are welcome. Please keep reports reproducible and avoid attaching real meeting audio, transcripts, or personal data.

## Development

```sh
npm run build   # regenerate client.js
npm test        # unit tests
```

Do not edit `client.js` by hand: it is generated from the source modules by `build.mjs`. A pull request should include the regenerated bundle when source changes affect it.

The browser editor test is separate:

```sh
# Install temporary fixture dependencies in a scratch directory, then:
node tests/notebook-editor-fixture.mjs <scratch-dir>
# Open the printed HTML page in a browser and run checkRecorderEditor from
# tests/notebook-editor.browser.mjs against a Page instance.
```

It is not part of `npm test` because it needs a browser and temporary React/esbuild packages.

## Pull requests

- Keep changes focused; describe the user-visible behavior and how you verified it.
- Run `npm run build` and `npm test` before opening the pull request.
- Do not commit real meeting data, credentials, or generated archives.
- For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
