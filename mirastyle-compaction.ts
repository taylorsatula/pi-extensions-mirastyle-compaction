/**
 * Mira-style Coding Compaction Extension
 *
 * Replaces Pi's default compaction summary with a coding-oriented engineering
 * handoff checkpoint. Pi's core compaction mechanics remain unchanged: the
 * latest CompactionEntry summary is injected before kept recent messages. This
 * extension changes what goes into that summary, who writes it, and what
 * happens around it:
 *
 * - The agent writes a short first-person `write_handoff` note just before
 *   compaction (steered once its context passes ~60% of the window). The call
 *   and its result stay verbatim in the kept runway, and the summarizer reads
 *   them too.
 * - Everything code can recompute at compaction time (repository state, files
 *   read and modified, the person's words verbatim) is computed by code and is
 *   never asked of the model. The checkpoint's code-owned part is rendered by
 *   code under a budget with a fixed shed order; the model writes only the
 *   "working state" sections.
 * - `recall_history` searches and reads the full pre-compaction history.
 * - After the compaction the agent is automatically prompted to resume
 *   ("auto-continue"), so an unattended run never ends on a compaction.
 * - If the summarizer fails, the previous working state is carried forward
 *   with a note; the run is never left without a usable checkpoint.
 * - A kept tool result the agent no longer needs verbatim can be condensed by
 *   the summarizer into a one-line pointer (an append-only context edit);
 *   `recall_history` still reads the original.
 *
 * Configuration:
 * - Edit DEFAULT_SUMMARIZER_PROVIDER / DEFAULT_SUMMARIZER_MODEL_ID below, or
 * - Start Pi with --mirastyle-compaction-provider and --mirastyle-compaction-model.
 *
 * If the configured summarizer cannot be used, the extension falls back to the
 * active session model. If that also cannot be used, it returns nothing so
 * Pi's default compaction runs.
 */

import { isAbsolute, relative, resolve as resolveFsPath } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	estimateTokens,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const EXTENSION_NAME = "mirastyle-compaction";
const SUMMARY_VERSION = 2;
const CUSTOM_MESSAGE_TYPE = "mirastyle-compaction";

// Leave blank to use the active session model by default.
const DEFAULT_SUMMARIZER_PROVIDER = "";
const DEFAULT_SUMMARIZER_MODEL_ID = "";

/** The most the summarizer may write. */
const MAX_SUMMARY_OUTPUT_TOKENS = 12_000;
const GIT_COMMAND_TIMEOUT_MS = 5_000;
const MAX_GIT_FIELD_CHARS = 4_000;
const MAX_MODEL_SELECTED_RETAINED_TOKENS = 15_000;

/** Compaction cycle trigger, as proportions of the session model's context window. */
const HANDOFF_TRIGGER = 0.6;
/** At or above this share Pi's own threshold compaction is left to handle the compaction. */
const BACKGROUND_TRIGGER = 0.75;
/** The code-owned part of the checkpoint fits this share of the model's window. */
const FACTS_SHARE = 0.1;
/** The summarizer's input is at most this share of its own model's window. */
const PROMPT_SHARE = 0.6;

/** How much of a tool result / message the summarizer is shown, with the rest clipped head-and-tail. */
const TOOL_RESULT_CHARS = 1_500;
const MESSAGE_CHARS = 4_000;

const MAX_HANDOFF_CHARS = 2_000;
const RECALL_MATCHES = 8;
const RECALL_SNIPPET = 240;
const MAX_ENTRY_TEXT = 20_000;

const WRITE_HANDOFF = "write_handoff";
const RECALL_HISTORY = "recall_history";

const HANDOFF_REQUEST =
	"Your context window is about to be compacted. Call write_handoff now with a short first-person note on how you are doing right now: what you are doing and where you are, what you just learned or decided, your exact next step and why, and anything you are unsure of or watching for. Make no other tool call this turn.";
const RESUME_MESSAGE = "The context window has just been compacted. Please resume with what you were doing.";

const DEFAULT_WINDOW = 128_000;

interface GitFacts {
	available: boolean;
	error?: string;
	branch: string;
	head: string;
	base: string;
	baseKnown: boolean;
	ahead: number;
	behind: number;
	uncommitted: string[];
	uncommittedTotal: number;
	commits: { sha: string; subject: string }[];
	/** True when the commit list is "since the last compaction" rather than recent history. */
	commitsSincePrevious: boolean;
	commitTotal: number;
	files: { path: string; added: number; removed: number; status: string }[];
	filesTotal: number;
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
	/** Checkpoint number within this session (1-based). */
	checkpointNumber: number;
	/** HEAD when this compaction happened; fed to the next one for "commits since last compaction". */
	headSha?: string;
	/** The summarizer's working state, carried forward when a later summarizer fails. */
	workingState?: string;
	/** Whether the agent's handoff note was part of this checkpoint. */
	handoffWritten?: boolean;
	/** Tool results condensed in the kept range by this compaction. */
	condensed: { entryId: string; note: string }[];
	model: {
		provider: string;
		id: string;
		selectionReason: SummarizerSelectionReason;
	};
	git: {
		isGitRepo: boolean;
		branch: string;
		head: string;
		base: string;
		baseKnown: boolean;
		ahead: number;
		behind: number;
		error?: string;
	};
	cutpoint: CutpointSelectionDetails;
}

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

function stringHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (!headers) {
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value !== null) {
			out[key] = value;
		}
	}
	return out;
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

/**
 * Fold the cumulative file lists from previous compactions into `fileOps`.
 * Both this extension's details and Pi's default compaction details store
 * all-time lists, so the merge is idempotent.
 */
function mergePreviousCompactionFileOps(entries: SessionEntry[], fileOps: FileOps): void {
	const prevCompactionIndex = findPreviousCompactionIndex(entries);
	if (prevCompactionIndex < 0) {
		return;
	}
	const prevCompaction = entries[prevCompactionIndex];
	if (prevCompaction.type !== "compaction" || !prevCompaction.details) {
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

/** Pi-style default kept range for a compaction we run ourselves: walk back from the newest entry, cutting at the first valid cutpoint once ~25% of the window is accumulated. */
function findDefaultKeptId(branchEntries: SessionEntry[], window: number): string | undefined {
	const keepRecentTokens = Math.round(window * 0.25);
	let tokens = 0;
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		tokens += estimateEntryTokens(branchEntries[i]);
		if (tokens >= keepRecentTokens && isValidCutpointEntry(branchEntries[i])) {
			return branchEntries[i].id;
		}
	}
	return branchEntries.find(isValidCutpointEntry)?.id;
}

function estimateEntryTokens(entry: SessionEntry): number {
	const message = messageFromEntry(entry);
	return message ? estimateTokens(message) : 0;
}

function estimateRetainedTokens(branchEntries: SessionEntry[], firstKeptEntryId: string, replaced?: ReadonlyMap<string, number>): number {
	const firstKeptIndex = findEntryIndexById(branchEntries, firstKeptEntryId);
	if (firstKeptIndex < 0) {
		return 0;
	}
	let tokens = 0;
	for (const entry of branchEntries.slice(firstKeptIndex)) {
		tokens += replaced?.get(entry.id) ?? estimateEntryTokens(entry);
	}
	return tokens;
}

function findCappedCutpointId(
	branchEntries: SessionEntry[],
	presentedCutpointIds: Set<string>,
	replaced?: ReadonlyMap<string, number>,
): string | undefined {
	let retainedTokens = 0;
	let earliestCandidateWithinCap: string | undefined;
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i];
		const entryTokens = replaced?.get(entry.id) ?? estimateEntryTokens(entry);
		if (retainedTokens + entryTokens > MAX_MODEL_SELECTED_RETAINED_TOKENS) {
			return earliestCandidateWithinCap;
		}
		retainedTokens += entryTokens;
		if (presentedCutpointIds.has(entry.id) && isValidCutpointEntry(entry)) {
			earliestCandidateWithinCap = entry.id;
		}
	}
	return earliestCandidateWithinCap;
}

/** The previous compaction's details, if any (this extension's or Pi default's). */
function previousCompactionDetails(branchEntries: SessionEntry[]): MirastyleCompactionDetails | undefined {
	const prevCompactionIndex = findPreviousCompactionIndex(branchEntries);
	if (prevCompactionIndex < 0) {
		return undefined;
	}
	const prevCompaction = branchEntries[prevCompactionIndex];
	if (prevCompaction.type !== "compaction" || !prevCompaction.details) {
		return undefined;
	}
	const details = prevCompaction.details as Partial<MirastyleCompactionDetails>;
	if (typeof details !== "object" || details === null || details.extension !== EXTENSION_NAME) {
		return undefined;
	}
	return details as MirastyleCompactionDetails;
}

function compactionNumber(branchEntries: SessionEntry[]): number {
	let count = 0;
	for (const entry of branchEntries) {
		if (entry.type === "compaction") {
			count += 1;
		}
	}
	return count + 1;
}

/** The person's words, verbatim, oldest first. Never filtered, never summarized. */
function collectPersonWords(branchEntries: SessionEntry[]): string[] {
	const words: string[] = [];
	for (const entry of branchEntries) {
		if (entry.type !== "message" || entry.message.role !== "user") {
			continue;
		}
		const content = (entry.message as { content?: unknown }).content;
		const parts: string[] = [];
		if (typeof content === "string") {
			parts.push(content);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (typeof block === "object" && block !== null && (block as { type?: string }).type === "text" && typeof (block as { text?: unknown }).text === "string") {
					parts.push((block as { text: string }).text);
				}
			}
		}
		const text = parts.join("\n").trim();
		if (text.length > 0) {
			words.push(text);
		}
	}
	return words;
}
type ContentBlock = { type: string; text?: string; name?: string; arguments?: unknown };

function contentBlocks(content: unknown): ContentBlock[] {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	if (!Array.isArray(content)) {
		return [];
	}
	return content.filter((block): block is ContentBlock => typeof block === "object" && block !== null && "type" in block);
}

/** Messages as text, the way recall shows an entry; system messages are left out. Shared by recall_history and the checkpoint serializer. */
function messagesText(messages: readonly AgentMessage[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "system") continue;
		if (message.role === "toolResult") parts.push(`[result of ${message.toolName}]`);
		for (const block of contentBlocks((message as { content?: unknown }).content)) {
			if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
			else if (block.type === "toolCall") parts.push(`[call ${block.name}] ${safeJson(block.arguments)}`);
			else if (block.type === "image") parts.push("[image]");
		}
	}
	return parts.join("\n");
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return String(value);
	}
}

/** The searchable/displayable text of one entry. Empty string means the entry carries no readable content. */
function entryText(entry: SessionEntry): string {
	switch (entry.type) {
		case "message":
			return `[message role=${entry.message.role}]\n${messagesText([entry.message])}`;
		case "custom_message": {
			const content = entry.content;
			const text = typeof content === "string"
				? content
				: content.filter((block) => block.type === "text").map((block) => (block as TextContent).text).join("\n");
			return `[custom message ${entry.customType}]\n${text}`;
		}
		case "branch_summary":
			return `[branch summary]\n${entry.summary}`;
		case "compaction":
			return `[compaction checkpoint]\n${entry.summary}`;
		case "context_edit":
			return `[context edit] ${entry.replacement === null ? "omits" : "replaces the content of"} entry ${entry.targetId}`;
		case "custom": {
			const data = safeJson(entry.data);
			return `[custom ${entry.customType}]\n${data.length > 1000 ? `${data.slice(0, 1000)}…` : data}`;
		}
		case "label":
			return `[label] ${entry.label ?? "(cleared)"}`;
		default:
			return "";
	}
}

/** Whether an entry carries anything the model or recall would read. */
function entryHasText(entry: SessionEntry): boolean {
	return entryText(entry).trim().length > 0;
}

interface EntryBlockInput {
	entry: SessionEntry;
	/** true/false to annotate valid_cutpoint, undefined to omit the attribute. */
	validCutpoint?: boolean;
}

/** One <entry> block for the summarizer prompt, clipped head-and-tail when long. */
function clipMiddle(text: string, limit: number, entryId: string): string {
	if (text.length <= limit) return text;
	// Head and tail: a log's outcome is usually at its end.
	const half = Math.floor(limit / 2);
	return `${text.slice(0, half)}\n[… ${text.length - limit} characters left out; ${RECALL_HISTORY} entry ${entryId} reads them …]\n${text.slice(-half)}`;
}

function entryBlock(input: EntryBlockInput): string {
	const message = messageFromEntry(input.entry);
	const role = entryRoleLabel(input.entry);
	const text = message ? messagesText([message]) : entryText(input.entry);
	const clipLimit = role === "toolResult" ? TOOL_RESULT_CHARS : MESSAGE_CHARS;
	const flag = input.validCutpoint === undefined ? "" : ` valid_cutpoint="${input.validCutpoint}"`;
	return `<entry id="${escapeXmlAttribute(input.entry.id)}" type="${escapeXmlAttribute(input.entry.type)}" role="${escapeXmlAttribute(role)}"${flag}>\n${clipMiddle(text, clipLimit, input.entry.id)}\n</entry>`;
}

const shown = (entry: SessionEntry): boolean => entryText(entry).trim().length > 0;

/** History blocks within `budget` characters; past it, the oldest go first, since the newest lead to the boundary. */
function historyText(entries: SessionEntry[], budget: number): string {
	const blocks = entries.filter(shown).map((entry) => entryBlock({ entry }));
	let total = 0;
	let start = blocks.length;
	while (start > 0 && total + (blocks[start - 1]?.length ?? 0) <= budget) {
		total += blocks[--start]?.length ?? 0;
	}
	const omitted = start > 0 ? `[${start} earlier entries left out to fit; ${RECALL_HISTORY} reads them]\n` : "";
	return blocks.length === 0 ? "(none)" : omitted + blocks.slice(start).join("\n");
}

/**
 * Kept blocks within `budget` characters, trimmed from the middle: the first entries are the
 * earliest cuts and the last are the newest evidence. Only the valid cuts actually shown count
 * as presented to the summarizer.
 */
function keptContextText(
	entries: SessionEntry[],
	valid: (index: number) => boolean,
	budget: number,
): { text: string; presented: Set<string> } {
	const blocks = entries.flatMap((entry, index) =>
		shown(entry)
			? [{ entry, valid: valid(index), text: entryBlock({ entry, validCutpoint: valid(index) }) }]
			: [],
	);
	let head = blocks.length;
	let tail = blocks.length;
	let total = blocks.reduce((sum, block) => sum + block.text.length, 0);
	if (total > budget) {
		// Keep a quarter of the budget from the start, the rest from the end.
		head = 0;
		total = 0;
		while (head < blocks.length && total + (blocks[head]?.text.length ?? 0) <= budget / 4) {
			total += blocks[head++]?.text.length ?? 0;
		}
		tail = blocks.length;
		while (tail > head && total + (blocks[tail - 1]?.text.length ?? 0) <= budget) {
			total += blocks[--tail]?.text.length ?? 0;
		}
	}
	const kept = [...blocks.slice(0, head), ...blocks.slice(tail)];
	const gap = tail > head ? [`[${tail - head} entries left out of the middle to fit; they are not valid cuts here]`] : [];
	const presented = new Set(kept.filter((block) => block.valid).map((block) => block.entry.id));
	return {
		text: [
			...blocks.slice(0, head).map((block) => block.text),
			...gap,
			...blocks.slice(Math.max(head, tail)).map((block) => block.text),
		].join("\n"),
		presented,
	};
}
/** Run git, returning trimmed stdout on success and undefined otherwise. Never throws. */
async function execGit(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	signal: AbortSignal,
	args: string[],
): Promise<string | undefined> {
	try {
		const result = await pi.exec("git", args, { cwd: ctx.cwd, timeout: GIT_COMMAND_TIMEOUT_MS, signal });
		return result.code === 0 ? result.stdout.trim() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The repository as it is now, read from the workspace. Everything here is recomputed at
 * compaction time; nothing is summarized by the model. `previousHeadSha` (chained through
 * compaction details) scopes the commit list to "since the last compaction".
 */
async function groundTruth(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	signal: AbortSignal,
	previousHeadSha: string | undefined,
): Promise<GitFacts> {
	const facts: GitFacts = {
		available: false,
		branch: "",
		head: "",
		base: "",
		baseKnown: false,
		ahead: 0,
		behind: 0,
		uncommitted: [],
		uncommittedTotal: 0,
		commits: [],
		commitsSincePrevious: false,
		commitTotal: 0,
		files: [],
		filesTotal: 0,
	};
	const inside = await execGit(pi, ctx, signal, ["rev-parse", "--is-inside-work-tree"]);
	if (inside !== "true") {
		facts.error = "not a git repository (or git is unavailable)";
		return facts;
	}
	facts.available = true;

	facts.branch = (await execGit(pi, ctx, signal, ["branch", "--show-current"])) || "(detached HEAD)";
	facts.head = (await execGit(pi, ctx, signal, ["rev-parse", "HEAD"])) ?? "";

	// The base branch: origin/HEAD if it exists, else origin/master, else origin/main.
	let baseRef: string | undefined;
	const originHead = await execGit(pi, ctx, signal, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (originHead) {
		baseRef = originHead;
	} else {
		for (const candidate of ["origin/master", "origin/main"]) {
			if ((await execGit(pi, ctx, signal, ["rev-parse", "--verify", "--quiet", candidate])) !== undefined) {
				baseRef = candidate;
				break;
			}
		}
	}
	if (baseRef !== undefined) {
		facts.base = baseRef.replace(/^origin\//, "");
		facts.baseKnown = true;
		const counts = await execGit(pi, ctx, signal, ["rev-list", "--left-right", "--count", `${baseRef}...HEAD`]);
		if (counts !== undefined) {
			const [behind, ahead] = counts.split(/\s+/).map((part) => Number.parseInt(part, 10));
			if (Number.isFinite(behind) && Number.isFinite(ahead)) {
				facts.behind = behind;
				facts.ahead = ahead;
			}
		}
	}

	const status = await execGit(pi, ctx, signal, ["status", "--short"]);
	if (status !== undefined && status !== "") {
		const lines = status.split("\n").filter((line) => line.trim().length > 0);
		facts.uncommittedTotal = lines.length;
		facts.uncommitted = lines.slice(0, 30);
	}

	// Commits: since the previous compaction when known, else the most recent ones.
	const range = previousHeadSha && (await execGit(pi, ctx, signal, ["rev-parse", "--verify", "--quiet", previousHeadSha])) !== undefined
		? `${previousHeadSha}..HEAD`
		: undefined;
	if (range !== undefined) {
		facts.commitsSincePrevious = true;
		const log = await execGit(pi, ctx, signal, ["log", "--format=%h %s", "-n", "15", range]);
		facts.commits = parseCommits(log);
		const total = await execGit(pi, ctx, signal, ["rev-list", "--count", range]);
		facts.commitTotal = total !== undefined ? Number.parseInt(total, 10) || facts.commits.length : facts.commits.length;
	} else {
		const log = await execGit(pi, ctx, signal, ["log", "--format=%h %s", "-n", "15"]);
		facts.commits = parseCommits(log);
		facts.commitTotal = facts.commits.length;
	}

	// Changed files vs the merge base with the base branch.
	if (baseRef !== undefined) {
		const numstat = await execGit(pi, ctx, signal, ["diff", "--numstat", "--find-renames", `${baseRef}...HEAD`]);
		const nameStatus = await execGit(pi, ctx, signal, ["diff", "--name-status", "--find-renames", `${baseRef}...HEAD`]);
		const statusByPath = new Map<string, string>();
		for (const line of (nameStatus ?? "").split("\n")) {
			const match = /^([A-Z])\d*\t(.+)$/.exec(line);
			if (match) {
				statusByPath.set(match[2], match[1]);
			}
		}
		const files: GitFacts["files"] = [];
		for (const line of (numstat ?? "").split("\n")) {
			const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
			if (match) {
				files.push({
					path: match[3],
					added: match[1] === "-" ? 0 : Number.parseInt(match[1], 10),
					removed: match[2] === "-" ? 0 : Number.parseInt(match[2], 10),
					status: statusByPath.get(match[3]) ?? "M",
				});
			}
		}
		files.sort((a, b) => a.path.localeCompare(b.path));
		facts.filesTotal = files.length;
		facts.files = files.slice(-100);
	}
	return facts;
}

function parseCommits(log: string | undefined): { sha: string; subject: string }[] {
	if (!log) return [];
	return log
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const space = line.indexOf(" ");
			return { sha: space >= 0 ? line.slice(0, space) : line, subject: space >= 0 ? line.slice(space + 1) : "" };
		});
}

const commitLine = (commit: { sha: string; subject: string }) => `- ${commit.sha} ${commit.subject}`;
const fileLine = (file: GitFacts["files"][number]) => `- ${file.path} (${file.status}, +${file.added} −${file.removed})`;
const pathList = (paths: readonly string[]) => (paths.length === 0 ? "none" : paths.join(", "));

function repositoryLines(ground: GitFacts): string[] {
	if (!ground.available) {
		return [`(Could not read the repository state: ${ground.error ?? "unknown error"})`];
	}
	const lines = [`On branch ${ground.branch} at ${ground.head.slice(0, 12) || "unknown"}.`];
	lines.push(
		ground.baseKnown
			? `${ground.ahead} commit${ground.ahead === 1 ? "" : "s"} ahead of origin/${ground.base}, ${ground.behind} behind.`
			: "origin is not fetched; ahead/behind unavailable.",
	);
	lines.push(
		ground.uncommittedTotal === 0
			? "No uncommitted changes."
			: `Uncommitted changes (${ground.uncommittedTotal}): ${ground.uncommitted.slice(0, 30).join(", ")}${ground.uncommittedTotal > 30 ? ", …" : ""}`,
	);
	return lines;
}
/** A list of lines that may be shed oldest-first when the checkpoint's code-owned part exceeds its budget. */
interface Sheddable {
	lines: string[];
	label: string;
}

function listedSheddable(part: Sheddable, omitted: Map<Sheddable, number>, empty: string): string[] {
	const dropped = omitted.get(part) ?? 0;
	const lines = part.lines.length === 0 && dropped === 0 ? [empty] : [...part.lines];
	if (dropped > 0) {
		lines.unshift(`(${dropped} older ${part.label} left out to fit; ${RECALL_HISTORY} and git recover them)`);
	}
	return lines;
}

interface RenderCheckpointInput {
	git: GitFacts;
	files: { read: string[]; modified: string[] };
	words: string[];
	number: number;
	at: number;
	/** The summarizer's working state; undefined when none exists yet. */
	body: string | undefined;
	/** Carried-forward note when the summarizer failed, or a cut-adjustment/condense note. */
	notes: string[];
	compacted: { first: string; last: string } | undefined;
	cut: string;
	cwd: string;
	sessionFile: string;
	tokensBefore: number;
	window: number;
	isSplitTurn: boolean;
	checkpointCount: number;
	budgetTokens: number;
}

/**
 * The checkpoint text. The code-owned part fits `budgetTokens` (a share of the model's
 * window): over it, lists are shed oldest first, in this order: files read, files modified,
 * the changed-file list, the commit list. The person's words, the session and repository
 * state and the working state are never shed; the working state is bounded by the
 * summarizer's output limit instead.
 */
function renderCheckpoint(input: RenderCheckpointInput): string {
	const readList: Sheddable = { lines: [...input.files.read], label: "files read" };
	const modifiedList: Sheddable = { lines: [...input.files.modified], label: "files modified" };
	const fileList: Sheddable = { lines: input.git.files.map(fileLine), label: "changed files" };
	const commitList: Sheddable = { lines: input.git.commits.map(commitLine), label: "commits" };
	const shedOrder = [readList, modifiedList, fileList, commitList];
	const omitted = new Map<Sheddable, number>();

	const working = [
		...input.notes.map((note) => `(mirastyle-compaction: ${note})`),
		...(input.notes.length === 0 ? [] : [""]),
		input.body ??
			"No working state has been written yet. Work from the repository state, the files above and the messages after this checkpoint.",
	].join("\n");

	const facts = (): string =>
		[
			`mirastyle-compaction compacted this session's earlier context into checkpoint ${input.number}, at ${new Date(input.at).toISOString()}. The files on disk and the messages after this checkpoint are newer than it: where they disagree with it, they win.`,
			"",
			"## Before you act",
			"1. Re-establish ground truth: run `git status` and `git log --oneline -10`, and compare them with the work queue below.",
			"2. Re-read any file before you edit it: this checkpoint describes files, it does not hold them.",
			"3. Do not redo work marked done, and do not ask again what the person already answered below.",
			`4. Anything missing here is still in the full history: use ${RECALL_HISTORY} with a query (a file name, an error, a number) or an entry number.`,
			"",
			"## The person's words, verbatim, oldest first",
			...wordLines(input.words),
			"",
			"## Session",
			...sessionLines(input),
			"",
			"## Repository, computed at compaction",
			...repositoryLines(input.git),
			`${input.git.commitsSincePrevious ? "Commits since the last compaction" : "Most recent commits"} (${input.git.commitTotal}${input.git.commitsSincePrevious ? " since then" : ""}; \`git log\` shows them all):`,
			...listedSheddable(commitList, omitted, "- none yet"),
			`Files changed vs origin/${input.git.baseKnown ? input.git.base : "?"} merge-base (${input.git.filesTotal}; \`git diff --stat\` shows them):`,
			...listedSheddable(fileList, omitted, "- none yet"),
			"",
			"## Files you read and modified with your file tools",
			`Read: ${listedSheddable(readList, omitted, "none").join(", ")}`,
			`Modified: ${listedSheddable(modifiedList, omitted, "none").join(", ")}`,
		].join("\n");
	const recovery = [
		"## Recovery",
		`The context continues verbatim from entry ${input.cut}.${input.compacted === undefined ? "" : ` This compaction covered entries ${input.compacted.first} to ${input.compacted.last}.`} Every entry is still stored: ${RECALL_HISTORY} searches and reads them. Session file: ${input.sessionFile}`,
	].join("\n");
	const render = () => [facts(), "", "## Working state, written at compaction", working, "", recovery].join("\n");

	const budgetChars = input.budgetTokens * 4;
	const ownLength = () => render().length - working.length;
	for (const part of shedOrder) {
		while (ownLength() > budgetChars && part.lines.length > 0) {
			// Drop from the end (the oldest of what is listed) in quarter-line batches.
			const drop = Math.max(1, Math.ceil(part.lines.length / 4));
			part.lines.splice(-drop, drop);
			omitted.set(part, (omitted.get(part) ?? 0) + drop);
		}
		if (ownLength() <= budgetChars) break;
	}
	return render();
}

function wordLines(words: string[]): string[] {
	if (words.length === 0) return ["(none)"];
	return words.map((word, index) => `[${index + 1}]\n"""\n${word}\n"""`);
}

function sessionLines(input: RenderCheckpointInput): string[] {
	const percent = input.window > 0 ? Math.round((input.tokensBefore / input.window) * 100) : 0;
	return [
		`Session file: ${input.sessionFile}`,
		`Working directory: ${input.cwd}`,
		`Context at compaction: ${input.tokensBefore} tokens (~${percent}% of a ${input.window}-token window).`,
		`Split turn: ${input.isSplitTurn ? "yes" : "no"}.`,
		`Checkpoint number in this session: ${input.checkpointCount}.`,
	];
}
const SYSTEM_PROMPT = `You are the compaction engine of a coding agent that works on a person's repository. Your output is not a chat reply. It is the working state of an engineering checkpoint: the same agent continues from it after its older context is removed.

Think of the session as a hurdle race. The checkpoint records the race so far: what was attempted, decided, changed and learned, and why. The entries kept verbatim after it are the runner's short runway into the next hurdle: just enough live context to regain stride, not a replay of the race.

You are given:
- <previous_checkpoint>, after the first compaction: the working state written last time. Treat it as frozen history and evolve it.
- <computed_facts>: computed by mirastyle-compaction from its records and the workspace: the person's words verbatim, the session's state, the repository's state, and the files read and modified. mirastyle-compaction puts them in the checkpoint unchanged, so rely on them and do not restate them.
- <agent_handoff>, when present: the agent's own first-person note, written just now, on what it is doing, what it learned and its exact next step. It is the freshest account, and it stays verbatim after the checkpoint. Use it, and do not copy it.
- <new_history_to_compact>: entries this checkpoint replaces. Integrate all of them.
- <split_turn_prefix>, when the compaction splits a turn: the prefix of the split turn. Integrate it too.
- <kept_recent_context>: the entries after them, as boundary evidence. You choose where the verbatim runway starts among them.
- <user_compaction_instructions>, when the person supplied /compact instructions: treat them as high-priority human guidance about what to emphasize.

Rules:
- Write one complete successor checkpoint, not a delta. Keep what still holds from the previous checkpoint, correct what newer entries contradict, and update completed and pending work.
- Integrate every entry before your cut: those entries leave the context. Do not recap entries at or after your cut; they stay verbatim.
- STATE AT COMPACTION BOUNDARY, WORK QUEUE and OPEN THREADS must reflect the newest evidence, including <kept_recent_context> and <agent_handoff>. Do not leave stale claims such as "not implemented yet" when later entries show otherwise.
- Separate verified facts, the person's requirements and your inferences. Do not invent file contents, test results, commands, decisions or failures.
- Keep exact file paths, symbols, commands, error messages, test names and identifiers. Point to large content (a path and lines, a command to rerun, or an entry number, which ${RECALL_HISTORY} reads) instead of copying it.
- Include substantive tool activity: commands and tests with their outcomes, failures, decisions and observations that changed the plan. Do not list every routine call.
- Use bounded phrasing such as "as of this checkpoint" or "during the compacted range". No greetings, praise or filler.
- Do not write the sections the extension computes itself (Before you act, the person's words, Session, Repository, Files). Write only the eight sections below.

Cut-point strategy:
- The cut is the first entry kept verbatim. Choose an entry ID from <kept_recent_context> marked valid_cutpoint="true"; nothing else is accepted.
- Prefer a message from the person, if one is in range: it gives the agent a concrete instruction.
- Keep at least one coherent unit: a request and its response, or the start of the current action. Do not leave the agent looking at an orphaned result.
- Between tasks, cut late: routine reads, searches and edits are safe to summarize, since their outcomes are on disk and in the checkpoint. Mid-task, keep the active instruction and the partial results or errors needed to finish the current step.
- The extension caps how much is kept and may move your cut later. Write as if your cut is honoured.

Condensing, optional: a tool result at or after your cut that the agent no longer needs verbatim, such as a long log whose outcome you recorded, can be condensed. The extension replaces its content, in what the agent sees, with your one-line note and a pointer to the full result. Only tool results can be condensed, and never the handoff note's.

Reply in exactly this form, without a code fence. Leave out <condense> when you condense nothing.

<cutpoint_decision>
<recommended_cut_before_entry_id>ENTRY_ID</recommended_cut_before_entry_id>
<cutpoint_reasoning>One sentence on why this cut lets the agent continue.</cutpoint_reasoning>
</cutpoint_decision>
<condense>
<tool_result entry_id="ENTRY_ID">One line on what the result showed.</tool_result>
</condense>

STATE AT COMPACTION BOUNDARY:
- Active task:
- Most recent request from the person:
- Current implementation state:
- Context needed to continue:

EVIDENCE TIERS:
- Verified from session and tool history:
- Requirements the person stated:
- Inferences:

CODE REFERENCES:
- Files and paths:
- Symbols, functions and types:
- Config keys, constants and identifiers:
- Verbatim error messages, command lines and test names (lookup strings only):

DECISIONS AND RATIONALE:
- Decisions made:
- Rationale:
- Ruled out:

COMMANDS, TESTS, AND FAILURES:
- Commands run:
- Tests run:
- Current failures:
- Validation still pending:

WORK QUEUE:
- Completed:
- In progress:
- Next exact steps:
- Blockers:
- Risks:

OPEN THREADS:
- Unresolved requests:
- Pending actions:
- Open questions:

COMPACTED HISTORY SYNOPSIS:
One paragraph on the arc of the session: what kind of work happened, the major turns, and why the approach changed. Leave specifics to the sections above.`;

const FIRST_SECTION = "STATE AT COMPACTION BOUNDARY:";

interface CondenseRequest {
	entryId: string;
	note: string;
}

interface SummarizerReply {
	cut?: string;
	reasoning: string;
	condense: CondenseRequest[];
	body: string;
}

/** The condensed replacement for a kept tool result: same call id and name, only the content changes. */
function condensedReplacement(entry: SessionEntry, note: string): ToolResultMessage | undefined {
	const message = messageFromEntry(entry);
	if (!message || message.role !== "toolResult") return undefined;
	const text = `[Condensed at compaction: ${note} The full result is entry ${entry.id}; ${RECALL_HISTORY} reads it.]`;
	return { ...message, content: [{ type: "text" as const, text }] };
}

/** Replacements for the tool results the summarizer asked to condense, keyed by entry ID. Only kept tool results, never the handoff note's. */
function buildCondensed(
	keptEntries: SessionEntry[],
	requests: readonly CondenseRequest[],
): Map<string, ToolResultMessage[]> {
	const replaced = new Map<string, ToolResultMessage[]>();
	const kept = new Map(keptEntries.map((entry) => [entry.id, entry]));
	for (const request of requests) {
		const note = request.note.trim();
		if (note === "") continue;
		const entry = kept.get(request.entryId);
		if (!entry) continue;
		const message = messageFromEntry(entry);
		if (!message || message.role !== "toolResult") continue;
		if (message.toolName === WRITE_HANDOFF) continue;
		const replacement = condensedReplacement(entry, note);
		if (replacement) replaced.set(entry.id, [replacement]);
	}
	return replaced;
}

/** Estimated tokens of an entry under the condensed-replacement map (falls back to the entry's own estimate). */
function replacedTokenMap(entries: SessionEntry[], replaced: ReadonlyMap<string, ToolResultMessage[]>): Map<string, number> {
	const out = new Map<string, number>();
	for (const entry of entries) {
		const replacement = replaced.get(entry.id);
		if (!replacement) continue;
		const chars = messagesText(replacement).length;
		out.set(entry.id, Math.max(1, Math.ceil(chars / 4)));
	}
	return out;
}

function stripAccidentalWrapper(summary: string): string {
	return summary
		.replace(/^```(?:xml|text)?\s*/i, "")
		.replace(/```\s*$/i, "")
		.replace(/^<pi:mirastyle_compacted_coding_context[^>]*>/i, "")
		.replace(/<\/pi:mirastyle_compacted_coding_context>\s*$/i, "")
		.trim();
}

/** The decision block, the condense list and the body, or undefined when the body is missing. */
function parseReply(text: string): SummarizerReply | undefined {
	const cleaned = stripAccidentalWrapper(text);
	const cut = /<recommended_cut_before_entry_id>\s*([^<\s]+)\s*<\/recommended_cut_before_entry_id>/i.exec(cleaned)?.[1];
	const reasoning = /<cutpoint_reasoning>([\s\S]*?)<\/cutpoint_reasoning>/i.exec(cleaned)?.[1]?.trim() ?? "";
	const condenseBlock = /<condense>([\s\S]*?)<\/condense>/i.exec(cleaned)?.[1] ?? "";
	const condense: CondenseRequest[] = [];
	for (const match of condenseBlock.matchAll(/<tool_result\s+entry_id="([^"]+)"\s*>([\s\S]*?)<\/tool_result>/gi)) {
		const note = (match[2] ?? "").trim().replace(/\s+/g, " ");
		if (note !== "") condense.push({ entryId: match[1], note });
	}
	const start = cleaned.indexOf(FIRST_SECTION);
	if (start === -1) return undefined;
	let body = cleaned.slice(start).trim();
	// Drop a trailing wrapper block the model may have appended after the sections.
	body = body.replace(/<\/pi:mirastyle_compacted_coding_context>\s*$/i, "").trim();
	return cut === undefined ? { reasoning, condense, body } : { cut, reasoning, condense, body };
}

/** Extract the raw working state from a previous compaction's details, when present. */
function previousWorkingState(branchEntries: SessionEntry[]): string | undefined {
	return previousCompactionDetails(branchEntries)?.workingState;
}
function computedFactsBlock(input: {
	words: string[];
	git: GitFacts;
	sessionFile: string;
	cwd: string;
	tokensBefore: number;
	window: number;
	isSplitTurn: boolean;
	checkpointNumber: number;
	compactedFileOps: FileOps;
	keptFileOps: FileOps;
}): string {
	const compacted = computeFileLists(input.compactedFileOps);
	const kept = computeFileLists(input.keptFileOps);
	const commitLines = input.git.commits.length === 0 ? ["- none yet"] : input.git.commits.map(commitLine);
	const fileLines = input.git.files.length === 0 ? ["- none yet"] : input.git.files.map(fileLine);
	return [
		"The person's words, verbatim, oldest first:",
		...(input.words.length === 0 ? ["(none)"] : input.words.map((word, index) => `[${index + 1}]\n"""\n${word}\n"""`)),
		"",
		"Session:",
		`Session file: ${input.sessionFile}`,
		`Working directory: ${input.cwd}`,
		`Context at compaction: ${input.tokensBefore} tokens.`,
		`Split turn: ${input.isSplitTurn ? "yes" : "no"}.`,
		`Checkpoint number in this session: ${input.checkpointNumber}.`,
		"",
		"Repository:",
		...repositoryLines(input.git),
		`${input.git.commitsSincePrevious ? "Commits since the last compaction" : "Most recent commits"} (${input.git.commitTotal}):`,
		...commitLines,
		`Files changed vs origin/${input.git.baseKnown ? input.git.base : "?"} merge-base (${input.git.filesTotal}):`,
		...fileLines,
		"",
		`Files read, compacted range: ${pathList(compacted.readFiles)}`,
		`Files modified, compacted range: ${pathList(compacted.modifiedFiles)}`,
		`Files read, kept range: ${pathList(kept.readFiles)}`,
		`Files modified, kept range: ${pathList(kept.modifiedFiles)}`,
	].join("\n");
}

function buildUserPrompt(input: {
	previousWorkingState: string | undefined;
	previousSummary: string | undefined;
	computedFacts: string;
	handoff: string | undefined;
	newHistory: string;
	turnPrefix: string;
	keptRecentContext: string;
	customInstructions: string | undefined;
	defaultFirstKeptEntryId: string;
	tokensBefore: number;
	isSplitTurn: boolean;
	window: number;
}): string {
	// Prefer the raw working state chained through compaction details; the wrapped
	// previous checkpoint is only a fallback for checkpoints written before this version.
	const previousBody = input.previousWorkingState ?? input.previousSummary;
	const previousLabel = input.previousWorkingState !== undefined
		? "The previous checkpoint's working state"
		: "The previous checkpoint (written before working state was tracked separately)";
	const previousSection = previousBody
		? `<previous_checkpoint>\n${previousBody}\n</previous_checkpoint>\n\n`
		: "";

	const customInstructionsSection = input.customInstructions?.trim()
		? `<user_compaction_instructions priority="high" source="human">
IMPORTANT: The person explicitly supplied custom compaction instructions for this checkpoint.
You must take them into account prominently when deciding what details to preserve, emphasize, and describe.
Follow them unless they conflict with the required output format, the computed facts, or newer session evidence.

${input.customInstructions.trim()}
</user_compaction_instructions>

`
		: "";

	const customInstructionsReminder = input.customInstructions?.trim()
		? "\nCUSTOM INSTRUCTION PRIORITY: The human-provided <user_compaction_instructions> above is high priority and should materially affect checkpoint emphasis and retained detail."
		: "";

	return `${previousSection}${customInstructionsSection}<computed_facts>
${input.computedFacts}
</computed_facts>

${input.handoff ? `<agent_handoff>\n${input.handoff}\n</agent_handoff>\n\n` : ""}<new_history_to_compact>
${input.newHistory}
</new_history_to_compact>

<split_turn_prefix>
${input.turnPrefix}
</split_turn_prefix>

<kept_recent_context boundary_reference="true">
These entries start at Pi's default fallback first kept entry ID. They are included as boundary evidence, but your <recommended_cut_before_entry_id> controls the final verbatim retention point. Use them to compute STATE AT COMPACTION BOUNDARY, WORK QUEUE, OPEN THREADS, and validation status accurately. If you recommend a later cut point, integrate any earlier boundary entries into the checkpoint because they will not remain verbatim. If they contradict older checkpoint claims about current work state, they win.

${input.keptRecentContext}
</kept_recent_context>

<cutpoint_recommendation_instructions>
Follow the cut-point strategy from the system prompt. Choose only an ID from an <entry> marked valid_cutpoint="true". Keep the short runway needed for the next action; summarize completed context instead of retaining a long replay. ${previousLabel} is included only when present.
</cutpoint_recommendation_instructions>${customInstructionsReminder}
Output the cut-point decision block first, then the eight checkpoint sections using the exact section structure from the system prompt. Do not write the code-owned sections. Do not include wrapper XML tags other than the decision and condense blocks. Do not include a raw per-tool-call history list.`;
}

function selectCutpoint(
	branchEntries: SessionEntry[],
	defaultFirstKeptEntryId: string,
	recommendedEntryId: string | undefined,
	presentedCutpointIds: Set<string>,
	replaced?: ReadonlyMap<string, number>,
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

	const retainedTokenEstimate = estimateRetainedTokens(branchEntries, recommendedEntryId, replaced);
	if (retainedTokenEstimate > MAX_MODEL_SELECTED_RETAINED_TOKENS) {
		const cappedEntryId = findCappedCutpointId(branchEntries, presentedCutpointIds, replaced);
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

function wrapSummary(input: {
	body: string;
	compactedAt: string;
	firstKeptEntryId: string;
	tokensBefore: number;
}): string {
	return `<pi:mirastyle_compacted_coding_context compacted_at="${input.compactedAt}" first_kept_entry_id="${input.firstKeptEntryId}" tokens_before="${input.tokensBefore}">
HISTORICAL CODING CHECKPOINT. Current filesystem state and later conversation are more authoritative. If conflicts arise, reread files and trust on-disk contents.

${input.body.trim()}
</pi:mirastyle_compacted_coding_context>`;
}

/** The handoff note from a write_handoff tool call in the given entries, if any. Uses the last one. */
function findHandoffNote(entries: SessionEntry[]): string | undefined {
	let note: string | undefined;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const content = (entry.message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (typeof block !== "object" || block === null) continue;
			const call = block as { type?: string; name?: string; arguments?: Record<string, unknown> };
			if (call.type === "toolCall" && call.name === WRITE_HANDOFF && typeof call.arguments?.text === "string" && call.arguments.text.trim() !== "") {
				note = call.arguments.text;
			}
		}
	}
	return note;
}
function recallHistoryTool() {
	return {
		name: RECALL_HISTORY,
		label: "Recall history",
		description:
			"Search or read this session's full history, including everything from before a compaction. Give `query` (words that must all appear, such as a file name, an error message or a number) to find entries, or `entry` (an entry ID from a search or a compaction checkpoint) to read one in full.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
			entry: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
		}),
		async execute(_toolCallId: string, params: { query?: string; entry?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionToolContext) {
			const entries: SessionEntry[] = ctx.sessionManager.getEntries();

				if (params.entry !== undefined) {
				const wanted = params.entry;
				const found = entries.find((entry) => entry.id === wanted);
				if (!found) {
					return { content: [{ type: "text" as const, text: `No entry ${wanted} in this session.` }], details: { matches: 0 }, isError: true };
				}
				const text = entryText(found);
				const shown = text.length > MAX_ENTRY_TEXT ? `${text.slice(0, MAX_ENTRY_TEXT)}\n[… ${text.length - MAX_ENTRY_TEXT} more characters]` : text;
				return { content: [{ type: "text" as const, text: `Entry ${found.id} (${found.type}):\n${shown}` }], details: { matches: 1 } };
			}

			if (params.query === undefined) {
				return { content: [{ type: "text" as const, text: "Give a query to search for, or an entry number to read." }], details: { matches: 0 }, isError: true };
			}

			const terms = params.query.toLowerCase().split(/\s+/).filter((term) => term !== "");
			const matches: string[] = [];
			// Newest first.
			for (let i = entries.length - 1; i >= 0 && matches.length < RECALL_MATCHES; i--) {
				const entry = entries[i];
				const text = entryText(entry);
				if (text.trim().length === 0) continue;
				const lower = text.toLowerCase();
				if (!terms.every((term) => lower.includes(term))) continue;
				const at = lower.indexOf(terms[0] ?? "");
				const start = Math.max(0, at - RECALL_SNIPPET / 2);
				const snippet = text.slice(start, start + RECALL_SNIPPET).replace(/\s+/g, " ");
				matches.push(`Entry ${entry.id} (${entry.type}): …${snippet}…`);
			}
			const text = matches.length === 0
				? `Nothing in this session's history contains all of: ${terms.join(", ")}.`
				: `Newest first. Read one in full with ${RECALL_HISTORY} and its entry ID.\n${matches.join("\n")}`;
			return { content: [{ type: "text" as const, text }], details: { matches: matches.length } };
		},
	};
}

function writeHandoffTool() {
	return {
		name: WRITE_HANDOFF,
		label: "Write handoff",
		description:
			"Only when mirastyle-compaction asks for it, just before your context is compacted: save a short first-person note on how you are doing right now. It stays in your context after the compaction.",
		parameters: Type.Object({
			text: Type.String({
				minLength: 1,
				maxLength: MAX_HANDOFF_CHARS,
				description:
					"About 300 words at most: what you are doing and where you are, what you just learned or decided, your exact next step and why, and what you are unsure of or watching for",
			}),
		}),
		async execute() {
			return { content: [{ type: "text" as const, text: "Saved" }], details: {} };
		},
	};
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
					headers: stringHeaders(auth.headers),
					env: auth.env as Record<string, string> | undefined,
					selectionReason: "configured",
				};
			}
			notifyUi(ctx, `${EXTENSION_NAME}: configured model auth failed (${(auth as { error?: string }).error ?? "unknown error"}); trying active model`, "warning");
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
		notifyUi(ctx, `${EXTENSION_NAME}: active model auth failed (${(activeAuth as { error?: string }).error ?? "unknown error"}); using Pi default compaction`, "warning");
		return undefined;
	}

	return {
		model: ctx.model,
		apiKey: activeAuth.apiKey,
		headers: stringHeaders(activeAuth.headers),
		env: activeAuth.env as Record<string, string> | undefined,
		selectionReason: "active-model-fallback",
	};
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
interface CompactionArtifactsInput {
	branchEntries: SessionEntry[];
	firstKeptEntryId: string;
	isSplitTurn: boolean;
	tokensBefore: number;
	previousSummary?: string;
	customInstructions?: string;
	signal?: AbortSignal;
	/** Include the handoff note scan (defaults to true). */
	scanHandoffNote?: boolean;
}

interface CompactionArtifacts {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details: MirastyleCompactionDetails;
	/** Context-edit drafts for condensed kept tool results. */
	condenseEdits: { targetId: string; content: { type: "text"; text: string }[] }[];
	usage?: Awaited<ReturnType<typeof completeSimple>>["usage"];
}

/**
 * Build the checkpoint for a compaction: code-computed facts, the summarizer's working state
 * (carried forward unchanged when the summarizer fails), the model-selected cut (validated
 * against the cap, counting condensed replacements), and the condense edits for kept tool
 * results. Shared by the Pi-initiated compaction path (session_before_compact) and this
 * extension's own cycle (agent_before_settle).
 */
async function buildCompactionArtifacts(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	input: CompactionArtifactsInput,
): Promise<CompactionArtifacts | undefined> {
	const { branchEntries, signal } = input;
	const defaultFirstKeptEntryId = input.firstKeptEntryId;
	const window = ctx.model?.contextWindow ?? DEFAULT_WINDOW;

	const fileOpsAtDefault = computeFileOpsForCutpoint(branchEntries, defaultFirstKeptEntryId);
	const words = collectPersonWords(branchEntries);
	const prevDetails = previousCompactionDetails(branchEntries);
	const git = await groundTruth(pi, ctx, signal ?? new AbortController().signal, prevDetails?.headSha);
	const sessionFile = ctx.sessionManager.getSessionFile() ?? "In-memory or unsaved session.";
	const compactedAt = new Date().toISOString();
	const checkpointNumberValue = compactionNumber(branchEntries);
	const { newHistoryEntries, turnPrefixEntries, retainedEntries } = getPreparedEntryRanges(
		branchEntries,
		defaultFirstKeptEntryId,
		input.isSplitTurn,
	);
	const handoffNote = input.scanHandoffNote === false ? undefined : findHandoffNote(retainedEntries);

	const selected = await resolveModelAuth(pi, ctx);
	if (!selected) {
		// No model at all: the caller falls back to Pi's default compaction (or settles).
		return undefined;
	}

	const summarizerWindow = selected.model.contextWindow > 0 ? selected.model.contextWindow : window;
	const promptBudgetChars = Math.max(16_000, Math.floor(summarizerWindow * 4 * PROMPT_SHARE));
	const validKept = (index: number): boolean => {
		const entry = retainedEntries[index];
		return entry !== undefined && isValidCutpointEntry(entry);
	};
	const kept = keptContextText(retainedEntries, validKept, Math.floor(promptBudgetChars / 3));
	const newHistory = historyText(newHistoryEntries, Math.max(2_000, promptBudgetChars - kept.text.length));
	const turnPrefix = input.isSplitTurn
		? historyText(turnPrefixEntries, Math.floor(promptBudgetChars / 3))
		: "None captured. This compaction did not split a turn.";

	const computedFacts = computedFactsBlock({
		words,
		git,
		sessionFile,
		cwd: ctx.cwd,
		tokensBefore: input.tokensBefore,
		window,
		isSplitTurn: input.isSplitTurn,
		checkpointNumber: checkpointNumberValue,
		compactedFileOps: fileOpsAtDefault.compactedFileOps,
		keptFileOps: fileOpsAtDefault.retainedFileOps,
	});

	const previousBody = prevDetails?.workingState;
	const effectiveSystemPrompt = input.customInstructions?.trim()
		? `${SYSTEM_PROMPT}

If <user_compaction_instructions> is present, treat it as high-priority human guidance about what to emphasize, preserve, and describe in extra detail. Follow it unless it conflicts with the required output format, the computed facts, or newer session evidence.`
		: SYSTEM_PROMPT;

	const userPrompt = buildUserPrompt({
		previousWorkingState: previousBody,
		previousSummary: input.previousSummary,
		computedFacts,
		handoff: handoffNote,
		newHistory,
		turnPrefix,
		keptRecentContext: kept.text,
		customInstructions: input.customInstructions,
		defaultFirstKeptEntryId,
		tokensBefore: input.tokensBefore,
		isSplitTurn: input.isSplitTurn,
		window,
	});

	notifyUi(
		ctx,
		`${EXTENSION_NAME}: generating coding checkpoint with ${selected.model.provider}/${selected.model.id}`,
		"info",
	);

	let reply: SummarizerReply | undefined;
	let problem: string | undefined;
	let usage: Awaited<ReturnType<typeof completeSimple>>["usage"] | undefined;
	try {
		const maxTokens = Math.min(
			MAX_SUMMARY_OUTPUT_TOKENS,
			selected.model.maxTokens > 0 ? selected.model.maxTokens : MAX_SUMMARY_OUTPUT_TOKENS,
		);
		const response = await completeSimple(
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

		usage = response.usage;
		if (response.stopReason === "error") {
			problem = response.errorMessage ?? "unknown provider error";
		} else {
			const rawBody = response.content
				.filter((content): content is { type: "text"; text: string } => content.type === "text")
				.map((content) => content.text)
				.join("\n")
				.trim();
			reply = parseReply(rawBody);
			if (!reply) {
				problem = "the reply had no checkpoint sections";
			}
		}
	} catch (error) {
		if (signal?.aborted) {
			throw error; // caller maps this to "cancelled"
		}
		problem = error instanceof Error ? (error.message.split("\n")[0] ?? "the request failed") : String(error);
	}

	// Condense what the summarizer flagged, then choose the cut (condensed results
	// count as their replacements against the retained-token cap).
	const condenseRequests = reply?.condense ?? [];
	const replaced = buildCondensed(retainedEntries, condenseRequests);
	const replacedTokens = replacedTokenMap(retainedEntries, replaced);
	const cut = selectCutpoint(branchEntries, defaultFirstKeptEntryId, reply?.cut, kept.presented, replacedTokens);
	if (!signal?.aborted) {
		const isFallback = cut.selectionReason === "fallback";
		notifyUi(
			ctx,
			`${EXTENSION_NAME}: ${isFallback ? "using fallback" : "using model-selected"} cut point ${cut.selectedFirstKeptEntryId}`,
			isFallback ? "warning" : "info",
		);
	}

	const selectedRetainedEntries = getRetainedRecentEntries(branchEntries, cut.selectedFirstKeptEntryId);
	const selectedRetainedMessages = getRetainedRecentMessages(branchEntries, cut.selectedFirstKeptEntryId);
	const selectedRetainedIds = new Set(selectedRetainedEntries.map((entry) => entry.id));
	const condensed: { entryId: string; note: string }[] = [];
	const refusedCondense = new Set<string>();
	const condenseEdits: { targetId: string; content: { type: "text"; text: string }[] }[] = [];
	for (const [entryId, messages] of replaced) {
		if (!selectedRetainedIds.has(entryId)) {
			refusedCondense.add(`${entryId} (cut before it)`);
			continue;
		}
		const replacement = messages[0];
		const first = replacement?.content[0];
		const text = first && first.type === "text" ? first.text : "";
		if (text === "") {
			refusedCondense.add(`${entryId} (empty replacement)`);
			continue;
		}
		condenseEdits.push({ targetId: entryId, content: [{ type: "text", text }] });
		condensed.push({ entryId, note: condenseRequests.find((request) => request.entryId === entryId)?.note ?? "" });
	}
	for (const request of condenseRequests) {
		if (!replaced.has(request.entryId)) {
			refusedCondense.add(request.entryId);
		}
	}

	const fileOps = computeFileOpsForCutpoint(branchEntries, cut.selectedFirstKeptEntryId);
	const allLists = computeFileLists(fileOps.allFileOps);
	const compactedLists = computeFileLists(fileOps.compactedFileOps);
	const retainedLists = computeFileLists(fileOps.retainedFileOps);

	const notes: string[] = [];
	if (!reply) {
		notes.push(`the working state was not updated at this compaction (${problem ?? "no usable reply"}); it is the previous one, carried forward unchanged.`);
	}
	if (cut.selectionReason !== "model") {
		notes.push(`CUTPOINT ADJUSTMENT NOTE: ${cut.validationMessage} Final first kept entry ID: ${cut.selectedFirstKeptEntryId}. Summarizer recommended: ${cut.recommendedFirstKeptEntryId ?? "none returned."}`);
	}
	if (refusedCondense.size > 0) {
		notes.push(`Kept verbatim instead of condensed (not a kept tool result that may be condensed): ${[...refusedCondense].join(", ")}.`);
	}
	if (condensed.length > 0) {
		notes.push(`Condensed ${condensed.length} kept tool result(s) to one-line pointers; ${RECALL_HISTORY} reads the originals.`);
	}

	const boundaryStart = getBoundaryStartIndex(branchEntries);
	const cutIndex = findEntryIndexById(branchEntries, cut.selectedFirstKeptEntryId);
	const compactedEntries = branchEntries
		.slice(boundaryStart, cutIndex >= 0 ? cutIndex : branchEntries.length)
		.filter(entryHasText);
	const compactedRange =
		compactedEntries.length > 0
			? { first: compactedEntries[0].id, last: compactedEntries[compactedEntries.length - 1].id }
			: undefined;

	const body = reply?.body ?? previousBody;
	const checkpointBody = renderCheckpoint({
		git,
		files: { read: allLists.readFiles, modified: allLists.modifiedFiles },
		words,
		number: checkpointNumberValue,
		at: Date.now(),
		body,
		notes,
		compacted: compactedRange,
		cut: cut.selectedFirstKeptEntryId,
		cwd: ctx.cwd,
		sessionFile,
		tokensBefore: input.tokensBefore,
		window,
		isSplitTurn: input.isSplitTurn,
		checkpointCount: checkpointNumberValue,
		budgetTokens: Math.max(2_000, Math.round(window * FACTS_SHARE)),
	});

	const summary = wrapSummary({
		body: checkpointBody,
		compactedAt,
		firstKeptEntryId: cut.selectedFirstKeptEntryId,
		tokensBefore: input.tokensBefore,
	});

	const details: MirastyleCompactionDetails = {
		extension: EXTENSION_NAME,
		version: SUMMARY_VERSION,
		generatedAt: compactedAt,
		readFiles: allLists.readFiles,
		modifiedFiles: allLists.modifiedFiles,
		compactedReadFiles: compactedLists.readFiles,
		compactedModifiedFiles: compactedLists.modifiedFiles,
		retainedReadFiles: retainedLists.readFiles,
		retainedModifiedFiles: retainedLists.modifiedFiles,
		retainedMessageCount: selectedRetainedMessages.length,
		retainedReferenceChars: kept.text.length,
		checkpointNumber: checkpointNumberValue,
		headSha: git.available ? git.head : undefined,
		workingState: body,
		handoffWritten: handoffNote !== undefined,
		condensed,
		model: {
			provider: selected.model.provider,
			id: selected.model.id,
			selectionReason: selected.selectionReason,
		},
		git: {
			isGitRepo: git.available,
			branch: git.branch,
			head: git.head,
			base: git.base,
			baseKnown: git.baseKnown,
			ahead: git.ahead,
			behind: git.behind,
			...(git.error === undefined ? {} : { error: git.error }),
		},
		cutpoint: cut,
	};

	return {
		summary,
		firstKeptEntryId: cut.selectedFirstKeptEntryId,
		tokensBefore: input.tokensBefore,
		details,
		condenseEdits,
		...(usage === undefined ? {} : { usage }),
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

	pi.registerTool(recallHistoryTool());
	pi.registerTool(writeHandoffTool());

	// Cycle state for this session. The extension factory is invoked per session runtime.
	let cycle: "idle" | "requested" = "idle";
	// Condense edits stashed by a Pi-initiated compaction; applied as append-only
	// context edits at the next turn boundary (session_before_compact cannot append entries).
	let pendingCondenseEdits: { targetId: string; content: { type: "text"; text: string }[] }[] = [];
	const resetCycle = () => {
		cycle = "idle";
	};

	pi.on("turn_end", async (event, ctx) => {
		// Apply any condense edits stashed by a Pi-initiated compaction at this boundary.
		if (pendingCondenseEdits.length > 0) {
			const pending = pendingCondenseEdits;
			pendingCondenseEdits = [];
			// Only edit targets that still exist in the branch; a context edit with a
			// missing target would throw inside the boundary commit.
			const branchIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
			const edits = pending.filter((edit) => branchIds.has(edit.targetId));
			if (edits.length === 0) {
				return undefined;
			}
			return {
				entries: edits.map((edit) => ({
					type: "context_edit" as const,
					targetId: edit.targetId,
					replacement: { content: edit.content },
				})),
			};
		}

		// Compaction cycle: past ~60% of the window (and below Pi's own backstop at 75%),
		// ask the agent for a handoff note once; compact when the run next settles,
		// whether or not it wrote the note.
		if (cycle !== "idle") {
			return;
		}
		const usage = ctx.getContextUsage();
		if (usage?.tokens == null || usage.contextWindow <= 0) {
			return;
		}
		const ratio = usage.tokens / usage.contextWindow;
		if (ratio < HANDOFF_TRIGGER || ratio >= BACKGROUND_TRIGGER) {
			return;
		}
		cycle = "requested";
		pi.sendMessage(
			{
				customType: CUSTOM_MESSAGE_TYPE,
				content: HANDOFF_REQUEST,
				display: true,
				details: { kind: "handoff-request" },
			},
			{ triggerTurn: true },
		);
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (cycle === "idle") {
			return undefined;
		}
		cycle = "idle";
		// Only auto-continue a normally completed run. If the person aborted or the
		// model errored out, leave the run alone; the next prompt picks everything up.
		if (event.outcome !== "completed") {
			return undefined;
		}

		const branchEntries = ctx.sessionManager.getBranch();
		if (branchEntries.length === 0) {
			return undefined;
		}
		const tokensBefore = ctx.getContextUsage()?.tokens ?? 0;
		// Our own cycle has no Pi-computed preparation: mirror Pi's default kept range
		// (~25% of the window) so the summarizer sees and may recommend any of it.
		const window = ctx.model?.contextWindow ?? DEFAULT_WINDOW;
		const fallbackCut = findDefaultKeptId(branchEntries, window);
		if (fallbackCut === undefined) {
			return undefined;
		}
		const artifacts = await buildCompactionArtifacts(pi, ctx, {
			branchEntries,
			firstKeptEntryId: fallbackCut,
			isSplitTurn: false,
			tokensBefore,
			signal: undefined,
		});
		if (!artifacts) {
			// No model at all: let the run settle normally; Pi's own compaction (if any) is the backstop.
			return undefined;
		}
		const drafts = [
			{
				type: "compaction" as const,
				summary: artifacts.summary,
				firstKeptEntryId: artifacts.firstKeptEntryId,
				details: artifacts.details,
				...(artifacts.usage === undefined ? {} : { usage: artifacts.usage }),
			},
			...artifacts.condenseEdits.map((edit) => ({
				type: "context_edit" as const,
				targetId: edit.targetId,
				replacement: { content: edit.content },
			})),
			{
				type: "custom_message" as const,
				customType: CUSTOM_MESSAGE_TYPE,
				content: RESUME_MESSAGE,
				display: true,
				details: { kind: "resume" },
			},
		];
		return { entries: drafts, continue: true };
	});

	pi.on("session_compact_failed", (event, ctx) => {
		resetCycle();
		pendingCondenseEdits = [];
		notifyUi(ctx, `${EXTENSION_NAME}: compaction failed${event.errorMessage ? ` (${event.errorMessage})` : ""}`, "warning");
	});

	pi.on("session_shutdown", () => {
		resetCycle();
		pendingCondenseEdits = [];
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, customInstructions, signal, branchEntries } = event;
		if (signal.aborted) {
			return { cancel: true };
		}
		try {
			const artifacts = await buildCompactionArtifacts(pi, ctx, {
				branchEntries,
				firstKeptEntryId: preparation.firstKeptEntryId,
				isSplitTurn: preparation.isSplitTurn,
				tokensBefore: preparation.tokensBefore,
				previousSummary: preparation.previousSummary,
				customInstructions,
				signal,
			});
			if (!artifacts) {
				// No model at all: let Pi's default compaction run.
				return;
			}
			pendingCondenseEdits = artifacts.condenseEdits;
			return {
				compaction: {
					summary: artifacts.summary,
					firstKeptEntryId: artifacts.firstKeptEntryId,
					tokensBefore: artifacts.tokensBefore,
					...(artifacts.usage === undefined ? {} : { usage: artifacts.usage }),
					details: artifacts.details,
				},
			};
		} catch (error) {
			if (signal.aborted) {
				return { cancel: true };
			}
			const message = error instanceof Error ? error.message : String(error);
			notifyUi(ctx, `${EXTENSION_NAME}: custom compaction failed (${message}); using Pi default compaction`, "warning");
			return;
		}
	});
}
