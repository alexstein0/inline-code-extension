import * as vscode from 'vscode';
import { ModelClient } from './modelClient';
import { DecorationRenderer } from './decorationRenderer';
import { Suggestion, PredictRequest, HistoryStep, editToSuggestion } from './types';

const MAX_HISTORY = 5;
const EDIT_DEBOUNCE_MS = 1000;      // 1s after typing
const CURSOR_DEBOUNCE_MS = 2000;    // 2s after cursor-only movement

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
                        this.burstSnapshot = editor.document.getText();
                        for (let i = 0; i < e.contentChanges.length && this.changeHistory.length > 0; i++) {
                            this.changeHistory.pop();
                        }
                    }
                    // Fall through: schedule a new prediction for the post-undo state
                    if (this.isEnabled()) {
                        this.schedulePrediction(editor, EDIT_DEBOUNCE_MS);
                    }
                    return;
                }

                if (this.currentSuggestion) {
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

        // Abort any in-flight request
        if (this.abortController) {
            this.abortController.abort();
        }
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

        try {
            this.requestInFlight = true;
            const response = await this.client.predict(request, this.abortController.signal);
            this.requestInFlight = false;

            // Stale response — a newer request was fired
            if (seq !== this.requestSeq) { return; }

            if (response.edits.length === 0) {
                console.log('[InlineCode] No valid edits from server');
                return;
            }

            const suggestions = response.edits.map(e => editToSuggestion(e));
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

        this.recordChange(suggestion);
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

    private pushHistory(step: HistoryStep): void {
        this.changeHistory.push(step);
        if (this.changeHistory.length > MAX_HISTORY) {
            this.changeHistory = this.changeHistory.slice(-MAX_HISTORY);
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

        const step = this.diffToHistoryStep(before, current);
        if (step) {
            this.pushHistory(step);
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
