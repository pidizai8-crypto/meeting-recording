import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const read = file => readFile(new URL('../' + file, import.meta.url), 'utf8')
const { model, kit } = runInNewContext([
  await read('vendor/notebook-editor.vendor.js'), await read('notebook-model.js'),
  ';({model: notebookModel, kit: notebookKit})',
].join('\n'), { URL, TextDecoder, TextEncoder })

test('legacy Markdown punctuation, HTML, whitespace and hard breaks remain literal after conversion', () => {
  for (const text of ['# 议题\n**重要**\n\n', '`x` &amp; <img src=x>', '    a\t b  \n\n\n',
    '<span style="color: #abc">字</span>', '1) literal', '=', '![diagram](image.png)', '<https://example.test>', '[00:10]']) {
    const item = model.documentSource(text, true)
    const emitted = item.serialize(item.doc)
    assert.ok(model.documentSource(emitted).doc.eq(item.doc), `${text} → ${emitted}`)
  }
})

test('unmodified source preserves every code unit, including CRLF, link definitions and unknown syntax', () => {
  for (const source of ['', '   ', '[abc]: /link\r\n', '# 一\r\n\r\n| a |\r\n|---|\r\n| *b* |\r\n', '::: remark\ncustom\n:::\n']) {
    const item = model.documentSource(source)
    assert.equal(item.serialize(item.doc), source)
  }
})

test('a source edit preserves the untouched mixed CR, LF and CRLF endings', () => {
  assert.equal(model.editSourceText('a\rb\nc\r\n', 'a\nbb\nc\n'), 'a\rbb\nc\r\n')
  assert.equal(model.editSourceText('一\r\n二\n三\r', '一\n二\n三\n末尾'), '一\r\n二\n三\r末尾')
  assert.equal(model.editSourceText('a\r\nb', 'a\nc\nb'), 'a\r\nc\r\nb')
})

test('editing one block keeps the untouched table, link references and trailing document whitespace', () => {
  const text = '# 标题\r\n\r\n[doc]: /link\r\n\r\n| A |\r\n|---|\r\n| [b][doc] |\r\n'
  const item = model.documentSource(text)
  const tr = kit.EditorState.create({ doc: item.doc }).tr.insertText('！', 3)
  assert.equal(item.serialize(tr.doc), text.replace('标题', '标题！'))
})

test('only a balanced, single-property hex color span becomes a mark', () => {
  for (const s of ['<span style="color: #123abc">**示例**</span>', "<span style='color:#AbC;'>示例</span>"]) {
    assert.equal(model.documentSource(s).doc.firstChild.firstChild.marks[0].type.name, 'color')
  }
  for (const bad of ['<img src="https://example.invalid/track">', '<span onclick="alert(1)" style="color:#abc">X</span>',
    '<span style="color:#abc;background:url(x)">X</span>', '<span style="color:#abc">X']) {
    const doc = model.documentSource(bad).doc
    assert.equal(doc.textContent, bad)
    assert.equal(doc.firstChild.firstChild.marks.length, 0)
  }
  const img = model.documentSource('![图片](https://example.invalid/tracking.png)').doc.firstChild.firstChild
  assert.equal(img.type.name, 'image')
  assert.equal(img.type.spec.toDOM(img)[0], 'span')
})

test('bold punctuation in the middle of Chinese and English words survives reopening', () => {
  for (const [text, start, end] of [['甲（待办）乙', 1, 5], ['Hi!X', 2, 3], ['甲乙丙', 1, 2], ['A  B', 1, 3]]) {
    const item = model.documentSource(text)
    const state = kit.EditorState.create({ doc: item.doc })
    const marked = state.tr.addMark(start + 1, end + 1, model.schema.marks.strong.create()).doc
    const raw = item.serialize(marked)
    assert.ok(model.documentSource(raw).doc.eq(marked), raw)
    if (text === '甲乙丙') assert.equal(raw, '甲**乙**丙')
  }
})

test('timestamps remain legible in the Markdown source', () => {
  const item = model.documentSource('会后', true)
  const state = kit.EditorState.create({ doc: item.doc })
  assert.match(item.serialize(state.tr.insertText('[00:10] ', 1).doc), /^\[00:10\] 会后$/)
})
