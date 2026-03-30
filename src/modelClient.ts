import * as vscode from 'vscode';
import { PredictRequest, PredictResponse } from './types';
import { parseResponse } from './responseParser';

export class ModelClient {
    private getServerUrl(): string {
        return vscode.workspace.getConfiguration('inlineCode').get<string>('serverUrl', 'http://localhost:8321');
    }

    async predict(request: PredictRequest, signal?: AbortSignal): Promise<PredictResponse> {
        const url = `${this.getServerUrl()}/predict`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
            signal,
        });

        if (!response.ok) {
            throw new Error(`Server returned ${response.status}: ${response.statusText}`);
        }

        const data: unknown = await response.json();
        return parseResponse(data);
    }

    async notify(event: string, action?: string, line?: number): Promise<void> {
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

    async switchModel(modelName: string): Promise<{status: string, model?: string, description?: string}> {
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
