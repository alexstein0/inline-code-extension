import * as vscode from 'vscode';
import { Suggestion } from './types';

// Inserted text: ghost-text style (dimmed, italic) + green left gutter bar
const insertedTextDecoration = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor('editorGhostText.foreground'),
    fontStyle: 'italic',
    backgroundColor: 'rgba(155, 185, 85, 0.08)',
    isWholeLine: true,
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: 'rgba(155, 185, 85, 0.6)',
});

// Text that will be deleted: just strikethrough, keep original color
const pendingDeleteDecoration = vscode.window.createTextEditorDecorationType({
    textDecoration: 'line-through',
    opacity: '0.6',
});

export class DecorationRenderer {
    private activeDecorations: vscode.TextEditorDecorationType[] = [];
    private previewApplied = false;
    private reverseEdit: (() => Promise<void>) | null = null;

    /**
     * Apply the edit to the document and highlight the changed region.
     * Inserted text is styled like ghost text (dimmed + italic + green gutter).
     * Returns true if the preview was applied successfully.
     */
    async showPreview(editor: vscode.TextEditor, suggestion: Suggestion): Promise<boolean> {
        this.clear(editor);

        const editPos = new vscode.Position(suggestion.editLine, suggestion.editCol);

        switch (suggestion.action) {
            case 'insert': {
                let content = suggestion.content;
                if (!content) { return false; }

                // When content starts with \n, the model means "insert new lines before editLine".
                // Transform: strip leading \n, ensure trailing \n so existing line gets pushed down.
                if (content.startsWith('\n')) {
                    content = content.slice(1);
                    if (!content.endsWith('\n')) {
                        content += '\n';
                    }
                }

                // Apply the insert
                const success = await editor.edit((eb) => {
                    eb.insert(editPos, content);
                }, { undoStopBefore: true, undoStopAfter: true });

                if (!success) { return false; }

                // Highlight each inserted line with ghost-text styling
                const insertedRange = this.calculateRange(editPos, content);
                this.decorateInsertedLines(editor, editPos.line, insertedRange.end.line, content);

                this.previewApplied = true;
                this.reverseEdit = async () => {
                    await editor.edit((eb) => {
                        eb.delete(insertedRange);
                    }, { undoStopBefore: false, undoStopAfter: false });
                };
                return true;
            }

            case 'delete': {
                // For delete, highlight what will be removed (don't actually delete yet)
                const content = suggestion.content;
                if (!content) { return false; }

                const range = this.calculateRange(editPos, content);
                editor.setDecorations(pendingDeleteDecoration, [{ range }]);

                this.previewApplied = false; // not applied yet — applied on accept
                this.reverseEdit = null;
                return true;
            }

            case 'replace': {
                const deleteText = suggestion.deleteText;
                const insertText = suggestion.insertText || '';
                if (!deleteText) { return false; }

                // Don't apply yet — show old text with strikethrough, new text as ghost
                const deleteRange = this.calculateRange(editPos, deleteText);
                editor.setDecorations(pendingDeleteDecoration, [{ range: deleteRange }]);

                // Show new text as ghost text after the old text
                const deleteEndLine = deleteRange.end.line;
                const lineEnd = editor.document.lineAt(deleteEndLine).range.end;
                const newLines = insertText.split('\n');
                // Show first line inline after the deleted text, rest on subsequent lines
                for (let i = 0; i < newLines.length; i++) {
                    const text = newLines[i];
                    if (text === '' && i === newLines.length - 1) { break; }
                    const targetLine = deleteEndLine + i;
                    if (targetLine >= editor.document.lineCount) { break; }
                    const attachEnd = i === 0 ? lineEnd : editor.document.lineAt(targetLine).range.end;
                    const dec = vscode.window.createTextEditorDecorationType({
                        after: {
                            contentText: (i === 0 ? '  →  ' : '    ') + text,
                            color: new vscode.ThemeColor('editorGhostText.foreground'),
                            fontStyle: 'italic',
                        },
                    });
                    this.activeDecorations.push(dec);
                    editor.setDecorations(dec, [{ range: new vscode.Range(attachEnd, attachEnd) }]);
                }

                this.previewApplied = false; // not applied yet — applied on accept
                this.reverseEdit = null;
                return true;
            }
        }
        return false;
    }

    /**
     * Accept the preview — just remove decorations (edit is already applied).
     * For delete action, actually apply the edit now.
     */
    async acceptPreview(editor: vscode.TextEditor, suggestion: Suggestion): Promise<void> {
        if (!this.previewApplied) {
            const editPos = new vscode.Position(suggestion.editLine, suggestion.editCol);
            if (suggestion.action === 'delete' && suggestion.content) {
                const range = this.calculateRange(editPos, suggestion.content);
                await editor.edit((eb) => {
                    eb.delete(range);
                });
            } else if (suggestion.action === 'replace' && suggestion.deleteText) {
                const range = this.calculateRange(editPos, suggestion.deleteText);
                await editor.edit((eb) => {
                    eb.replace(range, suggestion.insertText || '');
                });
            }
        }
        this.clear(editor);
        this.previewApplied = false;
        this.reverseEdit = null;
    }

    /**
     * Dismiss the preview — reverse the edit and remove decorations.
     */
    async dismissPreview(editor: vscode.TextEditor): Promise<void> {
        if (this.previewApplied && this.reverseEdit) {
            await this.reverseEdit();
        }
        this.clear(editor);
        this.previewApplied = false;
        this.reverseEdit = null;
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

    clear(editor: vscode.TextEditor): void {
        editor.setDecorations(insertedTextDecoration, []);
        editor.setDecorations(pendingDeleteDecoration, []);
        for (const dec of this.activeDecorations) {
            editor.setDecorations(dec, []);
            dec.dispose();
        }
        this.activeDecorations = [];
    }

    get isPreviewApplied(): boolean {
        return this.previewApplied;
    }

    /**
     * Apply ghost-text styling to inserted lines.
     * Each line gets: dimmed color, italic, green left gutter bar.
     */
    private decorateInsertedLines(editor: vscode.TextEditor, startLine: number, endLine: number, content: string): void {
        const ranges: vscode.Range[] = [];
        // If content ends with \n, the last "line" in the split is empty — don't decorate it
        const lastLine = content.endsWith('\n') ? endLine - 1 : endLine;
        for (let line = startLine; line <= lastLine && line < editor.document.lineCount; line++) {
            const lineRange = editor.document.lineAt(line).range;
            ranges.push(lineRange);
        }
        if (ranges.length > 0) {
            editor.setDecorations(insertedTextDecoration, ranges);
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
