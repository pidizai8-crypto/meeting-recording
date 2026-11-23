// Markdown is tokenized into a ProseMirror schema. User HTML never becomes DOM.
const notebookModel = (() => {
  const kit = notebookKit
  const hex = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i
  const span = /^<span\s+style\s*=\s*(["'])\s*color\s*:\s*(#[\da-f]+)\s*;?\s*\1\s*>$/i
  const marks = kit.schema.spec.marks.update('link', {
    ...kit.schema.spec.marks.get('link'), parseDOM: [],
    toDOM: () => ['span', { class: 'mn-md-link' }, 0],
  }).addBefore('em', 'color', {
    attrs: { value: { validate: 'string' } },
    toDOM(mark) {
      return ['span', hex.test(mark.attrs.value) ? { style: `color: ${mark.attrs.value}` } : {}, 0]
    },
  })
  const nodes = kit.schema.spec.nodes.update('image', {
    ...kit.schema.spec.nodes.get('image'), parseDOM: [], draggable: false,
    toDOM: node => ['span', { class: 'mn-md-image', contenteditable: 'false' }, `![${node.attrs.alt || ''}]`],
  })
  const schema = new kit.Schema({ nodes, marks })
  const tokenizer = new kit.MarkdownIt('commonmark', { html: true }).disable('html_block')

  // Only balanced color spans, bare strong tags and plain <br> are interpreted.
  // All other HTML tokens become literal text, including unmatched closing tags.
  tokenizer.core.ruler.after('inline', 'notebook_markup', state => {
    state.env.blocks = state.tokens.filter(token => token.level === 0 && token.map).map(token => token.map)
    for (const block of state.tokens) {
      if (!block.children) continue
      if (block.content === '<br />') { block.children = []; continue }
      const stack = [], strongTags = []
      for (const token of block.children) {
        if (token.type !== 'html_inline') continue
        const match = span.exec(token.content)
        token.type = 'text'
        if (match && hex.test(match[2])) stack.push({ token, color: match[2].toLowerCase() })
        else if (/^<span(?:\s|>)/i.test(token.content)) stack.push({})
        else if (/^<\/span\s*>$/i.test(token.content)) {
          const open = stack.pop()
          if (open?.token) {
            open.token.type = 'color_open'
            open.token.meta = open.color
            token.type = 'color_close'
          }
        } else if (/^<strong\s*>$/i.test(token.content)) strongTags.push(token)
        else if (/^<strong\s/i.test(token.content)) strongTags.push(null)
        else if (/^<\/strong\s*>$/i.test(token.content)) {
          const open = strongTags.pop()
          if (open) { open.type = 'strong_open'; token.type = 'strong_close' }
        } else if (/^<br\s*\/?\s*>$/i.test(token.content)) token.type = 'hardbreak'
      }
      const activeColors = []
      block.children = block.children.flatMap(token => {
        if (token.type === 'color_open') activeColors.push(token.meta)
        if (token.type !== 'color_close') return [token]
        activeColors.pop()
        if (!activeColors.length) return [token]
        const restore = new state.Token('color_open', 'span', 1)
        restore.meta = activeColors.at(-1)
        return [token, restore]
      })
    }
  })
  const parser = new kit.MarkdownParser(schema, tokenizer, {
    ...kit.defaultMarkdownParser.tokens,
    color: { mark: 'color', getAttrs: token => ({ value: token.meta }) },
    softbreak: { node: 'hard_break' },
  })
  function boldDelimiter(mark, parent, index, opening) {
    let first = opening ? index : index - 1, last = first
    while (first > 0 && mark.isInSet(parent.child(first - 1).marks)) first--
    while (last + 1 < parent.childCount && mark.isInSet(parent.child(last + 1).marks)) last++
    const start = parent.child(first).textContent, end = parent.child(last).textContent
    // CommonMark cannot delimit mid-word punctuation or leading/trailing marked whitespace.
    const ambiguous = /^[\s\p{P}\p{S}]/u.test(start) || /[\s\p{P}\p{S}]$/u.test(end)
    return ambiguous ? (opening ? '<strong>' : '</strong>') : '**'
  }
  const serializer = new kit.MarkdownSerializer({
    ...kit.defaultMarkdownSerializer.nodes,
    paragraph(state, node) {
      if (!node.childCount) state.write('<br />')
      else state.renderInline(node)
      state.closeBlock(node)
    },
    hard_break(state, node, parent, index) {
      // Adjacent/terminal line breaks otherwise disappear on the next Markdown parse.
      const next = parent.maybeChild(index + 1)
      state.write(next?.isText && index > 0 ? '\\\n' : '<br>')
    },
    text(state, node, parent, index) {
      if (state.inAutolink) { state.text(node.text, false); return }
      const atStart = !index || parent.child(index - 1).type === schema.nodes.hard_break
      let text = state.esc(node.text, atStart)
        .replace(/\\\[(\d{2,}:\d{2}(?::\d{2})?)\\\](?![([])/g, '[$1]')
      if (atStart) text = text.replace(/^(\d+)\)(?=\s)/, '$1\\)').replace(/^=+(?=\s*$)/, '\\$&')
      // Entities preserve indentation, tab stops and trailing whitespace even in CommonMark readers.
      if (atStart) text = text.replace(/^ +/, run => '&#32;'.repeat(run.length))
      if (index + 1 === parent.childCount || parent.child(index + 1).type === schema.nodes.hard_break) {
        text = text.replace(/ +$/, run => '&#32;'.repeat(run.length))
      }
      state.text(text.replaceAll('\t', '&#9;'), false)
    },
  }, {
    ...kit.defaultMarkdownSerializer.marks,
    strong: {
      open: (_state, mark, parent, index) => boldDelimiter(mark, parent, index, true),
      close: (_state, mark, parent, index) => boldDelimiter(mark, parent, index, false),
      mixable: true,
    },
    color: { open: (_state, mark) => `<span style="color: ${mark.attrs.value}">`, close: '</span>', mixable: true },
  }, { escapeExtraCharacters: /[<&|]/g })

  function plainDocument(text) {
    const content = []
    for (const [i, line] of text.split(/\r\n?|\n/).entries()) {
      if (i) content.push(schema.nodes.hard_break.create())
      if (line) content.push(schema.text(line))
    }
    return schema.topNodeType.create(null, schema.nodes.paragraph.create(null, content))
  }

  // Preserve untouched block spelling and the gaps between blocks (including link definitions).
  // The editor owns this cache, so unmount releases every reference to a meeting's source.
  function documentSource(text, plain = false) {
    const blocks = new WeakMap()
    const env = {}
    const doc = plain ? plainDocument(text) : parser.parse(text, env)
    let prefix = '', suffix = ''
    if (!plain) {
      const offsets = [0]
      for (const match of text.matchAll(/\r\n?|\n/g)) offsets.push(match.index + match[0].length)
      const ranges = (env.blocks || []).map(([a, b]) => {
        const start = offsets[a] ?? text.length
        const end = offsets[b] ?? text.length
        const raw = text.slice(start, end).replace(/(?:\r\n|\r|\n)+$/, '')
        return { start, end: start + raw.length, raw }
      })
      if (ranges.length === doc.childCount) {
        prefix = text.slice(0, ranges[0].start)
        suffix = text.slice(ranges.at(-1).end)
        doc.forEach((node, _, i) => blocks.set(node, {
          raw: ranges[i].raw,
          before: i ? text.slice(ranges[i - 1].end, ranges[i].start) : null,
          after: i + 1 < ranges.length ? text.slice(ranges[i].end, ranges[i + 1].start) : null,
        }))
      } else if (!ranges.length && text.trim()) prefix = text + (text.endsWith('\n\n') ? '' : '\n\n')
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    function serialize(value) {
      if (value === doc && !plain) return text
      if (value.childCount === 1 && value.firstChild.type === schema.nodes.paragraph && !value.firstChild.childCount) {
        return prefix.trim() || suffix.trim() ? prefix + suffix : ''
      }
      let out = prefix, prev
      value.forEach((node, _, i) => {
        const item = blocks.get(node)
        if (i) out += item?.before ?? prev?.after ?? eol + eol
        if (item) out += item.raw
        else {
          const raw = serializer.serialize(schema.topNodeType.create(null, node)).replaceAll('\n', eol)
          blocks.set(node, { raw })
          out += raw
        }
        prev = item
      })
      return out + suffix
    }
    return { doc, serialize }
  }
  // A textarea normalizes every CR/CRLF to LF. Splice only the edited range in the
  // original so mixed line endings, including a final CR, also survive source edits.
  function editSourceText(original, edited) {
    if (!original.includes('\r')) return edited
    const normalized = original.replace(/\r\n?/g, '\n')
    let left = 0, tail = 0
    const limit = Math.min(normalized.length, edited.length)
    while (left < limit && normalized[left] === edited[left]) left++
    while (tail < limit - left && normalized[normalized.length - 1 - tail] === edited[edited.length - 1 - tail]) tail++
    function offset(index) {
      let raw = 0
      for (let i = 0; i < index; i++, raw++) if (original[raw] === '\r' && original[raw + 1] === '\n') raw++
      return raw
    }
    const start = offset(left), finish = offset(normalized.length - tail)
    const eol = original.slice(start).match(/\r\n?|\n/)?.[0] || original.match(/\r\n?|\n/)[0]
    return original.slice(0, start) + edited.slice(left, edited.length - tail).replaceAll('\n', eol) + original.slice(finish)
  }

  // Source positions use the textarea's LF-normalized offsets. Exact matches cover ordinary
  // text and marked text. Escaped text, fences, and block boundaries use the nearest leaf.
  function selectionMap(doc, text) {
    const env = {}
    tokenizer.parse(text, env)
    const lines = [0]
    for (const match of text.matchAll(/\n/g)) lines.push(match.index + 1)
    const points = []
    doc.forEach((block, offset, i) => {
      const range = env.blocks[i] || [0, lines.length]
      let cursor = lines[range[0]] ?? text.length
      const end = lines[range[1]] ?? text.length
      points.push({ doc: offset + 1, raw: cursor, length: 0 })
      block.descendants((node, pos) => {
        if (!node.isText) return
        const found = text.indexOf(node.text, cursor)
        const raw = found >= cursor && found + node.text.length <= end ? found : cursor
        const length = Math.min(node.text.length, end - raw)
        points.push({ doc: offset + pos + 1, raw, length })
        cursor = raw + length
      })
    })
    function project(value, from, to, forward = false) {
      let distance = Infinity, answer = 0
      for (const point of points) {
        const within = Math.min(point.length, Math.max(0, value - point[from]))
        const gap = Math.abs(value - point[from] - within)
        if (gap < distance || (gap === distance && point.length)) {
          answer = point[to] + within
          distance = gap
          if (!gap && point.length && (!forward || within !== point.length)) break
        }
      }
      return answer
    }
    return { toSource: (pos, forward) => project(pos, 'doc', 'raw', forward), toVisual: pos => project(pos, 'raw', 'doc') }
  }
  return { schema, documentSource, plainDocument, selectionMap, editSourceText }
})()
