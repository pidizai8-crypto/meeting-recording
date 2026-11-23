import { readFile, writeFile } from 'node:fs/promises'

const dir = new URL('./', import.meta.url)
const read = name => readFile(new URL(name, dir), 'utf8')
const sources = await Promise.all([
  'desktop-audio.js', 'capture.js', 'speaker-groups.js', 'store.js', 'library.js', 'controller.js',
  'vendor/notebook-editor.vendor.js', 'notebook-model.js', 'notebook-editor.js', 'panel.js',
].map(read))
const css = (await Promise.all(['panel.css', 'notebook-editor.css'].map(read))).join('\n')
const copy = JSON.parse(await read('copy.json'))
const editorCopy = JSON.parse(await read('editor-copy.json'))
for (const locale of Object.keys(copy)) Object.assign(copy[locale], editorCopy[locale])
const body = sources.map(source => source.replace(/^export (?=(async )?(function|class|const) )/gm, '')).join('\n')
const bundle = `// Built by npm run build. Edit the source modules.\nwindow.__ModuleLoader__.load({\n  id: 'dsh-meeting-recorder',\n  factory(require) {\n    const React = require('react');\n    const h = React.createElement;\n    const meetingCss = ${JSON.stringify(css)};\n    const meetingCopy = ${JSON.stringify(copy)};\n${body}\n    return meetingPlugin();\n  }\n});\n`
await writeFile(new URL('client.js', dir), bundle, 'utf8')
