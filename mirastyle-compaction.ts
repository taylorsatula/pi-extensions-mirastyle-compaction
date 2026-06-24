/**
 * Mira-style Coding Compaction Extension
 *
 * Replaces Pi's default compaction summary with a coding-oriented engineering
 * handoff checkpoint. Pi's core compaction mechanics remain unchanged: the
 * latest CompactionEntry summary is injected before kept recent messages.
 *
 * Configuration:
 * - Edit DEFAULT_SUMMARIZER_PROVIDER / DEFAULT_SUMMARIZER_MODEL_ID below, or
 * - Start Pi with --mirastyle-compaction-provider and --mirastyle-compaction-model.
 *
 * If the configured summarizer cannot be used, the extension falls back to the
 * active session model. If that also fails, it returns nothing so Pi's default
 * compaction runs.
 */

import { isAbsolute, relative, resolve as resolveFsPath } from "node:path";
import { complete } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	estimateTokens,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";

const EXTENSION_NAME = "mirastyle-compaction";
const SUMMARY_VERSION = 1;

// Leave blank to use the active session model by default.
const DEFAULT_SUMMARIZER_PROVIDER = "";
const DEFAULT_SUMMARIZER_MODEL_ID = "";

const MAX_SUMMARY_OUTPUT_TOKENS = 12_000;
const GIT_COMMAND_TIMEOUT_MS = 5_000;
const MAX_GIT_FIELD_CHARS = 4_000;
const MAX_RETAINED_CONTEXT_REFERENCE_CHARS = 80_000;
const MAX_MODEL_SELECTED_RETAINED_TOKENS = 15_000;

interface GitSnapshot {
	isGitRepo: boolean;
	branch: string;
	statusShort: string;
	diffStat: string;
	scope: string;
	pathspecCount: number;
}

interface FileOps {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

type SummarizerSelectionReason = "configured" | "active-model-fallback";

type CustomContextMessage = {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: unknown;
	timestamp: number;
};

type BranchSummaryContextMessage = {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
};

interface SelectedSummarizer {
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	selectionReason: SummarizerSelectionReason;
}

interface CutpointSelectionDetails {
	defaultFirstKeptEntryId: string;
	selectedFirstKeptEntryId: string;
	recommendedFirstKeptEntryId?: string;
	selectionReason: "model" | "model-capped" | "fallback";
	validationMessage: string;
}

interface MirastyleCompactionDetails {
	extension: typeof EXTENSION_NAME;
	version: number;
	generatedAt: string;
	readFiles: string[];
	modifiedFiles: string[];
	compactedReadFiles: string[];
	compactedModifiedFiles: string[];
	retainedReadFiles: string[];
	retainedModifiedFiles: string[];
	retainedMessageCount: number;
	retainedReferenceChars: number;
	model: {
		provider: string;
		id: string;
		selectionReason: SummarizerSelectionReason;
	};
	git: GitSnapshot;
	cutpoint: CutpointSelectionDetails;
}

const SYSTEM_PROMPT = `You are a coding-session compaction engine.

Your output is not a chat response. Your output is the body of an engineering handoff checkpoint that another coding agent will use after older context has been removed.

Think of the coding session like a hurdle race. The checkpoint records the race so far: what was attempted, what was decided, what changed, and why. The retained verbatim messages are the runner's short runway into the next hurdle: just enough live context for the next agent to regain stride and continue without replaying the whole race.

Core rules:
- Produce one complete successor checkpoint body, not a delta.
- If <previous_checkpoint> is present, treat it as frozen historical state and evolve it with <new_history_to_compact>, <split_turn_prefix>, and <kept_recent_context>.
- Preserve still-relevant prior facts from the previous checkpoint.
- Fully integrate all entries that will be before your recommended cut point; those entries are being replaced by this checkpoint.
- Use <kept_recent_context> as default boundary evidence. The actual preserved verbatim range depends on your recommended cut point, so do not recap messages you recommend keeping verbatim, but do integrate any messages that fall before your recommended cut point.
- STATE AT COMPACTION BOUNDARY, WORK QUEUE, OPEN THREADS, and Required validation still pending must reflect the newest evidence in <kept_recent_context>, not only the older compacted history.
- If <kept_recent_context> shows that an implementation was written, tests were run, or a decision changed, do not leave stale prior claims like "plan not implemented" or "next edit is to create the file".
- Update completed/pending work based on newer compacted and retained history.
- Remove only facts contradicted by newer evidence, current deterministic metadata, or explicit user correction.
- Current filesystem state and later visible messages will be more authoritative than this checkpoint.
- Separate verified facts, user-stated requirements, and assistant inferences.
- Do not invent file contents, test results, commands, decisions, preferences, or failures.
- Do not list every tool call verbatim — coding sessions may contain hundreds of routine reads, greps, and edits — but include substantive tool activity: exact commands/tests and outcomes, failures, important output/error snippets, file sets, decisions, and plan-changing observations. Err on the side of inclusion; the checkpoint is an engineering handoff, not a log.
- Preserve exact file paths, symbols, function/class/type names, config keys, commands, error messages, test names, IDs, and user wording when important.
- Prefer bounded historical phrasing: "During the compacted range", "At the compaction boundary", "As of this checkpoint".
- Do not say timeless-present claims like "the user wants" unless bounded to this checkpoint.
- Be dense and continuation-oriented. No praise, greetings, narrative filler, or generic project-management prose.
- Begin with the required cut-point decision block, then output plain text exactly matching the requested checkpoint section structure. Do not use a code fence. Do not include wrapper XML tags except the required cut-point decision block.
- Session entries are annotated with entry IDs and valid_cutpoint flags. Before writing the checkpoint body, decide the first entry ID that should remain verbatim after compaction.
- The recommended cut point is the earliest entry to keep live in the future context, not the last entry to summarize.
- Choose only an entry marked valid_cutpoint="true". Never choose a tool result or non-message bookkeeping entry.

Cut-point strategy:
- The checkpoint summary captures the full history — decisions, rationale, file state, and completed work. Retained verbatim messages exist solely to give the next agent a live starting point, not to re-enact old work.
- Aim for a user message as the cut point. A user request gives the next agent a concrete task to act on. An assistant-only tail (e.g. a lone "Done." with no preceding request) provides almost no usable context.
- Keep at least one coherent interaction unit: a user request and its response, or the start of a new action. Do not leave the next agent staring at an orphaned tool result or completion confirmation.
- Avoid splitting a multi-step tool-call sequence. If the last compacted-away entry is mid-sequence, push the cut point forward to include the full turn.
- Routine reads, greps, edits, and their tool results are safe to summarize — their outcomes live in the filesystem and checkpoint sections. You do not need to retain them verbatim.
- Between tasks, you can cut earlier. Mid-task, keep the active instruction and any partial results or errors needed to finish the current stride.
- Include one concise reasoning sentence in the cut-point decision block explaining why that spot positions the agent to continue.
- The extension may cap the retained token count; write the checkpoint body as if your recommendation will be honored.

Output must start with exactly this decision block:

<cutpoint_decision>
<recommended_cut_before_entry_id>ENTRY_ID</recommended_cut_before_entry_id>
<cutpoint_reasoning>One sentence explaining why this cut point preserves continuity better than nearby alternatives.</cutpoint_reasoning>
</cutpoint_decision>

Then output all of the following sections. Every section must be present — fill each with relevant content from the session, even if brief:

STATE AT COMPACTION BOUNDARY:
- Active task:
- Most recent user request:
- Current implementation state:
- Context needed to continue:

EVIDENCE TIERS:
- Verified from session/tool history:
- User-stated requirements:
- Assistant-inferred implementation implications:

CODE REFERENCES:
- Files and paths:
- Symbols/classes/functions/types:
- Config keys, constants, settings, and identifiers:
- Verbatim error messages, command lines, and test names (lookup strings only; do not narrate context — that belongs in COMMANDS, TESTS, AND FAILURES):

DECISIONS AND RATIONALE:
- Decisions made:
- Rationale:
- Things ruled out:

COMMANDS, TESTS, AND FAILURES:
- Commands run:
- Tests run:
- Current failures:
- Required validation still pending:

WORK QUEUE:
- Completed:
- In progress:
- Next exact edits:
- Blockers:
- Risks:

OPEN THREADS:
- Unresolved user requests:
- Pending assistant actions:
- Open questions:

COMPACTED HISTORY SYNOPSIS:
One paragraph providing broad narrative orientation: the arc of the session, major pivots, and how work arrived at its current state. Operate at the level of "what kind of work happened and why did the approach change," not "what specific values were used." Do not restate file paths, exact measurements, thresholds, slide counts, config values, class names, or other concrete details already captured in the structured sections above — those sections are the single source for specifics. This section exists so a continuing agent can quickly understand the shape and trajectory of the session without reading every field.`;

function notifyUi(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	}
}

function stringFlag(pi: ExtensionAPI, name: string): string {
	const value = pi.getFlag(name);
	return typeof value === "string" ? value.trim() : "";
}

function sortedUnique(values: Iterable<string>): string[] {
	return [...new Set([...values].filter((value) => value.trim().length > 0))].sort();
}

function createFileOps(): FileOps {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

function mergeFileOps(target: FileOps, source: FileOps): void {
	for (const file of source.read) target.read.add(file);
	for (const file of source.written) target.written.add(file);
	for (const file of source.edited) target.edited.add(file);
}

function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOps): void {
	if (message.role !== "assistant" || !Array.isArray(message.content)) {
		return;
	}
	for (const block of message.content) {
		if (typeof block !== "object" || block === null || block.type !== "toolCall") {
			continue;
		}
		const path = typeof block.arguments?.path === "string" ? block.arguments.path : undefined;
		if (!path) {
			continue;
		}
		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

function computeFileLists(fileOps: FileOps): {
	readFiles: string[];
	modifiedFiles: string[];
} {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readFiles = sortedUnique([...fileOps.read].filter((file) => !modified.has(file)));
	const modifiedFiles = sortedUnique(modified);
	return { readFiles, modifiedFiles };
}

function truncateDisplayField(text: string, maxChars: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) {
		return trimmed;
	}
	return `${trimmed.slice(0, maxChars)}\n[truncated ${trimmed.length - maxChars} chars]`;
}

function formatBulletList(items: string[]): string {
	if (items.length === 0) {
		return "  - None captured.";
	}
	return items.map((item) => `  - ${item}`).join("\n");
}

function serializeAgentMessages(messages: AgentMessage[]): string {
	if (messages.length === 0) {
		return "None captured.";
	}
	return serializeConversation(convertToLlm(messages));
}

function timestampMillis(timestamp: string): number {
	const parsed = new Date(timestamp).getTime();
	return Number.isNaN(parsed) ? Date.now() : parsed;
}

function createCustomContextMessage(entry: Extract<SessionEntry, { type: "custom_message" }>): CustomContextMessage {
	return {
		role: "custom",
		customType: entry.customType,
		content: entry.content,
		display: entry.display,
		details: entry.details,
		timestamp: timestampMillis(entry.timestamp),
	};
}

function createBranchSummaryContextMessage(
	entry: Extract<SessionEntry, { type: "branch_summary" }>,
): BranchSummaryContextMessage {
	return {
		role: "branchSummary",
		summary: entry.summary,
		fromId: entry.fromId,
		timestamp: timestampMillis(entry.timestamp),
	};
}

function messageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomContextMessage(entry);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryContextMessage(entry);
	}
	return undefined;
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function entryRoleLabel(entry: SessionEntry): string {
	if (entry.type === "message") {
		return entry.message.role;
	}
	return entry.type;
}

function isValidCutpointEntry(entry: SessionEntry): boolean {
	if (entry.type === "branch_summary" || entry.type === "custom_message") {
		return true;
	}
	if (entry.type !== "message") {
		return false;
	}
	switch (entry.message.role) {
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
		case "user":
		case "assistant":
			return true;
		case "toolResult":
			return false;
	}
	return false;
}

function findPreviousCompactionIndex(entries: SessionEntry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return i;
		}
	}
	return -1;
}

function findEntryIndexById(entries: SessionEntry[], entryId: string): number {
	return entries.findIndex((entry) => entry.id === entryId);
}

function getBoundaryStartIndex(entries: SessionEntry[]): number {
	const prevCompactionIndex = findPreviousCompactionIndex(entries);
	if (prevCompactionIndex < 0) {
		return 0;
	}
	const prevCompaction = entries[prevCompactionIndex];
	if (prevCompaction.type !== "compaction") {
		return prevCompactionIndex + 1;
	}
	const firstKeptEntryIndex = findEntryIndexById(entries, prevCompaction.firstKeptEntryId);
	return firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
}

function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "bashExecution")) {
			return i;
		}
	}
	return -1;
}

function getPreparedEntryRanges(
	branchEntries: SessionEntry[],
	defaultFirstKeptEntryId: string,
	isSplitTurn: boolean,
): {
	newHistoryEntries: SessionEntry[];
	turnPrefixEntries: SessionEntry[];
	retainedEntries: SessionEntry[];
} {
	const boundaryStart = getBoundaryStartIndex(branchEntries);
	const firstKeptIndex = findEntryIndexById(branchEntries, defaultFirstKeptEntryId);
	if (firstKeptIndex < 0) {
		return {
			newHistoryEntries: [],
			turnPrefixEntries: [],
			retainedEntries: [],
		};
	}
	const turnStartIndex = isSplitTurn ? findTurnStartIndex(branchEntries, firstKeptIndex, boundaryStart) : -1;
	const historyEndIndex = turnStartIndex >= 0 ? turnStartIndex : firstKeptIndex;
	return {
		newHistoryEntries: branchEntries.slice(boundaryStart, historyEndIndex),
		turnPrefixEntries: turnStartIndex >= 0 ? branchEntries.slice(turnStartIndex, firstKeptIndex) : [],
		retainedEntries: branchEntries.slice(firstKeptIndex),
	};
}

function serializeEntriesWithIds(entries: SessionEntry[]): string {
	const serializedEntries: string[] = [];
	for (const entry of entries) {
		const message = messageFromEntry(entry);
		if (!message) {
			continue;
		}
		serializedEntries.push(
			`<session_entry id="${escapeXmlAttribute(entry.id)}" type="${escapeXmlAttribute(entry.type)}" role="${escapeXmlAttribute(entryRoleLabel(entry))}" valid_cutpoint="${isValidCutpointEntry(entry)}">\n${serializeAgentMessages([message])}\n</session_entry>`,
		);
	}
	return serializedEntries.length > 0 ? serializedEntries.join("\n\n") : "None captured.";
}

function getRetainedRecentEntries(branchEntries: SessionEntry[], firstKeptEntryId: string): SessionEntry[] {
	const firstKeptIndex = findEntryIndexById(branchEntries, firstKeptEntryId);
	return firstKeptIndex >= 0 ? branchEntries.slice(firstKeptIndex) : [];
}

function getRetainedRecentMessages(branchEntries: SessionEntry[], firstKeptEntryId: string): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const entry of getRetainedRecentEntries(branchEntries, firstKeptEntryId)) {
		const message = messageFromEntry(entry);
		if (message) {
			messages.push(message);
		}
	}
	return messages;
}

function extractFileOpsFromEntries(entries: SessionEntry[]): FileOps {
	const fileOps = createFileOps();
	for (const entry of entries) {
		const message = messageFromEntry(entry);
		if (message) {
			extractFileOpsFromMessage(message, fileOps);
		}
	}
	return fileOps;
}

function mergePreviousCompactionFileOps(entries: SessionEntry[], fileOps: FileOps): void {
	const prevCompactionIndex = findPreviousCompactionIndex(entries);
	if (prevCompactionIndex < 0) {
		return;
	}
	const prevCompaction = entries[prevCompactionIndex];
	// Only import file ops from Pi-generated compactions (not extension-generated ones).
	// Extension-generated compactions can store arbitrary data in details.
	if (prevCompaction.type !== "compaction" || prevCompaction.fromHook || !prevCompaction.details) {
		return;
	}
	const details = prevCompaction.details as { readFiles?: unknown; modifiedFiles?: unknown };
	if (Array.isArray(details.readFiles)) {
		for (const file of details.readFiles) {
			if (typeof file === "string") {
				fileOps.read.add(file);
			}
		}
	}
	if (Array.isArray(details.modifiedFiles)) {
		for (const file of details.modifiedFiles) {
			if (typeof file === "string") {
				fileOps.edited.add(file);
			}
		}
	}
}

function computeFileOpsForCutpoint(branchEntries: SessionEntry[], firstKeptEntryId: string): {
	compactedFileOps: FileOps;
	retainedFileOps: FileOps;
	allFileOps: FileOps;
} {
	const boundaryStart = getBoundaryStartIndex(branchEntries);
	const firstKeptIndex = findEntryIndexById(branchEntries, firstKeptEntryId);
	const safeFirstKeptIndex = firstKeptIndex >= 0 ? firstKeptIndex : branchEntries.length;
	const compactedFileOps = extractFileOpsFromEntries(branchEntries.slice(boundaryStart, safeFirstKeptIndex));
	mergePreviousCompactionFileOps(branchEntries, compactedFileOps);
	const retainedFileOps = extractFileOpsFromEntries(branchEntries.slice(safeFirstKeptIndex));
	const allFileOps = createFileOps();
	mergeFileOps(allFileOps, compactedFileOps);
	mergeFileOps(allFileOps, retainedFileOps);
	return { compactedFileOps, retainedFileOps, allFileOps };
}

function extractPresentedCutpointIds(prompt: string): Set<string> {
	const ids = new Set<string>();
	const entryPattern = /<session_entry\s+([^>]*\bvalid_cutpoint="true"[^>]*)>/gi;
	let match: RegExpExecArray | null;
	while ((match = entryPattern.exec(prompt)) !== null) {
		const idMatch = match[1].match(/\bid="([^"]+)"/i);
		if (idMatch?.[1]) {
			ids.add(idMatch[1]);
		}
	}
	return ids;
}

function estimateEntryTokens(entry: SessionEntry): number {
	const message = messageFromEntry(entry);
	return message ? estimateTokens(message) : 0;
}

function estimateRetainedTokens(branchEntries: SessionEntry[], firstKeptEntryId: string): number {
	const firstKeptIndex = findEntryIndexById(branchEntries, firstKeptEntryId);
	if (firstKeptIndex < 0) {
		return 0;
	}
	let tokens = 0;
	for (const entry of branchEntries.slice(firstKeptIndex)) {
		tokens += estimateEntryTokens(entry);
	}
	return tokens;
}

function findCappedCutpointId(branchEntries: SessionEntry[], presentedCutpointIds: Set<string>): string | undefined {
	let retainedTokens = 0;
	let earliestCandidateWithinCap: string | undefined;
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entryTokens = estimateEntryTokens(branchEntries[i]);
		if (retainedTokens + entryTokens > MAX_MODEL_SELECTED_RETAINED_TOKENS) {
			return earliestCandidateWithinCap;
		}
		retainedTokens += entryTokens;
		const candidate = branchEntries[i];
		if (presentedCutpointIds.has(candidate.id) && isValidCutpointEntry(candidate)) {
			earliestCandidateWithinCap = candidate.id;
		}
	}
	return earliestCandidateWithinCap;
}

function truncateRetainedReference(text: string): string {
	if (text.length <= MAX_RETAINED_CONTEXT_REFERENCE_CHARS) {
		return text;
	}
	const headChars = Math.floor(MAX_RETAINED_CONTEXT_REFERENCE_CHARS * 0.25);
	const tailChars = MAX_RETAINED_CONTEXT_REFERENCE_CHARS - headChars;
	const closingTag = "</session_entry>";
	const openingTag = "<session_entry";

	const headCloseIndex = text.lastIndexOf(closingTag, headChars);
	const headEnd = headCloseIndex >= 0 ? headCloseIndex + closingTag.length : headChars;
	const tailSearchStart = Math.max(headEnd, text.length - tailChars);
	const tailOpenIndex = text.indexOf(openingTag, tailSearchStart);
	const tailStart = tailOpenIndex >= 0 ? tailOpenIndex : tailSearchStart;
	const omittedChars = Math.max(0, tailStart - headEnd);

	return `${text.slice(0, headEnd)}\n\n[... ${omittedChars} characters of retained recent context omitted from the middle ...]\n\n${text.slice(tailStart)}`;
}

function normalizeGitPathspecs(cwd: string, gitRoot: string, touchedFiles: string[]): string[] {
	const resolvedCwd = resolveFsPath(cwd);
	const resolvedGitRoot = resolveFsPath(gitRoot);
	const pathspecs = new Set<string>();

	for (const file of touchedFiles) {
		const trimmed = file.trim();
		if (!trimmed) {
			continue;
		}
		let absolutePath: string;
		if (isAbsolute(trimmed)) {
			absolutePath = resolveFsPath(trimmed);
		} else {
			// Try resolving relative to cwd first, then fall back to git root.
			// The model may use paths relative to the project root while ctx.cwd
			// points elsewhere, so both bases need checking.
			absolutePath = resolveFsPath(resolvedCwd, trimmed);
			const relFromRoot = relative(resolvedGitRoot, absolutePath);
			if (relFromRoot && !relFromRoot.startsWith("..") && !isAbsolute(relFromRoot)) {
				pathspecs.add(`:(top)${relFromRoot.split("\\").join("/")}`);
				continue;
			}
			// Fallback: treat the path as relative to the git root directly.
			absolutePath = resolveFsPath(resolvedGitRoot, trimmed);
		}
		const relativePath = relative(resolvedGitRoot, absolutePath);
		if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
			continue;
		}
		pathspecs.add(`:(top)${relativePath.split("\\").join("/")}`);
	}

	return [...pathspecs].sort();
}

async function safeGitSnapshot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	signal: AbortSignal,
	touchedFiles: string[],
): Promise<GitSnapshot> {
	const execOptions = { cwd: ctx.cwd, timeout: GIT_COMMAND_TIMEOUT_MS, signal };
	try {
		const inside = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], execOptions);
		if (inside.code !== 0 || inside.stdout.trim() !== "true") {
			return {
				isGitRepo: false,
				branch: "Not a git repository.",
				statusShort: "",
				diffStat: "",
				scope: "not-a-git-repository",
				pathspecCount: 0,
			};
		}

		const [branchResult, gitRootResult] = await Promise.all([
			pi.exec("git", ["branch", "--show-current"], execOptions),
			pi.exec("git", ["rev-parse", "--show-toplevel"], execOptions),
		]);
		const branch = truncateDisplayField(branchResult.stdout || "(detached or unnamed HEAD)", MAX_GIT_FIELD_CHARS);
		if (gitRootResult.code !== 0 || !gitRootResult.stdout.trim()) {
			return {
				isGitRepo: true,
				branch,
				statusShort: "Git root unavailable; scoped status omitted.",
				diffStat: "Git root unavailable; scoped diff stat omitted.",
				scope: "session-touched paths only; git root unavailable",
				pathspecCount: 0,
			};
		}

		const pathspecs = normalizeGitPathspecs(ctx.cwd, gitRootResult.stdout.trim(), touchedFiles);
		const scope = `session-touched paths only (${pathspecs.length} pathspec${pathspecs.length === 1 ? "" : "s"}); repo-wide status/diff intentionally omitted`;
		if (pathspecs.length === 0) {
			return {
				isGitRepo: true,
				branch,
				statusShort: "Could not resolve session-touched file paths within this git repository; scoped status omitted.",
				diffStat: "Could not resolve session-touched file paths within this git repository; scoped diff stat omitted.",
				scope,
				pathspecCount: 0,
			};
		}

		const [statusResult, diffStatResult] = await Promise.all([
			pi.exec("git", ["status", "--short", "--", ...pathspecs], execOptions),
			pi.exec("git", ["diff", "--stat", "--", ...pathspecs], execOptions),
		]);

		const statusText = statusResult.code === 0
			? statusResult.stdout || "Clean session-touched paths."
			: `git status failed (exit ${statusResult.code}): ${statusResult.stderr || statusResult.stdout || "no output"}`;
		const diffText = diffStatResult.code === 0
			? diffStatResult.stdout || "No unstaged diff stat for session-touched paths."
			: `git diff --stat failed (exit ${diffStatResult.code}): ${diffStatResult.stderr || diffStatResult.stdout || "no output"}`;

		return {
			isGitRepo: true,
			branch,
			statusShort: truncateDisplayField(statusText, MAX_GIT_FIELD_CHARS),
			diffStat: truncateDisplayField(diffText, MAX_GIT_FIELD_CHARS),
			scope,
			pathspecCount: pathspecs.length,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			isGitRepo: false,
			branch: `Git snapshot unavailable: ${message}`,
			statusShort: "",
			diffStat: "",
			scope: "git snapshot unavailable",
			pathspecCount: 0,
		};
	}
}

async function resolveModelAuth(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<SelectedSummarizer | undefined> {
	const provider = stringFlag(pi, "mirastyle-compaction-provider") || DEFAULT_SUMMARIZER_PROVIDER;
	const modelId = stringFlag(pi, "mirastyle-compaction-model") || DEFAULT_SUMMARIZER_MODEL_ID;

	if (provider && modelId) {
		const configured = ctx.modelRegistry.find(provider, modelId);
		if (!configured) {
			notifyUi(ctx, `${EXTENSION_NAME}: configured model ${provider}/${modelId} was not found; trying active model`, "warning");
		} else {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(configured);
			if (auth.ok) {
				return {
					model: configured,
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					selectionReason: "configured",
				};
			}
			notifyUi(ctx, `${EXTENSION_NAME}: configured model auth failed (${auth.error}); trying active model`, "warning");
		}
	} else if (provider || modelId) {
		notifyUi(
			ctx,
			`${EXTENSION_NAME}: both provider and model must be configured together; trying active model`,
			"warning",
		);
	}

	if (!ctx.model) {
		notifyUi(ctx, `${EXTENSION_NAME}: no active model available; using Pi default compaction`, "warning");
		return undefined;
	}

	const activeAuth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!activeAuth.ok) {
		notifyUi(ctx, `${EXTENSION_NAME}: active model auth failed (${activeAuth.error}); using Pi default compaction`, "warning");
		return undefined;
	}

	return {
		model: ctx.model,
		apiKey: activeAuth.apiKey,
		headers: activeAuth.headers,
		env: activeAuth.env,
		selectionReason: "active-model-fallback",
	};
}

interface PreparedPromptContext {
	readFiles: string[];
	modifiedFiles: string[];
	retainedMessageCount: number;
	retainedReferenceChars: number;
	git: GitSnapshot;
	sessionFile: string;
	compactedAt: string;
	newHistory: string;
	retainedRecentContext: string;
	turnPrefix: string;
}

async function preparePromptContext(input: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	signal: AbortSignal;
	branchEntries: SessionEntry[];
	firstKeptEntryId: string;
	isSplitTurn: boolean;
}): Promise<PreparedPromptContext> {
	const retainedMessages = getRetainedRecentMessages(input.branchEntries, input.firstKeptEntryId);
	const promptFileOps = computeFileOpsForCutpoint(input.branchEntries, input.firstKeptEntryId);
	const promptFileLists = computeFileLists(promptFileOps.allFileOps);
	const { readFiles, modifiedFiles } = promptFileLists;
	const touchedFiles = sortedUnique([...readFiles, ...modifiedFiles]);
	const git = await safeGitSnapshot(input.pi, input.ctx, input.signal, touchedFiles);
	const sessionFile = input.ctx.sessionManager.getSessionFile() ?? "In-memory or unsaved session.";
	const compactedAt = new Date().toISOString();
	const preparedEntryRanges = getPreparedEntryRanges(
		input.branchEntries,
		input.firstKeptEntryId,
		input.isSplitTurn,
	);
	const newHistory = serializeEntriesWithIds(preparedEntryRanges.newHistoryEntries);
	const retainedRecentContext = truncateRetainedReference(serializeEntriesWithIds(preparedEntryRanges.retainedEntries));
	const turnPrefix = input.isSplitTurn
		? serializeEntriesWithIds(preparedEntryRanges.turnPrefixEntries)
		: "None captured. This compaction did not split a turn.";

	return {
		readFiles,
		modifiedFiles,
		retainedMessageCount: retainedMessages.length,
		retainedReferenceChars: retainedRecentContext.length,
		git,
		sessionFile,
		compactedAt,
		newHistory,
		retainedRecentContext,
		turnPrefix,
	};
}

function buildUserPrompt(input: {
	previousSummary: string | undefined;
	newHistory: string;
	turnPrefix: string;
	retainedRecentContext: string;
	retainedMessageCount: number;
	retainedReferenceChars: number;
	customInstructions: string | undefined;
	sessionFile: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	isSplitTurn: boolean;
	readFiles: string[];
	modifiedFiles: string[];
	git: GitSnapshot;
}): string {
	const previousSection = input.previousSummary
		? `<previous_checkpoint>\n${input.previousSummary}\n</previous_checkpoint>\n\n`
		: "<previous_checkpoint>\nNone captured. This is the first compaction checkpoint.\n</previous_checkpoint>\n\n";

	const customInstructionsSection = input.customInstructions?.trim()
		? `<user_compaction_instructions priority="high" source="human">
IMPORTANT: The user explicitly supplied custom compaction instructions for this checkpoint.
You must take them into account prominently when deciding what details to preserve, emphasize, and describe.
Follow them unless they conflict with required output format, deterministic metadata, or newer session evidence.

${input.customInstructions.trim()}
</user_compaction_instructions>

`
		: "";

	const customInstructionsReminder = input.customInstructions?.trim()
		? "\nCUSTOM INSTRUCTION PRIORITY: The human-provided <user_compaction_instructions> above is high priority and should materially affect checkpoint emphasis and retained detail."
		: "";

	return `${previousSection}${customInstructionsSection}<deterministic_metadata>
Session file: ${input.sessionFile}
Default fallback first kept entry ID: ${input.firstKeptEntryId}
Compacted from token count: ${input.tokensBefore}
Split turn: ${input.isSplitTurn}
Read-only files:
${formatBulletList(input.readFiles)}
Modified files:
${formatBulletList(input.modifiedFiles)}
${input.git.isGitRepo
? `Git repository: true
Git branch: ${input.git.branch}
Git scope: ${input.git.scope}
Git pathspec count: ${input.git.pathspecCount}
Git status --short (session-touched paths only):
${input.git.statusShort}
Git diff --stat (session-touched paths only):
${input.git.diffStat}`
: ''}
Retained recent message count: ${input.retainedMessageCount}
Retained recent reference chars: ${input.retainedReferenceChars}
</deterministic_metadata>

<new_history_to_compact>
${input.newHistory}
</new_history_to_compact>

<split_turn_prefix>
${input.turnPrefix}
</split_turn_prefix>

<kept_recent_context boundary_reference="true">
These messages start at Pi's default fallback first kept entry ID. They are included as boundary evidence, but your <recommended_cut_before_entry_id> controls the final verbatim retention point. Use them to compute STATE AT COMPACTION BOUNDARY, WORK QUEUE, OPEN THREADS, and validation status accurately. If you recommend a later cut point, integrate any earlier boundary messages into the checkpoint because they will not remain verbatim. If they contradict older checkpoint claims about current work state, they win.

${input.retainedRecentContext}
</kept_recent_context>

<cutpoint_recommendation_instructions>
Follow the cut-point strategy from the system prompt. Choose only an ID from a <session_entry> marked valid_cutpoint="true". Keep the short runway needed for the next action; summarize completed context instead of retaining a long replay.
</cutpoint_recommendation_instructions>${customInstructionsReminder}
Output the cut-point decision block first, then the checkpoint body using the exact section structure from the system prompt. Do not include wrapper XML tags other than the cut-point decision block. Do not include a raw per-tool-call history list.`;
}

function wrapSummary(input: {
	body: string;
	compactedAt: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	isSplitTurn: boolean;
	sessionFile: string;
	readFiles: string[];
	modifiedFiles: string[];
	retainedMessageCount: number;
	git: GitSnapshot;
}): string {
	return `<pi:mirastyle_compacted_coding_context compacted_at="${input.compactedAt}" first_kept_entry_id="${input.firstKeptEntryId}" tokens_before="${input.tokensBefore}">
HISTORICAL CODING CHECKPOINT. Current filesystem state and later conversation are more authoritative. If conflicts arise, reread files and trust on-disk contents.
Pi preserved ${input.retainedMessageCount} message(s) after first_kept_entry_id verbatim; this checkpoint used them as boundary evidence.

RECOVERY:
- Session file: ${input.sessionFile}
- First kept entry ID: ${input.firstKeptEntryId}
- Compacted from token count: ${input.tokensBefore}
- Split turn: ${input.isSplitTurn}
- For exact pre-compaction details (tool arguments, command output, message order), read session file JSONL records before first_kept_entry_id rather than relying on this checkpoint.

ARTIFACT STATE:
- Files read:
${formatBulletList(input.readFiles)}
- Files modified:
${formatBulletList(input.modifiedFiles)}
${input.git.isGitRepo
? `- Git repository: true\n- Git branch: ${input.git.branch}\n- Git scope: ${input.git.scope}\n- Git pathspec count: ${input.git.pathspecCount}\n- Git status --short (session-touched paths only):\n${input.git.statusShort}\n- Git diff --stat (session-touched paths only):\n${input.git.diffStat}`
: ''}

${input.body.trim()}
</pi:mirastyle_compacted_coding_context>`;
}

function stripAccidentalWrapper(summary: string): string {
	return summary
		.replace(/^```(?:xml|text)?\s*/i, "")
		.replace(/```\s*$/i, "")
		.replace(/^<pi:mirastyle_compacted_coding_context[^>]*>/i, "")
		.replace(/<\/pi:mirastyle_compacted_coding_context>\s*$/i, "")
		.trim();
}

function extractRecommendedCutpoint(summary: string): { body: string; recommendedEntryId: string | undefined } {
	const recommendationPattern = /<recommended_cut_before_entry_id>\s*([^<\s]+)\s*<\/recommended_cut_before_entry_id>/i;
	const decisionBlockPattern = /<cutpoint_decision>[\s\S]*?<\/cutpoint_decision>/gi;
	const match = summary.match(recommendationPattern);
	let body = summary.replace(decisionBlockPattern, "").trim();
	// Backward/partial-compliance cleanup: strip standalone tags if the model omitted the wrapper.
	body = body
		.replace(/<recommended_cut_before_entry_id>\s*([^<\s]+)\s*<\/recommended_cut_before_entry_id>/gi, "")
		.replace(/<cutpoint_reasoning>[\s\S]*?<\/cutpoint_reasoning>/gi, "")
		.trim();
	return {
		body,
		recommendedEntryId: match?.[1]?.trim(),
	};
}

function selectCutpoint(
	branchEntries: SessionEntry[],
	defaultFirstKeptEntryId: string,
	recommendedEntryId: string | undefined,
	presentedCutpointIds: Set<string>,
): CutpointSelectionDetails {
	if (!recommendedEntryId) {
		return {
			defaultFirstKeptEntryId,
			selectedFirstKeptEntryId: defaultFirstKeptEntryId,
			selectionReason: "fallback",
			validationMessage: "Summarizer did not return a cut-point recommendation.",
		};
	}

	if (!presentedCutpointIds.has(recommendedEntryId)) {
		return {
			defaultFirstKeptEntryId,
			selectedFirstKeptEntryId: defaultFirstKeptEntryId,
			recommendedFirstKeptEntryId: recommendedEntryId,
			selectionReason: "fallback",
			validationMessage: `Recommended cut point ${recommendedEntryId} was not one of the valid cut points presented to the summarizer.`,
		};
	}

	const recommendedEntry = branchEntries.find((entry) => entry.id === recommendedEntryId);
	if (!recommendedEntry) {
		return {
			defaultFirstKeptEntryId,
			selectedFirstKeptEntryId: defaultFirstKeptEntryId,
			recommendedFirstKeptEntryId: recommendedEntryId,
			selectionReason: "fallback",
			validationMessage: `Recommended cut point ${recommendedEntryId} was not found in the current branch.`,
		};
	}
	if (!isValidCutpointEntry(recommendedEntry)) {
		return {
			defaultFirstKeptEntryId,
			selectedFirstKeptEntryId: defaultFirstKeptEntryId,
			recommendedFirstKeptEntryId: recommendedEntryId,
			selectionReason: "fallback",
			validationMessage: `Recommended cut point ${recommendedEntryId} is not a valid cut point.`,
		};
	}

	const retainedTokenEstimate = estimateRetainedTokens(branchEntries, recommendedEntryId);
	if (retainedTokenEstimate > MAX_MODEL_SELECTED_RETAINED_TOKENS) {
		const cappedEntryId = findCappedCutpointId(branchEntries, presentedCutpointIds);
		if (cappedEntryId) {
			return {
				defaultFirstKeptEntryId,
				selectedFirstKeptEntryId: cappedEntryId,
				recommendedFirstKeptEntryId: recommendedEntryId,
				selectionReason: "model-capped",
				validationMessage: `Recommended cut point was valid but exceeded the retained-token cap; selected the nearest presented valid cut point within ${MAX_MODEL_SELECTED_RETAINED_TOKENS} estimated tokens.`,
			};
		}
		return {
			defaultFirstKeptEntryId,
			selectedFirstKeptEntryId: defaultFirstKeptEntryId,
			recommendedFirstKeptEntryId: recommendedEntryId,
			selectionReason: "fallback",
			validationMessage: "Recommended cut point was valid but exceeded the retained-token cap, and no capped presented cut point was available.",
		};
	}

	return {
		defaultFirstKeptEntryId,
		selectedFirstKeptEntryId: recommendedEntryId,
		recommendedFirstKeptEntryId: recommendedEntryId,
		selectionReason: "model",
		validationMessage: "Recommended cut point was presented, found, and valid.",
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("mirastyle-compaction-provider", {
		description: "Provider for Mira-style compaction summaries, e.g. anthropic or google. Requires --mirastyle-compaction-model.",
		type: "string",
	});
	pi.registerFlag("mirastyle-compaction-model", {
		description: "Model ID for Mira-style compaction summaries. Requires --mirastyle-compaction-provider.",
		type: "string",
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const selected = await resolveModelAuth(pi, ctx);
		if (!selected) {
			return;
		}

		const { preparation, customInstructions, signal, branchEntries } = event;
		const promptContext = await preparePromptContext({
			pi,
			ctx,
			signal,
			branchEntries,
			firstKeptEntryId: preparation.firstKeptEntryId,
			isSplitTurn: preparation.isSplitTurn,
		});

		notifyUi(
			ctx,
			`${EXTENSION_NAME}: generating coding checkpoint with ${selected.model.provider}/${selected.model.id}`,
			"info",
		);

		const userPrompt = buildUserPrompt({
			previousSummary: preparation.previousSummary,
			newHistory: promptContext.newHistory,
			turnPrefix: promptContext.turnPrefix,
			retainedRecentContext: promptContext.retainedRecentContext,
			retainedMessageCount: promptContext.retainedMessageCount,
			retainedReferenceChars: promptContext.retainedReferenceChars,
			customInstructions,
			sessionFile: promptContext.sessionFile,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			isSplitTurn: preparation.isSplitTurn,
			readFiles: promptContext.readFiles,
			modifiedFiles: promptContext.modifiedFiles,
			git: promptContext.git,
		});
		const presentedCutpointIds = extractPresentedCutpointIds(userPrompt);

		try {
			const maxTokens = Math.min(
				MAX_SUMMARY_OUTPUT_TOKENS,
				selected.model.maxTokens > 0 ? selected.model.maxTokens : MAX_SUMMARY_OUTPUT_TOKENS,
			);
			const effectiveSystemPrompt = customInstructions?.trim()
				? `${SYSTEM_PROMPT}

If <user_compaction_instructions> is present, treat it as high-priority human guidance about what to emphasize, preserve, and describe in extra detail. Follow it unless it conflicts with required output format, deterministic metadata, or newer session evidence.`
				: SYSTEM_PROMPT;

			const response = await complete(
				selected.model,
				{
					systemPrompt: effectiveSystemPrompt,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: userPrompt }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: selected.apiKey,
					headers: selected.headers,
					env: selected.env,
					maxTokens,
					signal,
				},
			);

			if (response.stopReason === "error") {
				throw new Error(response.errorMessage || "unknown provider error");
			}

			const rawBody = response.content
				.filter((content): content is { type: "text"; text: string } => content.type === "text")
				.map((content) => content.text)
				.join("\n")
				.trim();
			const cleanedBody = stripAccidentalWrapper(rawBody);
			const { body, recommendedEntryId } = extractRecommendedCutpoint(cleanedBody);
			if (!body) {
				if (!signal.aborted) {
					notifyUi(ctx, `${EXTENSION_NAME}: summarizer returned an empty checkpoint; using Pi default compaction`, "warning");
				}
				return;
			}

			const cutpoint = selectCutpoint(
				branchEntries,
				preparation.firstKeptEntryId,
				recommendedEntryId,
				presentedCutpointIds,
			);
			if (!signal.aborted) {
				const isFallback = cutpoint.selectionReason === "fallback";
				notifyUi(
					ctx,
					`${EXTENSION_NAME}: ${isFallback ? "using fallback" : "using model-selected"} cut point ${cutpoint.selectedFirstKeptEntryId}`,
					isFallback ? "warning" : "info",
				);
			}
			const selectedRetainedEntries = getRetainedRecentEntries(branchEntries, cutpoint.selectedFirstKeptEntryId);
			const selectedRetainedMessages = getRetainedRecentMessages(branchEntries, cutpoint.selectedFirstKeptEntryId);
			const selectedRetainedReferenceChars = serializeEntriesWithIds(selectedRetainedEntries).length;
			const selectedFileOps = computeFileOpsForCutpoint(branchEntries, cutpoint.selectedFirstKeptEntryId);
			const compactedFileLists = computeFileLists(selectedFileOps.compactedFileOps);
			const selectedRetainedFileLists = computeFileLists(selectedFileOps.retainedFileOps);
			const selectedAllFileLists = computeFileLists(selectedFileOps.allFileOps);

			const bodyWithCutpointNote =
				cutpoint.selectionReason === "model"
					? body
					: `CUTPOINT ADJUSTMENT NOTE:
- Final first kept entry ID: ${cutpoint.selectedFirstKeptEntryId}
- Summarizer recommended: ${cutpoint.recommendedFirstKeptEntryId ?? "None returned."}
- Selection reason: ${cutpoint.selectionReason}
- Validation: ${cutpoint.validationMessage}

${body}`;

			const summary = wrapSummary({
				body: bodyWithCutpointNote,
				compactedAt: promptContext.compactedAt,
				firstKeptEntryId: cutpoint.selectedFirstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				isSplitTurn: preparation.isSplitTurn,
				sessionFile: promptContext.sessionFile,
				readFiles: selectedAllFileLists.readFiles,
				modifiedFiles: selectedAllFileLists.modifiedFiles,
				retainedMessageCount: selectedRetainedMessages.length,
				git: promptContext.git,
			});

			const details: MirastyleCompactionDetails = {
				extension: EXTENSION_NAME,
				version: SUMMARY_VERSION,
				generatedAt: promptContext.compactedAt,
				readFiles: selectedAllFileLists.readFiles,
				modifiedFiles: selectedAllFileLists.modifiedFiles,
				compactedReadFiles: compactedFileLists.readFiles,
				compactedModifiedFiles: compactedFileLists.modifiedFiles,
				retainedReadFiles: selectedRetainedFileLists.readFiles,
				retainedModifiedFiles: selectedRetainedFileLists.modifiedFiles,
				retainedMessageCount: selectedRetainedMessages.length,
				retainedReferenceChars: selectedRetainedReferenceChars,
				model: {
					provider: selected.model.provider,
					id: selected.model.id,
					selectionReason: selected.selectionReason,
				},
				git: promptContext.git,
				cutpoint,
			};

			return {
				compaction: {
					summary,
					firstKeptEntryId: cutpoint.selectedFirstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!signal.aborted) {
				notifyUi(ctx, `${EXTENSION_NAME}: custom compaction failed (${message}); using Pi default compaction`, "warning");
			}
			return;
		}
	});
}
