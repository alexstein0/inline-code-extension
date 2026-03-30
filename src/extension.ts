import * as vscode from 'vscode';
import { SuggestionProvider } from './suggestionProvider';

let provider: SuggestionProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('[InlineCode] Extension activating...');

    provider = new SuggestionProvider(context);

    // Register commands — Tab and Esc are bound in package.json keybindings
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

    console.log('[InlineCode] Extension activated.');
}

export function deactivate() {
    provider?.dispose();
    provider = undefined;
    console.log('[InlineCode] Extension deactivated.');
}
