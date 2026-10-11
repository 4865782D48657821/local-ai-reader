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

    if (!tab?.id) throw new Error("Kein aktiver Tab gefunden.");

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
          text: best.innerText.replace(/\n{3,}/g, "\n\n").trim()
        };
      }
    });

    if (!result?.text) throw new Error("Kein Artikeltext gefunden.");

    await chrome.runtime.sendMessage({
      type: "START_READER",
      tabId: tab.id,
      title: result.title,
      text: result.text
    });

    status.textContent = "Reader geöffnet.";
  } catch (error) {
    status.textContent = "Fehler: " + error.message;
  } finally {
    button.disabled = false;
  }
});
