import { PredictResponse, Change, ActionType } from './types';

const VALID_ACTIONS: ActionType[] = ['insert', 'delete', 'replace'];

function parseChange(obj: Record<string, unknown>): Change | null {
    const action = obj.action as string;
    if (!VALID_ACTIONS.includes(action as ActionType)) {
        return null;
    }

    return {
        action: action as ActionType,
        line: typeof obj.line === 'number' ? obj.line : 1,
        before: typeof obj.before === 'string' ? obj.before : null,
        after: typeof obj.after === 'string' ? obj.after : null,
        content: typeof obj.content === 'string' ? obj.content : null,
        delete: typeof obj.delete === 'string' ? obj.delete : null,
        insert: typeof obj.insert === 'string' ? obj.insert : null,
        edit_line: typeof obj.edit_line === 'number' ? obj.edit_line : 0,
        edit_col: typeof obj.edit_col === 'number' ? obj.edit_col : 0,
        model_line: typeof obj.model_line === 'number' ? obj.model_line : null,
        pre_shift_line: typeof obj.pre_shift_line === 'number' ? obj.pre_shift_line : null,
    };
}

export function parseResponse(data: unknown): PredictResponse {
    if (typeof data !== 'object' || data === null) {
        throw new Error('Response is not an object');
    }

    const obj = data as Record<string, unknown>;

    if (Array.isArray(obj.changes)) {
        const changes: Change[] = [];
        for (const item of obj.changes) {
            if (typeof item === 'object' && item !== null) {
                const change = parseChange(item as Record<string, unknown>);
                if (change) {
                    changes.push(change);
                }
            }
        }
        return { changes };
    }

    return { changes: [] };
}
