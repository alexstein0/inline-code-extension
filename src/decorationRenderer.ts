import * as vscode from 'vscode';
import { Suggestion } from './types';

// Highlight style for inserted/changed text (green-tinted like a diff)
const insertHighlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(155, 185, 85, 0.15)',
    isWholeLine: false,
});

// Strikethrough for text that will be deleted (only used for replace preview)
const pendingDeleteHighlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 0, 0, 0.1)',
    isWholeLine: false,
});

export class DecorationRenderer {
    private activeDecorations: vscode.TextEditorDecorationType[] = [];
    private previewApplied = false;
    private reverseEdit: (() => Promise<void>) | null = null;

    /**
     * Apply the edit to the document and highlight the changed region.
     * This shows an exact preview — the document looks exactly as it will after Tab.
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

                // Highlight the inserted region
                const lines = content.split('\n');
                const endLine = editPos.line + lines.length - 1;
                const endCol = lines.length === 1
                    ? editPos.character + lines[0].length
                    : lines[lines.length - 1].length;
                const insertedRange = new vscode.Range(editPos, new vscode.Position(endLine, endCol));
                editor.setDecorations(insertHighlight, [{ range: insertedRange }]);

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
                editor.setDecorations(pendingDeleteHighlight, [{ range }]);

                this.previewApplied = false; // not applied yet — applied on accept
                this.reverseEdit = null;
                return true;
            }

            case 'replace': {
                const deleteText = suggestion.deleteText;
                const insertText = suggestion.insertText;
                if (!deleteText) { return false; }

                // Apply the replacement
                const deleteRange = this.calculateRange(editPos, deleteText);
                const success = await editor.edit((eb) => {
                    eb.replace(deleteRange, insertText || '');
                }, { undoStopBefore: true, undoStopAfter: true });

                if (!success) { return false; }

                // Highlight the new text
                const newLines = (insertText || '').split('\n');
                const endLine = editPos.line + newLines.length - 1;
                const endCol = newLines.length === 1
                    ? editPos.character + newLines[0].length
                    : newLines[newLines.length - 1].length;
                const insertedRange = new vscode.Range(editPos, new vscode.Position(endLine, endCol));
                editor.setDecorations(insertHighlight, [{ range: insertedRange }]);

                this.previewApplied = true;
                this.reverseEdit = async () => {
                    // Reverse: replace the inserted text back with the deleted text
                    await editor.edit((eb) => {
                        eb.replace(insertedRange, deleteText);
                    }, { undoStopBefore: false, undoStopAfter: false });
                };
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
        if (suggestion.action === 'delete' && !this.previewApplied) {
            // Delete wasn't applied during preview — apply now
            const editPos = new vscode.Position(suggestion.editLine, suggestion.editCol);
            const content = suggestion.content;
            if (content) {
                const range = this.calculateRange(editPos, content);
                await editor.edit((eb) => {
                    eb.delete(range);
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
        editor.setDecorations(insertHighlight, []);
        editor.setDecorations(pendingDeleteHighlight, []);
        for (const dec of this.activeDecorations) {
            editor.setDecorations(dec, []);
            dec.dispose();
        }
        this.activeDecorations = [];
    }

    get isPreviewApplied(): boolean {
        return this.previewApplied;
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
