# Repository Guidelines

## Project Structure & Module Organization

- `server.go` runs the local HTTP service on `127.0.0.1:8765` and invokes Piper to generate WAV audio. It uses only the Go standard library.
- `en_GB-aru-medium.onnx` and its `.json` metadata are the local Piper voice model. Treat the model as a binary asset; do not edit it manually.
- `extension/` contains the browser extension: `manifest.json` defines permissions and entry points, `popup.js` extracts article text, `background.js` chunks text and coordinates TTS playback, and `popup.html` provides the small UI.
- `*.bak` files are historical working copies, not active source files. There is currently no dedicated test directory.

## Build, Test, and Development Commands

There is no dependency manifest. Install Go and Piper separately, ensure `piper` is on `PATH`, then build and start the service with:

```sh
go build -o local-reader-server server.go
./local-reader-server
```

For quick iteration, `go run server.go` is also sufficient. Use `-model /path/to/model.onnx`, `-piper /path/to/piper`, or `-addr 127.0.0.1:8765` to override defaults.

Load `extension/` as an unpacked extension in Firefox or a compatible browser, open an article, and use the extension action to exercise the end-to-end flow. For a basic server check, send a JSON `POST` to `http://127.0.0.1:8765/speak` with a `text` field and verify that the response is WAV audio.

## Coding Style & Naming Conventions

Use standard `gofmt` formatting in `server.go`; keep Go names idiomatic and constants descriptive. Use two-space indentation in JavaScript, `camelCase` for functions and variables, and descriptive message types such as `START_READER` and `NEXT_CHUNK`. Keep user-facing extension text in German to match the existing UI. Avoid introducing dependencies when the standard library or browser APIs suffice.

## Testing Guidelines

No automated framework or coverage threshold is configured. Run `gofmt -w server.go` and validate manually: start the server, confirm Piper/model errors are surfaced, load the extension, extract a representative article, test play/stop/close, and check that long text advances through the short chunks. For server changes, also check invalid JSON, missing text, oversized text, and non-extension origins.

## Commit & Pull Request Guidelines

Existing commits use short, sentence-style summaries (for example, `reader prototype`). Keep commits focused and use concise imperative descriptions. Pull requests should explain the user-visible behavior, identify affected files, describe manual validation steps, and include screenshots or a short recording for UI changes. Never commit secrets or unnecessary generated audio/model copies.

## Security & Configuration Tips

The server is intentionally local-only and restricts CORS to browser-extension origins. Preserve the request-size and text-length limits, origin checks, subprocess timeout, and temporary-file cleanup when modifying TTS handling. Do not broaden host permissions or bind the server beyond loopback without documenting the security impact.
