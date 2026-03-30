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
