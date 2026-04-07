import * as vscode from 'vscode';
import { Suggestion } from './types';

/**
 * Re-indent a block of text to match a target indentation level.
 * Detects the indent of the first non-empty line in `text`, then shifts
 * all lines by the difference to match `targetIndent`.
 */
function reindentBlock(text: string, targetIndent: string): string {
    const lines = text.split('\n');
    // Find indent of first non-empty line
    const firstNonEmpty = lines.find(l => l.trim().length > 0);
    if (!firstNonEmpty) { return text; }
    const currentIndent = firstNonEmpty.match(/^(\s*)/)?.[1] || '';
    if (currentIndent === targetIndent) { return text; }

    return lines.map(line => {
        if (line.trim().length === 0) { return line; } // preserve blank lines
        if (line.startsWith(currentIndent)) {
            return targetIndent + line.slice(currentIndent.length);
        }
        return line; // line has less indent than base — leave as-is
    }).join('\n');
}

function getFixIndentation(): boolean {
    return vscode.workspace.getConfiguration('inlineCode').get<boolean>('fixIndentation', true);
}

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

            if (suggestion.action === 'insert') {
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
     * Dismiss the preview — reverse any document changes.
     */
    async dismissPreview(editor: vscode.TextEditor): Promise<void> {
        if (this.state !== 'active') { return; }
        this.state = 'dismissing';
        this.clearSafetyTimer();

        try {
            // Use VS Code's built-in undo to cleanly reverse the preview.
            // This avoids marking the document as dirty.
            if (this.insertedText) {
                await vscode.commands.executeCommand('undo');
            }
        } catch (e) {
            console.error('[InlineCode] Dismiss error:', e);
        }

        this.clearDecorations(editor);
        this.insertedText = null;
        this.insertedAt = null;
        this.deleteRange = null;
        this.state = 'idle';
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

        // Match indentation to the line we're inserting before
        if (getFixIndentation() && editPos.line < editor.document.lineCount) {
            const targetLine = editor.document.lineAt(editPos.line).text;
            const targetIndent = targetLine.match(/^(\s*)/)?.[1] || '';
            content = reindentBlock(content, targetIndent);
        }

        const success = await editor.edit((eb) => {
            eb.insert(editPos, content);
        }, { undoStopBefore: false, undoStopAfter: false });

        if (!success) { return false; }

        this.insertedText = content;
        this.insertedAt = editPos;

        // Decorate the inserted lines
        const insertedRange = this.calculateRange(editPos, content);
        this.decorateLines(editor, editPos.line, insertedRange.end.line, content, insertedLineDecoration);

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

        // Match insert indentation to delete indentation
        if (insertText && getFixIndentation()) {
            const firstDeleteLine = deleteText.split('\n').find(l => l.trim().length > 0);
            const targetIndent = firstDeleteLine?.match(/^(\s*)/)?.[1] || '';
            insertText = reindentBlock(insertText, targetIndent);
        }

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
