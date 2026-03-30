export type ActionType = 'insert' | 'delete' | 'replace';

// A single validated change from the server (edit location already resolved)
export interface Change {
    action: ActionType;
    line: number;              // 1-indexed target line (from model)
    before: string | null;
    after: string | null;
    content: string | null;
    delete: string | null;
    insert: string | null;
    edit_line: number;         // 0-indexed, resolved by server
    edit_col: number;          // 0-indexed, resolved by server
}

// Response from the model server — list of validated changes
export interface PredictResponse {
    changes: Change[];
}

// A history step sent to the server (mirrors the output JSON format)
export interface HistoryStep {
    action: ActionType;
    line: number;          // 1-indexed
    before: string | null;
    after: string | null;
    content: string | null;
    delete: string | null;
    insert: string | null;
}

// Request to the model server
export interface PredictRequest {
    file_content: string;
    cursor_line: number;   // 1-indexed
    cursor_col: number;    // 0-indexed
    language: string;
    file_path: string;
    history: HistoryStep[];
}

// Internal suggestion with VS Code coordinates (0-indexed both)
export interface Suggestion {
    action: ActionType;
    line: number;          // 1-indexed (from model)
    before: string | null;
    after: string | null;
    content: string | null;
    deleteText: string | null;
    insertText: string | null;
    editLine: number;      // 0-indexed
    editCol: number;       // 0-indexed
}

// Convert a server Change to an internal Suggestion.
// No validation needed — server already validated and resolved edit location.
export function changeToSuggestion(change: Change): Suggestion {
    return {
        action: change.action,
        line: change.line,
        before: change.before,
        after: change.after,
        content: change.content,
        deleteText: change.delete,
        insertText: change.insert,
        editLine: change.edit_line,
        editCol: change.edit_col,
    };
}
