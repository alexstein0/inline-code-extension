# Inline Code — VS Code Extension

AI-powered inline code editing suggestions. The model predicts the next granular editing step (insert, delete, replace) based on your file content, cursor position, and recent edit history.

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure server URL:**
   Open VS Code Settings → search `inlineCode.serverUrl` → set to your server URL

3. **Run:**
   - Open this folder in VS Code
   - Press F5 to launch the Extension Development Host
   - Open any Python file and start editing
   - Suggestions appear as ghost text after 500ms pause
   - **Tab** to accept, **Esc** to dismiss

## How It Works

The extension sends your current file state + cursor + recent edit history to a model server. The server returns structured edit predictions (not just completions — it can suggest insertions, deletions, and replacements anywhere in the file).

## Server

The extension connects to a FastAPI model server. See the server documentation for setup instructions.

Default server URL: `http://localhost:8321`
