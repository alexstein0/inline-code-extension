import * as vscode from 'vscode';
import { PredictRequest, PredictResponse } from './types';
import { parseResponse } from './responseParser';

function log(msg: string) {
    try {
        const { outputChannel } = require('./extension');
        if (outputChannel) {
            outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
        }
    } catch { /* ignore if output channel not ready */ }
}

export class ModelClient {
    private lastModelInfo: string | null = null;

    private getServerUrl(): string {
        return vscode.workspace.getConfiguration('inlineCode').get<string>('serverUrl', 'http://localhost:8321');
    }

    async predict(request: PredictRequest, signal?: AbortSignal): Promise<PredictResponse> {
        const url = `${this.getServerUrl()}/predict`;
        const body = JSON.stringify(request);
        log(`REQUEST → cursor=${request.cursor_line}:${request.cursor_col} history=${request.history.length} steps, file=${request.file_content.length} chars`);
        log(`  ▸ Request body: ${body.length > 500 ? body.slice(0, 500) + '...' : body}`);

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal,
        });

        if (!response.ok) {
            let detail = response.statusText;
            try {
                const errBody = await response.json() as any;
                detail = errBody.error || errBody.detail || JSON.stringify(errBody);
            } catch { /* response wasn't JSON */ }
            log(`ERROR ← ${response.status}: ${detail}`);
            throw new Error(`Server returned ${response.status}: ${detail}`);
        }

        const data: unknown = await response.json();
        const result = parseResponse(data);

        // Log warnings
        for (const w of result.warnings) { log(`  ⚠ ${w}`); }

        // Only log model/adaptor when it changes
        if (result.model) {
            const info = `${result.model} (adaptor: ${result.adaptor})`;
            if (info !== this.lastModelInfo) {
                log(`  [model changed] ${info}`);
                this.lastModelInfo = info;
            }
        }

        const finishSuffix = result.finish_reason === 'length' ? '  (hit token limit)' : '';
        log(`RESPONSE ← ${result.edits.length} edit(s)${finishSuffix}`);
        for (let i = 0; i < result.edits.length; i++) {
            const e = result.edits[i];
            log(`  ── Edit ${i + 1} ──`);
            log(`  action:    ${e.action}`);
            log(`  line:      ${e.line}`);
            if (e.content) {
                log(`  content:`);
                for (const line of e.content.split('\n')) { log(`    ${line}`); }
            }
            if (e.delete) {
                log(`  delete:`);
                for (const line of e.delete.split('\n')) { log(`    ${line}`); }
            }
            if (e.insert) {
                log(`  insert:`);
                for (const line of e.insert.split('\n')) { log(`    ${line}`); }
            }
        }
        return result;
    }

    async notify(event: string, action?: string, line?: number): Promise<void> {
        if (event === 'accept') {
            log(`✓ ACCEPTED ${action || ''} at L${line || '?'}`);
        } else if (event === 'dismiss') {
            log(`✗ DISMISSED`);
        }
        try {
            const url = `${this.getServerUrl()}/notify`;
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event, action, line }),
            });
        } catch {
            // Fire-and-forget — don't block on notification failures
        }
    }

    async listModels(): Promise<{models: {name: string, description: string, format: string}[], current: string}> {
        try {
            const url = `${this.getServerUrl()}/models`;
            const response = await fetch(url);
            if (!response.ok) { return {models: [], current: 'unknown'}; }
            return await response.json() as any;
        } catch {
            return {models: [], current: 'unknown'};
        }
    }

    async switchModel(modelName: string): Promise<{status: string, model?: string, description?: string, format?: string}> {
        const url = `${this.getServerUrl()}/switch-model`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model_name: modelName }),
        });
        return await response.json() as any;
    }

    async healthCheck(): Promise<boolean> {
        try {
            const url = `${this.getServerUrl()}/health`;
            const response = await fetch(url);
            return response.ok;
        } catch {
            return false;
        }
    }
}
