'use strict'

// A reader for a Hindsight memory bank: lists, lookups, search and questions.
// Everything goes through /api, which the server in front of this page limits to those calls.
// Where the review service is switched on there is one more section, Review, which can retire a fact
// and bring it back. Nothing here can change a memory's words or delete one.

const PAGE = 30
const MOST = 200
const KINDS = { world: 'Fact', experience: 'Experience', observation: 'Pattern' }
const PLURAL = { world: 'Facts', experience: 'Experiences', observation: 'Patterns' }
const TYPES = ['observation', 'world', 'experience']

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9v11h13V9',
  notes: 'M6 3h9l4 4v14H6zM14.5 3v4.5H19M9 12h7M9 16h7',
  memories: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  review: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM8.5 12.3l2.4 2.4 4.6-5',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5 20 20',
  ask: 'M4 5h16v11H9.5L5 20v-4H4z',
  back: 'M14 6l-6 6 6 6',
}

const TABS = [
  { key: 'home', label: 'Overview', href: '#/' },
  { key: 'notes', label: 'Notes', href: '#/notes' },
  { key: 'memories', label: 'Memories', href: '#/memories' },
  { key: 'review', label: 'Review', href: '#/review' },
  { key: 'search', label: 'Search', href: '#/search' },
  { key: 'ask', label: 'Ask', href: '#/ask' },
]

const main = document.getElementById('main')
const nav = document.getElementById('nav')
const cache = new Map()
const shown = new Map()
const places = new Map()
const trail = []
let turns = []
let drawing = 0
let here = location.hash
let asking = null
let marks = null

/** Builds an element. Text only ever enters the page as text nodes. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag)

  for (const [name, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (name === 'class') el.className = value
    else if (name.startsWith('on')) el.addEventListener(name.slice(2), value)
    else el.setAttribute(name, value === true ? '' : value)
  }

  for (const kid of kids.flat(Infinity)) {
    if (kid === undefined || kid === null || kid === false) continue
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)))
  }

  return el
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  path.setAttribute('d', ICONS[name])
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.7')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.append(path)

  return svg
}

async function api(path, body) {
  const res = await fetch('/api' + path, body === undefined
    ? { headers: { accept: 'application/json' } }
    : { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) })

  if (!res.ok) throw new Error(res.status === 403 ? 'That is not something this page may do.' : `The memory service answered ${res.status}.`)

  return res.json()
}

/** A lookup kept for the life of the page, so going back to a list is instant. */
function kept(path) {
  if (!cache.has(path)) cache.set(path, api(path).catch(problem => { cache.delete(path); throw problem }))

  return cache.get(path)
}

const query = values => {
  const params = new URLSearchParams()

  for (const [name, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== '') params.set(name, value)
  const text = params.toString()

  return text === '' ? '' : '?' + text
}

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const TIME = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const SHORT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const dated = (value, format = DAY) => {
  const at = value ? new Date(value) : null

  return at === null || Number.isNaN(at.getTime()) ? '' : format.format(at)
}

const sentence = slug => {
  const words = slug.replace(/\.md$/, '').replace(/[-_]+/g, ' ').trim()

  return words === '' ? 'Note' : words[0].toUpperCase() + words.slice(1)
}

/** What a note is called: its id says so when an assistant named it, otherwise its opening words. */
function named(doc) {
  const filed = /^([a-z][\w-]*)\/(?:\d{4}-\d{2}-\d{2}-)?(.+)$/i.exec(doc.id)
  const kind = filed === null ? (doc.tags?.[0] ?? 'note') : filed[1].replace(/s$/, '').replace(/-/g, ' ')
  const opening = (doc.original_text ?? '').replace(/\s+/g, ' ').trim()
  const title = filed !== null ? sentence(filed[2]) : opening !== '' ? clipped(opening.replace(/^[A-Z][a-z]+ \([^)]*\):\s*/, '').split(/[.!?]\s/)[0].replace(/[.!?]$/, ''), 90) : sentence(doc.retain_params?.context ?? 'Note')

  return { kind: sentence(kind), title }
}

const clipped = (text, most) => (text.length <= most ? text : text.slice(0, most - 1).replace(/\s+\S*$/, '') + '…')

const chip = (label, href, count) => h('a', { class: 'chip', href }, label, count === undefined ? null : h('small', null, count))

const tagChips = (tags, to = tag => '#/notes' + query({ tag })) => (tags ?? []).map(tag => chip(tag, to(tag)))

const kindOf = type => h('span', { class: 'kind' }, h('span', { class: 'dot ' + type }), KINDS[type] ?? type)

const state = (className, text) => h('p', { class: className, role: className === 'error' ? 'alert' : 'status' }, text)

function page(title, lede, ...kids) {
  return h('div', { class: 'page' }, h('header', { class: 'head' }, h('h1', null, title), lede ? h('p', { class: 'lede' }, lede) : null), kids)
}

const back = (href, label) => h('a', { class: 'back', href }, icon('back'), label)

function section(title, more, ...kids) {
  return h('section', { class: 'section' }, h('div', { class: 'row-head' }, h('h2', null, title), more ?? null), kids)
}

/**
 * A stored fact reads "statement | When: ... | Involving: ... | why". This parts it into the statement and
 * the rest, so a list shows the statement alone.
 */
function parted(text) {
  const [said, ...rest] = String(text ?? '').split(' | ')
  const notes = []

  for (const piece of rest) {
    const labelled = /^(When|Involving|Where|Why):\s*(.*)$/.exec(piece)
    notes.push(labelled === null ? ['Why', piece] : [labelled[1], labelled[2]])
  }

  return { said, notes }
}

/** One row for a memory: its words, then what kind it is, when, and its tags. */
function memoryRow(memory, extra) {
  const type = memory.fact_type ?? memory.type
  const when = dated(memory.occurred_start ?? memory.date ?? memory.mentioned_at)

  const inside = [
    h('div', { class: 'text' }, parted(memory.text).said),
    h('div', { class: 'meta' },
      kindOf(type),
      when ? h('span', { class: 'sep' }, when) : null,
      type === 'observation' && memory.proof_count > 1 ? h('span', { class: 'sep' }, `from ${memory.proof_count} memories`) : null,
      extra ?? null,
      (memory.tags ?? []).slice(0, 3).map(tag => h('span', { class: 'chip' }, tag))),
  ]

  return h('li', null, memory.id ? h('a', { class: 'item', href: '#/memory/' + encodeURIComponent(memory.id) }, inside) : h('div', { class: 'item' }, inside))
}

/**
 * The list of notes knows each one's id and tags; its words come with a second lookup. This fetches them
 * for a page of notes before any row is drawn, so rows do not change size after they appear.
 */
const worded = docs => Promise.all(docs.map(doc =>
  kept('/documents/' + encodeURIComponent(doc.id)).then(full => ({ ...doc, original_text: full.original_text ?? '' }), () => doc)))

function noteRow(doc) {
  const { kind, title } = named(doc)
  const text = (doc.original_text ?? '').replace(/\s+/g, ' ').trim()

  return h('li', null, h('a', { class: 'item', href: '#/note/' + encodeURIComponent(doc.id) },
    h('div', { class: 'title' }, title), text === '' ? null : h('div', { class: 'excerpt' }, clipped(text, 240)),
    h('div', { class: 'meta' },
      h('span', { class: 'kind' }, kind),
      h('span', { class: 'sep' }, dated(doc.created_at, TIME)),
      h('span', { class: 'sep' }, `${doc.memory_unit_count} ${doc.memory_unit_count === 1 ? 'memory' : 'memories'}`),
      (doc.tags ?? []).slice(0, 3).map(tag => h('span', { class: 'chip' }, tag)))))
}

/**
 * A list that fetches a page at a time and offers the next one. The first page is fetched before the list
 * is handed back, so a view appears whole instead of in two steps. It remembers under `key` how many rows
 * were opened, so coming back to the list finds it as long as it was left.
 */
async function paged(key, load, row, none) {
  const list = h('ul', { class: 'list' })
  const foot = h('div', { class: 'center' })
  const wrap = h('div', null, list, foot)
  let offset = 0

  const next = async most => {
    const got = await load(offset, most)
    offset += got.items.length
    shown.set(key, offset)
    list.append(...got.items.map(row))

    if (offset === 0) foot.replaceChildren(state('empty', none))
    else if (offset < got.total && got.items.length > 0) foot.replaceChildren(h('button', { class: 'button quiet', onclick: more }, `Show more (${got.total - offset} left)`))
    else foot.replaceChildren()
  }

  const more = async () => {
    foot.replaceChildren(state('loading', 'Loading'))
    await next(PAGE).catch(problem => foot.replaceChildren(state('error', problem.message), h('button', { class: 'button quiet', onclick: more }, 'Try again')))
  }

  await next(Math.min(MOST, Math.max(PAGE, shown.get(key) ?? 0)))

  return wrap
}

// ---------------------------------------------------------------- views

async function overview() {
  const [stats, series, recent, tags] = await Promise.all([
    kept('/stats'), kept('/stats/memories-timeseries?period=30d').catch(() => null), kept('/documents?limit=6').then(got => worded(got.items)), kept('/tags?limit=100'),
  ])
  const by = stats.nodes_by_fact_type ?? {}
  const figure = (count, label, type, href) => h('a', { class: 'figure', href }, h('b', null, count ?? 0), h('span', null, type ? h('span', { class: 'dot ' + type }) : null, label))

  return page('Memory', stats.last_memory_write_at ? `Last written ${dated(stats.last_memory_write_at, TIME)}.` : 'Nothing written yet.',
    h('div', { class: 'figures' },
      figure(stats.total_documents, 'Notes', null, '#/notes'),
      figure(by.observation, 'Patterns', 'observation', '#/memories?type=observation'),
      figure(by.world, 'Facts', 'world', '#/memories?type=world'),
      figure(by.experience, 'Experiences', 'experience', '#/memories?type=experience')),
    // A chart of one busy day says nothing; draw it once writing is spread over a few days.
    series === null || busyDays(series.buckets ?? []) < 3 ? null : chart(series.buckets),
    section('Recent notes', h('a', { class: 'more', href: '#/notes' }, 'All notes'), h('ul', { class: 'list' }, recent.map(noteRow))),
    section('Topics', h('span', { class: 'aside' }, 'memories in each'), h('div', { class: 'chips' }, tags.items.map(tag => chip(tag.tag, '#/notes' + query({ tag: tag.tag }), tag.count)))))
}

const written = bucket => (bucket.world ?? 0) + (bucket.experience ?? 0) + (bucket.observation ?? 0)

const busyDays = buckets => buckets.filter(bucket => written(bucket) > 0).length

function chart(buckets) {
  const totals = buckets.map(written)
  const top = Math.max(1, ...totals)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const gap = 3
  const width = 600
  const each = (width - gap * (totals.length - 1)) / Math.max(1, totals.length)

  svg.setAttribute('class', 'chart')
  svg.setAttribute('viewBox', `0 0 ${width} 56`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', `Memories written per day over the last ${totals.length} days`)

  totals.forEach((total, at) => {
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    const tall = total === 0 ? 2 : Math.max(4, Math.round((total / top) * 56))
    bar.setAttribute('x', (at * (each + gap)).toFixed(1))
    bar.setAttribute('y', 56 - tall)
    bar.setAttribute('width', each.toFixed(1))
    bar.setAttribute('height', tall)
    bar.setAttribute('rx', '1.5')
    if (total === 0) bar.setAttribute('class', 'none')
    svg.append(bar)
  })

  return h('div', { class: 'section' }, svg, h('div', { class: 'chart-note' },
    h('span', null, dated(buckets[0]?.time, SHORT)), h('span', null, 'memories written per day'), h('span', null, dated(buckets.at(-1)?.time, SHORT))))
}

async function notes(params) {
  const tag = params.get('tag') ?? ''
  const tags = await kept('/tags?limit=100')
  const filter = h('div', { class: 'scroller' },
    h('a', { class: 'chip' + (tag === '' ? ' on' : ''), href: '#/notes' }, 'All'),
    tags.items.map(each => h('a', { class: 'chip' + (each.tag === tag ? ' on' : ''), href: '#/notes' + query({ tag: each.tag }) }, each.tag)))

  return page('Notes', 'What was written down, newest first.', filter,
    await paged('notes:' + tag, async (offset, limit) => {
      const got = await kept('/documents' + query({ limit, offset, tags: tag }))

      return { ...got, items: await worded(got.items) }
    }, noteRow, tag === '' ? 'No notes yet.' : `No notes tagged ${tag}.`))
}

async function note(id) {
  const [doc, drawn] = await Promise.all([
    kept('/documents/' + encodeURIComponent(id)),
    kept('/memories/list' + query({ document_id: id, limit: MOST })),
  ])
  const { kind, title } = named(doc)
  const written = doc.retain_params?.context

  return page(title, null,
    h('div', { class: 'meta' }, h('span', { class: 'kind' }, kind), h('span', { class: 'sep' }, dated(doc.created_at, TIME)), tagChips(doc.tags)),
    h('div', { class: 'section panel' }, h('p', { class: 'body' }, doc.original_text ?? 'The words of this note were not kept.')),
    written ? h('p', { class: 'hint' }, written) : null,
    section(`What the memory took from it (${drawn.total})`, null,
      drawn.items.length === 0 ? state('empty', 'Nothing was drawn from this note.') : h('ul', { class: 'list' }, drawn.items.map(each => memoryRow(each)))))
}

async function memories(params) {
  const type = TYPES.includes(params.get('type')) ? params.get('type') : 'observation'
  const tag = params.get('tag') ?? ''
  const stats = await kept('/stats')
  const by = stats.nodes_by_fact_type ?? {}
  const told = { observation: 'What the memory has concluded by putting notes together.', world: 'Things that are so: decisions, preferences, how things are set up.', experience: 'What an assistant did, and how it went.' }

  return page('Memories', told[type],
    h('div', { class: 'bar' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Kind of memory' }, TYPES.map(each =>
        h('button', { 'aria-pressed': String(each === type), onclick: () => { location.hash = '#/memories' + query({ type: each, tag }) } },
          h('span', { class: 'dot ' + each }), PLURAL[each], h('small', null, by[each] ?? 0)))),
      tag === '' ? null : h('a', { class: 'chip on', href: '#/memories' + query({ type }) }, tag, h('small', null, 'clear'))),
    await paged(`memories:${type}:${tag}`, (offset, limit) => kept('/memories/list' + query({ type, limit, offset, tags: tag })), each => memoryRow(each), `No ${PLURAL[type].toLowerCase()} yet.`))
}

async function memory(id) {
  const one = await kept('/memories/' + encodeURIComponent(id))
  const told = one.type !== 'observation' ? [] : await kept('/memories/' + encodeURIComponent(id) + '/history').catch(() => [])
  const changes = Array.isArray(told) ? told : told.items ?? told.history ?? []
  const sources = one.source_memories ?? []
  const when = dated(one.occurred_start ?? one.date)
  const { said, notes } = parted(one.text)
  const rows = [
    ['Kind', kindOf(one.type)],
    ...notes.filter(([name]) => name !== 'When' || !when),
    when ? ['When', when] : null,
    one.mentioned_at ? ['Written', dated(one.mentioned_at, TIME)] : null,
    one.context ? ['From', one.context] : null,
    one.state && one.state !== 'valid' ? ['State', one.invalidation_reason ? `${one.state}: ${one.invalidation_reason}` : one.state] : null,
    (one.tags ?? []).length ? ['Topics', h('div', { class: 'chips' }, tagChips(one.tags, tag => '#/memories' + query({ type: one.type, tag })))] : null,
    (one.entities ?? []).length ? ['Mentions', h('div', { class: 'chips' }, one.entities.map(each => chip(each, '#/search' + query({ q: each }))))] : null,
    one.document_id ? ['Note', h('a', { class: 'more', href: '#/note/' + encodeURIComponent(one.document_id) }, 'Open the note it came from')] : null,
  ].filter(Boolean)
  const curated = marks === null || one.type === 'observation' ? null : one.state === 'invalidated'
    ? h('div', { class: 'section' }, state('empty', 'This fact is retired. The memory no longer uses it.'), restoring(one, () => route({ stay: true })))
    : h('div', { class: 'section' }, retiring(one, () => {}))

  return page(KINDS[one.type] ?? 'Memory', null,
    h('div', { class: 'panel' }, h('p', { class: 'body' }, said)),
    h('dl', { class: 'facts section' }, rows.map(([name, value]) => [h('dt', null, name), h('dd', null, value)])),
    curated,
    sources.length === 0 ? null : section(`Put together from (${sources.length})`, null, h('ul', { class: 'list' }, sources.map(each => memoryRow(each)))),
    changes.length === 0 ? null : section(`How it read before (${changes.length})`, null, h('ul', { class: 'list' }, changes.map(was =>
      h('li', null, h('div', { class: 'item' }, h('div', { class: 'text' }, parted(was.previous_text ?? was.text ?? '').said), h('div', { class: 'meta' }, `until ${dated(was.changed_at ?? was.created_at, TIME)}`)))))))
}

async function search(params) {
  const asked = (params.get('q') ?? '').trim()
  const input = h('input', { class: 'input', type: 'search', name: 'q', value: asked, placeholder: 'Search the memory', autocomplete: 'off', enterkeyhint: 'search', 'aria-label': 'Search the memory' })
  const out = h('div', null)
  const form = h('form', { class: 'field', onsubmit: event => {
    event.preventDefault()
    const to = '#/search' + query({ q: input.value.trim() })
    if (location.hash === to) route()
    else location.hash = to
  } }, input, h('button', { class: 'button', type: 'submit' }, 'Search'))

  if (asked !== '') {
    out.replaceChildren(state('loading', 'Searching'))
    api('/memories/recall', { query: asked, max_tokens: 3000 }).then(found => {
      const hits = found.results ?? []
      const top = Math.max(0.0001, ...hits.map(hit => hit.scores?.final ?? 0))

      out.replaceChildren(hits.length === 0 ? state('empty', 'Nothing in the memory matches that.') : h('div', null,
        h('p', { class: 'hint' }, `${hits.length} ${hits.length === 1 ? 'memory' : 'memories'}, closest first.`),
        h('ul', { class: 'list' }, hits.map(hit => {
          const bar = h('i')
          bar.style.width = Math.round(((hit.scores?.final ?? 0) / top) * 100) + '%'

          return memoryRow(hit, h('span', { class: 'sep', title: 'How close a match' }, h('span', { class: 'score' }, bar)))
        }))))
    }).catch(problem => out.replaceChildren(state('error', problem.message)))
  }

  return page('Search', 'Finds memories by meaning, not just by matching words.', form, h('div', { class: 'section' }, out))
}

/** Just enough formatting for an answer: headings, lists, bold and code. Built as nodes, never as markup. */
function answered(text) {
  const out = h('div', { class: 'answer' })
  let list = null

  const inline = line => line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map(part =>
    /^\*\*[^*]+\*\*$/.test(part) ? h('strong', null, part.slice(2, -2)) : /^`[^`]+`$/.test(part) ? h('code', null, part.slice(1, -1)) : part)

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const heading = /^#{1,6}\s+(.*)$/.exec(line)

    if (bullet !== null || numbered !== null) {
      const wanted = bullet !== null ? 'UL' : 'OL'
      if (list === null || list.tagName !== wanted) { list = h(wanted.toLowerCase()); out.append(list) }
      list.append(h('li', null, inline((bullet ?? numbered)[1])))
      continue
    }

    if (line.trim() === '') continue
    list = null
    out.append(heading !== null ? h('h3', null, inline(heading[1])) : h('p', null, inline(line)))
  }

  return out
}

function turnRow(turn) {
  const used = turn.based ?? []

  return h('div', { class: 'turn' },
    h('div', { class: 'q' }, turn.question),
    turn.failed ? state('error', turn.failed) : turn.answer === undefined ? state('loading', 'Thinking') : answered(turn.answer),
    used.length === 0 ? null : h('details', { class: 'based' }, h('summary', null, `Based on ${used.length} ${used.length === 1 ? 'memory' : 'memories'}`),
      h('ul', { class: 'list' }, used.map(each => memoryRow(each)))))
}

function askPage() {
  if (asking !== null) return asking

  const box = h('textarea', { class: 'textarea', rows: '3', placeholder: 'What has gone wrong before when…', 'aria-label': 'Your question' })
  const send = h('button', { class: 'button', type: 'submit' }, 'Ask')
  const log = h('div', null, turns.map(turnRow))

  const submit = async event => {
    event.preventDefault()
    const question = box.value.trim()
    if (question === '' || send.disabled) return

    const turn = { question }
    turns = [turn, ...turns]
    box.value = ''
    send.disabled = true
    log.replaceChildren(...turns.map(turnRow))

    try {
      const got = await api('/reflect', { query: question, budget: 'low', max_tokens: 900, include: { facts: {} } })
      turn.answer = got.text ?? ''
      turn.based = got.based_on?.memories ?? []
    } catch (problem) {
      turn.failed = problem.message
    }

    send.disabled = false
    log.replaceChildren(...turns.map(turnRow))
  }

  box.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event) })

  asking = page('Ask', 'The memory reads what it holds and answers in its own words.',
    h('form', { onsubmit: submit }, box, h('div', { class: 'field spread' }, h('p', { class: 'hint' }, 'Each question uses the language model, so it takes a few seconds. Questions are not added to the memory.'), send)),
    h('div', { class: 'section' }, log))

  return asking
}

// ---------------------------------------------------------------- review

/** Every pattern in the bank, fetched a page at a time. */
async function patterns() {
  const all = []

  for (;;) {
    const got = await kept('/memories/list' + query({ type: 'observation', limit: MOST, offset: all.length }))
    all.push(...got.items)
    if (got.items.length === 0 || all.length >= got.total) return all
  }
}

/** A pattern is waiting if it was never looked at, or has been rebuilt since. */
const waiting = async () => (await patterns()).filter(each => marks.get(each.id) !== each.updated_at)

async function counted() {
  const left = await waiting().then(all => all.length, () => 0)

  due.hidden = left === 0
  due.textContent = left > 99 ? '99+' : String(left)

  return left
}

const act = (label, onclick, quiet = true) => h('button', { class: 'button small' + (quiet ? ' quiet' : ''), type: 'button', onclick }, label)

/** Runs one write, with the buttons of `row` held while it is under way and the reason shown if it fails. */
async function writing(row, path, body) {
  const buttons = [...row.querySelectorAll('button')]
  buttons.forEach(button => { button.disabled = true })
  row.querySelector('.error')?.remove()

  try {
    return await api(path, body)
  } catch (problem) {
    buttons.forEach(button => { button.disabled = false })
    row.append(state('error', problem.message))

    return null
  }
}

/** "Bring back" for a retired fact. */
function restoring(fact, then) {
  const row = h('div', { class: 'actions' })

  row.append(act('Bring back', async () => {
    if (await writing(row, '/review/restore', { id: fact.id }) === null) return
    cache.clear()
    row.replaceChildren(state('empty', 'Brought back. The memory will use it again.'))
    counted()
    then()
  }))

  return row
}

/** "Retire this fact", which first asks why. What it leaves behind can undo it. */
function retiring(fact, then) {
  const row = h('div', { class: 'actions' })
  const open = () => row.replaceChildren(act('Retire this fact', ask))

  const ask = () => {
    const why = h('input', { class: 'input', type: 'text', maxlength: '300', placeholder: 'Why? (optional)', 'aria-label': 'Why this fact is wrong', autocomplete: 'off' })
    const form = h('form', { class: 'field wrap', onsubmit: async event => {
      event.preventDefault()
      if (await writing(row, '/review/retire', { id: fact.id, reason: why.value }) === null) return
      cache.clear()
      row.replaceChildren(state('empty', 'Retired. The memory is rebuilding without it.'), restoring(fact, () => {}))
      counted()
      then()
    } }, why, h('button', { class: 'button small', type: 'submit' }, 'Retire'), act('Cancel', open))

    row.replaceChildren(form)
    why.focus()
  }

  open()

  return row
}

/** One pattern in the queue: its words, then "Looks right" or a look at the facts it was built from. */
function reviewRow(pattern, onGone) {
  const under = h('div', { class: 'sources', hidden: true })
  const row = h('li', { class: 'review' })

  const choices = h('div', { class: 'actions' })
  let isSettled = false

  // The pattern is dealt with, one way or the other: it stops counting as waiting.
  const settle = () => {
    if (isSettled) return
    isSettled = true
    onGone()
  }

  const right = async () => {
    if (await writing(row, '/review/marks', { id: pattern.id, seen: pattern.updated_at }) === null) return
    marks.set(pattern.id, pattern.updated_at)
    ;(row.nextElementSibling ?? row.previousElementSibling)?.querySelector('button')?.focus({ preventScroll: true })
    row.remove()
    settle()
  }

  // Once a fact behind it is retired, the memory drops this pattern and builds a new one, which will
  // turn up here by itself. So this row keeps only the result, and the way to undo it.
  const retiredOne = () => {
    choices.replaceChildren(state('empty', 'The memory is rebuilding this pattern. The new one will show up here.'))
    settle()
  }

  const off = async () => {
    if (!under.hidden) { under.hidden = true; return }
    under.hidden = false
    under.replaceChildren(state('loading', 'Finding where this came from'))

    try {
      const full = await kept('/memories/' + encodeURIComponent(pattern.id))
      const sources = full.source_memories ?? []

      under.replaceChildren(
        h('p', { class: 'hint' }, sources.length === 0 ? 'The memory did not say which facts this came from.'
          : 'This was put together from the facts below. Retire the one that is wrong and the memory rebuilds the pattern without it. A retired fact can be brought back.'),
        ...sources.map(fact => h('div', { class: 'source' },
          h('div', { class: 'text' }, parted(fact.text).said),
          h('div', { class: 'meta' }, kindOf(fact.type), dated(fact.occurred_start ?? fact.mentioned_at) ? h('span', { class: 'sep' }, dated(fact.occurred_start ?? fact.mentioned_at)) : null),
          retiring(fact, retiredOne))))
    } catch (problem) {
      under.replaceChildren(state('error', problem.message))
    }
  }

  const when = dated(pattern.occurred_start ?? pattern.date ?? pattern.mentioned_at)

  row.append(
    h('div', { class: 'item' },
      h('div', { class: 'text whole' }, parted(pattern.text).said),
      h('div', { class: 'meta' },
        kindOf('observation'),
        when ? h('span', { class: 'sep' }, when) : null,
        pattern.proof_count > 1 ? h('span', { class: 'sep' }, `from ${pattern.proof_count} memories`) : null,
        (pattern.tags ?? []).slice(0, 3).map(tag => h('span', { class: 'chip' }, tag))),
      choices),
    under)
  choices.append(act('Looks right', right, false), act('Something is off', off))

  return row
}

async function review(params) {
  if (marks === null) return page('Review', 'Review is not switched on for this page.')

  const showing = params.get('show') === 'retired' ? 'retired' : 'queue'
  const tabs = h('div', { class: 'seg', role: 'group', 'aria-label': 'What to show' },
    h('button', { 'aria-pressed': String(showing === 'queue'), onclick: () => { location.hash = '#/review' } }, 'To look at'),
    h('button', { 'aria-pressed': String(showing === 'retired'), onclick: () => { location.hash = '#/review?show=retired' } }, 'Retired'))

  if (showing === 'retired') {
    const gone = await api('/memories/list' + query({ state: 'invalidated', limit: MOST }))

    return page('Review', 'Facts you retired. The memory keeps them but no longer uses them.', h('div', { class: 'bar' }, tabs),
      gone.items.length === 0 ? state('empty', 'Nothing is retired.') : h('ul', { class: 'list' }, gone.items.map(fact => h('li', { class: 'review' },
        h('div', { class: 'item' },
          h('div', { class: 'text whole' }, parted(fact.text).said),
          h('div', { class: 'meta' }, kindOf(fact.fact_type), h('span', { class: 'sep' }, `retired ${dated(fact.invalidated_at, TIME)}`), fact.invalidation_reason ? h('span', { class: 'sep' }, fact.invalidation_reason) : null),
          restoring(fact, () => {}))))))
  }

  const queue = await waiting()
  const lede = h('p', { class: 'lede' })
  const list = h('ul', { class: 'list' })
  const more = h('div', { class: 'center' })
  let left = queue.length
  let drawn = 0

  const told = () => { lede.textContent = left === 0 ? 'Nothing is waiting. Every pattern the memory formed has been looked at.' : `${left} ${left === 1 ? 'pattern' : 'patterns'} the memory formed by itself. Say which look right.` }
  const gone = () => { left -= 1; told(); counted(); if (list.children.length === 0 && drawn < queue.length) show() }

  const show = () => {
    const next = queue.slice(drawn, drawn + PAGE)
    drawn += next.length
    list.append(...next.map(each => reviewRow(each, gone)))
    more.replaceChildren(drawn < queue.length ? act(`Show more (${queue.length - drawn} left)`, show) : '')
  }

  told()
  show()
  counted()

  return h('div', { class: 'page' }, h('header', { class: 'head' }, h('h1', null, 'Review'), lede), h('div', { class: 'bar' }, tabs), list, more)
}

// ---------------------------------------------------------------- routing

const ROUTES = [
  [/^\/?$/, 'home', () => overview()],
  [/^\/notes$/, 'notes', (_, params) => notes(params)],
  [/^\/note\/(.+)$/, 'notes', match => note(decodeURIComponent(match[1])), '#/notes', 'Notes'],
  [/^\/memories$/, 'memories', (_, params) => memories(params)],
  [/^\/memory\/(.+)$/, 'memories', match => memory(decodeURIComponent(match[1])), '#/memories', 'Memories'],
  [/^\/review$/, 'review', (_, params) => review(params)],
  [/^\/search$/, 'search', (_, params) => search(params)],
  [/^\/ask$/, 'ask', async () => askPage()],
]

// The bar is built once and only its current mark moves, so it never blinks between pages.
const links = new Map(TABS.map(tab => [tab.key, h('a', { class: 'tab', href: tab.href }, icon(tab.key), tab.label)]))

const foot = h('div', { class: 'foot' }, 'Read only. Nothing here can change or delete a memory.')
const due = h('small', { class: 'badge', hidden: true })

links.get('review').hidden = true
links.get('review').append(due)
nav.replaceChildren(h('div', { class: 'brand' }, icon('memories'), 'Memory'), ...links.values(), foot)

function markNav(current) {
  for (const [key, link] of links) {
    if (key === current) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
}

/**
 * Draws the page the address names. Going back to the page before returns to where the reader was on it;
 * anywhere else starts at the top. `stay` redraws in place, for a refresh.
 */
async function route({ stay = false } = {}) {
  const [path, search_] = (location.hash.replace(/^#/, '') || '/').split('?')
  const params = new URLSearchParams(search_ ?? '')
  const found = ROUTES.map(each => ({ each, match: each[0].exec(path) })).find(tried => tried.match !== null)
  const turn = ++drawing

  // Note where the reader was on the page being left, now, before anything on it changes height.
  places.set(here, window.scrollY)
  here = location.hash

  if (found === undefined) { location.hash = '#/'; return }

  const [, tab, view, up, upLabel] = found.each
  markNav(tab)

  // The page before stays up until the next one is ready. Only a slow answer gets a loading line.
  const slow = setTimeout(() => { if (turn === drawing) main.replaceChildren(state('loading', 'Loading')) }, 400)
  let drawn

  try {
    drawn = await view(found.match, params)
  } catch (problem) {
    drawn = page('Something went wrong', problem.message)
  } finally {
    clearTimeout(slow)
  }

  if (turn !== drawing) return

  const to = location.hash
  const isBack = !stay && trail.at(-2) === to
  const place = stay || isBack ? places.get(to) ?? 0 : 0

  if (isBack) trail.pop()
  else if (!stay && trail.at(-1) !== to) trail.push(to)

  main.replaceChildren(up ? back(up, upLabel) : '', drawn)
  document.title = [drawn.querySelector('h1')?.textContent, 'Memory'].filter((part, at, all) => part && all.indexOf(part) === at).join(' \u00b7 ')
  if (!stay) main.focus({ preventScroll: true })
  window.scrollTo(0, place)
  places.set(to, place)
}

/**
 * Finds out whether the review service is there. If it is, the Review section appears and the count of
 * patterns waiting is shown on it; if not, the page stays as it was, read-only.
 */
async function reviewing() {
  try {
    marks = new Map(Object.entries((await api('/review/marks')).marks ?? {}))
  } catch {
    return
  }

  links.get('review').hidden = false
  foot.textContent = 'Review can retire a fact, and bring it back. Nothing here can rewrite or delete a memory.'
  counted()
}

if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

window.addEventListener('scroll', () => places.set(here, window.scrollY), { passive: true })
window.addEventListener('hashchange', () => route())

// Left open in the background, the page would go on showing what it fetched hours ago. Coming back to it
// after a while fetches again. A half-written question on Ask is left alone.
let hiddenAt = 0

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return }
  if (hiddenAt === 0 || Date.now() - hiddenAt < 60000) return

  cache.clear()
  if (!location.hash.startsWith('#/ask')) route({ stay: true })
})

reviewing().then(() => { if (location.hash.startsWith('#/review') || location.hash.startsWith('#/memory/')) route({ stay: true }) })
route()
