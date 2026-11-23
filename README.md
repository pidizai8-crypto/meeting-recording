# DSH Meeting Recorder

A local-first meeting recorder for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

It records the microphone, the Windows default playback device, or both; transcribes speech on the host with SenseVoice; groups turns by voice; and keeps a rich notebook, meeting history, and generated minutes.

## Features

- **Three recording sources** — microphone, Windows system audio (WASAPI loopback), or a mix of both.
- **Local transcription** — SenseVoice runs through the official DSH speech provider. Choose Chinese (the default) or automatic language detection.
- **Speaker grouping** — bundled CAM++ embeddings separate voices within each source and label them `1`, `2`, `3`, … Turns with weak evidence stay **Unconfirmed** instead of silently joining the wrong speaker.
- **Rich notebook** — bold, colored text, headings, bulleted and numbered lists, and timestamps. Text styles survive selection changes, replacement typing, and copy/paste inside the notebook.
- **Meeting history** — revisit, rename, delete, or open a meeting folder. Audio, transcript, notebook, and minutes are archived together.
- **Minutes** — send the transcript and notebook to the default DSH model to generate Markdown minutes.

## Requirements

- DeepSeek Harness **0.2.2-rc.5** or newer (`<0.3.0`).
- The official **Voice input** bundle with the local **SenseVoice** provider enabled. DSH downloads the speech model on first use (about 241 MB).
- **Windows 10/11** for system-audio capture through the desktop app. The microphone source also works in `dsh web` in a supported Chromium browser.
- No Python or external speech service is required. Speaker embeddings use the `sherpa-onnx-node` runtime already shipped with DSH.

## Install

From a DSH checkout:

```sh
dsh plugin --profile <profile> add github:pidizai8-crypto/meeting-recording
```

In DSH Desktop, open **Plugins → Add plugin** and install the package or the GitHub repository. Restart or reload when DSH asks.

The release tarball is also attached to [GitHub Releases](https://github.com/pidizai8-crypto/meeting-recording/releases); use the `tarball:` URL from the marketplace entry if your storefront offers it.

After installation, open a session's right sidebar, create a meeting tab, and prepare the speech model from the panel on first use.

## Privacy

- Audio, PCM segments, transcripts, notebooks, and history stay on this machine. Meetings are stored in the browser's IndexedDB; archives are written to the local DSH profile.
- Nothing is uploaded for transcription. The only outbound content is the transcript and notebook you explicitly send when you click **Generate minutes**, which goes to the default DSH model.
- The speech and speaker models run locally. The plugin has no telemetry and no external API keys.
- Recording requires the microphone permission, and the web system-audio source uses the browser's screen-sharing picker.

## Limitations

- **Speaker grouping is not identification.** Labels group similar voices; they are not names and can be wrong when people overlap, whisper, or speak for less than about two seconds. Correct a label in the transcript when needed.
- System audio captures the **default Windows playback device**. Capturing one application's audio separately is not supported.
- The transcriber currently supports Chinese and automatic language detection. An unclear Chinese segment may still be decoded as Japanese; the panel flags such a turn for replay instead of showing the text.
- The notebook's default color palette is fixed. Contrast on some custom themes may be lower than the WCAG text target.
- The download and archive files use Markdown internally for portability; the editor itself is a rich-text surface and does not expose Markdown source.

## Development

The plugin is plain ESM with no runtime npm dependencies. DSH provides React and the Cordis services.

```sh
npm run build   # rebuild client.js from the source modules
npm test        # Node unit tests
```

`tests/notebook-editor.browser.mjs` is an isolated ProseMirror fixture test; it needs a browser page and a temporary `react`/`react-dom`/`esbuild` install, so it is not part of `npm test`.

Layout:

| Path | Purpose |
|---|---|
| `index.js` | Host routes, speech engine bridge, archive and loopback registration |
| `capture.js` | Browser audio capture, VAD segmentation, PCM conversion |
| `speaker-turns.js` / `speaker-groups.js` | Turn-change detection and anonymous speaker prototypes |
| `voice-embedding.js` / `voice-engine/` | CAM++ and Silero ONNX runtime and model files |
| `notebook-*.js` / `panel.js` | Rich notebook and meeting UI |
| `store.js` / `library.js` / `archive.js` | IndexedDB persistence, history, and local archives |

## Third-party notices

The bundled models and editor libraries retain their original licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the full license texts under `voice-engine/` and in the header of `vendor/notebook-editor.vendor.js`.

## License

MIT. See [LICENSE](LICENSE). The bundled speech models and editor libraries keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
