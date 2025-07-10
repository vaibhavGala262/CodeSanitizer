import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Global variables to manage state
let highlightDecorations: vscode.TextEditorDecorationType[] = [];
let lastCleanEdit: { uri: vscode.Uri; originalText: string } | null = null;

export function activate(context: vscode.ExtensionContext) {
    console.log('CODESANITIZER EXTENSION ACTIVATED!');
    
    const showWelcome = context.globalState.get('firstRun', true);
    if (showWelcome) {
        vscode.window.showInformationMessage(
            'Log Cleaner: Use Ctrl+Alt+H to highlight, Ctrl+Alt+R to clean, Ctrl+Alt+G for Git features',
            'OK', 'Never Show Again'
        ).then(selection => {
            if (selection === 'Never Show Again') {
                context.globalState.update('firstRun', false);
            }
        });
    }

    // Register existing commands
    const toggleHighlightCommand = vscode.commands.registerCommand('codesanitizer.toggleHighlight', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        if (highlightDecorations.length > 0) {
            clearHighlights();
        } else {
            highlightPatterns(editor);
        }
    });

    const cleanCommand = vscode.commands.registerCommand('codesanitizer.cleanAll', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const document = editor.document;
        const fullText = document.getText();
        const languageId = document.languageId;

        lastCleanEdit = {
            uri: document.uri,
            originalText: fullText
        };

        const cleanedText = removePatterns(fullText, languageId);

        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(fullText.length)
        );
        edit.replace(document.uri, fullRange, cleanedText);
        await vscode.workspace.applyEdit(edit);
        
        clearHighlights();
    });

    const undoCleanCommand = vscode.commands.registerCommand('codesanitizer.undoClean', async () => {
        if (!lastCleanEdit) {
            vscode.window.showWarningMessage("Nothing to undo");
            return;
        }

        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            new vscode.Position(0, 0),
            new vscode.Position(Number.MAX_VALUE, Number.MAX_VALUE)
        );
        edit.replace(lastCleanEdit.uri, fullRange, lastCleanEdit.originalText);
        await vscode.workspace.applyEdit(edit);
        lastCleanEdit = null;
    });

    // NEW GIT FEATURES
    const cleanStagedCommand = vscode.commands.registerCommand('codesanitizer.cleanStaged', async () => {
        await cleanStagedFiles();
    });

    const setupPreCommitHookCommand = vscode.commands.registerCommand('codesanitizer.setupPreCommitHook', async () => {
        await setupPreCommitHook();
    });

    const cleanBeforeCommitCommand = vscode.commands.registerCommand('codesanitizer.cleanBeforeCommit', async () => {
        await cleanBeforeCommit();
    });

    const showGitStatusCommand = vscode.commands.registerCommand('codesanitizer.showGitStatus', async () => {
        await showGitCleanStatus();
    });

    // Clear highlights when document changes
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(() => {
        clearHighlights();
    });

    // Register all disposables
    context.subscriptions.push(
        toggleHighlightCommand,
        cleanCommand,
        undoCleanCommand,
        cleanStagedCommand,
        setupPreCommitHookCommand,
        cleanBeforeCommitCommand,
        showGitStatusCommand,
        changeDocumentSubscription
    );
}


async function setupPreCommitHook() {
    const workspaceFolder = await getGitWorkspaceFolder();
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No git repository found in workspace');
        return;
    }

    const hookPath = path.join(workspaceFolder, '.git', 'hooks', 'pre-commit');
    const hookContent = `#!/bin/sh
# Code Sanitizer Pre-commit Hook
# This hook automatically cleans debug code before commits

echo "🧹 Cleaning debug code before commit..."

# Get staged files
staged_files=$(git diff --cached --name-only --diff-filter=ACM | grep -E "\\.(js|ts|jsx|tsx|py|java|cpp|c|php|rb)$")

if [ -z "$staged_files" ]; then
    echo "No code files to clean"
    exit 0
fi

# Note: This would integrate with VS Code extension
# For now, just show what would be cleaned
echo "Files that would be cleaned:"
echo "$staged_files"

read -p "Continue with commit? (y/n): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Commit cancelled"
    exit 1
fi

exit 0
`;

    try {
        const fs = require('fs');
        
        // Ensure hooks directory exists
        const hooksDir = path.join(workspaceFolder, '.git', 'hooks');
        if (!fs.existsSync(hooksDir)) {
            fs.mkdirSync(hooksDir, { recursive: true });
        }
        
        fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
        vscode.window.showInformationMessage('Pre-commit hook installed! 🎉');
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to install hook: ${error}`);
    }
}

async function cleanBeforeCommit() {
    const workspaceFolder = await getGitWorkspaceFolder();
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No git repository found in workspace');
        return;
    }

    try {
        // Get modified files
        const { stdout } = await execAsync('git diff --name-only', {
            cwd: workspaceFolder
        });
        
        const modifiedFiles = stdout.trim().split('\n').filter(file => file.length > 0);
        
        if (modifiedFiles.length === 0) {
            vscode.window.showInformationMessage('No modified files to clean');
            return;
        }

        // Show preview with statistics
        await showCleaningPreview(modifiedFiles, workspaceFolder);
    } catch (error) {
        vscode.window.showErrorMessage(`Git error: ${error}`);
    }
}

async function showGitCleanStatus() {
    const workspaceFolder = await getGitWorkspaceFolder();
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No git repository found in workspace');
        return;
    }

    try {
        const { stdout } = await execAsync('git status --porcelain', {
            cwd: workspaceFolder
        });
        
        const files = stdout.trim().split('\n').filter(file => file.length > 0);
        let cleanableFiles = 0;
        let totalDebugLines = 0;

        for (const file of files) {
            const fileName = file.substring(3); // Remove git status prefix
            if (isCleanableFile(fileName)) {
                cleanableFiles++;
                totalDebugLines += await countDebugLines(path.join(workspaceFolder, fileName));
            }
        }

        vscode.window.showInformationMessage(
            `Git Status: ${cleanableFiles} files with ~${totalDebugLines} debug lines`
        );
    } catch (error) {
        vscode.window.showErrorMessage(`Git error: ${error}`);
    }
}

// NEW: Helper function to find git repository root
async function getGitWorkspaceFolder(): Promise<string | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return null;
    }

    // Try each workspace folder to find one with a git repository
    for (const folder of workspaceFolders) {
        try {
            await execAsync('git rev-parse --show-toplevel', {
                cwd: folder.uri.fsPath
            });
            // If this succeeds, we found a git repo
            return folder.uri.fsPath;
        } catch (error) {
            // This folder doesn't have a git repo, try the next one
            continue;
        }
    }

    // If no workspace folder has a git repo, try to find git root from current active file
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        const activeFilePath = activeEditor.document.uri.fsPath;
        const activeFileDir = path.dirname(activeFilePath);
        
        try {
            const { stdout } = await execAsync('git rev-parse --show-toplevel', {
                cwd: activeFileDir
            });
            return stdout.trim();
        } catch (error) {
            // No git repo found
        }
    }

    return null;
}


// Helper functions
function isCleanableFile(fileName: string): boolean {
    const cleanableExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.php', '.rb'];
    return cleanableExtensions.some(ext => fileName.endsWith(ext));
}

async function cleanFile(filePath: string): Promise<void> {
    try {
        const fs = require('fs');
        const content = fs.readFileSync(filePath, 'utf8');
        const fileExtension = path.extname(filePath).substring(1);
        
        // Map file extensions to language IDs
        const langMap: { [key: string]: string } = {
            'js': 'javascript',
            'ts': 'typescript',
            'jsx': 'javascript',
            'tsx': 'typescript',
            'py': 'python',
            'java': 'java',
            'cpp': 'cpp',
            'c': 'c',
            'php': 'php',
            'rb': 'ruby'
        };

        const languageId = langMap[fileExtension] || 'plaintext';
        const cleanedContent = removePatterns(content, languageId);
        
        fs.writeFileSync(filePath, cleanedContent, 'utf8');
    } catch (error) {
        console.error(`Error cleaning file ${filePath}:`, error);
    }
}

async function countDebugLines(filePath: string): Promise<number> {
    try {
        const fs = require('fs');
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        
        return lines.filter((line:string) => 
            line.includes('console.log') || 
            line.includes('print(') ||
            line.includes('printf(') ||
            line.trim().startsWith('//') ||
            line.trim().startsWith('#')
        ).length;
    } catch (error) {
        return 0;
    }
}

async function showStagedFilesPreview(files: string[], workspacePath: string) {
    const panel = vscode.window.createWebviewPanel(
        'codesanitizer-preview',
        'Staged Files Preview',
        vscode.ViewColumn.Two,
        { enableScripts: true }
    );

    let filesInfo = '';
    for (const file of files) {
        if (isCleanableFile(file)) {
            const debugLines = await countDebugLines(path.join(workspacePath, file));
            filesInfo += `<li>${file} - ${debugLines} debug lines</li>`;
        }
    }

    panel.webview.html = `
        <html>
        <head><title>Preview</title></head>
        <body>
            <h2>Files to be cleaned:</h2>
            <ul>${filesInfo}</ul>
            <button onclick="clean()">Clean All</button>
            <button onclick="cancel()">Cancel</button>
            <script>
                const vscode = acquireVsCodeApi();
                function clean() { vscode.postMessage({command: 'clean'}); }
                function cancel() { vscode.postMessage({command: 'cancel'}); }
            </script>
        </body>
        </html>
    `;
}

async function showCleaningPreview(files: string[], workspacePath: string) {
    let totalLines = 0;
    let cleanableFiles = 0;

    for (const file of files) {
        if (isCleanableFile(file)) {
            cleanableFiles++;
            totalLines += await countDebugLines(path.join(workspacePath, file));
        }
    }

    const result = await vscode.window.showInformationMessage(
        `Found ${cleanableFiles} files with ~${totalLines} debug lines. Clean before commit?`,
        { modal: true },
        'Clean & Stage', 'Just Clean', 'Cancel'
    );

    if (result === 'Clean & Stage') {
        // Clean and stage files
        for (const file of files) {
            if (isCleanableFile(file)) {
                await cleanFile(path.join(workspacePath, file));
            }
        }
        await execAsync('git add .', { cwd: workspacePath });
        vscode.window.showInformationMessage('Files cleaned and staged! 🎉');
    } else if (result === 'Just Clean') {
        // Just clean files
        for (const file of files) {
            if (isCleanableFile(file)) {
                await cleanFile(path.join(workspacePath, file));
            }
        }
        vscode.window.showInformationMessage('Files cleaned! 🧹');
    }
}

// Fixed Git Integration Functions
async function cleanStagedFiles() {
    const workspaceFolder = await getGitWorkspaceFolder();
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No git repository found in workspace');
        return;
    }

    try {
        // Get staged files using git status
        const { stdout } = await execAsync('git status --porcelain', {
            cwd: workspaceFolder
        });
        
        // Parse staged files (lines starting with A, M, R, C, D in first column)
        const stagedFiles = stdout.trim().split('\n')
            .filter(line => line.length > 0)
            .filter(line => /^[AMRCD]/.test(line)) // First character indicates staged
            .map(line => line.substring(3)); // Remove status prefix
        
        if (stagedFiles.length === 0) {
            vscode.window.showInformationMessage('No staged files to clean');
            return;
        }

        // Show what will be cleaned
        const result = await vscode.window.showInformationMessage(
            `Clean ${stagedFiles.length} staged files?`,
            { modal: true },
            'Yes, Clean', 'Preview First', 'Cancel'
        );

        if (result === 'Cancel') return;

        if (result === 'Preview First') {
            await showStagedFilesPreview(stagedFiles, workspaceFolder);
            return;
        }

        // Clean staged files
        let cleanedCount = 0;
        for (const file of stagedFiles) {
            if (isCleanableFile(file)) {
                await cleanFile(path.join(workspaceFolder, file));
                cleanedCount++;
            }
        }

        vscode.window.showInformationMessage(`Cleaned ${cleanedCount} files`);
    } catch (error) {
        vscode.window.showErrorMessage(`Git error: ${error}`);
    }
}

// Keep all your existing functions (clearHighlights, removePatterns, etc.)
function clearHighlights() {
    highlightDecorations.forEach(decoration => {
        decoration.dispose();
    });
    highlightDecorations = [];
}

function removePatterns(text: string, languageId: string): string {
    const patterns: { regex: RegExp, languages?: string[] }[] = [
        { regex: /^\s*console\.log\([^)]*\);?\s*$/gm, languages: ['javascript', 'typescript'] },
        { regex: /^\s*print\([^)]*\);?\s*$/gm, languages: ['python'] },
        { regex: /^\s*printf\([^)]*\);?\s*$/gm, languages: ['c', 'cpp'] },
        { regex: /^\s*std::cout\s*<<[^;]*;\s*$/gm, languages: ['cpp'] },
        { regex: /^\s*System\.out\.println\([^)]*\);?\s*$/gm, languages: ['java'] },
        { regex: /^\s*puts?\s+[^;]*;?\s*$/gm, languages: ['ruby'] },
        { regex: /^\s*echo\s+[^;]*;?\s*$/gm, languages: ['php'] },
        { regex: /^\s*\/\/.*$/gm, languages: ['javascript', 'typescript', 'java', 'cpp', 'c', 'csharp', 'go', 'rust', 'dart'] },
        { regex: /\/\*[\s\S]*?\*\//g, languages: ['javascript', 'typescript', 'java', 'cpp', 'c', 'csharp', 'go', 'rust', 'dart'] },
        { regex: /^\s*#.*$/gm, languages: ['python', 'ruby', 'perl', 'yaml', 'dockerfile', 'shellscript'] },
        { regex: /<!--[\s\S]*?-->/g, languages: ['html', 'xml'] },
        { regex: /^\s*'''[\s\S]*?'''\s*$/gm, languages: ['python'] },
        { regex: /^\s*"""[\s\S]*?"""\s*$/gm, languages: ['python'] }
    ];

    let cleanedText = text;
    
    patterns.forEach(pattern => {
        if (!pattern.languages || pattern.languages.includes(languageId)) {
            cleanedText = cleanedText.replace(pattern.regex, '');
        }
    });

    cleanedText = cleanedText.replace(/\n\s*\n\s*\n/g, '\n\n');
    cleanedText = cleanedText.replace(/[ \t]+$/gm, '');
    cleanedText = cleanedText.replace(/^\s*\n/, '');
    cleanedText = cleanedText.replace(/[\u200B-\u200D\uFEFF]/g, '');
    
    return cleanedText;
}

function highlightPatterns(editor: vscode.TextEditor) {
    clearHighlights();

    const document = editor.document;
    const languageId = document.languageId;
    const text = document.getText();

    const printDecoration = vscode.window.createTextEditorDecorationType({
        border: "1px solid rgba(255,100,100,0.3)",
        backgroundColor: "rgba(255,100,100,0.1)",
        overviewRulerColor: "rgba(255,100,100,0.5)",
        overviewRulerLane: vscode.OverviewRulerLane.Right
    });

    const commentDecoration = vscode.window.createTextEditorDecorationType({
        border: "1px solid rgba(100,200,100,0.3)",
        backgroundColor: "rgba(100,200,100,0.1)",
        overviewRulerColor: "rgba(100,200,100,0.5)",
        overviewRulerLane: vscode.OverviewRulerLane.Right
    });

    highlightDecorations = [printDecoration, commentDecoration];

    const printPatterns: { regex: RegExp, languages?: string[] }[] = [
        { regex: /console\.log\([^)]*\);?/g, languages: ['javascript', 'typescript'] },
        { regex: /print\([^)]*\);?/g, languages: ['python'] },
        { regex: /printf\([^)]*\);?/g, languages: ['c', 'cpp'] },
        { regex: /std::cout\s*<<[^;]*;/g, languages: ['cpp'] },
        { regex: /System\.out\.println\([^)]*\);?/g, languages: ['java'] },
        { regex: /puts?\s+[^;]*;?/g, languages: ['ruby'] },
        { regex: /echo\s+[^;]*;?/g, languages: ['php'] }
    ];

    const commentPatterns: { regex: RegExp, languages?: string[] }[] = [
        { regex: /\/\/.*$/gm, languages: ['javascript', 'typescript', 'java', 'cpp', 'c', 'csharp', 'go', 'rust', 'dart'] },
        { regex: /\/\*[\s\S]*?\*\//g, languages: ['javascript', 'typescript', 'java', 'cpp', 'c', 'csharp', 'go', 'rust', 'dart'] },
        { regex: /#.*$/gm, languages: ['python', 'ruby', 'perl', 'yaml', 'dockerfile', 'shellscript'] },
        { regex: /<!--[\s\S]*?-->/g, languages: ['html', 'xml'] },
        { regex: /'''.*?'''/gs, languages: ['python'] },
        { regex: /""".*?"""/gs, languages: ['python'] }
    ];

    const printRanges = getRangesForPatterns(text, printPatterns, languageId, document);
    editor.setDecorations(printDecoration, printRanges);

    const commentRanges = getRangesForPatterns(text, commentPatterns, languageId, document);
    editor.setDecorations(commentDecoration, commentRanges);
}

function getRangesForPatterns(
    text: string,
    patterns: { regex: RegExp, languages?: string[] }[],
    languageId: string,
    document: vscode.TextDocument
): vscode.Range[] {
    const ranges: vscode.Range[] = [];

    patterns.forEach(pattern => {
        if (!pattern.languages || pattern.languages.includes(languageId)) {
            // Reset regex lastIndex to fix keyboard shortcut bug
            pattern.regex.lastIndex = 0;
            let match;
            while ((match = pattern.regex.exec(text)) !== null) {
                const startPos = document.positionAt(match.index);
                const endPos = document.positionAt(match.index + match[0].length);
                ranges.push(new vscode.Range(startPos, endPos));
            }
        }
    });

    return ranges;
}

export function deactivate() {
    clearHighlights();
}