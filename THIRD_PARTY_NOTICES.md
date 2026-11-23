# Third-party notices

This repository redistributes the following third-party components. The plugin's own source code is separate from these components.

## Speech models

| Component | File | License | Notice |
|---|---|---|---|
| CAM++ Chinese/English speaker embedding, 192-dimensional, FP16 | `voice-engine/campplus-zh-en-fp16.onnx` | Apache License 2.0 | [voice-engine/LICENSE-CAMPLUS.txt](voice-engine/LICENSE-CAMPLUS.txt), [voice-engine/NOTICE.md](voice-engine/NOTICE.md) |
| Silero VAD v5.1.2 | `voice-engine/silero-vad.onnx` | MIT | [voice-engine/LICENSE-SILERO.txt](voice-engine/LICENSE-SILERO.txt), [voice-engine/NOTICE.md](voice-engine/NOTICE.md) |

The models run locally through the `sherpa-onnx-node` runtime shipped with DeepSeek Harness. No model file is downloaded by this plugin.

## Bundled notebook editor

`vendor/notebook-editor.vendor.js` is a checked-in browser bundle of the libraries below. Its header contains the complete license texts. The plugin has no runtime npm dependencies; this bundle is loaded as a local script.

| Package | Version | License |
|---|---|---|
| entities | 8.1.0 | BSD-2-Clause |
| linkify-it | 6.1.0 | MIT |
| markdown-it | 15.0.3 | MIT |
| mdurl | 2.1.0 | MIT |
| orderedmap | 2.1.1 | MIT |
| prosemirror-commands | 1.7.2 | MIT |
| prosemirror-history | 1.5.2 | MIT |
| prosemirror-keymap | 1.2.3 | MIT |
| prosemirror-markdown | 1.14.0 | MIT |
| prosemirror-model | 1.25.13 | MIT |
| prosemirror-schema-list | 1.6.1 | MIT |
| prosemirror-state | 1.4.4 | MIT |
| prosemirror-transform | 1.12.7 | MIT |
| prosemirror-view | 1.43.0 | MIT |
| punycode.js | 2.3.1 | MIT |
| rope-sequence | 1.3.4 | MIT |
| uc.micro | 3.0.0 | MIT |
| w3c-keyname | 2.2.8 | MIT |

The source entry point and pinned versions are recorded in `vendor/notebook-dependencies.mjs`. Rebuilding the bundle requires the corresponding upstream packages; the checked-in output is what the plugin ships.

## DeepSeek Harness

The plugin uses public DSH/Cordis services at runtime. DSH itself is a separate project with its own license; no DSH source is included here.
