package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	maxTextLength = 1000
	maxBodyLength = 2 << 20
	requestTimeout = 5 * time.Minute
)

type speakRequest struct {
	Text string `json:"text"`
}

type server struct {
	piper string
	model string
	jobMu sync.Mutex
}

func extensionOrigin(origin string) bool {
	return strings.HasPrefix(origin, "moz-extension://") ||
		strings.HasPrefix(origin, "chrome-extension://")
}

func (s *server) cors(w http.ResponseWriter, origin string) {
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
}

func (s *server) speak(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if !extensionOrigin(origin) {
		http.Error(w, "Extension origin not allowed", http.StatusForbidden)
		return
	}
	if r.Method == http.MethodOptions {
		s.cors(w, origin)
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var request speakRequest
	body := http.MaxBytesReader(w, r.Body, maxBodyLength)
	decoder := json.NewDecoder(body)
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	text := strings.TrimSpace(request.Text)
	if text == "" {
		http.Error(w, "No text provided", http.StatusBadRequest)
		return
	}
	if len([]rune(text)) > maxTextLength {
		http.Error(w, "Text is too long", http.StatusRequestEntityTooLarge)
		return
	}
	if _, err := os.Stat(s.model); err != nil {
		http.Error(w, "Model not found: "+filepath.Base(s.model), http.StatusInternalServerError)
		return
	}

	// Piper is deliberately serialized. This prevents two jobs from competing
	// for RAM and CPU on older machines.
	s.jobMu.Lock()
	defer s.jobMu.Unlock()

	tempFile, err := os.CreateTemp("", "local-reader-*.wav")
	if err != nil {
		http.Error(w, "Could not create temporary audio file", http.StatusInternalServerError)
		return
	}
	wavPath := tempFile.Name()
	tempFile.Close()
	defer os.Remove(wavPath)

	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.piper, "--model", s.model, "--output_file", wavPath)
	cmd.Stdin = strings.NewReader(text)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			http.Error(w, "Piper timed out", http.StatusGatewayTimeout)
			return
		}
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		http.Error(w, message, http.StatusInternalServerError)
		return
	}

	audio, err := os.Open(wavPath)
	if err != nil {
		http.Error(w, "Piper produced no audio", http.StatusInternalServerError)
		return
	}
	defer audio.Close()
	header := make([]byte, 12)
	if _, err := io.ReadFull(audio, header); err != nil ||
		!bytes.Equal(header[:4], []byte("RIFF")) ||
		!bytes.Equal(header[8:12], []byte("WAVE")) {
		http.Error(w, "Piper produced invalid WAV audio", http.StatusInternalServerError)
		return
	}
	if _, err := audio.Seek(0, io.SeekStart); err != nil {
		http.Error(w, "Could not read generated audio", http.StatusInternalServerError)
		return
	}
	info, err := audio.Stat()
	if err != nil {
		http.Error(w, "Could not inspect generated audio", http.StatusInternalServerError)
		return
	}
	s.cors(w, origin)
	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("Content-Length", fmt.Sprint(info.Size()))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, audio)
}

func defaultModelPath() string {
	modelName := "en_GB-aru-medium.onnx"
	if path, err := filepath.Abs(modelName); err == nil {
		if _, statErr := os.Stat(path); statErr == nil {
			return path
		}
	}
	if executable, err := os.Executable(); err == nil {
		path := filepath.Join(filepath.Dir(executable), modelName)
		if _, statErr := os.Stat(path); statErr == nil {
			return path
		}
	}
	path, _ := filepath.Abs(modelName)
	return path
}

func main() {
	defaultModel := defaultModelPath()
	model := flag.String("model", defaultModel, "path to the Piper ONNX model")
	piper := flag.String("piper", "piper", "Piper executable")
	addr := flag.String("addr", "127.0.0.1:8765", "HTTP listen address")
	flag.Parse()

	s := &server{piper: *piper, model: *model}
	mux := http.NewServeMux()
	mux.HandleFunc("/speak", s.speak)
	httpServer := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	fmt.Printf("Model: %s\nPiper: %s\nLocal TTS server: http://%s\n", *model, *piper, *addr)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
