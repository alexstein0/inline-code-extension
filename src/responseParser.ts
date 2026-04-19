import { PredictResponse, Edit, ActionType } from './types';

const VALID_ACTIONS: ActionType[] = ['insert', 'delete', 'replace'];

function parseEdit(obj: Record<string, unknown>): Edit | null {
    const action = obj.action as string;
    if (!VALID_ACTIONS.includes(action as ActionType)) {
        return null;
    }
    return {
        action: action as ActionType,
        line: typeof obj.line === 'number' ? obj.line : 1,
        content: typeof obj.content === 'string' ? obj.content : null,
        delete: typeof obj.delete === 'string' ? obj.delete : null,
        insert: typeof obj.insert === 'string' ? obj.insert : null,
    };
}

export function parseResponse(data: unknown): PredictResponse {
    const empty: PredictResponse = { edits: [], warnings: [], model: null, adaptor: null, finish_reason: null };
    if (typeof data !== 'object' || data === null) { return empty; }

    const obj = data as Record<string, unknown>;
    const edits: Edit[] = [];
    if (Array.isArray(obj.edits)) {
        for (const item of obj.edits) {
            if (typeof item === 'object' && item !== null) {
                const e = parseEdit(item as Record<string, unknown>);
                if (e) { edits.push(e); }
            }
        }
    }
    return {
        edits,
        warnings: Array.isArray(obj.warnings) ? (obj.warnings as string[]) : [],
        model: typeof obj.model === 'string' ? obj.model : null,
        adaptor: typeof obj.adaptor === 'string' ? obj.adaptor : null,
        finish_reason: typeof obj.finish_reason === 'string' ? obj.finish_reason : null,
    };
}
