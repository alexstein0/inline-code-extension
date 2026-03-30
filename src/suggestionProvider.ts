import * as vscode from 'vscode';
import { ModelClient } from './modelClient';
import { DecorationRenderer } from './decorationRenderer';
import { Suggestion, PredictRequest, HistoryStep, changeToSuggestion } from './types';

const MAX_HISTORY = 5;
const CURSOR_JUMP_THRESHOLD = 10; // lines — reset history if cursor jumps further than this

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
    private isApplyingEdit = false;
    private isShowingPreview = false;

    constructor(private context: vscode.ExtensionContext) {
        this.client = new ModelClient();
        this.renderer = new DecorationRenderer();

        vscode.commands.executeCommand('setContext', 'inlineCode.suggestionVisible', false);

        // Trigger predictions on cursor movement (but not if a request is already in flight)
        context.subscriptions.push(
            vscode.window.onDidChangeTextEditorSelection((e) => {
                if (!this.isEnabled() || this.isApplyingEdit || this.isShowingPreview) { return; }
                if (!this.isSupportedDocument(e.textEditor.document)) { return; }
                if (this.requestInFlight) { return; }
                this.schedulePrediction(e.textEditor);
            })
        );

        // Dismiss on text changes (user is typing)
        context.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (this.isApplyingEdit || this.isShowingPreview) { return; }
                const editor = vscode.window.activeTextEditor;
                if (editor && e.document === editor.document && this.isSupportedDocument(e.document)) {
                    this.dismissSuggestion(editor);
                    if (this.isEnabled()) {
                        this.schedulePrediction(editor);
                    }
                }
            })
        );
    }

    private isEnabled(): boolean {
        return vscode.workspace.getConfiguration('inlineCode').get<boolean>('enabled', true);
    }

    private isSupportedDocument(doc: vscode.TextDocument): boolean {
        // Only predict for actual files — ignore output panels, terminals, etc.
        return doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled';
    }

    private getDebounceMs(): number {
        return vscode.workspace.getConfiguration('inlineCode').get<number>('debounceMs', 500);
    }

    private schedulePrediction(editor: vscode.TextEditor): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.triggerPrediction(editor);
        }, this.getDebounceMs());
    }

    async triggerPrediction(editor: vscode.TextEditor): Promise<void> {
        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();

        const seq = ++this.requestSeq;
        const position = editor.selection.active;

        // Reset history if cursor jumped far
        const cursorLine1 = position.line + 1;
        if (this.lastEditLine !== null && Math.abs(cursorLine1 - this.lastEditLine) > CURSOR_JUMP_THRESHOLD) {
            this.changeHistory = [];
            this.lastEditLine = null;
        }

        const request: PredictRequest = {
            file_content: editor.document.getText(),
            cursor_line: cursorLine1,
            cursor_col: position.character,
            language: editor.document.languageId,
            file_path: editor.document.fileName,
            history: this.changeHistory,
        };

        try {
            this.requestInFlight = true;
            const response = await this.client.predict(request, this.abortController.signal);
            this.requestInFlight = false;

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
        this.currentSuggestion = suggestion;
        vscode.commands.executeCommand('setContext', 'inlineCode.suggestionVisible', true);

        const queueInfo = this.changeQueue.length > 0 ? ` [${this.changeQueue.length} more queued]` : '';
        const detail = suggestion.action === 'replace'
            ? `"${(suggestion.deleteText || '').slice(0, 30)}" → "${(suggestion.insertText || '').slice(0, 30)}"`
            : `"${(suggestion.content || '').slice(0, 50)}"`;
        console.log(`[InlineCode] Showing: ${suggestion.action} at L${suggestion.editLine + 1}:${suggestion.editCol} ${detail}${queueInfo}`);

        // Apply the edit as a live preview (highlighted in the document)
        this.isShowingPreview = true;
        const applied = await this.renderer.showPreview(editor, suggestion);
        this.isShowingPreview = false;

        if (!applied) {
            console.log('[InlineCode] Failed to apply preview');
            this.currentSuggestion = null;
            vscode.commands.executeCommand('setContext', 'inlineCode.suggestionVisible', false);
            return;
        }

        // Show jump indicator if edit is far from cursor
        this.renderer.showJumpIndicator(editor, suggestion);
    }

    private isEditVisible(editor: vscode.TextEditor, suggestion: Suggestion): boolean {
        const visibleRanges = editor.visibleRanges;
        if (visibleRanges.length === 0) { return false; }
        const editLine = suggestion.editLine;
        return visibleRanges.some(r => editLine >= r.start.line && editLine <= r.end.line);
    }

    async acceptSuggestion(editor: vscode.TextEditor): Promise<void> {
        const suggestion = this.currentSuggestion;
        if (!suggestion) { return; }

        // If the edit is off-screen, first Tab scrolls to it
        if (!this.isEditVisible(editor, suggestion)) {
            console.log(`[InlineCode] Edit at L${suggestion.editLine + 1} is off-screen — scrolling to it`);
            editor.revealRange(
                new vscode.Range(suggestion.editLine, 0, suggestion.editLine, 0),
                vscode.TextEditorRevealType.InCenter
            );
            return;
        }

        this.isApplyingEdit = true;

        // Accept the preview — for insert/replace it's already applied, just remove decorations
        // For delete, this actually applies the deletion
        await this.renderer.acceptPreview(editor, suggestion);

        // Move cursor to the end of the edit
        const editPos = new vscode.Position(suggestion.editLine, suggestion.editCol);
        let cursorPos: vscode.Position;
        if (suggestion.action === 'insert' && suggestion.content) {
            // Apply same normalization as decorationRenderer
            let content = suggestion.content;
            if (content.startsWith('\n')) {
                content = content.slice(1);
                if (!content.endsWith('\n')) { content += '\n'; }
            }
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

        // Show next queued change immediately
        if (this.changeQueue.length > 0) {
            const next = this.changeQueue.shift()!;
            console.log(`[InlineCode] Next queued change (${this.changeQueue.length} remaining)`);
            this.isApplyingEdit = false;
            await this.showSuggestion(editor, next);
        } else {
            this.isApplyingEdit = false;
            this.currentSuggestion = null;
            vscode.commands.executeCommand('setContext', 'inlineCode.suggestionVisible', false);
            // Trigger next prediction after accepting
            this.schedulePrediction(editor);
        }
    }

    async dismissSuggestion(editor: vscode.TextEditor): Promise<void> {
        if (this.currentSuggestion) {
            this.isShowingPreview = true;
            await this.renderer.dismissPreview(editor);
            this.isShowingPreview = false;
            this.client.notify('dismiss');
            console.log('[InlineCode] Dismissed (preview reversed)');
        }
        this.changeQueue = [];
        this.currentSuggestion = null;
        vscode.commands.executeCommand('setContext', 'inlineCode.suggestionVisible', false);
    }

    private recordChange(suggestion: Suggestion): void {
        const editLine = suggestion.editLine + 1;

        if (this.lastEditLine !== null && Math.abs(editLine - this.lastEditLine) > CURSOR_JUMP_THRESHOLD) {
            this.changeHistory = [];
        }
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

        this.changeHistory.push(step);
        if (this.changeHistory.length > MAX_HISTORY) {
            this.changeHistory = this.changeHistory.slice(-MAX_HISTORY);
        }
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
