import * as vscode from 'vscode';
import { SuggestionProvider } from './suggestionProvider';
import { ModelClient } from './modelClient';

let provider: SuggestionProvider | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
const modelClient = new ModelClient();
export let outputChannel: vscode.OutputChannel;

async function updateStatusBar() {
    if (!statusBarItem) { return; }
    try {
        const info = await modelClient.listModels();
        if (info.current && info.current !== 'unknown') {
            statusBarItem.text = `$(hubot) ${info.current}`;
            statusBarItem.tooltip = 'Click to switch inline code model';
        } else {
            statusBarItem.text = `$(hubot) Select Model`;
            statusBarItem.tooltip = 'No model loaded — click to select one';
        }
    } catch {
        statusBarItem.text = '$(hubot) disconnected';
    }
}

async function autoSelectDefaultModel() {
    try {
        const info = await modelClient.listModels();
        if (info.current && info.current !== 'unknown') { return; } // already loaded
        if (info.models.length === 0) { return; }

        // Pick the first model as default
        const defaultModel = info.models[0].name;
        outputChannel.appendLine(`[InlineCode] No model loaded — auto-selecting "${defaultModel}"`);

        const result = await modelClient.switchModel(defaultModel);
        if (result.status === 'ok') {
            outputChannel.appendLine(`[InlineCode] Loaded default model: ${result.model} (${result.format})`);
        } else {
            outputChannel.appendLine(`[InlineCode] Failed to load default model: ${JSON.stringify(result)}`);
        }
    } catch (e: any) {
        outputChannel.appendLine(`[InlineCode] Could not auto-select model: ${e.message}`);
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

    // Create output channel for logging (View → Output → "Inline Code")
    outputChannel = vscode.window.createOutputChannel('Inline Code');
    context.subscriptions.push(outputChannel);
    outputChannel.appendLine('[InlineCode] Extension activating...');
    outputChannel.show(true); // Show output panel on startup

    provider = new SuggestionProvider(context);

    // Status bar — shows current model, click to switch
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'inlineCode.selectModel';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Auto-select default model if none is loaded
    autoSelectDefaultModel().then(() => updateStatusBar());

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
