import * as vscode from 'vscode';
import { Suggestion } from './types';

// Ghost-text styling for inserted/new text: dimmed, italic, green gutter bar
const insertedLineDecoration = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor('editorGhostText.foreground'),
    fontStyle: 'italic',
    backgroundColor: 'rgba(155, 185, 85, 0.08)',
    isWholeLine: true,
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: 'rgba(155, 185, 85, 0.6)',
});

// Strikethrough for text that will be deleted
const deletedLineDecoration = vscode.window.createTextEditorDecorationType({
    textDecoration: 'line-through',
    opacity: '0.6',
});

type PreviewState = 'idle' | 'applying' | 'active' | 'dismissing';

export class DecorationRenderer {
    private activeDecorations: vscode.TextEditorDecorationType[] = [];
    private state: PreviewState = 'idle';
    private generation = 0;
    private safetyTimer: ReturnType<typeof setTimeout> | null = null;

    // What was inserted during preview (for reversal)
    private insertedText: string | null = null;
    private insertedAt: vscode.Position | null = null;
    // Exact byte ranges of inserted preview text. Used to dismiss without
    // relying on `executeCommand('undo')` (which would undo the user's
    // keystroke instead if they typed while preview was visible).
    // `previewRanges` is updated whenever the document changes — see updatePreviewRanges().
    private previewRanges: Array<{ start: number; length: number }> = [];

    // For replace: the old text that was strikethrough'd (to delete on accept)
    private deleteRange: vscode.Range | null = null;
    private wasDirtyBeforePreview = false;

    /**
     * Show a preview of the suggested edit.
     *
     * - Insert: inserts text into document, decorates as ghost text
     * - Delete: decorates existing text with strikethrough (no doc change)
     * - Replace: strikethroughs old text, inserts new text below, decorates as ghost
     *
     * Returns true if preview is now active.
     */
    async showPreview(editor: vscode.TextEditor, suggestion: Suggestion): Promise<boolean> {
        if (this.state !== 'idle') {
            return false;
        }

        this.state = 'applying';
        const gen = ++this.generation;
        this.wasDirtyBeforePreview = editor.document.isDirty;

        this.clearDecorations(editor);
        this.insertedText = null;
        this.insertedAt = null;
        this.deleteRange = null;

        const editPos = new vscode.Position(suggestion.editLine, suggestion.editCol);
        let success = false;

        try {
            // Phase 2 salvage: multi-position inline insertions take priority
            if (suggestion.inlineInsertions && suggestion.inlineInsertions.length > 0) {
                success = await this.previewMultiInsert(editor, suggestion.inlineInsertions);
            } else {
                switch (suggestion.action) {
                    case 'insert':
                        success = await this.previewInsert(editor, suggestion, editPos);
                        break;
                    case 'delete':
                        success = this.previewDelete(editor, suggestion, editPos);
                        break;
                    case 'replace':
                        success = await this.previewReplace(editor, suggestion, editPos);
                        break;
                }
            }
        } catch (e) {
            console.error('[InlineCode] Preview error:', e);
            success = false;
        }

        // If generation changed during async operations, someone else took over
        if (gen !== this.generation) {
            return false;
        }

        if (success) {
            this.state = 'active';
        } else {
            this.state = 'idle';
        }

        return success;
    }

    /**
     * Accept the preview — finalize the edit.
     * For insert: text is already in document, just clear decorations.
     * For delete: apply the deletion now.
     * For replace: delete the old strikethrough lines, keep the new inserted lines.
     */
    async acceptPreview(editor: vscode.TextEditor, suggestion: Suggestion): Promise<void> {
        if (this.state !== 'active') { return; }
        this.state = 'applying';
        this.clearSafetyTimer();

        try {
            const editPos = new vscode.Position(suggestion.editLine, suggestion.editCol);

            if (suggestion.inlineInsertions && suggestion.inlineInsertions.length > 0) {
                // Multi-insert preview already wrote the text. Just commit an undo stop.
                await editor.edit(() => {}, { undoStopBefore: true, undoStopAfter: true });

            } else if (suggestion.action === 'insert') {
                // Insert was already applied during preview without undo stops.
                // Create an undo stop now so the accepted edit is undoable.
                await editor.edit(() => {}, { undoStopBefore: true, undoStopAfter: true });

            } else if (suggestion.action === 'delete' && suggestion.content) {
                // Delete wasn't applied during preview — apply now
                const range = this.calculateRange(editPos, suggestion.content);
                await editor.edit((eb) => {
                    eb.delete(range);
                }, { undoStopBefore: true, undoStopAfter: true });

            } else if (suggestion.action === 'replace' && this.deleteRange) {
                // Delete the old strikethrough lines (new lines are already inserted below)
                // Include the trailing newline of the last deleted line
                const fullDeleteRange = new vscode.Range(
                    this.deleteRange.start,
                    new vscode.Position(this.deleteRange.end.line + 1, 0)
                );
                await editor.edit((eb) => {
                    eb.delete(fullDeleteRange);
                }, { undoStopBefore: true, undoStopAfter: true });
            }
            // For insert: text is already in the document, nothing to do
        } catch (e) {
            console.error('[InlineCode] Accept error:', e);
        }

        this.clearDecorations(editor);
        this.insertedText = null;
        this.insertedAt = null;
        this.deleteRange = null;
        this.state = 'idle';
    }

    /**
     * Dismiss the preview — explicitly delete the tracked preview ranges.
     * This is robust against the user typing while the preview is showing
     * (which would make `executeCommand('undo')` undo the user's keystroke
     * instead of our preview).
     */
    async dismissPreview(editor: vscode.TextEditor): Promise<void> {
        if (this.state !== 'active') { return; }
        this.state = 'dismissing';
        this.clearSafetyTimer();

        try {
            if (this.previewRanges.length > 0) {
                // Delete in descending offset order so earlier offsets don't shift
                const sorted = [...this.previewRanges].sort((a, b) => b.start - a.start);
                await editor.edit((eb) => {
                    for (const r of sorted) {
                        const startPos = editor.document.positionAt(r.start);
                        const endPos = editor.document.positionAt(r.start + r.length);
                        eb.delete(new vscode.Range(startPos, endPos));
                    }
                }, { undoStopBefore: false, undoStopAfter: false });
            }
        } catch (e) {
            console.error('[InlineCode] Dismiss error:', e);
        }

        this.clearDecorations(editor);
        this.insertedText = null;
        this.insertedAt = null;
        this.deleteRange = null;
        this.previewRanges = [];
        this.state = 'idle';
    }

    /**
     * Adjust tracked preview ranges in response to a document change that
     * occurred OUTSIDE our preview operations (e.g. the user typed). The
     * change's offset is in the pre-change document; tracked ranges live in
     * the post-change document.
     *
     * Called by SuggestionProvider when a user keystroke arrives while a
     * preview is active, before tryReSalvage.
     */
    updatePreviewRanges(change: { rangeOffset: number; rangeLength: number; text: string }): void {
        if (this.previewRanges.length === 0) { return; }
        const editStart = change.rangeOffset;
        const editEnd = change.rangeOffset + change.rangeLength;
        const delta = change.text.length - change.rangeLength;
        this.previewRanges = this.previewRanges.map(r => {
            if (r.start >= editEnd) {
                return { start: r.start + delta, length: r.length };
            } else if (r.start + r.length <= editStart) {
                return r;  // change after the range, no shift
            } else {
                // overlap — user typed into our ghost text; for now, mark as dirty (length 0)
                // so we can re-render fresh
                return { start: r.start, length: 0 };
            }
        });
    }

    /** Read-only view of the current preview ranges. */
    getPreviewRanges(): Array<{ start: number; length: number }> {
        return [...this.previewRanges];
    }

    /** Show a jump indicator at the cursor when the edit is far away. */
    showJumpIndicator(editor: vscode.TextEditor, suggestion: Suggestion): void {
        const cursorLine = editor.selection.active.line;
        const editLine = suggestion.editLine;
        const distance = Math.abs(editLine - cursorLine);

        if (distance <= 2) { return; }

        const direction = editLine > cursorLine ? '↓' : '↑';
        const lineNum = editLine + 1;
        const label = `  ${direction} Tab → line ${lineNum}`;

        const cursorEnd = editor.document.lineAt(cursorLine).range.end;
        const dec = vscode.window.createTextEditorDecorationType({
            after: {
                contentText: label,
                color: new vscode.ThemeColor('editorGhostText.foreground'),
                fontStyle: 'italic',
                margin: '0 0 0 1em',
            },
        });
        this.activeDecorations.push(dec);
        editor.setDecorations(dec, [{ range: new vscode.Range(cursorEnd, cursorEnd) }]);
    }

    resetState(): void {
        this.clearSafetyTimer();
        this.insertedText = null;
        this.insertedAt = null;
        this.deleteRange = null;
        this.state = 'idle';
    }

    get isActive(): boolean {
        return this.state === 'active';
    }

    get isBusy(): boolean {
        return this.state === 'applying' || this.state === 'dismissing';
    }

    // ─── Private: preview implementations ───────────────────────────

    /**
     * Multi-position inline ghost text. Used by speculative-salvage when the user's
     * typing has produced a state that is a *subsequence* of the model's target —
     * we just need to inject the missing characters at multiple offsets.
     */
    private async previewMultiInsert(
        editor: vscode.TextEditor,
        insertions: Array<{ offset: number; text: string }>,
    ): Promise<boolean> {
        if (insertions.length === 0) { return false; }

        // Snapshot cursor offset so we can restore it (preview shouldn't move the cursor)
        const cursorOffsetBefore = editor.document.offsetAt(editor.selection.active);

        // Apply in descending offset order so earlier offsets aren't shifted by later inserts
        const sorted = [...insertions].sort((a, b) => b.offset - a.offset);
        const success = await editor.edit((eb) => {
            for (const ins of sorted) {
                const pos = editor.document.positionAt(ins.offset);
                eb.insert(pos, ins.text);
            }
        }, { undoStopBefore: false, undoStopAfter: false });

        if (!success) { return false; }

        // Restore the cursor to its visual position: original offset shifted by
        // the total length of inserts that landed STRICTLY BEFORE the cursor.
        // (Inserts AT the cursor offset should leave the cursor before the ghost
        // text — user is "still typing here".)
        let shift = 0;
        for (const ins of insertions) {
            if (ins.offset < cursorOffsetBefore) {
                shift += ins.text.length;
            }
        }
        const restoredOffset = cursorOffsetBefore + shift;
        const restoredPos = editor.document.positionAt(restoredOffset);
        editor.selection = new vscode.Selection(restoredPos, restoredPos);

        // Decorate inserted regions. Compute adjusted offsets in ascending order.
        const ranges: vscode.Range[] = [];
        const tracked: Array<{ start: number; length: number }> = [];
        const ascending = [...insertions].sort((a, b) => a.offset - b.offset);
        let runningShift = 0;
        for (const ins of ascending) {
            const startOffset = ins.offset + runningShift;
            const endOffset = startOffset + ins.text.length;
            const startPos = editor.document.positionAt(startOffset);
            const endPos = editor.document.positionAt(endOffset);
            ranges.push(new vscode.Range(startPos, endPos));
            tracked.push({ start: startOffset, length: ins.text.length });
            runningShift += ins.text.length;
        }
        this.previewRanges = tracked;
        // Use a per-range character decoration so we don't span whole lines
        const inlineDec = vscode.window.createTextEditorDecorationType({
            color: new vscode.ThemeColor('editorGhostText.foreground'),
            backgroundColor: 'rgba(155, 185, 85, 0.15)',
            fontStyle: 'italic',
        });
        this.activeDecorations.push(inlineDec);
        editor.setDecorations(inlineDec, ranges);
        // Track: from acceptance perspective, no further work needed. Set a flag.
        this.insertedText = '__MULTI__';
        this.insertedAt = null;
        return true;
    }


    private async previewInsert(
        editor: vscode.TextEditor, suggestion: Suggestion, editPos: vscode.Position
    ): Promise<boolean> {
        let content = suggestion.content;
        if (!content) { return false; }

        // Normalize: strip leading \n, ensure trailing \n
        content = content.replace(/^\n+/, '');
        if (content && !content.endsWith('\n')) {
            content += '\n';
        }
        if (!content) { return false; }

        // Handle insert past end-of-document (e.g. "insert at line 2" when doc has 1 line):
        // append after the last line with a leading newline so a new line is created.
        let actualEditPos = editPos;
        let prependedNewline = false;
        if (editPos.line >= editor.document.lineCount) {
            const lastLine = editor.document.lineCount - 1;
            const lastLineEnd = editor.document.lineAt(lastLine).range.end;
            actualEditPos = lastLineEnd;
            content = '\n' + content;
            prependedNewline = true;
        }

        // Snapshot cursor offset so we can restore it (preview shouldn't move the cursor)
        const cursorOffsetBefore = editor.document.offsetAt(editor.selection.active);
        const insertOffsetForRestore = editor.document.offsetAt(actualEditPos);

        const success = await editor.edit((eb) => {
            eb.insert(actualEditPos, content);
        }, { undoStopBefore: false, undoStopAfter: false });

        if (!success) { return false; }

        // Restore cursor: shift by content length only if insert was strictly before cursor.
        const shift = insertOffsetForRestore < cursorOffsetBefore ? content.length : 0;
        const restoredOffset = cursorOffsetBefore + shift;
        const restoredPos = editor.document.positionAt(restoredOffset);
        editor.selection = new vscode.Selection(restoredPos, restoredPos);

        this.insertedText = content;
        this.insertedAt = actualEditPos;
        // Track exact range for explicit deletion on dismiss
        const insertOffset = editor.document.offsetAt(actualEditPos);
        this.previewRanges = [{ start: insertOffset, length: content.length }];

        // Decorate the inserted lines.
        // If we prepended a \n, the visible inserted content starts on the NEXT line.
        const decorateStart = prependedNewline ? actualEditPos.line + 1 : actualEditPos.line;
        const insertedRange = this.calculateRange(actualEditPos, content);
        this.decorateLines(editor, decorateStart, insertedRange.end.line, content, insertedLineDecoration);

        return true;
    }

    private previewDelete(
        editor: vscode.TextEditor, suggestion: Suggestion, editPos: vscode.Position
    ): boolean {
        const content = suggestion.content;
        if (!content) { return false; }

        const range = this.calculateRange(editPos, content);
        editor.setDecorations(deletedLineDecoration, [{ range }]);

        // No document modification — deletion happens on accept
        return true;
    }

    private async previewReplace(
        editor: vscode.TextEditor, suggestion: Suggestion, editPos: vscode.Position
    ): Promise<boolean> {
        const deleteText = suggestion.deleteText;
        let insertText = suggestion.insertText || '';
        if (!deleteText) { return false; }

        // Ensure insert text ends with \n for proper line separation
        if (insertText && !insertText.endsWith('\n')) {
            insertText += '\n';
        }

        // 1. Strikethrough the old text
        const delRange = this.calculateRange(editPos, deleteText);
        editor.setDecorations(deletedLineDecoration, [{ range: delRange }]);
        this.deleteRange = delRange;

        // 2. Insert new text AFTER the old text
        if (insertText) {
            const insertPos = new vscode.Position(delRange.end.line + 1, 0);
            const success = await editor.edit((eb) => {
                if (insertPos.line <= editor.document.lineCount) {
                    eb.insert(insertPos, insertText);
                } else {
                    const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
                    eb.insert(lastLine.range.end, '\n' + insertText);
                }
            }, { undoStopBefore: false, undoStopAfter: false });

            if (!success) { return false; }

            const actualInsertPos = insertPos.line <= editor.document.lineCount
                ? insertPos : new vscode.Position(editor.document.lineCount - 1, 0);

            this.insertedText = insertText;
            this.insertedAt = actualInsertPos;

            // Decorate the new lines
            const insertedRange = this.calculateRange(actualInsertPos, insertText);
            this.decorateLines(editor, actualInsertPos.line, insertedRange.end.line, insertText, insertedLineDecoration);
        }

        return true;
    }

    // ─── Private: utilities ─────────────────────────────────────────

    private decorateLines(
        editor: vscode.TextEditor, startLine: number, endLine: number,
        content: string, decoration: vscode.TextEditorDecorationType
    ): void {
        const ranges: vscode.Range[] = [];
        const lastLine = content.endsWith('\n') ? endLine - 1 : endLine;
        for (let line = startLine; line <= lastLine && line < editor.document.lineCount; line++) {
            ranges.push(editor.document.lineAt(line).range);
        }
        if (ranges.length > 0) {
            editor.setDecorations(decoration, ranges);
        }
    }

    clearDecorations(editor: vscode.TextEditor): void {
        editor.setDecorations(insertedLineDecoration, []);
        editor.setDecorations(deletedLineDecoration, []);
        for (const dec of this.activeDecorations) {
            editor.setDecorations(dec, []);
            dec.dispose();
        }
        this.activeDecorations = [];
    }

    private clearSafetyTimer(): void {
        if (this.safetyTimer) {
            clearTimeout(this.safetyTimer);
            this.safetyTimer = null;
        }
    }

    private calculateRange(start: vscode.Position, content: string): vscode.Range {
        const lines = content.split('\n');
        const endLine = start.line + lines.length - 1;
        const endCol = lines.length === 1
            ? start.character + lines[0].length
            : lines[lines.length - 1].length;
        return new vscode.Range(start, new vscode.Position(endLine, endCol));
    }
}
