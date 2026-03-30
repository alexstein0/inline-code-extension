import * as vscode from 'vscode';
import { Suggestion } from './types';

// Strikethrough for deleted text
const deleteDecorationType = vscode.window.createTextEditorDecorationType({
    textDecoration: 'line-through',
    opacity: '0.5',
});

export class DecorationRenderer {
    private activeDecorations: vscode.TextEditorDecorationType[] = [];

    show(editor: vscode.TextEditor, suggestion: Suggestion): void {
        this.clear(editor);

        // Show the edit preview at the edit location
        switch (suggestion.action) {
            case 'insert':
                this.showInsert(editor, suggestion);
                break;
            case 'delete':
                this.showDelete(editor, suggestion);
                break;
            case 'replace':
                this.showReplace(editor, suggestion);
                break;
        }

        // If the edit is far from the cursor, show a jump indicator at the cursor
        this.showJumpIndicator(editor, suggestion);
    }

    clear(editor: vscode.TextEditor): void {
        editor.setDecorations(deleteDecorationType, []);
        for (const dec of this.activeDecorations) {
            editor.setDecorations(dec, []);
            dec.dispose();
        }
        this.activeDecorations = [];
    }

    private showInsert(editor: vscode.TextEditor, suggestion: Suggestion): void {
        const content = suggestion.content;
        if (!content) { return; }

        // Show each line of the insert as ghost text.
        // Line 0: appended as `after` decoration on the edit line (or line above).
        // Lines 1+: appended as `after` decorations on subsequent lines.
        const insertLines = content.split('\n');
        const editLine = suggestion.editLine;

        // Attach ghost text to the line where the insert happens.
        // If inserting at col 0, show on the line above (the BEFORE line).
        const attachLine = suggestion.editCol === 0 && editLine > 0
            ? editLine - 1
            : editLine;

        for (let i = 0; i < insertLines.length; i++) {
            const text = insertLines[i];
            if (text === '' && i === insertLines.length - 1) { break; } // skip trailing empty

            const targetLine = attachLine + i;
            if (targetLine >= editor.document.lineCount) { break; }

            const lineEnd = editor.document.lineAt(targetLine).range.end;
            const prefix = i === 0 ? '  ' : '  '; // visual separator

            const dec = vscode.window.createTextEditorDecorationType({
                after: {
                    contentText: prefix + text,
                    color: new vscode.ThemeColor('editorGhostText.foreground'),
                    fontStyle: 'italic',
                },
            });
            this.activeDecorations.push(dec);
            editor.setDecorations(dec, [{ range: new vscode.Range(lineEnd, lineEnd) }]);
        }
    }

    private showDelete(editor: vscode.TextEditor, suggestion: Suggestion): void {
        const content = suggestion.content;
        if (!content) { return; }

        const range = this.calculateRange(suggestion.editLine, suggestion.editCol, content);
        editor.setDecorations(deleteDecorationType, [{ range }]);
    }

    private showReplace(editor: vscode.TextEditor, suggestion: Suggestion): void {
        const deleteContent = suggestion.deleteText;
        const insertContent = suggestion.insertText;
        if (!deleteContent) { return; }

        // Strikethrough on old text
        const deleteRange = this.calculateRange(suggestion.editLine, suggestion.editCol, deleteContent);
        editor.setDecorations(deleteDecorationType, [{ range: deleteRange }]);

        // Ghost text for replacement
        if (insertContent) {
            const insertLines = insertContent.split('\n');

            for (let i = 0; i < insertLines.length; i++) {
                const text = insertLines[i];
                if (text === '' && i === insertLines.length - 1) { break; }

                // First line: after the delete range end. Subsequent: on following lines.
                const targetLine = deleteRange.end.line + i;
                if (targetLine >= editor.document.lineCount) { break; }

                const lineEnd = editor.document.lineAt(targetLine).range.end;
                const prefix = i === 0 ? '  ' : '  ';

                const dec = vscode.window.createTextEditorDecorationType({
                    after: {
                        contentText: prefix + text,
                        color: new vscode.ThemeColor('editorGhostText.foreground'),
                        fontStyle: 'italic',
                    },
                });
                this.activeDecorations.push(dec);
                editor.setDecorations(dec, [{ range: new vscode.Range(lineEnd, lineEnd) }]);
            }
        }
    }

    private showJumpIndicator(editor: vscode.TextEditor, suggestion: Suggestion): void {
        const cursorLine = editor.selection.active.line;
        const editLine = suggestion.editLine;
        const distance = Math.abs(editLine - cursorLine);

        // Only show indicator if the edit is more than 2 lines away
        if (distance <= 2) { return; }

        const direction = editLine > cursorLine ? '↓' : '↑';
        const lineNum = editLine + 1; // display as 1-indexed
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

    private calculateRange(startLine: number, startCol: number, content: string): vscode.Range {
        const lines = content.split('\n');
        const endLine = startLine + lines.length - 1;
        const endCol = lines.length === 1
            ? startCol + lines[0].length
            : lines[lines.length - 1].length;

        return new vscode.Range(
            new vscode.Position(startLine, startCol),
            new vscode.Position(endLine, endCol)
        );
    }
}
