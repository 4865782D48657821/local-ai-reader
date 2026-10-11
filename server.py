#!/usr/bin/env python3

from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import json
import shutil
import subprocess
import tempfile

HOST = "127.0.0.1"
PORT = 8765

# Sucht den piper-Befehl in PATH; Fallback ist der Name des Befehls.
PIPER = shutil.which("piper") or "piper"

# Ersetze den Dateinamen durch den Namen deiner Modell-Datei.
MODEL = Path(__file__).resolve().parent / "en_GB-aru-medium.onnx"

MAX_TEXT_LENGTH = 1000


def is_extension_origin(origin: str) -> bool:
    return origin.startswith(("moz-extension://", "chrome-extension://"))


class Handler(BaseHTTPRequestHandler):
    def send_cors_headers(self, origin: str) -> None:
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")

    def do_OPTIONS(self):
        origin = self.headers.get("Origin", "")
        if not is_extension_origin(origin):
            self.send_error(403, "Extension origin not allowed")
            return

        self.send_response(204)
        self.send_cors_headers(origin)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        if self.path != "/speak":
            self.send_error(404, "Not found")
            return

        origin = self.headers.get("Origin", "")
        if not is_extension_origin(origin):
            self.send_error(403, "Extension origin not allowed")
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0 or content_length > 2_000_000:
                self.send_error(400, "Invalid request size")
                return

            request_data = json.loads(self.rfile.read(content_length))
            text = str(request_data.get("text", "")).strip()

            if not text:
                self.send_error(400, "No text provided")
                return
            if len(text) > MAX_TEXT_LENGTH:
                self.send_error(413, "Text is too long")
                return
            if not MODEL.is_file():
                self.send_error(500, f"Model not found: {MODEL.name}")
                return

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
                wav_path = Path(temp_file.name)

            try:
                result = subprocess.run(
                    [PIPER, "--model", str(MODEL), "--output_file", str(wav_path)],
                    input=text,
                    text=True,
                    capture_output=True,
                    timeout=300,
                )

                if result.returncode != 0:
                    error = result.stderr.strip() or "Piper failed"
                    self.send_error(500, error)
                    return

                audio = wav_path.read_bytes()

                self.send_response(200)
                self.send_cors_headers(origin)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(audio)))
                self.end_headers()
                self.wfile.write(audio)

            finally:
                wav_path.unlink(missing_ok=True)

        except FileNotFoundError:
            self.send_error(
                500,
                "Piper executable not found. Check that 'piper' is on PATH."
            )
        except subprocess.TimeoutExpired:
            self.send_error(504, "Piper timed out")
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON")
        except Exception as error:
            self.send_error(500, str(error))

    def log_message(self, format, *args):
        print(f"{self.address_string()} - {format % args}")


if __name__ == "__main__":
    print(f"Model: {MODEL}")
    print(f"Piper: {PIPER}")
    print(f"Local TTS server: http://{HOST}:{PORT}")
    HTTPServer((HOST, PORT), Handler).serve_forever()
