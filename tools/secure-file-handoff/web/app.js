(() => {
  "use strict";
  const encoder = new TextEncoder();
  const AAD = encoder.encode("NEXORA-SFH-v1");
  const statusEl = document.getElementById("status");
  const maxEl = document.getElementById("max-size");
  const textEl = document.getElementById("text");
  const sendEl = document.getElementById("send");
  let uploadToken = "";

  function status(message, error = false) {
    statusEl.textContent = message;
    statusEl.className = error ? "error" : "";
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function pemToDer(pem) {
    const base64 = pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out.buffer;
  }

  async function initialize() {
    const params = new URLSearchParams(location.hash.slice(1));
    uploadToken = params.get("u") || "";
    history.replaceState(null, "", location.pathname);
    if (!uploadToken || uploadToken.length < 32) throw new Error("This upload link is invalid or missing.");

    const statusResponse = await fetch("/api/status", {cache: "no-store"});
    if (!statusResponse.ok) throw new Error("Handoff is unavailable.");
    const info = await statusResponse.json();
    const maxBytes = Number(info.maxBytes);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16384) throw new Error("Invalid handoff settings.");
    maxEl.textContent = Math.ceil(maxBytes / 1024) + " KiB";

    const keyResponse = await fetch("/api/public-key", {cache: "no-store"});
    if (!keyResponse.ok) throw new Error("Recipient key is unavailable.");
    const pem = await keyResponse.text();
    const publicKey = await crypto.subtle.importKey(
      "spki",
      pemToDer(pem),
      {name: "RSA-OAEP", hash: "SHA-256"},
      false,
      ["encrypt"]
    );
    sendEl.disabled = false;

    document.getElementById("handoff-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = textEl.value;
      textEl.value = "";
      if (!text) {
        status("Paste text to send.", true);
        return;
      }
      const plaintext = encoder.encode(text);
      if (plaintext.length < 1 || plaintext.length > maxBytes) {
        status("Text must be between 1 byte and " + maxBytes + " UTF-8 bytes.", true);
        return;
      }

      sendEl.disabled = true;
      textEl.disabled = true;
      status("Encrypting locally…");
      let requestSent = false;
      try {
        const aesKey = await crypto.subtle.generateKey({name: "AES-GCM", length: 256}, true, ["encrypt"]);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt({name: "AES-GCM", iv, additionalData: AAD}, aesKey, plaintext);
        const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);
        const wrappedKey = await crypto.subtle.encrypt({name: "RSA-OAEP", label: AAD}, publicKey, rawAesKey);
        const envelope = {
          v: 1,
          iv: bytesToBase64(iv),
          wrappedKey: bytesToBase64(new Uint8Array(wrappedKey)),
          ciphertext: bytesToBase64(new Uint8Array(ciphertext))
        };
        status("Uploading ciphertext…");
        requestSent = true;
        const response = await fetch("/api/upload", {
          method: "POST",
          headers: {"Content-Type": "application/json", "X-Upload-Token": uploadToken},
          body: JSON.stringify(envelope),
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer"
        });
        uploadToken = "";
        if (!response.ok) throw new Error("Upload was rejected. The link may be expired or already used.");
        status("Encrypted text sent. Only ciphertext was transferred. You may close this page.");
      } catch (_) {
        if (requestSent) {
          uploadToken = "";
          status("Upload failed. The link may be expired or already used.", true);
        } else {
          textEl.disabled = false;
          sendEl.disabled = false;
          status("Could not encrypt locally. Re-enter the text and try again.", true);
        }
      }
    });
  }

  initialize().catch(() => {
    uploadToken = "";
    status("This handoff link is invalid, expired, or unavailable.", true);
    sendEl.disabled = true;
  });
})();
