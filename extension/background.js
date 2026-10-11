const jobs = new Map();

// Keep requests small enough that Piper has a short time-to-first-audio and
// never needs to hold a long article in its working set.
function splitLongSentence(sentence, maxLength) {
  const pieces = [];
  let current = "";

  for (const word of sentence.split(/\s+/)) {
    if (!word) continue;

    if (word.length > maxLength) {
      if (current) pieces.push(current);
      current = "";
      for (let i = 0; i < word.length; i += maxLength) {
        pieces.push(word.slice(i, i + maxLength));
      }
    } else if (current && current.length + word.length + 1 > maxLength) {
      pieces.push(current);
      current = word;
    } else {
      current += (current ? " " : "") + word;
    }
  }

  if (current) pieces.push(current);
  return pieces;
}

function splitIntoChunks(text, maxLength = 600) {
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]*/g) || [text];
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    const part = sentence.trim();
    if (!part) continue;

    if (current && current.length + part.length + 1 > maxLength) {
      chunks.push(current);
      current = "";
    }

    // Sehr lange Einzelsätze teilen.
    if (part.length > maxLength) {
      if (current) chunks.push(current);
      current = "";
      chunks.push(...splitLongSentence(part, maxLength));
    } else {
      current += (current ? " " : "") + part;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function base64FromBytes(bytes) {
  let binary = "";
  const size = 0x8000;

  for (let i = 0; i < bytes.length; i += size) {
    binary += String.fromCharCode(...bytes.subarray(i, i + size));
  }

  return btoa(binary);
}

async function showReader(tabId, title, text) {
  await browser.scripting.executeScript({
    target: { tabId },
    func: ({ title, text, tabId}) => {
      document.getElementById("local-reader-overlay")?.remove();

      const overlay = document.createElement("div");
      overlay.id = "local-reader-overlay";
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483647",
        overflow: "auto",
        background: "#f7f4ed",
        color: "#222",
        padding: "40px max(24px, calc((100vw - 760px) / 2))",
        font: "18px/1.7 Georgia, serif",
        boxSizing: "border-box"
      });

      const close = document.createElement("button");
      close.textContent = "Schließen";
      close.style.cssText =
        "position:fixed;right:20px;top:16px;padding:8px;cursor:pointer";

      const heading = document.createElement("h1");
      heading.textContent = title;

      const controls = document.createElement("div");
      controls.style.cssText =
        "position:sticky;top:0;background:#f7f4ed;padding:10px 0";

      const play = document.createElement("button");
      play.textContent = "Vorlesen";
      play.style.cssText = "padding:10px 16px;cursor:pointer";

      const stop = document.createElement("button");
      stop.textContent = "Stopp";
      stop.style.cssText =
        "padding:10px 16px;margin-left:8px;cursor:pointer";

      const status = document.createElement("span");
      status.textContent = "Bereit";
      status.style.cssText = "margin-left:12px;font:14px sans-serif";

      const article = document.createElement("div");
      article.style.whiteSpace = "pre-wrap";
      article.textContent = text;

      const audio = new Audio();
      let active = false;

      function send(type) {
        return browser.runtime.sendMessage({ type, tabId });
      }

      play.onclick = async () => {
        if (active) return;

        active = true;
        play.disabled = true;
        status.textContent = "Erzeuge ersten Abschnitt …";

        try {
          await send("NEXT_CHUNK");
        } catch (error) {
          active = false;
          play.disabled = false;
          status.textContent = "Fehler: " + error.message;
        }
      };

      stop.onclick = async () => {
        active = false;
        audio.pause();
        audio.removeAttribute("src");
        play.disabled = false;
        status.textContent = "Gestoppt";

        try {
          await send("STOP_READER");
        } catch (error) {
          console.error("Fehler beim Stoppen:", error);
        }
      };

      close.onclick = async () => {
        active = false;
        audio.pause();
        audio.removeAttribute("src");

        try {
          await send("STOP_READER");
        } catch (error) {
          console.error("Fehler beim Stoppen:", error);
        }

        overlay.remove();
      };

      overlay.append(close, heading, controls, article);
      controls.append(play, stop, status);
      document.body.appendChild(overlay);

      window.__localReaderSetAudio = (base64, isLast) => {
        if (!active) return;

        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);

        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }

        const url = URL.createObjectURL(
          new Blob([bytes], { type: "audio/wav" })
        );

        audio.onloadeddata = () => {
          status.textContent = isLast
            ? "Wird vorgelesen · letzter Abschnitt"
            : "Wird vorgelesen";

          audio.play().catch(error => {
            status.textContent =
              "Bitte erneut auf Vorlesen klicken: " + error.message;
            active = false;
            play.disabled = false;
            URL.revokeObjectURL(url);
          });
        };

        audio.onended = () => {
          URL.revokeObjectURL(url);
          audio.removeAttribute("src");
          if (!active) return;

          if (isLast) {
            active = false;
            play.disabled = false;
            status.textContent = "Fertig";
          } else {
            status.textContent = "Erzeuge nächsten Abschnitt …";
            browser.runtime.sendMessage({ type: "NEXT_CHUNK", tabId })
              .catch(error => {
                active = false;
                play.disabled = false;
                status.textContent = "Fehler: " + error.message;
              });
          }
        };

        audio.src = url;
        audio.load();
      };

      window.__localReaderFinished = () => {
        active = false;
        play.disabled = false;
        status.textContent = "Fertig";
      };
    },
    args: [{ title, text, tabId }]
  });
}

async function sendAudioToTab(tabId, base64, isLast) {
  await browser.scripting.executeScript({
    target: { tabId },
    func: ({ base64, isLast }) => {
      window.__localReaderSetAudio?.(base64, isLast);
    },
    args: [{ base64, isLast }]
  });
}

browser.runtime.onMessage.addListener(message => {
  if (message.type === "START_READER") {
    const chunks = splitIntoChunks(message.text);
    jobs.set(message.tabId, {
      chunks,
      index: 0,
      stopped: false,
      started: false,
      nextAudioPromise: null,
      controller: new AbortController()
    });

    showReader(message.tabId, message.title, message.text).catch(error => {
      console.error("Reader konnte nicht geöffnet werden:", error);
    });

    return;
  }

  if (message.type === "STOP_READER") {
    const job = jobs.get(message.tabId);
    if (job) {
      job.stopped = true;
      job.controller.abort();
    }
    jobs.delete(message.tabId);
    return;
  }

  if (message.type === "NEXT_CHUNK") {
    processNextChunk(message.tabId).catch(async error => {
      if (error.name === "AbortError") return;
      console.error("TTS-Fehler:", error);
      jobs.delete(message.tabId);

      try {
        await browser.scripting.executeScript({
          target: { tabId: message.tabId },
          func: errorMessage => {
            const status = document.querySelector(
              "#local-reader-overlay span"
            );
            if (status) status.textContent = "TTS-Fehler: " + errorMessage;
          },
          args: [String(error)]
        });
      } catch (injectionError) {
        console.error(
          "Fehlermeldung konnte nicht angezeigt werden:",
          injectionError
        );
      }
    });
  }
});

async function processNextChunk(tabId) {
  const job = jobs.get(tabId);
  if (!job || job.stopped) return;

  const nextAudio = await ensureNextChunk(tabId);
  if (!nextAudio) {
    jobs.delete(tabId);

    await browser.scripting.executeScript({
      target: { tabId },
      func: () => window.__localReaderFinished?.()
    });

    return;
  }

  // The promise has now been consumed; the slot is free for the following
  // chunk to be generated in the background.
  job.nextAudioPromise = null;

  // On slow CPUs, prepare one complete hand-off before starting playback.
  // This adds startup latency but prevents the first transition from
  // immediately racing Piper.
  if (!job.started && !nextAudio.isLast) {
    await ensureNextChunk(tabId);
  }

  job.started = true;

  if (job.stopped) return;

  await sendAudioToTab(tabId, nextAudio.base64, nextAudio.isLast);

  // Start generating the following section while this one is playing.
  // The promise is consumed by the NEXT_CHUNK message from onended.
  ensureNextChunk(tabId).catch(() => {});
}

function ensureNextChunk(tabId) {
  const job = jobs.get(tabId);
  if (!job || job.stopped) return Promise.resolve(null);
  if (job.nextAudioPromise) return job.nextAudioPromise;
  if (job.index >= job.chunks.length) return Promise.resolve(null);

  const chunk = job.chunks[job.index++];
  const isLast = job.index >= job.chunks.length;
  const promise = fetch("http://127.0.0.1:8765/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: chunk }),
    signal: job.controller.signal
  }).then(async response => {
    if (!response.ok) {
      throw new Error(`Lokaler TTS-Dienst: HTTP ${response.status}`);
    }

    return {
      base64: base64FromBytes(
        new Uint8Array(await response.arrayBuffer())
      ),
      isLast
    };
  });

  job.nextAudioPromise = promise;
  // If the user stops while Piper is working, the promise may never be
  // consumed. Attach a rejection handler to avoid an unhandled rejection.
  promise.catch(() => {});
  return promise;
}
