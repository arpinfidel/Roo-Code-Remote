# Project Run Instructions

## 1. Start WebSocket Server

```bash
cd test-server
npm install
npm start
```

## 2. Run WebView Development Server

```bash
cd webview-ui
npm install
npm run dev
```

## 3. Compile and Run Extension

```bash
# In root directory
npm install
npm run compile
```

## 4. Debug in VSCode

1. Open project in VSCode
2. Press F5 to launch extension debug session
3. WebSocket server will be available at `ws://localhost:8080`

## Configuration

Set WebSocket URL in extension settings:

```json
"roo-cline.websocket.serverUrl": "ws://localhost:8080"
```

## Key Endpoints

- WebSocket Server: `ws://localhost:8080`
- WebView Dev Server: `http://localhost:3000`
- Extension Host: Launches in VSCode extension host
