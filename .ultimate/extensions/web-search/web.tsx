/** web-search's transcript card: the query, top domains and result count; failures open themselves. */
import { useEffect, useRef, useState } from 'react'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { Shimmer } from '@/components/ai/shimmer'
import { defineWebExtension, useToolDuration } from '@/sdk'
import type { ToolCallView } from '@/sdk'

/** One result in the tool's `details` (server.ts). */
interface Result {
  url: string
  title: string
  snippet: string
  publishedDate: string | null
  domain: string
  engine: string | null
}
interface Unresponsive {
  engine: string
  message: string
}
type Details =
  | {
      status: 'success'
      count: number
      results: Result[]
      unresponsive: Unresponsive[]
    }
  | { status: 'error'; error: string; httpStatus: number | null }

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const text = (value: unknown) => (typeof value === 'string' ? value : '')
/** A URL as shown: no scheme, no `www.`, no trailing slash. */
const bare = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
const day = (date: string) => (/^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : date)
/** The first few distinct domains, in rank order. */
function domains(results: readonly Result[], count = 3) {
  const unique = [...new Set(results.map((result) => result.domain))]
  return unique.length > count
    ? `${unique.slice(0, count).join(', ')} +${unique.length - count}`
    : unique.join(', ')
}

function Search({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const details = call.details as Details | undefined
  const failure = details?.status === 'error' ? details : undefined
  const results = details?.status === 'success' ? details.results : []
  const unresponsive = details?.status === 'success' ? details.unresponsive : []
  const query = text(call.args.query)
  // Collapsed while it goes well; a failure opens it, also one that arrives live.
  const failed = call.status === 'error' || !!failure
  const [open, setOpen] = useState(failed)
  const was = useRef(failed)
  useEffect(() => {
    if (failed && !was.current) setOpen(true)
    was.current = failed
  }, [failed])
  return (
    <Tool onOpenChange={setOpen} open={open}>
      <ToolHeader
        meta={
          <>
            {unresponsive.length > 0 && (
              <span className="text-warning">{plural(unresponsive.length, 'engine')} down</span>
            )}
            {details?.status === 'success' && <span>{plural(results.length, 'result')}</span>}
            {duration && <span>{duration}</span>}
          </>
        }
        name="web_search"
        state={call.status}
        title={
          <>
            <span className="text-foreground/90">{query}</span>
            {results.length > 0 && (
              <span className="text-muted-foreground/60"> · {domains(results)}</span>
            )}
          </>
        }
      />
      <ToolContent>
        {call.status === 'running' && (
          <ToolSection>
            <Shimmer className="text-[12px]">searching the web…</Shimmer>
          </ToolSection>
        )}
        {failure ? (
          <ToolSection>
            <div className="break-words text-error">{failure.error}</div>
            {failure.httpStatus && (
              <div className="text-[11px] text-muted-foreground/70">HTTP {failure.httpStatus}</div>
            )}
          </ToolSection>
        ) : details ? (
          <>
            {results.length > 0 && (
              <ol aria-label="Search results" className="divide-y divide-border/60">
                {results.map((result, index) => (
                  <li className="flex gap-2.5 px-2.5 py-2" key={index}>
                    <span className="w-4 shrink-0 text-right text-muted-foreground/60 tabular-nums">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <a
                        className="block truncate font-sans text-[13px] text-foreground hover:underline"
                        href={result.url}
                        rel="noreferrer"
                        target="_blank"
                        title={result.url}
                      >
                        {result.title || bare(result.url)}
                      </a>
                      <div className="mt-0.5 flex min-w-0 gap-2 text-[11px] text-muted-foreground">
                        <span className="truncate">{result.domain}</span>
                        {result.publishedDate && (
                          <span className="shrink-0 text-muted-foreground/70">
                            {day(result.publishedDate)}
                          </span>
                        )}
                      </div>
                      {result.snippet && (
                        <p className="mt-1 line-clamp-3 font-sans text-[12.5px] leading-snug text-muted-foreground">
                          {result.snippet}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {details.status === 'success' && results.length === 0 && (
              <ToolSection className="text-muted-foreground/70">no results</ToolSection>
            )}
            {unresponsive.length > 0 && (
              <ToolSection className="border-t border-border/60 text-[11.5px]">
                {unresponsive.map((engine, index) => (
                  <div
                    className="flex min-w-0 gap-1.5 text-warning"
                    key={`${engine.engine}:${index}`}
                  >
                    <span className="shrink-0">!</span>
                    <span className="min-w-0 break-words">
                      {engine.engine}: {engine.message}
                    </span>
                  </div>
                ))}
              </ToolSection>
            )}
          </>
        ) : (
          call.status === 'error' && <ToolOutput isError output={call.output} />
        )}
        <ToolDiagnostics
          diagnostics={call.diagnostics.filter((item) => item.code !== 'tool_error')}
        />
      </ToolContent>
    </Tool>
  )
}

export default defineWebExtension({ tools: { web_search: Search } })
