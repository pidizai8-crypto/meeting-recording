// Usage: npm install --prefix <temp-dir> react@19 react-dom@19 esbuild
// Then: node tests/notebook-editor-fixture.mjs <temp-dir>
// Open the printed file in an isolated browser page and call checkRecorderEditor(page)
// from notebook-editor.browser.mjs. This fixture never opens a meeting or microphone.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

if (!process.argv[2]) throw Error('Pass the temporary directory containing node_modules.')
const dependencies = resolve(process.argv[2])
const { build } = createRequire(join(dependencies, 'package.json'))('esbuild')
const dir = await mkdtemp(join(tmpdir(), 'meeting-notebook-test-'))
const resource = filename => new URL('../' + filename, import.meta.url)
const base = JSON.parse(await readFile(resource('copy.json'), 'utf8')).zh
const editor = JSON.parse(await readFile(resource('editor-copy.json'), 'utf8')).zh
await build({
  stdin: {
    contents: `import * as React from 'react'; import {createRoot} from 'react-dom/client';
      Object.assign(window, {React, createRoot, h: React.createElement});`, resolveDir: dependencies,
  },
  bundle: true, define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(dir, 'react.js'),
})
const fixture = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>虚构笔记 · 编辑器测试</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${resource('panel.css')}"><link rel="stylesheet" href="${resource('notebook-editor.css')}">
<style>body{font:16px system-ui}#app{width:min(520px,100%);height:360px}#app .mn-sheet{height:100%}</style>
<div id="app" class="mn-root"></div><script src="react.js"></script>
${['vendor/notebook-editor.vendor.js', 'notebook-model.js', 'notebook-editor.js'].map(name => `<script src="${resource(name)}"></script>`).join('\n')}
<script>
const copy = ${JSON.stringify({ ...base, ...editor }).replaceAll('<', '\\u003c')};
const root = createRoot(document.querySelector('#app'));
let key = 0, props = {value:'', format:'markdown'};
window.limitDisabled = false;
window.fixtureRefresh = function() {
  root.render(h('div', {className:'mn-sheet'}, h(RecorderMarkdownEditor, {
    ...props, key, disabled:window.limitDisabled, t:name => copy[name],
    placeholder:'写下议程或待讨论的问题…', getTimestamp:() => '[00:10] ',
    onChange(value) { window.changes.push(value); props = {value,format:'markdown'}; window.fixtureRefresh() }
  })));
};
window.fixtureLoad = (value,format='markdown') => { key++; window.changes=[]; props={value,format}; window.fixtureRefresh() };
window.fixtureLoad('甲乙丙');
</script></html>`
const page = join(dir, 'fixture.html')
await writeFile(page, fixture, 'utf8')
console.log(pathToFileURL(page).href)
