const { app, BrowserWindow, screen, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let whisperProcess = null;

// ... existing createWindow ...

function setupWhisperIPC(win) {
    ipcMain.on('start-recording', (event) => {
        if (whisperProcess) return;

        const binPath = path.join(__dirname, 'whisper_bin', 'stream.exe');
        const modelPath = path.join(__dirname, 'whisper_models', 'ggml-base.en.bin');
        
        // stream.exe arguments: 
        // -m model -t threads --step step_ms --length length_ms -vth prob_threshold
        // standard real-time: step 500, length 5000 keep context
        
        console.log('Spawning:', binPath);
        
        whisperProcess = spawn(binPath, [
            '-m', modelPath,
            '-t', '4',
            '--step', '0',      // 0 might mean default sliding window
            '--length', '10000', // 10s context
            '-vth', '0.6'       // voice threshold
        ]);

        whisperProcess.stdout.on('data', (data) => {
            const text = data.toString().trim();
            console.log('Whisper stdout:', text);
            // stream.exe output format is often: [timestamp] text
            // We want to just send the text.
            // Filter out timestamp like [00:00:00.000 --> 00:00:00.000]
            
            // Regex to clean timestamp
            const cleanText = text.replace(/\[.*\]/g, '').trim();
            if (cleanText) {
                win.webContents.send('transcription-data', cleanText);
            }
        });

        whisperProcess.stderr.on('data', (data) => {
            console.error('Whisper stderr:', data.toString());
        });

        whisperProcess.on('close', (code) => {
            console.log(`Whisper child process exited with code ${code}`);
            whisperProcess = null;
            win.webContents.send('transcription-stopped');
        });
    });

    ipcMain.on('stop-recording', () => {
        if (whisperProcess) {
            whisperProcess.kill();
            whisperProcess = null;
        }
    });
}
