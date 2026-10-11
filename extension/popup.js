const button = document.getElementById("read");
const status = document.getElementById("status");

button.addEventListener("click", async () => {
  button.disabled = true;
  status.textContent = "Artikel wird extrahiert …";

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!tab?.id) {
      throw new Error("Kein aktiver Tab gefunden.");
    }

    // Text aus der Seite holen. Hier wird noch kein TTS-fetch ausgeführt.
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const selectors = ["article", "main", '[role="main"]'];
        let best = document.body;

        for (const selector of selectors) {
          const candidate = document.querySelector(selector);
          if (candidate && candidate.innerText.length > best.innerText.length * 0.5) {
            best = candidate;
            break;
          }
        }

        return {
          title: document.title,
          text: best.innerText.replace(/\n{3,}/g, "\n\n").trim().slice(0, 100000)
        };
      }
    });

    if (!result?.text) {
      throw new Error("Kein Artikeltext gefunden.");
    }

    status.textContent = "Sprache wird lokal erzeugt …";

    // Dieser fetch läuft jetzt im Erweiterungskontext.
    const response = await fetch("http://127.0.0.1:8765/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: result.text })
    });

    if (!response.ok) {
      throw new Error(`Lokaler TTS-Dienst: HTTP ${response.status}`);
    }

    // Audio als Base64 an den Tab übergeben.
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    const audioBase64 = btoa(binary);

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: ({ title, text, audioBase64 }) => {
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

        const play = document.createElement("button");
        play.textContent = "Vorlesen";
        play.style.cssText = "padding:10px 16px;margin:8px 8px 20px 0;cursor:pointer";

        const stop = document.createElement("button");
        stop.textContent = "Stopp";
        stop.style.cssText = "padding:10px 16px;margin:8px;cursor:pointer";

        const message = document.createElement("div");
        message.style.cssText = "font:14px sans-serif;margin:8px 0";

        const article = document.createElement("div");
        article.style.whiteSpace = "pre-wrap";
        article.textContent = text;

        const binary = atob(audioBase64);
        const audioBytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          audioBytes[i] = binary.charCodeAt(i);
        }

        const audioUrl = URL.createObjectURL(
          new Blob([audioBytes], { type: "audio/wav" })
        );
        const audio = new Audio(audioUrl);

        play.onclick = async () => {
          try {
            await audio.play();
            message.textContent = "Wird vorgelesen …";
          } catch (error) {
            message.textContent = "Wiedergabefehler: " + error.message;
          }
        };

        audio.onended = () => {
          message.textContent = "Fertig.";
        };

        stop.onclick = () => {
          audio.pause();
          audio.currentTime = 0;
          message.textContent = "Gestoppt.";
        };

        close.onclick = () => {
          audio.pause();
          URL.revokeObjectURL(audioUrl);
          overlay.remove();
        };

        overlay.append(close, heading, play, stop, message, article);
        document.body.appendChild(overlay);
      },
      args: [{
        title: result.title,
        text: result.text,
        audioBase64
      }]
    });

    status.textContent = "Reader geöffnet.";
  } catch (error) {
    status.textContent = "Fehler: " + error.message;
  } finally {
    button.disabled = false;
  }
});
