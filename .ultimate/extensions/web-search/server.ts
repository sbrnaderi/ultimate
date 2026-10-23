/** web-search: a `web_search` tool over the user's local SearXNG instance (`webSearch.url`, user settings only). */
import { Type } from '@earendil-works/pi-ai'
import type { JsonObject } from '@earendil-works/pi-durable'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { readSettings, userSettingsPath } from '../../../lib/settings.ts'

const DEFAULT_URL = 'http://192.168.1.102:8389'
const REQUEST_TIMEOUT_MS = 15_000
const guidance = `Use web_search to discover pages, verify current facts, or locate documentation. It queries the user's local SearXNG instance, which aggregates public search engines.
Results may be incomplete when upstream engines are unresponsive; the tool reports which ones.
To read a promising result, fetch it with bash curl (send a User-Agent; some sites block curl's default).`

export type SearchResult = {
  url: string
  title: string
  snippet: string
  publishedDate: string | null
  domain: string
  engine: string | null
}
export type UnresponsiveEngine = {
  engine: string
  message: string
}
export type Details =
  | {
      status: 'success'
      results: SearchResult[]
      unresponsive: UnresponsiveEngine[]
    }
  | { status: 'error'; error: string; httpStatus: number | null }

/** The tool's text output is bounded like other tools: 50 KiB / 2000 lines. */
const MAX_OUTPUT_BYTES = 50 * 1024
const MAX_OUTPUT_LINES = 2_000
const TRUNCATION_NOTICE = '\n[Output truncated to 50KB / 2000 lines.]'
export function truncateToolOutput(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= MAX_OUTPUT_LINES && Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_BYTES)
    return text
  const byteBudget = MAX_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE, 'utf8')
  const kept: string[] = []
  let bytes = 0
  for (const line of lines.slice(0, MAX_OUTPUT_LINES - 1)) {
    const separator = kept.length === 0 ? 0 : 1
    const available = byteBudget - bytes - separator
    if (available <= 0) break
    if (Buffer.byteLength(line, 'utf8') <= available) {
      kept.push(line)
      bytes += separator + Buffer.byteLength(line, 'utf8')
      continue
    }
    let end = line.length
    while (end > 0 && Buffer.byteLength(line.slice(0, end), 'utf8') > available) end--
    if (end > 0) kept.push(line.slice(0, end))
    break
  }
  return `${kept.join('\n')}${TRUNCATION_NOTICE}`
}

/** A URL as shown: no scheme, no `www.`, no trailing slash. */
export const bare = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')

function prettyDomain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    // A result URL SearXNG produced that no parser reads is still shown as-is.
    return url
  }
}

/** A SearXNG fault; `status` is the instance's HTTP answer when it responded, otherwise null; `notify` marks the configuration and connectivity faults worth one process-local notice. */
class SearxngError extends Error {
  readonly status: number | null
  readonly notify: boolean
  constructor(message: string, options: { status?: number; notify?: boolean } = {}) {
    super(message)
    this.status = options.status ?? null
    this.notify = options.notify ?? false
  }
}

/**
 * The instance URL, user settings only: a repository must not redirect the user's queries elsewhere.
 * `ULTIMATE_WEB_SEARCH_TEST_URL` overrides it only for local fake-server tests.
 */
export async function searxngUrl(host: ExtensionHost): Promise<string> {
  const test = process.env.ULTIMATE_WEB_SEARCH_TEST_URL
  if (test) return validated(test, 'ULTIMATE_WEB_SEARCH_TEST_URL', false)
  // Invalid settings read as unset (the default); the settings loader reports the file itself.
  const settings = await readSettings(userSettingsPath(host.userHome)).catch((): JsonObject => ({}))
  const group = settings.webSearch
  const configured =
    group && typeof group === 'object' && !Array.isArray(group)
      ? (group as Record<string, unknown>).url
      : undefined
  if (configured === undefined) return validated(DEFAULT_URL, 'webSearch.url (the default)', false)
  return validated(
    typeof configured === 'string' ? configured : '',
    'webSearch.url in ~/.ultimate/settings.json',
    true,
  )
}

/** An http(s) URL without credentials, normalized to no trailing slash; names the setting when it is not. */
function validated(value: string, setting: string, notify: boolean): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  const malformed = new SearxngError(
    `web_search needs an http(s) SearXNG URL: set "${setting}" (for example ${DEFAULT_URL}).`,
    { notify },
  )
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw malformed
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new SearxngError(
      `web_search needs an http(s) SearXNG URL without credentials: set "${setting}" (for example ${DEFAULT_URL}).`,
      { notify },
    )
  return url.origin + url.pathname.replace(/\/+$/, '')
}

/** Map a SearXNG `/search?format=json` payload to tool results; anything without a results array is an error. */
export function parseResults(payload: unknown, base: string): SearchResult[] {
  const items = (payload as { results?: unknown } | null)?.results
  if (!Array.isArray(items))
    throw new SearxngError(
      `SearXNG at ${base} returned no results array: is JSON output enabled (search.formats: [html, json] in settings.yml)?`,
    )
  const results: SearchResult[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (typeof record.url !== 'string' || !record.url) continue
    results.push({
      url: record.url,
      title: typeof record.title === 'string' ? record.title : '',
      snippet: typeof record.content === 'string' ? record.content : '',
      publishedDate: nullable(record.publishedDate) ?? nullable(record.published_date) ?? null,
      domain:
        typeof record.pretty_url === 'string' && record.pretty_url
          ? record.pretty_url
          : prettyDomain(record.url),
      engine: nullable(record.engine),
    })
  }
  return results
}

export function parseUnresponsive(payload: unknown): UnresponsiveEngine[] {
  // SearXNG reports these as [engine, reason] pairs, e.g. [["brave","Suspended: too many requests"]].
  const items = (payload as { unresponsive_engines?: unknown } | null)?.unresponsive_engines
  if (!Array.isArray(items)) return []
  return items.flatMap((item) =>
    Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string'
      ? [{ engine: item[0], message: item[1] }]
      : [],
  )
}

const nullable = (value: unknown) => (typeof value === 'string' && value ? value : null)

export default function webSearch(host: ExtensionHost) {
  // Unreachable or misconfigured instance: a tool error every call, one process-local notice ever.
  const notices = host.resource('web-search:notice', () => ({ sent: false }))
  async function search(query: string, args: { signal?: AbortSignal; [key: string]: unknown }) {
    const base = await searxngUrl(host)
    const url = new URL(`${base}/search`)
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    for (const name of ['categories', 'time_range']) {
      const value = args[name]
      if (typeof value === 'string' && value) url.searchParams.set(name, value)
    }
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const signal = args.signal ? AbortSignal.any([args.signal, timeout]) : timeout
    let response: Response
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal,
      })
    } catch {
      if (args.signal?.aborted) throw new SearxngError('web_search was cancelled.')
      const message = timeout.aborted
        ? `SearXNG at ${base} did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`
        : `Could not reach SearXNG at ${base}; check webSearch.url in ~/.ultimate/settings.json.`
      throw new SearxngError(message, { notify: true })
    }
    const text = await response.text().catch(() => '')
    if (response.status === 403 && /format json is not supported/i.test(text))
      throw new SearxngError(
        `SearXNG at ${base} refuses JSON output (HTTP 403). Enable it there: search.formats: [html, json] in settings.yml.`,
        { status: 403 },
      )
    if (!response.ok)
      throw new SearxngError(
        `SearXNG at ${base} answered HTTP ${response.status}${text.trim() ? `: ${text.trim().slice(0, 200)}` : '.'}`,
        { status: response.status },
      )
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw new SearxngError(`SearXNG at ${base} returned a response that is not JSON.`)
    }
    return {
      results: parseResults(payload, base),
      unresponsive: parseUnresponsive(payload),
    }
  }
  return defineExtension({
    name: 'web-search',
    sections: [section('web_search', () => guidance)],
    tools: [
      defineTool({
        name: 'web_search',
        // Repeating a search only reads public web results; it changes no project state.
        replay: 'safe',
        description:
          "Search the public web through the user's local SearXNG instance. Returns ranked pages with titles, URLs, domains, snippets and publication dates, plus a note when upstream engines were unresponsive. Use this to discover sources or find current information. To read a result page, use curl. Output is limited to 50KB or 2,000 lines.",
        parameters: Type.Object({
          query: Type.String({
            minLength: 1,
            maxLength: 512,
            description: 'What to find on the web, as a self-contained search query.',
          }),
          count: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 25,
              description: 'Maximum number of results. Defaults to 10.',
            }),
          ),
          categories: Type.Optional(
            Type.String({
              maxLength: 128,
              description:
                'Comma-separated SearXNG categories, for example "general", "news", "it". Defaults to the instance default.',
            }),
          ),
          time_range: Type.Optional(
            Type.Union(
              [
                Type.Literal('day'),
                Type.Literal('week'),
                Type.Literal('month'),
                Type.Literal('year'),
              ],
              { description: 'Only results from this recent period.' },
            ),
          ),
        }),
        async execute(args, api, context) {
          const query = args.query
          try {
            const { results, unresponsive } = await search(query, {
              signal: context.abortSignal,
              categories: args.categories,
              time_range: args.time_range,
            })
            const shown = results.slice(0, args.count ?? 10)
            await api.details({ status: 'success', results: shown, unresponsive }, context)
            const note = unresponsive.length
              ? `Note: ${unresponsive.length} upstream ${unresponsive.length === 1 ? 'engine was' : 'engines were'} unresponsive (${unresponsive.map((engine) => `${engine.engine}: ${engine.message}`).join('; ')}); the result set may be incomplete.`
              : ''
            const text =
              (shown.length
                ? `Found ${shown.length} results for: ${query}\n\n` +
                  shown
                    .map(
                      (result, index) =>
                        `${index + 1}. ${result.title || bare(result.url)}\nURL: ${result.url}\nDomain: ${result.domain}${result.publishedDate ? `\nPublished: ${result.publishedDate}` : ''}\n${result.snippet}`,
                    )
                    .join('\n\n---\n\n')
                : `No results for: ${query}`) + (note ? `\n\n${note}` : '')
            return {
              output: [{ type: 'text', text: truncateToolOutput(text) }],
            }
          } catch (error) {
            if (error instanceof SearxngError && error.notify && !notices.sent) {
              notices.sent = true
              host.notice(`web_search: ${error.message}`)
            }
            const message = error instanceof Error ? error.message : 'web_search failed.'
            const text = truncateToolOutput(message)
            await api.details(
              {
                status: 'error',
                error: text,
                httpStatus: error instanceof SearxngError ? error.status : null,
              },
              context,
            )
            return { isError: true, output: [{ type: 'text' as const, text }] }
          }
        },
      }),
    ],
  })
}
