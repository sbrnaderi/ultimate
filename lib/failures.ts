import { AssistantEntry } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, EntryId, EntryRecord, Tx } from '@earendil-works/pi-durable'
import type { AssistantMessage } from '@earendil-works/pi-ai'

/**
 * The first entry at or after `from` whose assistant message ended with a provider error, the record a failed run
 * left in its conversation. Page by page, ascending, like a report reads a run's tail.
 */
export async function failedTurn(
  tx: Tx,
  conversationId: ConversationId,
  from: EntryId,
): Promise<EntryRecord | undefined> {
  let cursor: Cursor | undefined
  for (;;) {
    const page = await tx.scanEntries(
      { conversationId, minEntryId: from, order: 'ascending' },
      500,
      cursor,
    )
    const failure = page.items.find(
      (entry) =>
        entry.kind === AssistantEntry.kind &&
        entry.model?.[0]?.role === 'assistant' &&
        entry.model[0].stopReason === 'error',
    )
    if (failure) return failure
    if (page.next === undefined) return undefined
    cursor = page.next
  }
}

/** How much of a provider's own message a failure sentence carries. */
const ERROR_CHARS = 160

/**
 * The sentence for a run that ended without an answer, shared by board replies and subagent reports. `reason` is how
 * the run settled (a submission reason such as `model_error`, or the message's own stopReason); `failure`, when the
 * failed call is known, adds its model and the provider's message, so a dead provider reads differently from a flaky
 * agent: `ended its turn without an answer (model_error · huggingface/x · 402 "…")`.
 */
export function failureSentence(reason: string | undefined, failure?: AssistantMessage): string {
  const why =
    reason ??
    (failure?.stopReason === 'aborted' || failure?.stopReason === 'error'
      ? failure.stopReason
      : undefined)
  if (failure?.stopReason !== 'error')
    return `ended its turn without an answer${why ? ` (${why})` : ''}`
  // A submission that settled `done` on an error turn says nothing about why: the failure itself does.
  const cause = why === undefined || why === 'done' ? 'error' : why
  const error = failure.errorMessage?.replace(/\s+/g, ' ').trim()
  const detail = `${failure.provider}/${failure.model}${
    error ? ` · ${error.length > ERROR_CHARS ? `${error.slice(0, ERROR_CHARS - 1)}…` : error}` : ''
  }`
  return `ended its turn without an answer (${cause} · ${detail})`
}
