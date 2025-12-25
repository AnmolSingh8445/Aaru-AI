const { ipcRenderer } = require('electron');
const marked = require('marked');

// Global State
let isRecording = false;
let recordingSource = null; // 'click' | 'shortcut' | 'ptt'
let pttTimer = null;
let pttActive = false;
let audioContext = null;
let micStream = null;
let sysStream = null;
let micSource = null;
let sysSource = null;
let processor = null;
let audioChunks = [];
let appSettings = {};
let fullResponseText = '';
let deepgramSocket = null;
let deepgramFinalText = ""; // To store confirmed text
let deepgramInterimText = ""; // To store flickering text

// DOM Elements
let micBtn, submitBtn, resetBtn, inputField, responsePanel, responseContent, settingsPanel, closeSettingsBtn, saveSettingsBtn;
let helpPanel, closeHelpBtn;

document.addEventListener('DOMContentLoaded', async () => {
    // Map new DOM elements
    micBtn = document.getElementById('btn-mic');
    submitBtn = document.getElementById('btn-submit');
    resetBtn = document.getElementById('btn-reset');
    inputField = document.getElementById('input-main');
    
    responsePanel = document.getElementById('panel-response');
    responseContent = document.getElementById('response-content');
    
    settingsPanel = document.getElementById('panel-settings');
    closeSettingsBtn = document.getElementById('btn-close-settings');
    saveSettingsBtn = document.getElementById('btn-save-settings');

    helpPanel = document.getElementById('panel-help');
    closeHelpBtn = document.getElementById('btn-close-help');

    // Initialize Overlay interactions
    initOverlay();
    
    // Initialize Settings interactions (and await model loading)
    await initSettings();

    // Init Help interactions
    initHelp();

    // Load initial settings
    await refreshSettings();

    // Resize on load
    ipcRenderer.send('resize-window', 36);

    // Auto-focus input
    setTimeout(() => inputField.focus(), 100);
});

async function refreshSettings() {
    appSettings = await ipcRenderer.invoke('get-settings');
    applySettingsUI(appSettings);
}

// ---------------------------------------------------------
// Overlay Logic
// ---------------------------------------------------------

function initOverlay() {
    // Update Settings Handler
    ipcRenderer.on('settings-updated', (event, s) => {
        appSettings = s;
        applySettingsUI(s);
    });

    // Reset / New Chat
    resetBtn.addEventListener('click', () => {
        hideResponse();
        inputField.value = '';
        inputField.placeholder = "Ask me anything...";
    });

    // Toggle Mic (Click)
    micBtn.addEventListener('click', async () => {
        // Remove focus from button to prevent Enter key re-triggering it
        micBtn.blur();
        inputField.focus();
        
        if (!isRecording) {
            await startRecording('click');
        } else {
            // Only stop if we are in 'click' or 'shortcut' mode (Sticky)
            // If user clicks button while PTT is held, it should probably overridden to Sticky?
            // Simplified: Click toggles current state off if recording, or on if not.
            await stopRecording();
        }
    });

    // Spacebar Push-to-Talk Logic
    document.addEventListener('keydown', async (e) => {
        if (e.code === 'Space') {
             // Block all Space defaults (scrolling/typing) initially
             e.preventDefault();

             if (e.repeat) return; // Ignore repeats for logic

             // If cursor click recording is active, do nothing
             if (isRecording && recordingSource === 'click') return;

             if (!isRecording && !pttTimer) {
                 // Start Timer
                 pttTimer = setTimeout(async () => {
                     // Long Press Detected -> Start PTT
                     pttActive = true;
                     pttTimer = null;
                     await startRecording('ptt');
                 }, 200); // 200ms threshold
             }
        }
    });

    document.addEventListener('keyup', async (e) => {
        if (e.code === 'Space') {
             // If cursor click recording is active, ignore space release
             if (isRecording && recordingSource === 'click') return;
             
             e.preventDefault();

             // Check state
             if (pttTimer) {
                 // Released BEFORE timer fired -> Short Tap
                 clearTimeout(pttTimer);
                 pttTimer = null;
                 
                 // Insert Space Manually
                 const start = inputField.selectionStart;
                 const end = inputField.selectionEnd;
                 const val = inputField.value;
                 inputField.value = val.substring(0, start) + " " + val.substring(end);
                 inputField.selectionStart = inputField.selectionEnd = start + 1;
                 inputField.focus(); // Ensure focus stays
             }
             else if (pttActive) {
                 // Released AFTER timer fired -> Stop PTT
                 pttActive = false;
                 await stopRecording();
             }
        }
    });

    // Shortcut: Toggle Mic
    ipcRenderer.on('toggle-mic', () => {
        micBtn.click();
    });

    // Shortcut: Reset / New Chat
    ipcRenderer.on('trigger-reset', () => {
        resetBtn.click();
    });

    // Manual Submit
    submitBtn.addEventListener('click', () => {
        submitQuery();
    });

    inputField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            submitQuery();
        }
    });

    // Global settings toggle
    ipcRenderer.on('toggle-settings', () => {
        toggleSettings();
    });
}

function submitQuery() {
    const text = inputField.value;
    if (text.trim()) {
        askAI(text);
    }
}

async function startRecording(source = 'manual') {
    try {
        if (isRecording) return; // Prevent double start
        recordingSource = source;
        audioChunks = [];
        inputField.placeholder = "Listening...";
        inputField.value = "";
        micBtn.classList.add('listening');
        isRecording = true;

        hideResponse();

        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });

        // 1. Get Microphone Stream
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micSource = audioContext.createMediaStreamSource(micStream);

        // 2. Get System Audio Stream (Silent Capture)
        const sources = await ipcRenderer.invoke('get-screen-sources');
        const sourceId = sources[0].id;

        sysStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId
                }
            },
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId
                }
            }
        });

        // We only need audio from system
        sysSource = audioContext.createMediaStreamSource(sysStream);

        // 3. Mixing
        processor = audioContext.createScriptProcessor(4096, 1, 1);

        micSource.connect(processor);
        sysSource.connect(processor);

        processor.connect(audioContext.destination); 

        processor.onaudioprocess = (e) => {
            if (!isRecording) return;
            const floatSamples = e.inputBuffer.getChannelData(0);
            
            // Standard recording integration
            audioChunks.push(new Float32Array(floatSamples));

            // Real-time Deepgram Streaming
            if (appSettings.transcriptionProvider === 'deepgram' && deepgramSocket && deepgramSocket.readyState === WebSocket.OPEN) {
                 const int16Samples = convertFloat32ToInt16(floatSamples);
                 deepgramSocket.send(int16Samples);
            }
        };

        // Open Deepgram Socket if needed
        if (appSettings.transcriptionProvider === 'deepgram') {
            const apiKey = appSettings.deepgramKey;
            if (apiKey) {
                // Nova-3 URL
                const url = 'wss://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&encoding=linear16&sample_rate=16000&interim_results=true';
                deepgramSocket = new WebSocket(url, ['token', apiKey]);

                deepgramSocket.onopen = () => {
                    console.log("Deepgram WS Connected");
                    deepgramFinalText = ""; 
                    deepgramInterimText = "";
                };

                deepgramSocket.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data.channel && data.channel.alternatives && data.channel.alternatives[0]) {
                            const alt = data.channel.alternatives[0];
                            const transcript = alt.transcript;
                            
                            if (transcript) {
                                if (data.is_final) {
                                    deepgramFinalText += (deepgramFinalText ? " " : "") + transcript;
                                    deepgramInterimText = "";
                                } else {
                                    deepgramInterimText = transcript;
                                }
                                
                                // Update Input Field smoothly
                                const displayText = deepgramFinalText + (deepgramInterimText ? " " + deepgramInterimText : "");
                                inputField.value = displayText;
                            }
                        }
                    } catch (e) {
                        console.error("Deepgram Parse Error", e);
                    }
                };

                deepgramSocket.onerror = (e) => {
                    console.error("Deepgram WS Error", e);
                    inputField.placeholder = "Deepgram Error...";
                };
                
                deepgramSocket.onclose = () => {
                     console.log("Deepgram WS Closed");
                };
            } else {
                inputField.placeholder = "Missing Deepgram API Key";
            }
        }

    } catch (err) {
        console.error("Error starting recording:", err);
        inputField.placeholder = "Error: " + err.message;
        cleanupRecording();
    }
}

function convertFloat32ToInt16(buffer) {
    let l = buffer.length;
    let buf = new Int16Array(l);
    while (l--) {
        buf[l] = Math.min(1, Math.max(-1, buffer[l])) * 0x7FFF;
    }
    return buf;
}

async function stopRecording() {
    micBtn.classList.remove('listening');
    isRecording = false;
    inputField.placeholder = "Thinking...";

    if (micStream) micStream.getTracks().forEach(track => track.stop());
    if (sysStream) sysStream.getTracks().forEach(track => track.stop());

    if (processor) { processor.disconnect(); }
    if (micSource) { micSource.disconnect(); }
    if (sysSource) { sysSource.disconnect(); }

    if (audioContext && audioContext.state !== 'closed') await audioContext.close();

    const finalBuffer = flattenAudioChunks(audioChunks);
    
    if (finalBuffer.length === 0) {
        inputField.placeholder = "No audio recorded.";
        cleanupRecording();
        return;
    }
    
    // Close WS
    if (deepgramSocket) {
        // Send a close frame or just close
        if (deepgramSocket.readyState === WebSocket.OPEN) {
             deepgramSocket.send(JSON.stringify({ type: 'CloseStream' }));
             deepgramSocket.close();
        }
        deepgramSocket = null;
    }

    // Capture the final text from real-time session
    if (appSettings.transcriptionProvider === 'deepgram') {
       // If we used real-time, we likely already have the text in inputField.
       // We DO NOT send to backend processing to avoid double-processing or overwriting.
       // However, we might want to auto-submit?
       // Let's rely on what's in the input box.
       const existingText = inputField.value;
       
       if (existingText.trim() && appSettings.autoSubmit) {
           askAI(existingText);
       }
       
       cleanupRecording();
       return; // SKIP IPC processing for Deepgram
    }

    // Legacy / Local Flow
    const wavBuffer = encodeWAV(finalBuffer, 16000);
    ipcRenderer.send('process-audio', wavBuffer);
    cleanupRecording();
}

function cleanupRecording() {
    audioContext = null;
    micStream = null;
    sysStream = null;
    micSource = null;
    sysSource = null;
    processor = null;
}

function flattenAudioChunks(chunks) {
    let length = 0;
    chunks.forEach(chunk => length += chunk.length);
    const result = new Float32Array(length);
    let offset = 0;
    chunks.forEach(chunk => {
        result.set(chunk, offset);
        offset += chunk.length;
    });
    return result;
}

function encodeWAV(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);

    floatTo16BitPCM(view, 44, samples);

    return buffer;
}

function floatTo16BitPCM(output, offset, input) {
    for (let i = 0; i < input.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, input[i]));
        output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

ipcRenderer.on('transcription-result', (event, text) => {
    inputField.placeholder = "Ask me anything...";
    if (text && text.trim().length > 0) {
        inputField.value = text;
        if (appSettings.autoSubmit) {
            askAI(text);
        }
    } else {
        inputField.placeholder = "No speech detected.";
    }
});

ipcRenderer.on('transcription-error', (event, err) => {
    console.error(err);
    micBtn.classList.remove('listening');
    isRecording = false;
    inputField.placeholder = "Error: " + err;
});

// AI Streaming
ipcRenderer.on('ai-start', () => {
    fullResponseText = '';
    responseContent.innerHTML = '';
    responsePanel.classList.remove('hidden');
    inputField.placeholder = "AI Thinking...";
    updateWindowHeight();
});

ipcRenderer.on('ai-chunk', (event, chunk) => {
    fullResponseText += chunk;
    responseContent.innerHTML = marked.parse(fullResponseText);
    addCopyButtons();
    updateWindowHeight();
});

ipcRenderer.on('ai-done', () => {
    inputField.placeholder = "Ask me anything...";
    responseContent.innerHTML = marked.parse(fullResponseText);
    addCopyButtons();
});

function addCopyButtons() {
    const pres = responseContent.querySelectorAll('pre');
    pres.forEach(pre => {
        if (!pre.querySelector('.copy-btn')) {
            const btn = document.createElement('button');
            btn.className = 'copy-btn';
            btn.innerText = 'Copy';
            btn.onclick = () => {
                const code = pre.querySelector('code').innerText;
                navigator.clipboard.writeText(code);
                btn.innerText = 'Copied!';
                setTimeout(() => btn.innerText = 'Copy', 2000);
            };
            pre.appendChild(btn);
        }
    });
}

function askAI(question) {
    ipcRenderer.send('ask-ai', question);
}

function updateWindowHeight() {
    // If Settings or Help are open, don't update overlay height based on response
    if (!settingsPanel.classList.contains('hidden')) return;
    if (helpPanel && !helpPanel.classList.contains('hidden')) return;

    const overlayHeight = 36;
    const margin = 8;
    const responseHeight = responsePanel.classList.contains('hidden') ? 0 : responsePanel.offsetHeight;

    let totalHeight = overlayHeight;
    if (responseHeight > 0) {
        totalHeight += margin + responseHeight;
    }

    // Reset width to 600 when in normal mode
    ipcRenderer.send('resize-window', { width: 600, height: Math.ceil(totalHeight) });
}

function hideResponse() {
    fullResponseText = '';
    responsePanel.classList.add('hidden');
    responseContent.innerHTML = '';
    updateWindowHeight();
}

// ---------------------------------------------------------
// Settings Logic
// ---------------------------------------------------------

let settingsEls = {};

async function initSettings() {
    settingsEls = {
        whisperModel: document.getElementById('select-whisper-model'),
        whisperDropdown: document.getElementById('dropdown-whisper-model'),
        
        transcriptionRadios: document.getElementsByName('transcription-provider'),
        localTransSettings: document.getElementById('sub-transcription-local'),
        deepgramTransSettings: document.getElementById('sub-transcription-deepgram'),
        deepgramKey: document.getElementById('input-deepgram-key'),

        autoSubmit: document.getElementById('check-auto-submit'),
        useGPU: document.getElementById('check-gpu'),
        aiRadios: document.getElementsByName('ai-provider'),
        ollamaSettings: document.getElementById('sub-settings-ollama'),
        deepseekSettings: document.getElementById('sub-settings-deepseek'),
        
        ollamaModel: document.getElementById('select-ollama-model'),
        ollamaDropdown: document.getElementById('dropdown-ollama-model'),
        
        deepseekKey: document.getElementById('input-deepseek-key'),
        
        interviewType: document.getElementById('select-interview-type'),
        interviewDropdown: document.getElementById('dropdown-interview-type'),
        
        resumeText: document.getElementById('text-resume')
    };

    // Load lists
    await loadWhisperModels();
    await loadOllamaModels();
    
    // Init Dropdown Logic
    setupCustomDropdown(settingsEls.whisperDropdown, settingsEls.whisperModel);
    setupCustomDropdown(settingsEls.ollamaDropdown, settingsEls.ollamaModel);
    setupCustomDropdown(settingsEls.interviewDropdown, settingsEls.interviewType);

    // Global Click to close dropdowns
    document.addEventListener('click', (e) => {
        closeAllDropdowns(e.target);
    });

    // Listeners
    if(settingsEls.transcriptionRadios) {
        settingsEls.transcriptionRadios.forEach(radio => {
            radio.addEventListener('change', (e) => toggleTranscriptionProvider(e.target.value));
        });
    }

    if(settingsEls.aiRadios) {
        settingsEls.aiRadios.forEach(radio => {
            radio.addEventListener('change', (e) => toggleProvider(e.target.value));
        });
    }

    saveSettingsBtn.addEventListener('click', async () => {
        // Safe check for selected provider
        const checkedRadio = document.querySelector('input[name="ai-provider"]:checked');
        const aiProvider = checkedRadio ? checkedRadio.value : 'ollama';

        const checkedTransRadio = document.querySelector('input[name="transcription-provider"]:checked');
        const transProvider = checkedTransRadio ? checkedTransRadio.value : 'local';
        
        const settings = {
            transcriptionProvider: transProvider,
            whisperModel: settingsEls.whisperModel.value,
            deepgramKey: settingsEls.deepgramKey.value,
            autoSubmit: settingsEls.autoSubmit.checked,
            useGPU: settingsEls.useGPU.checked,
            aiProvider: aiProvider,
            ollamaModel: settingsEls.ollamaModel.value,
            deepseekKey: settingsEls.deepseekKey.value,
            interviewType: settingsEls.interviewType.value,
            resumeText: settingsEls.resumeText.value
        };
        
        await ipcRenderer.invoke('save-settings', settings);
        appSettings = settings;
        setTimeout(() => toggleSettings(), 1000);
    });

    closeSettingsBtn.addEventListener('click', () => {
        toggleSettings();
    });
}


function setupCustomDropdown(dropdownEl, inputEl) {
    if (!dropdownEl || !inputEl) return;
    
    const trigger = dropdownEl.querySelector('.dropdown-trigger');
    const optionsPanel = dropdownEl.querySelector('.dropdown-options');
    
    // Toggle
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = optionsPanel.classList.contains('show');
        closeAllDropdowns(); // Close others
        if (!isOpen) { 
            optionsPanel.classList.add('show');
        }
    });

    // Option Clicks (Delegate)
    optionsPanel.addEventListener('click', async (e) => {
        if (e.target.classList.contains('dropdown-option')) {
            const val = e.target.getAttribute('data-value');
            const txt = e.target.innerText;

            if (val === 'Browse from System...') {
                optionsPanel.classList.remove('show');
                const path = await ipcRenderer.invoke('pick-whisper-model');
                if (path) {
                    inputEl.value = path;
                    // Show basename
                    trigger.innerText = path.split(/[\\/]/).pop();
                    
                    // Deselect others
                    dropdownEl.querySelectorAll('.dropdown-option').forEach(op => op.classList.remove('selected'));
                }
                e.stopPropagation();
                return;
            }
            
            // Update UI
            trigger.innerText = txt;
            inputEl.value = val;
            
            // Highlight
            dropdownEl.querySelectorAll('.dropdown-option').forEach(op => op.classList.remove('selected'));
            e.target.classList.add('selected');
            
            optionsPanel.classList.remove('show');
            e.stopPropagation();
        }
    });
}

function closeAllDropdowns(target) {
    document.querySelectorAll('.dropdown-options').forEach(panel => {
        if (!panel.contains(target) && !panel.parentElement.contains(target)) {
            panel.classList.remove('show');
        }
    });
}

async function populateDropdown(dropdownEl, models, errorMsg) {
    const optionsPanel = dropdownEl.querySelector('.dropdown-options');
    const trigger = dropdownEl.querySelector('.dropdown-trigger');
    
    if (!models || models.length === 0) {
        optionsPanel.innerHTML = `<div class="dropdown-option disabled">${errorMsg || 'No options'}</div>`;
        trigger.innerText = errorMsg || 'No options';
        return;
    }
    
    optionsPanel.innerHTML = models.map(m => 
        `<div class="dropdown-option" data-value="${m}">${m}</div>`
    ).join('');
    
    // Default select first
    if (models.length > 0) {
        // Don't auto-select here, let applySettingsUI do it, 
        // or just leave trigger text as is until settings load.
    }
}

async function loadWhisperModels() {
    try {
        const models = await ipcRenderer.invoke('get-whisper-models');
        models.push('Browse from System...');
        await populateDropdown(settingsEls.whisperDropdown, models, 'Error loading models');
    } catch (e) {
        const trigger = settingsEls.whisperDropdown.querySelector('.dropdown-trigger');
        trigger.innerText = 'Error';
    }
}

async function loadOllamaModels() {
    try {
        const models = await ipcRenderer.invoke('get-ollama-models');
        const trigger = settingsEls.ollamaDropdown.querySelector('.dropdown-trigger');
        
        if (models.length === 0) {
           trigger.innerText = 'No Ollama models';
           settingsEls.ollamaDropdown.querySelector('.dropdown-options').innerHTML = '';
        } else {
           await populateDropdown(settingsEls.ollamaDropdown, models, 'No models found');
        }
    } catch (e) {
         const trigger = settingsEls.ollamaDropdown.querySelector('.dropdown-trigger');
         trigger.innerText = 'Error checking Ollama';
    }
}

function applySettingsUI(s) {
    if (!s) return;
    
    // Helper to set dropdown value
    const setDropdown = (dropdownEl, inputEl, val) => {
        if (!val) return;
        inputEl.value = val;
        
        // Find option text
        const option = dropdownEl.querySelector(`.dropdown-option[data-value="${val}"]`);
        const trigger = dropdownEl.querySelector('.dropdown-trigger');
        if (option) {
             trigger.innerText = option.innerText;
             // Set selected class
             dropdownEl.querySelectorAll('.dropdown-option').forEach(op => op.classList.remove('selected'));
             option.classList.add('selected');
        } else {
            // If value not in list (e.g. custom or old), just show value
            // Show basename for readability
            trigger.innerText = val.split(/[\\/]/).pop();
        }
    };

    const transProvider = s.transcriptionProvider || 'local';
    const transRadio = document.querySelector(`input[name="transcription-provider"][value="${transProvider}"]`);
    if(transRadio) transRadio.checked = true;
    toggleTranscriptionProvider(transProvider);

    if (s.whisperModel && settingsEls.whisperDropdown) {
        setDropdown(settingsEls.whisperDropdown, settingsEls.whisperModel, s.whisperModel);
    }
    
    if (s.deepgramKey && settingsEls.deepgramKey) settingsEls.deepgramKey.value = s.deepgramKey;

    settingsEls.autoSubmit.checked = !!s.autoSubmit;
    settingsEls.useGPU.checked = !!s.useGPU;
    
    const provider = s.aiProvider || 'ollama';
    const radio = document.querySelector(`input[name="ai-provider"][value="${provider}"]`);
    if(radio) radio.checked = true;
    toggleProvider(provider);
    
    if (s.ollamaModel && settingsEls.ollamaDropdown) {
        setDropdown(settingsEls.ollamaDropdown, settingsEls.ollamaModel, s.ollamaModel);
    }
    
    if (s.deepseekKey) settingsEls.deepseekKey.value = s.deepseekKey;
    
    if (s.interviewType && settingsEls.interviewDropdown) {
        setDropdown(settingsEls.interviewDropdown, settingsEls.interviewType, s.interviewType);
    }
    
    if (s.resumeText) settingsEls.resumeText.value = s.resumeText;
}

function toggleProvider(val) {
    if (val === 'ollama') {
        settingsEls.ollamaSettings.classList.add('active');
        settingsEls.deepseekSettings.classList.remove('active');
    } else {
        settingsEls.ollamaSettings.classList.remove('active');
        settingsEls.deepseekSettings.classList.add('active');
    }
}

function toggleTranscriptionProvider(val) {
    if (val === 'local') {
        settingsEls.localTransSettings.classList.add('active');
        settingsEls.deepgramTransSettings.classList.remove('active');
    } else {
        settingsEls.localTransSettings.classList.remove('active');
        settingsEls.deepgramTransSettings.classList.add('active');
    }
}


function toggleSettings() {
    const isHidden = settingsPanel.classList.contains('hidden');
    
    if (isHidden) {
        // Show Settings
        settingsPanel.classList.remove('hidden');
        helpPanel.classList.add('hidden'); // Close help if open
        inputField.disabled = true;
        
        // Expand window to show settings
        ipcRenderer.send('resize-window', { width: 600, height: 650, resizable: false });
    } else {
        // Hide Settings
        settingsPanel.classList.add('hidden');
        inputField.disabled = false;
        
        // Reset Logic
        updateWindowHeight();
    }
}

function initHelp() {
    closeHelpBtn.addEventListener('click', () => {
        toggleHelp();
    });

    ipcRenderer.on('toggle-help', () => {
        toggleHelp();
    });
}

function toggleHelp() {
    const isHidden = helpPanel.classList.contains('hidden');
    
    if (isHidden) {
        // Show Help
        helpPanel.classList.remove('hidden');
        settingsPanel.classList.add('hidden'); // Close settings if open
        inputField.disabled = true;
        
        // Expand window to show help
        ipcRenderer.send('resize-window', { width: 600, height: 650, resizable: false });
    } else {
        // Hide Help
        helpPanel.classList.add('hidden');
        inputField.disabled = false;
        
        // Reset Logic
        updateWindowHeight();
    }
}
