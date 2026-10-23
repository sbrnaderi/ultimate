import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import webSearch, {
  parseResults,
  parseUnresponsive,
  searxngUrl,
} from '../.ultimate/extensions/web-search/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { removeTemp, temp } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const close of cleanup.splice(0)) await close()
})

/** A host over a temp user home; `settings` writes `~/.ultimate/settings.json` when given. */
async function fixture(settings?: string) {
  const userHome = await temp()
  cleanup.push(() => removeTemp(userHome))
  if (settings !== undefined) {
    await mkdir(join(userHome, '.ultimate'), { recursive: true })
    await writeFile(join(userHome, '.ultimate/settings.json'), settings)
  }
  const notice = vi.fn<(message: string) => void>()
  const host = {
    userHome,
    notice,
    resource: <T>(_key: string, create: () => T) => create(),
  } as unknown as ExtensionHost
  const tools = webSearch(host).tools!
  const details = vi.fn<(value: unknown, context: unknown) => Promise<void>>(async () => {})
  const run = async (args: unknown, signal?: AbortSignal) =>
    tools[0].execute(args, { details } as never, { abortSignal: signal } as never)
  return { run, details, notice }
}

/** A fake SearXNG answering GET /search; the handler returns the answer or hangs. */
async function fake(
  handler: (params: URLSearchParams) => {
    status?: number
    body?: string
    contentType?: string
    hang?: boolean
  },
) {
  const requests: string[] = []
  const errors: unknown[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1')
    requests.push(url.pathname + url.search)
    const answer = handler(url.searchParams)
    if (answer.hang) return // Leave it unanswered: the client's timeout or abort ends it.
    response.writeHead(answer.status ?? 200, {
      'content-type': answer.contentType ?? 'application/json',
    })
    response.end(answer.body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  vi.stubEnv('ULTIMATE_WEB_SEARCH_TEST_URL', `http://127.0.0.1:${address.port}`)
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(errors).toEqual([])
  })
  return { requests }
}

const item = (url: string, title: string, extra: Record<string, unknown> = {}) => ({
  title,
  url,
  content: `snippet for ${title}`,
  engine: 'google',
  ...extra,
})
const payload = (results: unknown[], unresponsive: unknown = []) => ({
  query: 'q',
  results,
  answers: [],
  corrections: [],
  infoboxes: [],
  suggestions: [],
  unresponsive_engines: unresponsive,
})

it('requests q + format=json, formats results, and reports unresponsive engines in text and details', async () => {
  const f = await fixture()
  const server = await fake(() => ({
    body: JSON.stringify(
      payload(
        [
          item(
            'https://pmc.ncbi.nlm.nih.gov/articles/x/',
            'Onychomycosis: An Updated Review - PMC',
            {
              pretty_url: 'pmc.ncbi.nlm.nih.gov › articles',
              publishedDate: '2026-01-01T00:00:00',
            },
          ),
          item('https://example.com/no-title', ''),
        ],
        [
          ['brave', 'Suspended: too many requests'],
          ['duckduckgo', 'CAPTCHA'],
        ],
      ),
    ),
  }))
  const search = await f.run({
    query: 'toenail fungal infection cure evidence review',
    count: 2,
  })
  expect(server.requests).toEqual([
    '/search?q=toenail+fungal+infection+cure+evidence+review&format=json',
  ])
  expect(search).not.toHaveProperty('isError')
  const text = JSON.stringify(search)
  expect(text).toContain('Found 2 results for: toenail fungal infection cure evidence review')
  expect(text).toContain('Onychomycosis: An Updated Review - PMC')
  expect(text).toContain('Domain: pmc.ncbi.nlm.nih.gov › articles')
  expect(text).toContain('Published: 2026-01-01T00:00:00')
  expect(text).toContain('snippet for Onychomycosis: An Updated Review - PMC')
  expect(text).toContain('https://example.com/no-title') // Titleless results show their URL.
  expect(text).toContain(
    '2 upstream engines were unresponsive (brave: Suspended: too many requests; duckduckgo: CAPTCHA)',
  )
  expect(f.details.mock.calls[0][0]).toMatchObject({
    status: 'success',
    results: [
      {
        url: 'https://pmc.ncbi.nlm.nih.gov/articles/x/',
        domain: 'pmc.ncbi.nlm.nih.gov › articles',
        publishedDate: '2026-01-01T00:00:00',
        engine: 'google',
      },
      { domain: 'example.com', publishedDate: null },
    ],
    unresponsive: [
      { engine: 'brave', message: 'Suspended: too many requests' },
      { engine: 'duckduckgo', message: 'CAPTCHA' },
    ],
  })
})
it('passes categories and time_range, caps to count, and defaults count to 10', async () => {
  const f = await fixture()
  const many = Array.from({ length: 20 }, (_, index) =>
    item(`https://e${index}.test/`, `Page ${index}`),
  )
  const server = await fake(() => ({ body: JSON.stringify(payload(many)) }))
  const narrowed = await f.run({
    query: 'nodejs 26 release notes',
    count: 3,
    categories: 'it,news',
    time_range: 'year',
  })
  expect(server.requests[0]).toContain('categories=it%2Cnews')
  expect(server.requests[0]).toContain('time_range=year')
  expect(JSON.stringify(narrowed)).toContain('Found 3 results')
  expect((f.details.mock.calls[0][0] as { results: unknown[] }).results).toHaveLength(3)
  const defaulted = await f.run({ query: 'nodejs 26 release notes' })
  expect((f.details.mock.calls[1][0] as { results: unknown[] }).results).toHaveLength(10)
  expect(JSON.stringify(defaulted)).toContain('Found 10 results')
  expect(JSON.stringify(defaulted)).toContain('Page 9')
  expect(JSON.stringify(defaulted)).not.toContain('Page 10')
})
it('reports an empty result set without an error and skips malformed items', async () => {
  const f = await fixture()
  await fake(() => ({
    body: JSON.stringify(payload([null, 7, { title: 'no url' }, 'x'])),
  }))
  const empty = await f.run({ query: 'nothing matches this' })
  expect(empty).not.toHaveProperty('isError')
  expect(JSON.stringify(empty)).toContain('No results for: nothing matches this')
  expect(f.details.mock.calls[0][0]).toMatchObject({
    status: 'success',
    results: [],
  })
})
it.each([
  ['missing results', JSON.stringify({ query: 'q' }), 'no results array', null], // What `?query=` instead of `q=` answers.
  ['results not an array', '{"results": "nope"}', 'no results array', null],
  ['invalid JSON', '<html>not json</html>', 'not JSON', null],
  [
    'JSON output disabled',
    '{"error": "format json is not supported"}',
    'refuses JSON output (HTTP 403)',
    403,
  ],
])('errors clearly on %s', async (_case, answer, expected, httpStatus) => {
  const f = await fixture()
  await fake(() =>
    typeof answer === 'string' && answer.startsWith('<')
      ? { body: answer, contentType: 'text/html' }
      : { body: answer, ...(httpStatus ? { status: httpStatus } : {}) },
  )
  const output = await f.run({ query: 'test' })
  expect(output).toHaveProperty('isError', true)
  expect(JSON.stringify(output)).toContain(expected)
  expect(f.details.mock.calls[0][0]).toMatchObject({
    status: 'error',
    httpStatus,
  })
})
it('maps other HTTP answers to an error naming the status', async () => {
  const f = await fixture()
  await fake(() => ({ status: 500, body: 'boom' }))
  const output = await f.run({ query: 'test' })
  expect(output).toHaveProperty('isError', true)
  expect(JSON.stringify(output)).toContain('answered HTTP 500')
  expect(f.details.mock.calls[0][0]).toMatchObject({
    status: 'error',
    httpStatus: 500,
  })
})
it('fails fast on an unreachable instance with exactly one notice', async () => {
  vi.stubEnv('ULTIMATE_WEB_SEARCH_TEST_URL', 'http://127.0.0.1:1')
  const f = await fixture()
  for (let attempt = 0; attempt < 2; attempt++) {
    const output = await f.run({ query: 'test' })
    expect(output).toHaveProperty('isError', true)
    expect(JSON.stringify(output)).toContain('Could not reach SearXNG at http://127.0.0.1:1')
  }
  expect(f.notice).toHaveBeenCalledTimes(1)
  expect(f.notice.mock.calls[0][0]).toContain('webSearch.url')
})
it('notices a configured URL that is not usable, naming the setting', async () => {
  vi.unstubAllEnvs() // No test override: the configured value is used.
  const f = await fixture(JSON.stringify({ webSearch: { url: 'not a url' } }))
  for (let attempt = 0; attempt < 2; attempt++) {
    const output = await f.run({ query: 'test' })
    expect(output).toHaveProperty('isError', true)
    expect(JSON.stringify(output)).toContain('webSearch.url in ~/.ultimate/settings.json')
  }
  expect(f.notice).toHaveBeenCalledTimes(1)
})
it('honours the caller abort signal against a server that never answers', async () => {
  await fake(() => ({ hang: true }))
  const f = await fixture()
  const controller = new AbortController()
  const pending = f.run({ query: 'test' }, controller.signal)
  controller.abort()
  const output = await pending
  expect(output).toHaveProperty('isError', true)
  expect(JSON.stringify(output)).toContain('cancelled')
})
it('takes webSearch.url from user settings only and rejects bad values', async () => {
  const userHome = await temp()
  cleanup.push(() => removeTemp(userHome))
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  const host = { userHome } as ExtensionHost
  const set = async (settings: string) => {
    await writeFile(join(userHome, '.ultimate/settings.json'), settings)
    return searxngUrl(host)
  }
  expect(
    await set(
      JSON.stringify({
        webSearch: { url: 'http://192.168.1.5:8080/searxng/' },
      }),
    ),
  ).toBe('http://192.168.1.5:8080/searxng')
  expect(await set('{}')).toBe('http://192.168.1.102:8389') // Unset takes the default.
  expect(await set('not json')).toBe('http://192.168.1.102:8389') // Broken settings read as unset.
  await expect(set(JSON.stringify({ webSearch: { url: '   ' } }))).rejects.toThrow(
    'webSearch.url in ~/.ultimate/settings.json',
  )
  await expect(set(JSON.stringify({ webSearch: { url: 'ftp://192.168.1.5' } }))).rejects.toThrow(
    'http(s)',
  )
  await expect(
    set(JSON.stringify({ webSearch: { url: 'http://user:pw@192.168.1.5' } })),
  ).rejects.toThrow('without credentials')
})
it('caps text output at 50 KiB / 2000 lines', async () => {
  const f = await fixture()
  await fake(() => ({
    body: JSON.stringify(
      payload([item('https://big.test/', 'Big', { content: 'ü'.repeat(60000) })]),
    ),
  }))
  const output = await f.run({ query: 'test' })
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(52 * 1024)
  expect(JSON.stringify(output)).toContain('Output truncated')
})
it('parses results and unresponsive engines defensively', () => {
  expect(parseResults(payload([item('https://a.test/', 'A')]), 'http://x')).toEqual([
    {
      url: 'https://a.test/',
      title: 'A',
      snippet: 'snippet for A',
      publishedDate: null,
      domain: 'a.test',
      engine: 'google',
    },
  ])
  expect(() => parseResults(null, 'http://x')).toThrow('no results array')
  expect(() => parseResults({ results: {} }, 'http://x')).toThrow('no results array')
  expect(parseUnresponsive(payload([], 'nope'))).toEqual([])
  expect(parseUnresponsive(undefined)).toEqual([])
  expect(parseUnresponsive(payload([], [['google', 'Timed out'], ['x'], 5]))).toEqual([
    { engine: 'google', message: 'Timed out' },
  ])
})
