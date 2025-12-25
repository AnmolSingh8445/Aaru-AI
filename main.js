const { app, BrowserWindow, screen, globalShortcut, ipcMain, desktopCapturer, nativeImage, dialog } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const Tesseract = require('tesseract.js');

// Settings File
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
let settingsWindow = null;
let mainWindow = null;
let conversationHistory = [];

// Helper: Load/Save Settings
function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_PATH)) {
            return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        }
    } catch (e) { console.error("Error loading settings", e); }
    return {
        transcriptionProvider: 'local',
        whisperModel: 'ggml-base.en.bin',
        deepgramKey: '',
        autoSubmit: false,
        useGPU: false,
        aiProvider: 'ollama',
        ollamaModel: 'llama3.2',
        interviewType: 'general'
    };
}

function saveSettings(data) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2));
}

function getResourcesPath() {
    return app.isPackaged ? process.resourcesPath : __dirname;
}

function createWindow() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth } = primaryDisplay.workAreaSize;
    const windowWidth = 600;
    const initialHeight = 36;

    const x = Math.round((screenWidth - windowWidth) / 2);
    const y = 50;

    const win = new BrowserWindow({
        width: windowWidth,
        height: initialHeight,
        x: x,
        y: y,
        icon: path.join(__dirname, 'icon.png'),
        frame: false,
        transparent: true,
        resizable: false, // We will manually resize
        alwaysOnTop: true,
        type: 'toolbar',
        skipTaskbar: true,
        hasShadow: false,
        backgroundColor: '#00000000',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        type: 'toolbar', // Helps with window behavior
        focusable: true
    });

    // Make it "Supreme" - Always on Top, even over full-screen apps
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true);
    win.setFullScreenable(false);

    win.setContentProtection(true);

    mainWindow = win;

    win.loadFile('index.html');

    // Auto-focus on start
    win.once('ready-to-show', () => {
        win.show();
        win.focus();
    });

    // Registration of shortcuts
    const moveStep = 10;
    globalShortcut.register('Alt+Shift+Up', () => {
        const [cx, cy] = win.getPosition();
        win.setPosition(cx, cy - moveStep);
    });

    globalShortcut.register('Alt+Shift+Down', () => {
        const [cx, cy] = win.getPosition();
        win.setPosition(cx, cy + moveStep);
    });

    globalShortcut.register('Alt+Shift+Left', () => {
        const [cx, cy] = win.getPosition();
        win.setPosition(cx - moveStep, cy);
    });

    globalShortcut.register('Alt+Shift+Right', () => {
        const [cx, cy] = win.getPosition();
        win.setPosition(cx + moveStep, cy);
    });

    globalShortcut.register('Alt+Shift+E', () => app.quit());
    globalShortcut.register('Alt+Shift+e', () => app.quit());

    // New Settings Shortcut
    globalShortcut.register('Alt+Shift+M', () => {
        if (mainWindow) mainWindow.webContents.send('toggle-settings');
    });

    // Mic Toggle Shortcut
    globalShortcut.register('Alt+Shift+A', () => {
        if (mainWindow) mainWindow.webContents.send('toggle-mic');
    });

    // Visibility Toggle Shortcut (Hide/Show)
    globalShortcut.register('Alt+Shift+V', () => {
        if (win.isVisible()) {
            win.hide();
        } else {
            win.show();
        }
    });

    // Help Shortcut
    globalShortcut.register('Alt+Shift+H', () => {
        if (mainWindow) mainWindow.webContents.send('toggle-help');
    });

    // Smart Screen Solve Shortcut
    globalShortcut.register('Alt+Shift+S', () => {
        captureAndSolve(win);
    });

    // Reset / New Chat Shortcut
    globalShortcut.register('Alt+Shift+C', () => {
        if (mainWindow) {
            conversationHistory = []; // Clear History
            mainWindow.webContents.send('trigger-reset');
        }
    });

    setupWhisperIPC(win);
    setupSettingsIPC();
}

function setupSettingsIPC() {
    ipcMain.handle('get-settings', () => {
        return loadSettings();
    });

    ipcMain.handle('save-settings', (event, data) => {
        saveSettings(data);
        // Refresh main window usage of settings if needed?
        // Ideally main window reads settings on each action or we push updates.
        // For now, main window can re-read or we can send event.
        if (mainWindow) mainWindow.webContents.send('settings-updated', data);
    });

    ipcMain.handle('get-whisper-models', async () => {
        const modelsDir = path.join(getResourcesPath(), 'whisper_models');
        if (fs.existsSync(modelsDir)) {
            return fs.readdirSync(modelsDir).filter(f => f.endsWith('.bin'));
        }
        return [];
    });

    ipcMain.handle('pick-whisper-model', async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [{ name: 'Whisper Models', extensions: ['bin'] }]
        });
        if (canceled || filePaths.length === 0) {
            return null;
        }
        return filePaths[0];
    });

    ipcMain.handle('get-screen-sources', async () => {
        const { desktopCapturer } = require('electron');
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        return sources;
    });

    ipcMain.handle('get-ollama-models', async () => {
        return new Promise((resolve) => {
            exec('ollama list', { windowsHide: true }, (err, stdout, stderr) => {
                if (err) {
                    console.error("Ollama list error", err);
                    resolve([]);
                    return;
                }
                // Parse stdout: NAME ID SIZE MODIFIED
                // skip header
                const lines = stdout.trim().split('\n').slice(1);
                const models = lines.map(line => line.split(/\s+/)[0]);
                resolve(models);
            });
        });
    });

    ipcMain.on('ask-ai', async (event, question) => {
        const s = loadSettings();
        const provider = s.aiProvider || 'ollama';

        // Initialize History if empty
        if (conversationHistory.length === 0) {
            let systemPrompt = `You are the candidate in this interview. `;
            systemPrompt += `The interview type is ${s.interviewType || 'General'}. `;
            if (s.resumeText) {
                systemPrompt += `\nThis is YOUR resume and background. Answer questions based on this profile:\n${s.resumeText}\n`;
            }
            systemPrompt += `\nAnswer as the candidate. Be extremely concise and direct. Answer ONLY what is asked. Do not elaborate unless specifically requested. Keep answers short and to the point. Do not mention you are an AI.`;

            conversationHistory.push({ role: 'system', content: systemPrompt });
        }

        // Add User Question
        conversationHistory.push({ role: 'user', content: question });

        event.sender.send('ai-start');

        let fullAnswer = "";

        try {
            if (provider === 'ollama') {
                const model = s.ollamaModel || 'llama3';
                fullAnswer = await streamOllama(model, conversationHistory, event.sender);
            } else if (provider === 'deepseek') {
                const key = s.deepseekKey;
                if (!key) throw new Error("DeepSeek API Key is missing.");
                fullAnswer = await streamDeepSeek(key, conversationHistory, event.sender);
            }

            // Save Assistant Answer to History
            conversationHistory.push({ role: 'assistant', content: fullAnswer });

        } catch (err) {
            console.error("AI Error:", err);
            event.sender.send('ai-chunk', "**Error:** " + err.message);
            // Remove the failed user question so they can retry?? 
            // Or just leave it. Let's start fresh if error?
            // conversationHistory.pop(); // Remove user Q?
        } finally {
            event.sender.send('ai-done');
        }
    });

    ipcMain.on('resize-window', (event, arg) => {
        if (mainWindow) {
            let width, height;
            if (typeof arg === 'number') {
                height = parseInt(arg);
                const size = mainWindow.getSize();
                width = parseInt(size[0]);
            } else {
                width = parseInt(arg.width);
                height = parseInt(arg.height);
            }

            if (!width || isNaN(width)) {
                const size = mainWindow.getSize();
                width = parseInt(size[0]);
            }
            if (!height || isNaN(height)) height = 100; // Fallback

            // Use setBounds for more reliability on Windows
            const bounds = mainWindow.getBounds();

            // Calculate new x to preserve the center of the window
            const currentCenterX = bounds.x + (bounds.width / 2);
            const newX = Math.round(currentCenterX - (width / 2));

            mainWindow.setBounds({
                x: newX,
                y: bounds.y,
                width: width,
                height: height
            });
        }
    });
}

// AI Helpers
const http = require('http');
const https = require('https');

function streamOllama(model, messages, sender) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            model: model,
            stream: true,
            messages: messages
        });

        let fullResponse = "";

        const req = http.request({
            hostname: 'localhost',
            port: 11434,
            path: '/api/chat',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Ollama API Error: ${res.statusCode} ${res.statusMessage}`));
                return;
            }
            res.setEncoding('utf8');
            let buffer = '';

            res.on('data', chunk => {
                buffer += chunk;
                let lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (line.trim() === '') continue;
                    try {
                        const json = JSON.parse(line);
                        if (json.message && json.message.content) {
                            const content = json.message.content;
                            fullResponse += content;
                            sender.send('ai-chunk', content);
                        }
                        if (json.done) {
                            resolve(fullResponse);
                            return;
                        }
                    } catch (e) {
                        console.error("Error parsing Ollama chunk", e);
                    }
                }
            });
            res.on('end', () => resolve(fullResponse));
        });

        req.on('error', (e) => reject(e));
        req.write(data);
        req.end();
    });
}

function streamDeepSeek(apiKey, messages, sender) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            model: "deepseek-chat",
            stream: true,
            messages: messages
        });

        let fullResponse = "";

        const req = https.request({
            hostname: 'api.deepseek.com',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': data.length
            }
        }, (res) => {
            res.setEncoding('utf8');
            let buffer = '';

            res.on('data', chunk => {
                buffer += chunk;
                let lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('data: ')) {
                        const jsonStr = trimmed.replace('data: ', '');
                        if (jsonStr === '[DONE]') {
                            resolve(fullResponse);
                            return;
                        }
                        try {
                            const json = JSON.parse(jsonStr);
                            if (json.choices && json.choices[0].delta && json.choices[0].delta.content) {
                                const content = json.choices[0].delta.content;
                                fullResponse += content;
                                sender.send('ai-chunk', content);
                            }
                        } catch (e) {
                            console.error("Error parsing DeepSeek chunk", e);
                        }
                    }
                }
            });
            res.on('end', () => {
                resolve(fullResponse);
            });
        });

        req.on('error', (e) => reject(e));
        req.write(data);
        req.end();
    });
}


async function captureAndSolve(win) {
    try {
        console.log("Starting Screen Solve...");
        win.webContents.send('ai-start'); // Show thinking state
        win.webContents.send('ai-chunk', '**Analyzing screen...**\n');

        const primaryDisplay = screen.getPrimaryDisplay();
        const { width, height } = primaryDisplay.size;

        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width, height }
        });

        const primarySource = sources[0]; // Usually the first one is the main screen
        if (!primarySource) {
            throw new Error("No screen source found.");
        }

        const image = primarySource.thumbnail;
        const pngBuffer = image.toPNG();

        // Use Tesseract.js for OCR (keeping original logic)
        // Note: For better results, one might use an online OCR or a vision model, 
        // but user only asked for Voice Providers change, so I'll keep this as is 
        // or check if I should use Vision? The task is "Voice & Transcription".
        // I will stick to existing logic for Screen Solve to avoid scope creep unless necessary.

        console.log("Screen captured, running OCR...");
        win.webContents.send('ai-chunk', '**Extracting text...**\n');

        const { data: { text } } = await Tesseract.recognize(
            pngBuffer,
            'eng',
            { logger: m => console.log(m) }
        );

        const cleanText = text.trim();
        if (!cleanText) {
            throw new Error("No text found on screen.");
        }

        console.log("OCR Result:", cleanText);
        win.webContents.send('ai-chunk', `**Found Text:**\n> ${cleanText.substring(0, 100).replace(/\n/g, ' ')}...\n\n**Solving...**\n`);

        const s = loadSettings();
        const provider = s.aiProvider || 'ollama';

        const systemPrompt = `You are an expert Coding and Exam Assistant. 
The user has captured a screenshot of a problem (MCQ or Coding Question).
The extracted text from the screen is provided below.
Ignore irrelevant UI elements, window titles, or noise.
Identify the question and provide the correct answer or solution.
If it is an MCQ, provide the correct option and a brief explanation.
If it is a coding problem, provide the correct code solution.
Be concise and direct.`;

        const userPrompt = `Here is the text from the screen:\n\n${cleanText}`;

        // Create a temporary history for this specific solve request
        // We don't necessarily want to pollute the main interview history with screen solves?
        // Or do we? The user asked for "Conversation Memory" separate from the "Resume" requirement.
        // For now, let's keep Screen Solve isolated as it has a specific different system prompt.
        const solveMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];

        let fullAnswer = "";

        if (provider === 'ollama') {
            const model = s.ollamaModel || 'llama3.2';
            fullAnswer = await streamOllama(model, solveMessages, win.webContents);
        } else if (provider === 'deepseek') {
            const key = s.deepseekKey;
            if (!key) throw new Error("DeepSeek API Key is missing.");
            fullAnswer = await streamDeepSeek(key, solveMessages, win.webContents);
        }

    } catch (err) {
        console.error("Screen Solve Error:", err);
        win.webContents.send('ai-chunk', `\n**Error:** ${err.message}`);
    } finally {
        win.webContents.send('ai-done');
    }
}

// Helper for Deepgram
function transcribeDeepgram(audioBuffer, apiKey) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.deepgram.com',
            path: '/v1/listen?model=nova-3&smart_format=true',
            method: 'POST',
            headers: {
                'Authorization': `Token ${apiKey}`,
                'Content-Type': 'audio/wav',
                'Content-Length': audioBuffer.length
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const json = JSON.parse(data);
                        const transcript = json.results?.channels[0]?.alternatives[0]?.transcript;
                        resolve(transcript || "");
                    } catch (e) {
                        reject(new Error("Failed to parse Deepgram response"));
                    }
                } else {
                    reject(new Error(`Deepgram Error: ${res.statusCode} ${data}`));
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.write(audioBuffer);
        req.end();
    });
}

function setupWhisperIPC(win) {
    ipcMain.on('process-audio', async (event, buffer) => {
        const tempPath = path.join(app.getPath('temp'), 'aaru_temp_input.wav');

        try {
            // Write buffer to file (needed for local whisper)
            const audioBuffer = Buffer.from(buffer);

            // Get current settings
            const currentSettings = loadSettings();
            const provider = currentSettings.transcriptionProvider || 'local';

            if (provider === 'deepgram') {
                const apiKey = currentSettings.deepgramKey;
                if (!apiKey) {
                    win.webContents.send('transcription-error', 'Deepgram API Key is missing.');
                    return;
                }

                // Call Deepgram
                try {
                    console.log("Using Deepgram for transcription...");
                    const transcript = await transcribeDeepgram(audioBuffer, apiKey);
                    win.webContents.send('transcription-result', transcript);
                } catch (err) {
                    console.error("Deepgram Transcription Error:", err);
                    win.webContents.send('transcription-error', err.message);
                }
                return;
            }

            // Fallback to Local Whisper
            fs.writeFileSync(tempPath, audioBuffer);

            const modelName = currentSettings.whisperModel || 'ggml-base.en.bin';
            const useGPU = currentSettings.useGPU || false;

            // Choose binary folder based on GPU setting
            const binFolder = useGPU ? 'cuda' : 'cpu';
            // Determine architecture folder
            const archFolder = (process.arch === 'ia32') ? 'ia32' : 'x64';

            const binPath = path.join(getResourcesPath(), 'whisper_bin', archFolder, binFolder, 'main.exe');

            let modelPath;
            if (path.isAbsolute(modelName)) {
                modelPath = modelName;
            } else {
                modelPath = path.join(getResourcesPath(), 'whisper_models', modelName);
            }

            if (!fs.existsSync(binPath)) {
                console.error("DEBUG: Binary NOT FOUND at", binPath);
                win.webContents.send('transcription-error', `Binary not found: ${binPath}`);
                return;
            }
            if (!fs.existsSync(modelPath)) {
                console.error("DEBUG: Model NOT FOUND at", modelPath);
                win.webContents.send('transcription-error', `Model not found: ${modelPath}`);
                return;
            }

            // Spawn main.exe
            const whisper = spawn(binPath, [
                '-m', modelPath,
                '-f', tempPath,
                '--no-timestamps'
            ], { windowsHide: true });

            let outputText = '';

            whisper.stdout.on('data', (data) => {
                outputText += data.toString();
            });

            whisper.on('close', (code) => {
                // Cleanup
                try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e) { }

                if (code === 0) {
                    let finalTrans = outputText;
                    finalTrans = finalTrans.replace(/system_info.*/g, '');
                    finalTrans = finalTrans.replace(/main: .*/g, '');
                    finalTrans = finalTrans.replace(/\n/g, ' ');

                    // 1. Remove bracketed noise tags like [Music], (Silence) within the text
                    finalTrans = finalTrans.replace(/\[.*?\]/g, '');
                    finalTrans = finalTrans.replace(/\(.*?\)/g, '');

                    finalTrans = finalTrans.trim();

                    // 2. Filter Full-line Hallucinations
                    const hallucinations = [
                        /^Expected/i,
                        /^Silence/i,
                        /^Audio/i,
                        /^Music/i,
                        /^Song/i
                    ];

                    const isHallucination = hallucinations.some(h => h.test(finalTrans));

                    // Also check if it is just a very short repeated char or empty
                    if (isHallucination || finalTrans.length < 2 || /^[.?!, ]+$/.test(finalTrans)) {
                        console.log("Filtered Hallucination/Noise:", finalTrans);
                        finalTrans = "";
                    }

                    win.webContents.send('transcription-result', finalTrans);
                } else {
                    win.webContents.send('transcription-error', `Process exited with code ${code}`);
                }
            });

        } catch (err) {
            console.error("Error processing audio:", err);
            win.webContents.send('transcription-error', err.message);
        }
    });
}

app.whenReady().then(() => {
    createWindow();
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
