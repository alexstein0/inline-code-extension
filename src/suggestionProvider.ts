import * as vscode from 'vscode';
import { ModelClient } from './modelClient';
import { DecorationRenderer } from './decorationRenderer';
import { Suggestion, PredictRequest, HistoryStep, editToSuggestion } from './types';

const MAX_HISTORY = 5;
const EDIT_DEBOUNCE_MS = 1000;      // 1s after typing
const CURSOR_DEBOUNCE_MS = 2000;    // 2s after cursor-only movement
const HISTORY_IDLE_MS = 30000;      // reset history after this much inactivity

/**
 * Compute insertions to transform `current` → `target`. Returns null if
 * `current` is not a subsequence of `target` (i.e., the user typed something
 * that would need to be DELETED to reach target — divergence).
 *
 * Greedy linear scan: for each character of target, either match the next
 * character of current or accumulate as a pending insertion.
 */
function computeInsertions(current: string, target: string): Array<{ offset: number; text: string }> | null {
    const insertions: Array<{ offset: number; text: string }> = [];
    let i = 0;  // pointer into target
    let j = 0;  // pointer into current
    let pendingText = '';
    let pendingOffset = 0;
    while (i < target.length || j < current.length) {
        if (i < target.length && j < current.length && target[i] === current[j]) {
            if (pendingText) {
                insertions.push({ offset: pendingOffset, text: pendingText });
                pendingText = '';
            }
            i++; j++;
        } else if (i < target.length) {
            // Need to insert target[i] before current[j] (or at end)
            if (!pendingText) { pendingOffset = j; }
            pendingText += target[i];
            i++;
        } else {
            // current has unconsumed chars not in target → user diverged
            return null;
        }
    }
    if (pendingText) {
        insertions.push({ offset: pendingOffset, text: pendingText });
    }
    return insertions;
}

export class SuggestionProvider {
    private client: ModelClient;
    private renderer: DecorationRenderer;
    private currentSuggestion: Suggestion | null = null;
    private changeQueue: Suggestion[] = [];
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private requestSeq = 0;
    private abortController: AbortController | null = null;
    private requestInFlight = false;
    private changeHistory: HistoryStep[] = [];
    private lastEditLine: number | null = null;
    private busy = false;  // mutex for accept/dismiss/show operations
    private suppressNextChange = 0;  // ignore N upcoming change events (from our own undo)
    private lastRequestKey: string | null = null;  // dedup identical requests
    // Cached target state from current/recent suggestion — used when the user
    // keeps typing and we want to re-evaluate against the same target without
    // a new model round-trip.
    private cachedTarget: string | null = null;
    private lastActivityTime: number = Date.now();
    // Parallel to changeHistory: the doc state just BEFORE each entry was applied.
    // Used to net consecutive overlapping entries into a single canonical edit.
    private historyPreStates: string[] = [];
    // Snapshot of the document text taken before the current typing burst started.
    // Used to compute a line-diff at flush time, capturing the actual change.
    private burstSnapshot: string | null = null;

    constructor(private context: vscode.ExtensionContext) {
        this.client = new ModelClient();
        this.renderer = new DecorationRenderer();

        vscode.commands.executeCommand('setContext', 'inlineCode.suggestionVisible', false);

        // Seed burstSnapshot with the active editor's content if any
        const initialEditor = vscode.window.activeTextEditor;
        if (initialEditor) {
            this.burstSnapshot = initialEditor.document.getText();
        }

        // Re-snapshot when the active editor changes (different file)
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor((ed) => {
                this.burstSnapshot = ed ? ed.document.getText() : null;
            })
        );

        // On cursor movement: do NOT dismiss active preview (user just clicking around).
        // Only schedule a new prediction after the debounce.
        context.subscriptions.push(
            vscode.window.onDidChangeTextEditorSelection((e) => {
                if (!this.isEnabled() || this.busy) { return; }
                if (!this.isSupportedDocument(e.textEditor.document)) { return; }

                // Don't auto-dismiss on cursor move — only Esc or a text edit dismisses.
                if (this.currentSuggestion && this.renderer.isActive) { return; }

                if (this.requestInFlight) { return; }
                this.schedulePrediction(e.textEditor, CURSOR_DEBOUNCE_MS);
            })
        );

        // On text change: undo/redo dismiss suggestion silently, other edits dismiss + reschedule
        context.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument((e) => {
                // Suppression must run BEFORE busy check, otherwise the busy
                // path eats the event and the suppression counter never decrements
                if (this.suppressNextChange > 0) {
                    this.suppressNextChange -= 1;
                    return;
                }
                if (this.busy) { return; }
                const editor = vscode.window.activeTextEditor;
                if (!editor || e.document !== editor.document) { return; }
                if (!this.isSupportedDocument(e.document)) { return; }

                const isUndo = e.reason === vscode.TextDocumentChangeReason.Undo;
                const isRedo = e.reason === vscode.TextDocumentChangeReason.Redo;

                // Undo/redo: clean up any active suggestion AND pop history.
                // Since preview edits have no undo stops, a single Ctrl+Z reverses
                // both the preview and whatever edit came before it.
                if (isUndo || isRedo) {
                    if (this.currentSuggestion) {
                        console.log(`[InlineCode] ${isUndo ? 'Undo' : 'Redo'} — clearing suggestion`);
                        this.renderer.clearDecorations(editor);
                        this.renderer.resetState();
                        this.currentSuggestion = null;
                        this.changeQueue = [];
                        vscode.commands.executeCommand('setContext', 'inlineCode.suggestionVisible', false);
                    }
                    if (isUndo) {
                        // Pop history entries matching the number of content reversals
                        // and reset the burst snapshot to the current (post-undo) state
                        const histBefore = this.changeHistory.length;
                        this.burstSnapshot = editor.document.getText();
                        for (let i = 0; i < e.contentChanges.length && this.changeHistory.length > 0; i++) {
                            this.changeHistory.pop();
                            this.historyPreStates.pop();
                        }
                        console.log(`[InlineCode] Undo: contentChanges=${e.contentChanges.length}, history ${histBefore} → ${this.changeHistory.length}`);
                    }
                    // Fall through: schedule a new prediction for the post-undo state
                    if (this.isEnabled()) {
                        this.schedulePrediction(editor, EDIT_DEBOUNCE_MS);
                    }
                    return;
                }

                if (this.currentSuggestion) {
                    // User typed while a suggestion is visible. Update tracked
                    // preview ranges to reflect the user's edit, then try to
                    // re-salvage against the cached target before dismissing.
                    for (const ch of e.contentChanges) {
                        this.renderer.updatePreviewRanges({
                            rangeOffset: ch.rangeOffset,
                            rangeLength: ch.rangeLength,
                            text: ch.text,
                        });
                    }
                    if (this.cachedTarget !== null) {
                        this.tryReSalvage(editor);
                        return;
                    }
                    this.dismissSuggestion(editor);
                } else {
                    // Manual edit (not from us): accumulate for history
                    for (const change of e.contentChanges) {
                        this.recordManualChange(change);
                    }
                }
                if (this.isEnabled()) {
                    this.schedulePrediction(editor, EDIT_DEBOUNCE_MS);
                }
            })
        );
    }

    private isEnabled(): boolean {
        return vscode.workspace.getConfiguration('inlineCode').get<boolean>('enabled', true);
    }

    private isSupportedDocument(doc: vscode.TextDocument): boolean {
        return doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled';
    }

    private schedulePrediction(editor: vscode.TextEditor, delayMs: number): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.triggerPrediction(editor);
        }, delayMs);
    }

    async triggerPrediction(editor: vscode.TextEditor): Promise<void> {
        // Finalize any accumulated manual edits into one history entry
        this.flushPendingManualEdits(editor);

        // NOTE: we used to abort any in-flight request here, but that prevents
        // the speculative-salvage path. We let in-flight requests complete; the
        // requestSeq check filters stale results, and salvage tries to adapt
        // a "snapshot-stale" response to the current document.
        this.abortController = new AbortController();

        const seq = ++this.requestSeq;
        const position = editor.selection.active;


        const request: PredictRequest = {
            file_content: editor.document.getText(),
            cursor_line: position.line + 1,
            cursor_col: position.character,
            language: editor.document.languageId,
            file_path: editor.document.fileName,
            history: this.changeHistory,
        };

        // Dedup: if the request is identical to the last one, skip calling the model.
        const requestKey = JSON.stringify({
            file: request.file_content,
            line: request.cursor_line,
            col: request.cursor_col,
            history: request.history,
        });
        if (requestKey === this.lastRequestKey) {
            console.log('[InlineCode] Request unchanged — skipping model call');
            return;
        }
        this.lastRequestKey = requestKey;

        // Snapshot what we're sending. If the user types while the model is
        // thinking, we'll try to salvage the suggestion against the new state.
        const sentSnapshot = request.file_content;

        try {
            this.requestInFlight = true;
            const response = await this.client.predict(request, this.abortController.signal);
            this.requestInFlight = false;

            // If something else is already showing, skip this response.
            // (We allow seq-stale responses through if nothing's shown yet — the
            // salvage path can still adapt them to the current doc state.)
            if (this.currentSuggestion || this.busy) {
                return;
            }

            if (response.edits.length === 0) {
                console.log(`[InlineCode] No valid edits from server (seq=${seq})`);
                return;
            }

            // Compare snapshot to current document — did the user type while we waited?
            const currentSnapshot = editor.document.getText();
            let suggestions = response.edits.map(e => editToSuggestion(e));

            // Compute cumulative target for caching (used by continuous-typing tracking)
            let cumulativeTarget: string | null = sentSnapshot;
            for (const sug of suggestions) {
                if (cumulativeTarget === null) { break; }
                cumulativeTarget = this.applySuggestion(cumulativeTarget, sug);
            }
            this.cachedTarget = cumulativeTarget;

            if (sentSnapshot !== currentSnapshot) {
                console.log(`[InlineCode] User typed while waiting (snapshot changed). Trying to salvage…`);
                suggestions = this.salvageAgainstUserTyping(suggestions, sentSnapshot, currentSnapshot, editor);
                if (suggestions.length === 0) {
                    console.log('[InlineCode] Could not salvage — rejecting batch and rescheduling');
                    this.cachedTarget = null;
                    if (this.isEnabled()) {
                        this.schedulePrediction(editor, 1000);
                    }
                    return;
                }
                console.log(`[InlineCode] Salvaged ${suggestions.length} edit(s)`);
            }

            console.log(`[InlineCode] Received ${suggestions.length} edit(s): ${suggestions.map(s => `${s.action}@L${s.editLine + 1}`).join(', ')}`);

            this.changeQueue = suggestions.slice(1);
            await this.showSuggestion(editor, suggestions[0]);
        } catch (err: unknown) {
            this.requestInFlight = false;
            if (err instanceof Error && err.name === 'AbortError') { return; }
            console.error('[InlineCode] Prediction failed:', err);
        }
    }

    private async showSuggestion(editor: vscode.TextEditor, suggestion: Suggestion): Promise<void> {
        if (this.busy) { return; }
        this.busy = true;

        this.currentSuggestion = suggestion;
        vscode.commands.executeCommand('setContext', 'inlineCode.suggestionVisible', true);

        const queueInfo = this.changeQueue.length > 0 ? ` [${this.changeQueue.length} more queued]` : '';
        const detail = suggestion.action === 'replace'
            ? `"${(suggestion.deleteText || '').slice(0, 30)}" → "${(suggestion.insertText || '').slice(0, 30)}"`
            : `"${(suggestion.content || '').slice(0, 50)}"`;
        console.log(`[InlineCode] Showing: ${suggestion.action} at L${suggestion.editLine + 1}:${suggestion.editCol} (server-resolved) ${detail}${queueInfo}`);

        const applied = await this.renderer.showPreview(editor, suggestion);

        if (!applied) {
            console.log('[InlineCode] Failed to apply preview');
            this.currentSuggestion = null;
            vscode.commands.executeCommand('setContext', 'inlineCode.suggestionVisible', false);
            this.busy = false;
            return;
        }

        // Show jump indicator if edit is far from cursor
        this.renderer.showJumpIndicator(editor, suggestion);
        this.busy = false;
    }

    private isEditVisible(editor: vscode.TextEditor, suggestion: Suggestion): boolean {
        const visibleRanges = editor.visibleRanges;
        if (visibleRanges.length === 0) { return false; }
        const editLine = suggestion.editLine;
        return visibleRanges.some(r => editLine >= r.start.line && editLine <= r.end.line);
    }

    async acceptSuggestion(editor: vscode.TextEditor): Promise<void> {
        const suggestion = this.currentSuggestion;
        if (!suggestion || this.busy) { return; }

        // If the edit is off-screen, first Tab scrolls to it
        if (!this.isEditVisible(editor, suggestion)) {
            console.log(`[InlineCode] Edit at L${suggestion.editLine + 1} is off-screen — scrolling to it`);
            editor.revealRange(
                new vscode.Range(suggestion.editLine, 0, suggestion.editLine, 0),
                vscode.TextEditorRevealType.InCenter
            );
            return;
        }

        this.busy = true;

        await this.renderer.acceptPreview(editor, suggestion);

        // Move cursor to the end of the edit
        const editPos = new vscode.Position(suggestion.editLine, suggestion.editCol);
        let cursorPos: vscode.Position;
        if (suggestion.action === 'insert' && suggestion.content) {
            let content = suggestion.content.replace(/^\n+/, '');
            if (content && !content.endsWith('\n')) { content += '\n'; }
            const lines = content.split('\n');
            const endLine = editPos.line + lines.length - 1;
            const endCol = lines.length === 1
                ? editPos.character + lines[0].length
                : lines[lines.length - 1].length;
            cursorPos = new vscode.Position(endLine, endCol);
        } else if (suggestion.action === 'replace' && suggestion.insertText) {
            const lines = suggestion.insertText.split('\n');
            const endLine = editPos.line + lines.length - 1;
            const endCol = lines.length === 1
                ? editPos.character + lines[0].length
                : lines[lines.length - 1].length;
            cursorPos = new vscode.Position(endLine, endCol);
        } else {
            cursorPos = editPos;
        }
        editor.selection = new vscode.Selection(cursorPos, cursorPos);

        // For salvage accepts, push a synthetic canonical history entry
        // computed from the burstSnapshot diff (covers user typing + salvage).
        // For normal accepts, use the suggestion's canonical fields directly.
        if (suggestion.inlineInsertions && suggestion.inlineInsertions.length > 0) {
            this.flushPendingManualEdits(editor);
        } else {
            this.recordChange(suggestion);
        }
        // Re-baseline snapshot — accepted text is now part of the file but isn't a "user typing" event
        this.burstSnapshot = editor.document.getText();
        this.client.notify('accept', suggestion.action, suggestion.editLine + 1);
        console.log(`[InlineCode] Accepted: ${suggestion.action} at L${suggestion.editLine + 1}`);

        // Note: line numbers are NOT adjusted here — the server already resolves
        // each step sequentially against the updated file state, so line numbers
        // are correct for the document state after all prior edits are applied.

        // Show next queued change
        if (this.changeQueue.length > 0) {
            const next = this.changeQueue.shift()!;
            console.log(`[InlineCode] Next queued change (${this.changeQueue.length} remaining)`);
            this.busy = false;
            await this.showSuggestion(editor, next);
        } else {
            this.currentSuggestion = null;
            vscode.commands.executeCommand('setContext', 'inlineCode.suggestionVisible', false);
            this.busy = false;
            // Schedule next prediction after accepting
            this.schedulePrediction(editor, EDIT_DEBOUNCE_MS);
        }
    }

    async dismissSuggestion(editor: vscode.TextEditor): Promise<void> {
        if (!this.currentSuggestion) { return; }
        if (this.busy) { return; }
        this.busy = true;
        // The undo fired by dismissPreview will arrive as a TextDocumentChange
        // event after this method returns — suppress it.
        this.suppressNextChange += 1;

        await this.renderer.dismissPreview(editor);
        this.client.notify('dismiss');
        console.log('[InlineCode] Dismissed');

        this.changeQueue = [];
        this.currentSuggestion = null;
        vscode.commands.executeCommand('setContext', 'inlineCode.suggestionVisible', false);
        this.busy = false;
    }

    /**
     * Try to adapt suggestions against a user typing burst that happened while
     * the model was thinking.
     *
     * Strategy: compute the cumulative `target` state by applying ALL edits to
     * the sent snapshot, then compute insertions to turn `current` → `target`.
     * If `current` is a subsequence of `target` (only insertions needed, no
     * deletions), we have a salvageable diff. Render as multi-position inline
     * ghost text. Otherwise reject.
     */
    private salvageAgainstUserTyping(
        suggestions: Suggestion[],
        sent: string,
        current: string,
        _editor: vscode.TextEditor,
    ): Suggestion[] {
        // Build cumulative target by applying every edit in order to sent
        let target = sent;
        for (const sug of suggestions) {
            const next = this.applySuggestion(target, sug);
            if (next === null) { return []; }
            target = next;
        }
        if (current === target) {
            console.log('[InlineCode] User already typed the entire suggestion — dropping');
            return [];
        }

        const insertions = computeInsertions(current, target);
        if (insertions === null) {
            console.log('[InlineCode] User diverged from suggestion (deletions required) — rejecting');
            return [];
        }
        if (insertions.length === 0) {
            return [];
        }
        console.log(`[InlineCode] Salvaged as ${insertions.length} inline insertion(s)`);
        // Wrap as a single Suggestion that carries the multi-insertion payload
        const totalChars = insertions.reduce((s, i) => s + i.text.length, 0);
        return [{
            action: 'insert',
            line: 1,  // not meaningful for multi-insert but required by type
            content: null,
            deleteText: null,
            insertText: null,
            editLine: 0,
            editCol: 0,
            inlineInsertions: insertions,
        } as Suggestion & { inlineInsertions: Array<{ offset: number; text: string }> }];
    }

    /** Apply a single Suggestion to the given file content; returns null on failure. */
    private applySuggestion(content: string, sug: Suggestion): string | null {
        const lines = content.split('\n');
        const lineIdx = sug.line - 1;
        if (lineIdx < 0 || lineIdx > lines.length) { return null; }
        if (sug.action === 'insert') {
            const insertLines = (sug.content ?? '').replace(/\n$/, '').split('\n');
            return [...lines.slice(0, lineIdx), ...insertLines, ...lines.slice(lineIdx)].join('\n');
        }
        if (sug.action === 'delete') {
            const delLines = (sug.content ?? '').replace(/\n$/, '').split('\n');
            const n = delLines.length;
            return [...lines.slice(0, lineIdx), ...lines.slice(lineIdx + n)].join('\n');
        }
        if (sug.action === 'replace') {
            const delLines = (sug.deleteText ?? '').replace(/\n$/, '').split('\n');
            const insLines = (sug.insertText ?? '').replace(/\n$/, '').split('\n');
            const n = delLines.length;
            return [...lines.slice(0, lineIdx), ...insLines, ...lines.slice(lineIdx + n)].join('\n');
        }
        return null;
    }

    /**
     * User typed while a suggestion is showing. The doc currently reflects
     * (their_typed_state + our_inserted_ghost_text). To recompute the diff
     * against the cached target, we first need to remove our ghost text.
     *
     * Approach: call the renderer's dismiss (which undoes our inserts), then
     * compute insertions(current_after_undo, cachedTarget). If still salvageable,
     * show new ghost text. If not, dismiss for real and reschedule.
     */
    private async tryReSalvage(editor: vscode.TextEditor): Promise<void> {
        if (!this.cachedTarget) { return; }
        if (this.busy) { return; }
        this.busy = true;
        // Dismiss undoes our preview insertions; we need to suppress the resulting
        // change event so it doesn't recurse.
        this.suppressNextChange += 1;
        await this.renderer.dismissPreview(editor);
        this.currentSuggestion = null;
        vscode.commands.executeCommand('setContext', 'inlineCode.suggestionVisible', false);

        const target = this.cachedTarget;
        const current = editor.document.getText();

        if (current === target) {
            // User typed everything already
            console.log('[InlineCode] User completed the suggestion via typing');
            this.cachedTarget = null;
            this.busy = false;
            return;
        }

        const insertions = computeInsertions(current, target);
        if (insertions === null || insertions.length === 0) {
            console.log('[InlineCode] User diverged from target — fresh request');
            this.cachedTarget = null;
            this.busy = false;
            if (this.isEnabled()) {
                this.schedulePrediction(editor, EDIT_DEBOUNCE_MS);
            }
            return;
        }

        const newSug: Suggestion = {
            action: 'insert', line: 1,
            content: null, deleteText: null, insertText: null,
            editLine: 0, editCol: 0,
            inlineInsertions: insertions,
        };
        this.busy = false;
        await this.showSuggestion(editor, newSug);
        console.log(`[InlineCode] Re-salvaged: ${insertions.length} inline insertion(s) remaining`);
    }

    /**
     * Compute how many lines were added/removed by an accepted edit.
     * Positive = lines added, negative = lines removed.
     */
    private computeLineShift(suggestion: Suggestion): number {
        if (suggestion.action === 'insert' && suggestion.content) {
            let content = suggestion.content.replace(/^\n+/, '');
            if (content && !content.endsWith('\n')) { content += '\n'; }
            // Count newlines = number of lines inserted
            return (content.match(/\n/g) || []).length;
        } else if (suggestion.action === 'delete' && suggestion.content) {
            const deletedLines = (suggestion.content.match(/\n/g) || []).length;
            return -deletedLines;
        } else if (suggestion.action === 'replace') {
            const deletedLines = ((suggestion.deleteText || '').match(/\n/g) || []).length;
            const insertedLines = ((suggestion.insertText || '').match(/\n/g) || []).length;
            return insertedLines - deletedLines;
        }
        return 0;
    }

    private recordChange(suggestion: Suggestion): void {
        const editLine = suggestion.editLine + 1;
        this.lastEditLine = editLine;

        const step: HistoryStep = {
            action: suggestion.action,
            line: editLine,
            content: suggestion.content,
            delete: suggestion.deleteText,
            insert: suggestion.insertText,
        };

        this.pushHistory(step);
    }

    private pushHistory(step: HistoryStep, preState?: string, postState?: string): void {
        // Reset history if user has been idle too long — stale context isn't useful
        if (Date.now() - this.lastActivityTime > HISTORY_IDLE_MS && this.changeHistory.length > 0) {
            console.log(`[InlineCode] History reset: idle > ${HISTORY_IDLE_MS}ms`);
            this.changeHistory = [];
            this.historyPreStates = [];
        }
        this.lastActivityTime = Date.now();

        // Try to collapse the new step against the most recent one if they're inverses.
        // E.g., insert "x" then delete "x" → both should drop.
        if (this.changeHistory.length > 0) {
            const last = this.changeHistory[this.changeHistory.length - 1];
            if (this.areInverses(last, step)) {
                console.log(`[InlineCode] History: dropping inverse pair`);
                this.changeHistory.pop();
                this.historyPreStates.pop();
                return;  // don't push the new step either
            }
        }

        // Net with the previous entry if they overlap on the same line range AND
        // we have full pre/post states for both. Replace the prior entry with a
        // single canonical diff from the prior entry's pre-state to the new post-state.
        if (
            preState !== undefined && postState !== undefined &&
            this.changeHistory.length > 0 && this.historyPreStates.length > 0 &&
            this.stepsOverlap(this.changeHistory[this.changeHistory.length - 1], step)
        ) {
            const priorPre = this.historyPreStates[this.historyPreStates.length - 1];
            const netted = this.diffToHistoryStep(priorPre, postState);
            if (netted) {
                console.log(`[InlineCode] History: netting consecutive entries on overlapping lines`);
                this.changeHistory[this.changeHistory.length - 1] = netted;
                // Leave priorPre in place — it's still the pre-state of the netted entry
                return;
            }
        }

        this.changeHistory.push(step);
        if (preState !== undefined) {
            this.historyPreStates.push(preState);
        } else {
            // Fallback: use current burstSnapshot as a stand-in (not exact but usable)
            this.historyPreStates.push(this.burstSnapshot ?? '');
        }
        if (this.changeHistory.length > MAX_HISTORY) {
            this.changeHistory = this.changeHistory.slice(-MAX_HISTORY);
            this.historyPreStates = this.historyPreStates.slice(-MAX_HISTORY);
        }
    }

    /** True if two history steps affect overlapping line ranges. */
    private stepsOverlap(a: HistoryStep, b: HistoryStep): boolean {
        const aRange = this.stepLineRange(a);
        const bRange = this.stepLineRange(b);
        return aRange.start <= bRange.end && bRange.start <= aRange.end;
    }

    /** Compute [start, end] (inclusive) line range affected by a step. */
    private stepLineRange(s: HistoryStep): { start: number; end: number } {
        const line = s.line;
        let lines: number;
        if (s.action === 'insert') {
            lines = (s.content ?? '').split('\n').filter(l => l.length > 0).length || 1;
            return { start: line, end: line + lines - 1 };
        }
        if (s.action === 'delete') {
            lines = (s.content ?? '').split('\n').filter(l => l.length > 0).length || 1;
            return { start: line, end: line + lines - 1 };
        }
        // replace
        const delLines = (s.delete ?? '').split('\n').filter(l => l.length > 0).length || 1;
        return { start: line, end: line + delLines - 1 };
    }

    /** True if step `b` would undo step `a`. */
    private areInverses(a: HistoryStep, b: HistoryStep): boolean {
        if (a.line !== b.line) { return false; }
        // insert X followed by delete X
        if (a.action === 'insert' && b.action === 'delete') {
            return (a.content ?? '') === (b.content ?? '');
        }
        if (a.action === 'delete' && b.action === 'insert') {
            return (a.content ?? '') === (b.content ?? '');
        }
        // replace A→B followed by replace B→A
        if (a.action === 'replace' && b.action === 'replace') {
            return (a.delete ?? '') === (b.insert ?? '') && (a.insert ?? '') === (b.delete ?? '');
        }
        return false;
    }

    /** Reset history (called on file-empty transitions, explicit clears, etc.) */
    private resetHistory(reason: string): void {
        if (this.changeHistory.length > 0) {
            console.log(`[InlineCode] History reset: ${reason}`);
            this.changeHistory = [];
        }
    }

    /** Mark that a manual change occurred. The actual diff is computed at flush time
     *  by comparing burstSnapshot (taken at end of last flush / activation) to
     *  the current document text. */
    private recordManualChange(_change: vscode.TextDocumentContentChangeEvent): void {
        // No-op per change; flushPendingManualEdits does the heavy lifting via diff.
    }

    /** Flush accumulated manual edits into a single history entry by diffing
     *  burstSnapshot against the current document text. */
    private flushPendingManualEdits(editor?: vscode.TextEditor): void {
        const ed = editor ?? vscode.window.activeTextEditor;
        if (!ed) { return; }
        const current = ed.document.getText();
        const before = this.burstSnapshot;
        // Always update the snapshot, even if no diff to compute.
        this.burstSnapshot = current;
        if (before === null || before === current) { return; }

        // File-clear is a fresh start — reset history when the file goes empty.
        // (We do NOT reset on empty → populated, because that's the user typing
        // their first edit and we want to record it.)
        const becameEmpty = before.length > 0 && current.trim() === '';
        if (becameEmpty) {
            this.resetHistory('file went empty');
            return;  // don't record the clear itself as a step
        }

        const step = this.diffToHistoryStep(before, current);
        if (step) {
            this.pushHistory(step, before, current);
        }
    }

    /** Compute a single canonical edit (replace) describing the line-level diff
     *  between before and after document text. Returns null if nothing changed. */
    private diffToHistoryStep(before: string, after: string): HistoryStep | null {
        const beforeLines = before.split('\n');
        const afterLines = after.split('\n');

        // Find first differing line
        let prefix = 0;
        const minLen = Math.min(beforeLines.length, afterLines.length);
        while (prefix < minLen && beforeLines[prefix] === afterLines[prefix]) { prefix++; }
        if (prefix === beforeLines.length && prefix === afterLines.length) { return null; }

        // Find last differing line (working backwards)
        let suffix = 0;
        while (
            suffix < (beforeLines.length - prefix) &&
            suffix < (afterLines.length - prefix) &&
            beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
        ) { suffix++; }

        const deleteLines = beforeLines.slice(prefix, beforeLines.length - suffix);
        const insertLines = afterLines.slice(prefix, afterLines.length - suffix);
        const deleteText = deleteLines.join('\n');
        const insertText = insertLines.join('\n');

        if (deleteText === insertText) { return null; }

        // Decide action based on what's empty
        if (!deleteText && insertText) {
            return {
                action: 'insert',
                line: prefix + 1,
                content: insertText,
                delete: null, insert: null,
            };
        }
        if (deleteText && !insertText) {
            return {
                action: 'delete',
                line: prefix + 1,
                content: deleteText,
                delete: null, insert: null,
            };
        }
        return {
            action: 'replace',
            line: prefix + 1,
            content: null,
            delete: deleteText,
            insert: insertText,
        };
    }

    dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        if (this.abortController) {
            this.abortController.abort();
        }
    }
}
