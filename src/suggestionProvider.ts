import * as vscode from 'vscode';
import { ModelClient } from './modelClient';
import { DecorationRenderer } from './decorationRenderer';
import { Suggestion, PredictRequest, HistoryStep, changeToSuggestion } from './types';

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

    constructor(private context: vscode.ExtensionContext) {
        this.client = new ModelClient();
        this.renderer = new DecorationRenderer();

        vscode.commands.executeCommand('setContext', 'inlineCode.suggestionVisible', false);

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

                // Undo/redo with active suggestion: the undo already reversed the preview
                // (since it was inserted without undo stops, it's grouped with the previous edit).
                // Just clean up suggestion state — don't re-show or trigger new prediction.
                if (this.currentSuggestion && (
                    e.reason === vscode.TextDocumentChangeReason.Undo ||
                    e.reason === vscode.TextDocumentChangeReason.Redo
                )) {
                    console.log(`[InlineCode] ${e.reason === vscode.TextDocumentChangeReason.Undo ? 'Undo' : 'Redo'} — dismissing suggestion`);
                    this.renderer.clearDecorations(editor);
                    this.renderer.resetState();
                    this.currentSuggestion = null;
                    this.changeQueue = [];
                    vscode.commands.executeCommand('setContext', 'inlineCode.suggestionVisible', false);
                    return;
                }

                if (this.currentSuggestion) {
                    this.dismissSuggestion(editor);
                } else if (e.reason === vscode.TextDocumentChangeReason.Undo) {
                    // Pop the most recent history entry per content change
                    for (let i = 0; i < e.contentChanges.length; i++) {
                        if (this.changeHistory.length > 0) {
                            this.changeHistory.pop();
                        }
                    }
                } else if (e.reason === vscode.TextDocumentChangeReason.Redo) {
                    // Redo: don't re-add (we don't track popped entries) — just leave history as-is
                } else {
                    // Manual edit (not from us): record in history
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

            if (response.changes.length === 0) {
                console.log('[InlineCode] No valid changes from server');
                return;
            }

            const suggestions = response.changes.map(c => changeToSuggestion(c));
            console.log(`[InlineCode] Received ${suggestions.length} change(s): ${suggestions.map(s => `${s.action}@L${s.editLine + 1}`).join(', ')}`);

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
            before: suggestion.before,
            after: suggestion.after,
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

    /** Convert a manual document change into a HistoryStep and add it.
     *  Coalesces rapid keystrokes on the same line into a single entry.
     *  Only records inserts (we don't have the deleted text for deletions). */
    private recordManualChange(change: vscode.TextDocumentContentChangeEvent): void {
        const startLine = change.range.start.line + 1;
        const insertedText = change.text;
        const wasDeletion = change.rangeLength > 0;

        // Skip deletions and replaces — we don't have the deleted text,
        // and sending a placeholder pollutes the model's context.
        if (wasDeletion || !insertedText) { return; }

        // Coalesce: if the last history entry is an insert on the same line, append to it
        const last = this.changeHistory.length > 0 ? this.changeHistory[this.changeHistory.length - 1] : null;
        if (last && last.action === 'insert' && last.line === startLine && last.content) {
            last.content += insertedText;
            return;
        }

        const step: HistoryStep = {
            action: 'insert',
            line: startLine,
            before: null, after: null,
            content: insertedText,
            delete: null, insert: null,
        };
        this.pushHistory(step);
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
