# Aaru AI (Service Host Runtime)

Aaru AI is a powerful, stealthy AI overlay for Windows that integrates local privacy-focused AI (Ollama) and cloud power (DeepSeek, Deepgram) into a minimal, always-on-top toolbar. It is designed for seamless voice interaction, screen context awareness, and instant AI assistance without leaving your active workflow.

## 🚀 Features

*   **Invisible Overlay:** Minimalist UI that stays on top of full-screen apps.
*   **Voice Control:**
    *   **Local Transcription:** Runs entirely on-device using Whisper (C++ implementation) for zero-latency, private voice typing.
    *   **Cloud Transcription:** Optional integration with Deepgram for higher accuracy.
*   **AI Intelligence:**
    *   **Local LLMs:** Integrates with [Ollama](https://ollama.com/) to run Llama 3, Mistral, etc., locally.
    *   **DeepSeek API:** Switch to DeepSeek for complex reasoning.
*   **Smart Screen Solve:** Capture any part of your screen (e.g., coding problems, MCQs) and get instant solutions via OCR + AI.
*   **Interview Mode:** persistent context memory to act as a candidate assistant.
*   **Stealth Mode:** Fully control visibility and position via shortcuts.

## 🛠️ Installation

1.  **Download:** Go to the [Releases](https://github.com/yourusername/aaru-ai/releases) page and download `Service Host Runtime Setup 1.0.0.exe`.
2.  **Install:** Run the installer. The app will launch automatically.
3.  **Setup:**
    *   Ensure **Ollama** is installed and running if you want to use local AI.
    *   Open Settings (`Alt + Shift + M`) to configure models and API keys.

## ⌨️ Shortcuts (Hotkeys)

The application is primarily controlled via keyboard shortcuts to minimize interference:

| Shortcut | Action |
| :--- | :--- |
| **Alt + Shift + A** | 🎤 Toggle Microphone (Start/Stop Recording) |
| **Alt + Shift + S** | 📸 **Screen Solve:** Captures screen & solves the problem |
| **Alt + Shift + V** | 👁️ Start/Stop Visibility (Hide/Show Window) |
| **Alt + Shift + C** | 🧹 Clear Chat History / New Session |
| **Alt + Shift + M** | ⚙️ Open Settings Panel |
| **Alt + Shift + H** | ❓ Open Help Panel |
| **Alt + Shift + E** | ❌ Quit Application |
| **Alt + Shift + Arrows** | ↔️ Move the overlay window pixel-by-pixel |

*Note: You can also hold **Spacebar** for Push-to-Talk functionality.*

## 🔧 Development

### Prerequisites
*   [Node.js](https://nodejs.org/) (v16+)
*   [Ollama](https://ollama.com/) (for local AI)
*   **Visual Studio C++ Build Tools** (if rebuilding native dependencies)

### Setup
1.  Clone the repository:
    ```bash
    git clone https://github.com/yourusername/aaru-ai.git
    cd aaru-ai
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Run locally:
    ```bash
    npm start
    ```

### Building for Windows
To create the `.exe` installer (includes Whisper binaries and models):

```bash
npm run build
```
This will generate the installer in the `dist/` folder.

## 📂 Project Structure

*   `main.js` - Electron backend (Shortcuts, Window Management, Python/C++ Spawning).
*   `script.js` - Frontend logic (Audio capture, WebSocket with Deepgram, UI interactions).
*   `whisper_bin/` - Contains the compiled `main.exe` for local Whisper transcription.
*   `whisper_models/` - Stores local `.bin` models for Whisper.

## 📜 License
ISC
