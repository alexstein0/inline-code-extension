import * as vscode from 'vscode';
import { SuggestionProvider } from './suggestionProvider';
import { ModelClient } from './modelClient';

let provider: SuggestionProvider | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
const modelClient = new ModelClient();

async function updateStatusBar() {
    if (!statusBarItem) { return; }
    try {
        const info = await modelClient.listModels();
        statusBarItem.text = `$(hubot) ${info.current}`;
        statusBarItem.tooltip = 'Click to switch inline code model';
    } catch {
        statusBarItem.text = '$(hubot) disconnected';
    }
}

async function selectModel() {
    const info = await modelClient.listModels();
    if (!info.models.length) {
        vscode.window.showErrorMessage('No models available. Is the server running?');
        return;
    }

    const items = info.models.map(m => ({
        label: m.name,
        description: m.format,
        detail: m.description,
        picked: m.name === info.current,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Current: ${info.current}. Select a model to switch to:`,
    });

    if (!selected || selected.label === info.current) { return; }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Loading ${selected.label}...` },
        async () => {
            try {
                const result = await modelClient.switchModel(selected.label);
                if (result.status === 'ok') {
                    vscode.window.showInformationMessage(`Switched to ${result.model} (${result.format})`);
                } else {
                    vscode.window.showErrorMessage(`Failed: ${JSON.stringify(result)}`);
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Error switching model: ${e.message}`);
            }
            await updateStatusBar();
        }
    );
}

export function activate(context: vscode.ExtensionContext) {
    console.log('[InlineCode] Extension activating...');

    provider = new SuggestionProvider(context);

    // Status bar — shows current model, click to switch
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'inlineCode.selectModel';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    updateStatusBar();

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand(
            'inlineCode.acceptSuggestion',
            (editor) => {
                provider?.acceptSuggestion(editor);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand(
            'inlineCode.dismissSuggestion',
            (editor) => {
                provider?.dismissSuggestion(editor);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand(
            'inlineCode.triggerSuggestion',
            (editor) => {
                provider?.triggerPrediction(editor);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('inlineCode.selectModel', selectModel)
    );

    console.log('[InlineCode] Extension activated.');
}

export function deactivate() {
    provider?.dispose();
    provider = undefined;
    console.log('[InlineCode] Extension deactivated.');
}
