# mirastyle-compaction

A Pi compaction extension that replaces the default session summary with a structured engineering handoff checkpoint. It is designed for coding sessions where continuity across context windows matters more than conversational narrative.

The design is a port of the improved compaction handoff built into [picloud](https://github.com/taylorsatula/picloud), adapted to normal Pi (where the extension controls the cut point exactly). Its principles:

1. **Ground truth over memory.** Everything code can recompute (repository state, files read and modified, the person's words verbatim) is computed by code at compaction time and rendered into the checkpoint unchanged. The model never restates it.
2. **The person's words are never paraphrased.** Every user message is carried verbatim into every checkpoint.
3. **Accumulate; don't re-summarize.** The summarizer's working state is chained through compaction `details`; each checkpoint evolves the previous one. Code-owned facts are never summarized at all.
4. **Lead with the resume point.** The agent's own first-person handoff note stays verbatim in the kept runway, right before the resume message.
5. **Keep negative knowledge.** Failures, decisions and ruled-out alternatives live in the working state, not in a log nobody re-reads.
6. **Point, don't paste.** Large tool results the agent no longer needs verbatim are condensed into one-line pointers; `recall_history` reads the originals.
7. **Make loss recoverable.** `recall_history` searches and reads the full pre-compaction history.
8. **Verify before trusting.** "Before you act" tells the agent to re-establish ground truth before acting on the checkpoint.
9. **Never strand the run.** If the summarizer fails, the previous working state is carried forward with a note and a usable checkpoint is still produced. The run always continues.
10. **Degrade in a fixed order.** The code-owned part has a budget (10% of the model's window) and sheds file/commit lists oldest-first over it. The person's words, the session and repository state, and the working state are never shed.
11. **Size relative to the model.** Thresholds and budgets are proportions of the model's context window.

## What it does

Pi's core compaction mechanics are unchanged: the latest `CompactionEntry` summary is injected before the retained recent messages. This extension changes what goes into that summary, who writes it, and what happens around it:

### The handoff cycle

When the session's context passes **60% of the model's window** (and is below Pi's own threshold compaction at ~75%), the extension steers the agent once per cycle:

1. The agent is steered (as a custom message, not your words) to call **`write_handoff`** with a short first-person note: what it is doing, what it just learned, its exact next step, and what it is unsure of or watching for (about 300 words).
2. When the run next settles, the extension compacts at the `agent_before_settle` boundary: the summarizer chooses the cut, the checkpoint is built, the condense edits are applied, and a resume message ("The context window has just been compacted. Please resume with what you were doing.") is appended — the agent continues on its own. A compaction never needs you and never ends the run.
3. If the agent ignores the steer, the compaction happens anyway, without the note. If you abort the run, no compaction and no resume happen.

The agent's note stays verbatim in the kept runway, right before the resume message, and the summarizer reads it too.

### Two compaction paths

- **This extension's cycle** (above): the boundary commit is atomic — the compaction entry, any condense edits and the resume message are appended together at the point the run settles, with the exact cut the summarizer chose. Pi's own threshold compaction stays on as a backstop (and still gets our checkpoint through `session_before_compact`).
- **Pi-initiated compaction** (`/compact`, threshold, overflow): `session_before_compact` builds the same checkpoint. Manual `/compact` does **not** auto-resume; our own cycle does. Condense edits are applied as append-only context edits at the next turn boundary.

### The checkpoint

The output is an engineering handoff document. The **code-owned** part (computed by the extension, never by the model) comes first:

| Section | Contents |
|---|---|
| Before you act | Re-establish ground truth (`git status`, `git log`), re-read files before editing, don't redo finished work, use `recall_history` |
| The person's words, verbatim | Every user message, oldest first, in triple-quoted blocks — never paraphrased, never shed |
| Session | Session file, working directory, context at compaction, split-turn flag, checkpoint number |
| Repository, computed at compaction | Branch, HEAD, ahead/behind vs `origin/HEAD` (or `origin/master`/`origin/main`), uncommitted changes, commits since the last compaction (or the most recent 15), files changed vs the merge base with stats |
| Files you read and modified | Full session totals from the file tools, compacted vs retained split also tracked in `details` |
| Working state, written at compaction | **The only model-written part.** The eight sections below, or the previous working state carried forward with a note |
| Recovery | The cut point, the compacted entry range, a pointer to `recall_history` and the session file |

The **working state** is the eight fixed sections: STATE AT COMPACTION BOUNDARY, EVIDENCE TIERS, CODE REFERENCES, DECISIONS AND RATIONALE, COMMANDS/TESTS/FAILURES, WORK QUEUE, OPEN THREADS, COMPACTED HISTORY SYNOPSIS.

The entire body is wrapped in `<pi:mirastyle_compacted_coding_context>` XML tags with metadata attributes (`compacted_at`, `first_kept_entry_id`, `tokens_before`). The raw working state is also stored in the compaction entry's `details` (`workingState`), which is what a later compaction evolves — so a failed summarizer never loses the previous working state.

### Budget and shed order

The code-owned part fits a budget of **10% of the model's context window** (estimated at 4 chars/token). Over it, lists are shed (from the end, i.e. the oldest commits/files listed) in this fixed order:

1. Files read
2. Files modified
3. Changed files (vs merge base)
4. Commits

Each shed list gets a note (`(N older … left out to fit; recall_history and git recover them)`). The person's words, session and repository state, and the working state are never shed; the working state is bounded only by the summarizer's output limit.

## Prompt construction

The summarizer receives:

- **Previous checkpoint** (`<previous_checkpoint>`): the previous working state (chained via `details.workingState`), treated as frozen history to evolve.
- **Custom instructions** (`<user_compaction_instructions>`): from `/compact ...`, with explicit high-priority framing. Omitted if none.
- **Computed facts** (`<computed_facts>`): everything in the code-owned checkpoint, in full — the model relies on it and must not restate it.
- **Agent handoff** (`<agent_handoff>`): the agent's note, when present.
- **New history** (`<new_history_to_compact>`): entries since the last compaction boundary, serialized with `<entry>` tags (`id`, `type`, `role`). Each message over 4,000 chars / tool result over 1,500 chars is clipped head-and-tail with a `recall_history` pointer. If the budget is exceeded, the oldest entries are dropped first (with a note).
- **Split turn prefix** (`<split_turn_prefix>`): when the compaction splits a turn.
- **Kept recent context** (`<kept_recent_context>`): the entries from the fallback kept point, as boundary evidence, marked `valid_cutpoint="true|false"`. The display is trimmed from the middle when over budget; only the valid cuts actually shown count as presented.

Entries are never valid cut points if they are tool results, `context_edit` entries, or other bookkeeping entries (user messages, assistant messages, bash executions, custom messages, branch summaries are valid).

## Cut-point strategy

The summarizer selects which entry remains as the first verbatim message after compaction, choosing an ID marked `valid_cutpoint="true"` in the kept context. The strategy favors:

- **User messages** as cut points — they give the next agent a concrete task.
- **At least one coherent interaction unit**: a request and its response, or the start of a new action.
- **Earlier cuts between tasks**; routine reads and greps are safe to summarize.
- **Later cuts mid-task**, keeping the active instruction and partial results.

Validation:

- The cut must be one presented to the summarizer and marked valid.
- Retained tokens from that point onward must not exceed **15,000** (estimated, counting condensed replacements). If exceeded, the nearest valid cut within the cap is used instead, with a `CUTPOINT ADJUSTMENT NOTE` in the checkpoint.
- Otherwise, the extension falls back to Pi's default `firstKeptEntryId`, also with a note.

## Tools the extension registers

### `recall_history`

Search or read the session's full history, **including everything compacted away**. Give `query` (words that must all appear — a file name, an error, a number) to find entries, or `entry` (an entry ID from a search or a checkpoint) to read one in full. Matches are newest first; snippets are 240 characters; an entry read is capped at 20,000 characters.

### `write_handoff`

Only useful when the extension steers the agent just before compaction. Saves a short first-person note (max 2,000 characters) that stays verbatim in the context after the compaction. Outside a compaction cycle, calling it is harmless.

## Summarizer selection

1. `--mirastyle-compaction-provider` + `--mirastyle-compaction-model` (both required together; or the hardcoded defaults).
2. The active session model as fallback.
3. If neither can authenticate, the extension returns nothing for `session_before_compact` so Pi's default compaction runs (our own cycle still settles normally).

If the summarizer returns an unusable reply or errors out, the extension does **not** fall back to Pi default: it produces the checkpoint anyway, carrying the previous working state forward with a note that it was not updated. Only the absence of any usable model takes the Pi-default path.

If the compaction's abort signal fires mid-summarizer, the compaction is cancelled cleanly (`cancel: true`).

## Failure handling

| Failure | Outcome |
|---|---|
| No model at all | `session_before_compact` returns nothing → Pi default compaction; our cycle skips the boundary |
| Summarizer errors / unusable reply | Checkpoint still produced; previous working state carried forward with a note; cut falls back to Pi's default |
| Summarizer recommends an unknown/invalid cut | Pi's default cut, with a note |
| Recommended cut over the 15k token cap | Nearest valid cut within the cap (`model-capped`), with a note |
| Condense target is not a kept tool result, or cut passes it | Kept verbatim, with a note |
| Pi's own threshold compaction fires before our cycle | Same checkpoint written through `session_before_compact`; Pi's compaction wins; no auto-resume |
| Person aborts the run | No compaction, no resume |

## Differences from Pi's built-in compaction

| Aspect | Pi default | mirastyle-compaction |
|---|---|---|
| Summary format | Conversational narrative | Code-computed facts + model-written working state, fixed sections |
| Cut point | Fixed algorithmic position | Model-selected, validated against token cap |
| Prior summary handling | Not carried forward | Previous working state chained through `details` (not re-summarized) |
| Ground truth | Not computed | Repository/HEAD/ahead-behind/uncommitted/commits/files computed by code |
| Person's words | Not carried | Verbatim in every checkpoint, never shed |
| Compaction timing | Pi's threshold | Extension steers at ~60% (below 75% backstop), compacts at settle, resumes automatically |
| Post-compaction | Nothing | Agent is prompted to resume automatically |
| Context trimming | None | Kept tool results may be condensed to one-line pointers (append-only context edits) |
| History recovery | Not provided | `recall_history` searches and reads the full history |
| Failure behavior | Always produces a summary | Code-built checkpoint even when the summarizer fails |

## Configuration

```
--mirastyle-compaction-provider=anthropic
--mirastyle-compaction-model=claude-sonnet-4-20250514
```

Custom compaction instructions via `/compact ...` are included with high-priority framing in the summarizer prompt.

## Constants

| Constant | Value | Description |
|---|---|---|
| `MAX_SUMMARY_OUTPUT_TOKENS` | 12,000 | Maximum output tokens for the summarizer response |
| `MAX_MODEL_SELECTED_RETAINED_TOKENS` | 15,000 | Token cap for the model-selected cut point (condensed replacements counted) |
| `HANDOFF_TRIGGER` | 0.6 | Share of the model's window at which the handoff note is requested |
| `BACKGROUND_TRIGGER` | 0.75 | At/above this share, Pi's own compaction is left in charge |
| `FACTS_SHARE` | 0.1 | Share of the window for the code-owned checkpoint part (sheds file/commit lists beyond it) |
| `PROMPT_SHARE` | 0.6 | Max share of the summarizer model's window for its input |
| `TOOL_RESULT_CHARS` | 1,500 | Clip for tool results in what the summarizer sees |
| `MESSAGE_CHARS` | 4,000 | Clip for messages in what the summarizer sees |
| `MAX_HANDOFF_CHARS` | 2,000 | Max size of `write_handoff` notes |
| `GIT_COMMAND_TIMEOUT_MS` | 5,000 | Timeout for individual git commands |
| `RECALL_MATCHES` / `RECALL_SNIPPET` / `MAX_ENTRY_TEXT` | 8 / 240 / 20,000 | `recall_history` match count, snippet size, entry read cap |

## Recovery

Every checkpoint records: the cut entry, the compacted entry range, and where the session file lives. Everything compacted away is one `recall_history` query away — for example `recall_history("error TS2345")` or `recall_history("src/theme.ts")`. The raw history is never deleted.
