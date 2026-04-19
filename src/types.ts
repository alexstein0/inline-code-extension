export type ActionType = 'insert' | 'delete' | 'replace';

// Canonical edit from the server (also used for history — same shape).
export interface Edit {
    action: ActionType;
    line: number;              // 1-indexed
    content: string | null;    // for insert/delete
    delete: string | null;     // for replace
    insert: string | null;     // for replace
}

// Response from the model server
export interface PredictResponse {
    edits: Edit[];
    warnings: string[];
    model: string | null;
    adaptor: string | null;
    finish_reason: string | null;
}

// History is just a list of canonical edits
export type HistoryStep = Edit;

// Request to the model server
export interface PredictRequest {
    file_content: string;
    cursor_line: number;   // 1-indexed
    cursor_col: number;    // 0-indexed
    language: string;
    file_path: string;
    history: HistoryStep[];
}

// Internal suggestion with VS Code coordinates (0-indexed both).
export interface Suggestion {
    action: ActionType;
    line: number;              // 1-indexed (server-resolved)
    content: string | null;
    deleteText: string | null;
    insertText: string | null;
    editLine: number;          // 0-indexed
    editCol: number;           // 0-indexed (always 0 for our full-line edits)
}

// Convert a canonical Edit to an internal Suggestion.
export function editToSuggestion(edit: Edit): Suggestion {
    return {
        action: edit.action,
        line: edit.line,
        content: edit.content,
        deleteText: edit.delete,
        insertText: edit.insert,
        editLine: edit.line - 1,
        editCol: 0,
    };
}
