# mirastyle-compaction

A Pi compaction extension that replaces the default session summary with a structured engineering handoff checkpoint. It is designed for coding sessions where continuity across context windows matters more than conversational narrative.

## What it does

When Pi triggers compaction, this extension intercepts the `session_before_compact` event and generates a detailed checkpoint instead of Pi's default summary. The checkpoint captures file state, decisions, failures, work status, and open threads in a fixed structure so that the next agent instance can resume without reconstructing context from scattered conversation history.

Pi's core compaction mechanics are unchanged: the latest `CompactionEntry` summary is injected before the retained recent messages. This extension only changes what goes into that summary.

## How it works

### Prompt construction

The extension builds a prompt for a summarizer model containing:

- **Previous checkpoint** (`<previous_checkpoint>`): If a prior compaction exists, its full body is included as frozen historical state to be evolved. On the first compaction, this section states that no previous checkpoint exists.
- **Custom instructions** (`<user_compaction_instructions>`): If the user provided `/compact ...` instructions, they are included with explicit high-priority framing. Omitted entirely if none were given.
- **Deterministic metadata** (`<deterministic_metadata>`): Session file path, token count at compaction, split-turn flag, read-only files, modified files, git snapshot (branch, scoped status, scoped diff stat), and retained message count. Git fields are omitted when there is no repository.
- **New history** (`<new_history_to_compact>`): All session entries since the last compaction boundary, serialized with entry IDs and `valid_cutpoint` flags. Only entries that will be replaced by this checkpoint go here.
- **Split turn prefix** (`<split_turn_prefix>`): If the compaction splits a turn mid-sequence, the prefix portion is included separately.
- **Retained recent context** (`<kept_recent_context>`): Messages starting at Pi's default fallback `firstKeptEntryId`, included as boundary evidence. The summarizer uses these to compute accurate current-state sections but should not recap them verbatim unless they fall before the recommended cut point.

Each session entry is wrapped in `<session_entry>` tags with attributes: `id`, `type`, `role`, and `valid_cutpoint`. Entries marked `valid_cutpoint="true"` are eligible as cut points (user messages, assistant messages, bash executions, custom messages, branch summaries). Tool results are never valid cut points.

### Summarizer selection

The extension resolves which model to use in this order:

1. A configured provider/model via `--mirastyle-compaction-provider` and `--mirastyle-compaction-model` flags (or hardcoded defaults). Requires both provider and model ID.
2. The active session model as a fallback.
3. If neither can authenticate, returns nothing so Pi's default compaction runs.

The configured model does not require a separate API key beyond what Pi already has; if Pi's auth succeeds for the model, the extension uses it.

### Cut-point strategy

The summarizer selects which entry should remain as the first verbatim message after compaction. This is the most significant departure from Pi's default behavior, which uses a fixed algorithmic cut point.

The extension presents all valid cut-point candidates to the summarizer and asks it to choose one. The strategy favors:

- **User messages** as cut points, because they give the next agent a concrete task. An assistant-only tail provides almost no usable context.
- **At least one coherent interaction unit**: a user request and its response, or the start of a new action. Orphaned tool results or completion confirmations are avoided.
- **Earlier cuts between tasks**, since routine reads, greps, and edits are safe to summarize — their outcomes live in the filesystem and the checkpoint itself.
- **Later cuts mid-task**, keeping the active instruction and any partial results needed to finish the current stride.

After the summarizer recommends a cut point, the extension validates it:

- The ID must be one presented in the prompt and marked `valid_cutpoint="true"`.
- The retained tokens from that point onward must not exceed 15,000 estimated tokens. If they do, the extension finds the nearest valid cut point within the cap and uses that instead, prepending a `CUTPOINT ADJUSTMENT NOTE` to the checkpoint body explaining the adjustment.
- If validation fails entirely, the extension falls back to Pi's default `firstKeptEntryId`.

### Checkpoint structure

The output is an engineering handoff document with these required sections:

| Section | Purpose |
|---|---|
| STATE AT COMPACTION BOUNDARY | Active task, most recent user request, implementation state, context needed to continue |
| EVIDENCE TIERS | Verified facts, user-stated requirements, assistant inferences — separated by confidence level |
| CODE REFERENCES | File paths, symbols, config keys, error messages — lookup strings only, no narrative |
| DECISIONS AND RATIONALE | Decisions made, why, and alternatives ruled out |
| COMMANDS, TESTS, AND FAILURES | Commands run, tests executed, current failures, pending validation |
| WORK QUEUE | Completed items, in-progress work, next exact edits, blockers, risks |
| OPEN THREADS | Unresolved requests, pending actions, open questions |
| COMPACTED HISTORY SYNOPSIS | One paragraph describing the arc of the session — broad orientation, not specific details |

The entire body is wrapped in `<pi:mirastyle_compacted_coding_context>` XML tags with metadata attributes (`compacted_at`, `first_kept_entry_id`, `tokens_before`).

### Iterative checkpoints

When multiple compacting events occur in a session, each new checkpoint evolves the previous one. The summarizer receives the prior checkpoint as frozen historical state and integrates new history into it, preserving still-relevant facts while updating completed/pending work based on newer evidence. Stale claims like "plan not implemented" are corrected if later entries show otherwise.

### Git integration

If the working directory is inside a git repository, the extension captures a scoped git snapshot using only the file paths touched during the session (read, written, edited). It normalizes paths relative to the git root using two-base resolution: first trying relative-to-cwd, then falling back to relative-to-git-root directly. This handles cases where the model uses paths relative to the project root while `ctx.cwd` points elsewhere.

The snapshot includes branch name, `git status --short`, and `git diff --stat` limited to those pathspecs. Repo-wide status is intentionally omitted to avoid noise from unrelated changes. If path resolution fails, the failure is reported rather than silently omitting the data.

## Differences from Pi's built-in compaction

| Aspect | Pi default | mirastyle-compaction |
|---|---|---|
| Summary format | Conversational narrative | Structured engineering handoff with fixed sections |
| Cut point | Fixed algorithmic position | Model-selected, validated against token cap |
| Prior summary handling | Not carried forward | Previous checkpoint included as frozen state to evolve |
| File tracking | Basic read/modified lists | Separated into compacted vs. retained file ops, plus scoped git snapshot |
| Custom instructions | No mechanism | `/compact ...` instructions gated and prominently framed |
| Retained context reference | Not exposed to summarizer | Included as boundary evidence with explicit guidance on how to use it |
| Fallback behavior | Always produces a summary | Falls back to Pi default only when summarizer auth fails or returns empty |

## Configuration

Set via command-line flags when starting Pi:

```
--mirastyle-compaction-provider=anthropic
--mirastyle-compaction-model=claude-sonnet-4-20250514
```

Both flags are required together. If neither is set, the extension uses the active session model. If both are set but the configured model cannot authenticate, it falls back to the active model.

Custom compaction instructions can be provided per-session via the `/compact` command. These are included in the prompt with high-priority framing and affect what the summarizer emphasizes and preserves.

## Constants

| Constant | Value | Description |
|---|---|---|
| `MAX_SUMMARY_OUTPUT_TOKENS` | 12,000 | Maximum output tokens for the summarizer response |
| `GIT_COMMAND_TIMEOUT_MS` | 5,000 | Timeout for individual git commands |
| `MAX_GIT_FIELD_CHARS` | 4,000 | Maximum characters for git status/diff fields before truncation |
| `MAX_RETAINED_CONTEXT_REFERENCE_CHARS` | 80,000 | Maximum characters for the retained context reference; excess is trimmed from the middle |
| `MAX_MODEL_SELECTED_RETAINED_TOKENS` | 15,000 | Token cap for the model-selected cut point; exceeded cuts are capped to the nearest valid candidate |
