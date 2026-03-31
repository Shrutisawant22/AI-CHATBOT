/* ═══════════════════════════════════════════════════════════
   AI Chat Assistant – script.js
   Powered by Google Gemini API
   ═══════════════════════════════════════════════════════════ */

"use strict";

/* ──────────────────────────────────────────────────────────
   CONFIG – Replace with your actual Gemini API key
   ────────────────────────────────────────────────────────── */
const API_KEY = "AIzaSyCkl-5OhBtB1HAVuPs5wv4NXsyGiAz4ukM";

// Model fallback chain – tried in order until one succeeds
const MODELS = [
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-1.5-flash-latest",
    "gemini-max",
    "gemini-1.5-pro-latest",
];

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

// Max retries per model on transient 429 / 503 errors
const MAX_RETRIES = 2;

/* ──────────────────────────────────────────────────────────
   STATE
   ────────────────────────────────────────────────────────── */
let chatHistory = [];   // { role: 'user'|'model', parts: [{ text }] }
let isLoading = false;
let streamTimeout = null;

/* ──────────────────────────────────────────────────────────
   DOM REFS
   ────────────────────────────────────────────────────────── */
const chatContainer = document.getElementById("chat-container");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const clearChatBtn = document.getElementById("clear-chat-btn");
const themeToggleBtn = document.getElementById("theme-toggle-btn");
const typingIndicator = document.getElementById("typing-indicator");
const welcomeScreen = document.getElementById("welcome-screen");
const attachBtn = document.getElementById("attach-btn");
const micBtn = document.getElementById("mic-btn");

/* ──────────────────────────────────────────────────────────
   INIT
   ────────────────────────────────────────────────────────── */
function init() {
    loadTheme();
    loadChatHistory();
    bindEvents();
    messageInput.focus();
}

/* ──────────────────────────────────────────────────────────
   EVENT BINDINGS
   ────────────────────────────────────────────────────────── */
function bindEvents() {
    sendBtn.addEventListener("click", handleSend);

    messageInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    });

    messageInput.addEventListener("input", () => {
        autoResizeTextarea();
        sendBtn.disabled = messageInput.value.trim().length === 0 || isLoading;
    });

    clearChatBtn.addEventListener("click", clearChat);
    themeToggleBtn.addEventListener("click", toggleTheme);

    // Suggestion cards
    document.querySelectorAll(".suggestion-card").forEach((card) => {
        card.addEventListener("click", () => {
            const prompt = card.getAttribute("data-prompt");
            if (prompt) {
                messageInput.value = prompt;
                autoResizeTextarea();
                sendBtn.disabled = false;
                handleSend();
            }
        });
    });

    // UI-only buttons
    attachBtn.addEventListener("click", () => showToast("📎 File attachment coming soon!"));
    micBtn.addEventListener("click", () => showToast("🎙️ Voice input coming soon!"));
}

/* ──────────────────────────────────────────────────────────
   AUTO-RESIZE TEXTAREA
   ────────────────────────────────────────────────────────── */
function autoResizeTextarea() {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 160) + "px";
}

/* ──────────────────────────────────────────────────────────
   HANDLE SEND
   ────────────────────────────────────────────────────────── */
function handleSend() {
    const text = messageInput.value.trim();
    if (!text || isLoading) return;

    // Hide welcome screen on first message
    if (welcomeScreen) {
        welcomeScreen.style.animation = "fadeInUp 0.3s ease reverse both";
        setTimeout(() => welcomeScreen.remove(), 280);
    }

    messageInput.value = "";
    autoResizeTextarea();
    sendBtn.disabled = true;

    sendMessage(text);
}

/* ──────────────────────────────────────────────────────────
   SEND MESSAGE
   ────────────────────────────────────────────────────────── */
async function sendMessage(userText) {
    // Display user message
    displayMessage("user", userText);

    // Push to history
    chatHistory.push({ role: "user", parts: [{ text: userText }] });

    // Show typing indicator & lock UI
    setLoading(true);

    try {
        const aiText = await fetchAIResponse(chatHistory);
        hideTypingIndicator();
        displayMessage("model", aiText, true); // true = stream effect
        chatHistory.push({ role: "model", parts: [{ text: aiText }] });
        saveChatHistory();
    } catch (err) {
        hideTypingIndicator();
        displayMessage("error", getErrorMessage(err));
    } finally {
        setLoading(false);
    }
}

/* ──────────────────────────────────────────────────────────
   FETCH AI RESPONSE  (model fallback + retry on 429)
   ────────────────────────────────────────────────────────── */
async function fetchAIResponse(history) {
    let lastError;

    for (const model of MODELS) {
        const url = `${BASE_URL}/${model}:generateContent?key=${API_KEY}`;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const response = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        contents: history,
                        generationConfig: {
                            temperature: 0.85,
                            topK: 40,
                            topP: 0.95,
                            maxOutputTokens: 2048,
                        },
                        safetySettings: [
                            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                        ],
                    }),
                });

                // ── Transient errors: retry with backoff ──────────────
                if (response.status === 429 || response.status === 503) {
                    const errBody = await response.json().catch(() => ({}));
                    lastError = new Error(
                        errBody?.error?.message || `HTTP ${response.status} from ${model}`
                    );
                    if (attempt < MAX_RETRIES) {
                        const delay = (attempt + 1) * 1500; // 1.5s, 3s
                        await sleep(delay);
                        continue; // retry same model
                    }
                    break; // exhaust retries → try next model
                }

                // ── Hard errors: skip to next model ──────────────────
                if (!response.ok) {
                    const errBody = await response.json().catch(() => ({}));
                    lastError = new Error(
                        errBody?.error?.message || `HTTP ${response.status} from ${model}`
                    );
                    break; // try next model
                }

                // ── Success ───────────────────────────────────────────
                const data = await response.json();
                const text =
                    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
                    data?.candidates?.[0]?.output ||
                    null;

                if (!text) {
                    lastError = new Error(`Empty response from ${model}.`);
                    break; // try next model
                }

                return text; // ✅ done

            } catch (networkErr) {
                // True network failure (offline, DNS, etc.)
                lastError = networkErr;
                if (attempt < MAX_RETRIES) {
                    await sleep((attempt + 1) * 1000);
                    continue;
                }
                break;
            }
        }
    }

    // All models exhausted
    throw lastError || new Error("All Gemini models failed. Please try again.");
}

/* Helper – promise-based sleep */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ──────────────────────────────────────────────────────────
   DISPLAY MESSAGE
   ────────────────────────────────────────────────────────── */
function displayMessage(role, text, stream = false) {
    const isUser = role === "user";
    const isError = role === "error";
    const isAI = !isUser && !isError;

    const row = document.createElement("div");
    row.classList.add("message-row", isUser ? "message-row--user" : "message-row--ai");

    // Avatar
    const avatar = document.createElement("div");
    avatar.classList.add("msg-avatar", isUser ? "msg-avatar--user" : "msg-avatar--ai");

    if (isUser) {
        avatar.textContent = "YOU";
    } else {
        // Mini star SVG for AI
        avatar.innerHTML = `<svg width="14" height="14" viewBox="0 0 32 32" fill="none">
      <defs>
        <linearGradient id="aGrad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#6c63ff"/>
          <stop offset="100%" stop-color="#00d4ff"/>
        </linearGradient>
      </defs>
      <path d="M16 4L19.6 12.4L28.8 13.8L22.4 20L24 29.2L16 25.2L8 29.2L9.6 20L3.2 13.8L12.4 12.4L16 4Z" fill="url(#aGrad)"/>
    </svg>`;
    }

    // Content wrapper
    const content = document.createElement("div");
    content.classList.add("msg-content");

    // Bubble
    const bubble = document.createElement("div");
    bubble.classList.add("msg-bubble");
    if (isUser) bubble.classList.add("msg-bubble--user");
    if (isAI) bubble.classList.add("msg-bubble--ai");
    if (isError) bubble.classList.add("msg-bubble--ai", "msg-bubble--error");

    // Timestamp
    const meta = document.createElement("div");
    meta.classList.add("msg-meta");
    meta.textContent = formatTime(new Date());

    content.appendChild(bubble);
    content.appendChild(meta);

    row.appendChild(avatar);
    row.appendChild(content);

    chatContainer.appendChild(row);
    scrollToBottom();

    if (isAI && stream) {
        streamText(bubble, text);
    } else {
        bubble.innerHTML = formatAIText(text);
        scrollToBottom();
    }
}

/* ──────────────────────────────────────────────────────────
   STREAM TEXT (character-by-character)
   ────────────────────────────────────────────────────────── */
function streamText(bubble, fullText) {
    const formattedText = fullText; // keep raw; we stream raw then format
    let index = 0;

    // Add blinking cursor
    const cursor = document.createElement("span");
    cursor.classList.add("streaming-cursor");
    bubble.appendChild(cursor);

    const CHUNK = 3;   // chars per tick
    const DELAY = 14;  // ms per tick

    function tick() {
        if (index < formattedText.length) {
            const slice = formattedText.slice(0, index + CHUNK);
            bubble.innerHTML = escapeHTML(slice);
            bubble.appendChild(cursor);
            index += CHUNK;
            streamTimeout = setTimeout(tick, DELAY);
            scrollToBottom();
        } else {
            // Done – render formatted version
            bubble.innerHTML = formatAIText(fullText);
            scrollToBottom();
        }
    }

    tick();
}

/* ──────────────────────────────────────────────────────────
   FORMAT AI TEXT (basic markdown → HTML)
   ────────────────────────────────────────────────────────── */
function formatAIText(text) {
    let html = escapeHTML(text);

    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
        `<pre><code class="lang-${lang || 'text'}">${code.trim()}</code></pre>`
    );

    // Inline code (`code`)
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");

    // Bold (**text** or __text__)
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");

    // Italic (*text* or _text_)
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
    html = html.replace(/_(.+?)_/g, "<em>$1</em>");

    // Headings
    html = html.replace(/^#{3}\s(.+)$/gm, "<h3 style='margin:8px 0 4px;font-size:1rem;color:var(--accent-alt)'>$1</h3>");
    html = html.replace(/^#{2}\s(.+)$/gm, "<h2 style='margin:10px 0 4px;font-size:1.05rem;color:var(--accent-alt)'>$1</h2>");
    html = html.replace(/^#{1}\s(.+)$/gm, "<h1 style='margin:12px 0 6px;font-size:1.1rem;color:var(--accent-alt)'>$1</h1>");

    // Unordered lists
    html = html.replace(/^[-*]\s(.+)$/gm, "<li style='margin-left:18px;list-style:disc'>$1</li>");
    html = html.replace(/(<li.*<\/li>)/s, "<ul style='margin:6px 0'>$1</ul>");

    // Ordered lists
    html = html.replace(/^\d+\.\s(.+)$/gm, "<li style='margin-left:18px'>$1</li>");

    // Newlines → <br>
    html = html.replace(/\n/g, "<br>");

    return html;
}

/* ──────────────────────────────────────────────────────────
   ESCAPE HTML (XSS protection)
   ────────────────────────────────────────────────────────── */
function escapeHTML(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/* ──────────────────────────────────────────────────────────
   TYPING INDICATOR
   ────────────────────────────────────────────────────────── */
function showTypingIndicator() {
    typingIndicator.hidden = false;
    scrollToBottom();
}

function hideTypingIndicator() {
    typingIndicator.hidden = true;
}

/* ──────────────────────────────────────────────────────────
   LOADING STATE
   ────────────────────────────────────────────────────────── */
function setLoading(state) {
    isLoading = state;
    messageInput.disabled = state;
    sendBtn.disabled = state;

    if (state) {
        showTypingIndicator();
        sendBtn.innerHTML = `<div class="spinner"></div>`;
    } else {
        hideTypingIndicator();
        sendBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="22" y1="2" x2="11" y2="13"/>
        <polygon points="22 2 15 22 11 13 2 9 22 2"/>
      </svg>`;
        messageInput.focus();
    }
}

/* ──────────────────────────────────────────────────────────
   CLEAR CHAT
   ────────────────────────────────────────────────────────── */
function clearChat() {
    if (isLoading) return;

    // Cancel any ongoing stream
    if (streamTimeout) {
        clearTimeout(streamTimeout);
        streamTimeout = null;
    }

    chatHistory = [];
    saveChatHistory();

    // Fade out all messages then rebuild welcome
    const rows = chatContainer.querySelectorAll(".message-row");
    rows.forEach((row, i) => {
        row.style.transition = `opacity 0.25s ease ${i * 0.04}s, transform 0.25s ease ${i * 0.04}s`;
        row.style.opacity = "0";
        row.style.transform = "translateY(-8px)";
    });

    setTimeout(() => {
        // Remove all message rows
        chatContainer.querySelectorAll(".message-row").forEach((r) => r.remove());

        // Re-inject welcome screen if not present
        if (!document.getElementById("welcome-screen")) {
            const welcome = buildWelcomeScreen();
            chatContainer.insertBefore(welcome, chatContainer.firstChild);

            // Re-bind suggestion cards
            welcome.querySelectorAll(".suggestion-card").forEach((card) => {
                card.addEventListener("click", () => {
                    const prompt = card.getAttribute("data-prompt");
                    if (prompt) {
                        messageInput.value = prompt;
                        autoResizeTextarea();
                        sendBtn.disabled = false;
                        handleSend();
                    }
                });
            });
        }

        messageInput.focus();
    }, 300 + rows.length * 40);
}

/* ──────────────────────────────────────────────────────────
   BUILD WELCOME SCREEN (for re-insertion after clear)
   ────────────────────────────────────────────────────────── */
function buildWelcomeScreen() {
    const div = document.createElement("div");
    div.id = "welcome-screen";
    div.classList.add("welcome-screen");
    div.innerHTML = `
    <div class="welcome-orb"></div>
    <h2 class="welcome-title">How can I help you today?</h2>
    <p class="welcome-sub">Ask me anything — I'm powered by Google Gemini.</p>
    <div class="suggestion-grid">
      <button class="suggestion-card" data-prompt="Explain quantum computing in simple terms">
        <span class="suggestion-icon">⚛️</span>
        <span>Explain quantum computing in simple terms</span>
      </button>
      <button class="suggestion-card" data-prompt="Write a professional email to reschedule a meeting">
        <span class="suggestion-icon">✉️</span>
        <span>Write a professional email to reschedule a meeting</span>
      </button>
      <button class="suggestion-card" data-prompt="What are the latest trends in AI for 2025?">
        <span class="suggestion-icon">🤖</span>
        <span>What are the latest trends in AI for 2025?</span>
      </button>
      <button class="suggestion-card" data-prompt="Give me a 7-day healthy meal plan">
        <span class="suggestion-icon">🥗</span>
        <span>Give me a 7-day healthy meal plan</span>
      </button>
    </div>`;
    return div;
}

/* ──────────────────────────────────────────────────────────
   SAVE / LOAD CHAT HISTORY (localStorage)
   ────────────────────────────────────────────────────────── */
function saveChatHistory() {
    try {
        localStorage.setItem("ai_chat_history", JSON.stringify(chatHistory));
    } catch {
        // Storage quota exceeded or unavailable – silently ignore
    }
}

function loadChatHistory() {
    try {
        const stored = localStorage.getItem("ai_chat_history");
        if (!stored) return;

        const parsed = JSON.parse(stored);
        if (!Array.isArray(parsed) || parsed.length === 0) return;

        chatHistory = parsed;

        // Hide welcome screen
        if (welcomeScreen) welcomeScreen.remove();

        // Rebuild messages (no streaming – history renders instantly)
        chatHistory.forEach((entry) => {
            displayMessage(entry.role === "user" ? "user" : "model", entry.parts[0].text, false);
        });

        scrollToBottom(false);
    } catch {
        chatHistory = [];
    }
}

/* ──────────────────────────────────────────────────────────
   THEME TOGGLE
   ────────────────────────────────────────────────────────── */
function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("ai_chat_theme", next);
}

function loadTheme() {
    const saved = localStorage.getItem("ai_chat_theme") || "dark";
    document.documentElement.setAttribute("data-theme", saved);
}

/* ──────────────────────────────────────────────────────────
   SCROLL TO BOTTOM
   ────────────────────────────────────────────────────────── */
function scrollToBottom(smooth = true) {
    chatContainer.scrollTo({
        top: chatContainer.scrollHeight,
        behavior: smooth ? "smooth" : "instant",
    });
}

/* ──────────────────────────────────────────────────────────
   FORMAT TIME
   ────────────────────────────────────────────────────────── */
function formatTime(date) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* ──────────────────────────────────────────────────────────
   ERROR MESSAGE HELPER
   ────────────────────────────────────────────────────────── */
function getErrorMessage(err) {
    if (!navigator.onLine)
        return "⚠️ No internet connection. Please check your network.";

    const msg = (err.message || "").toLowerCase();

    if (msg.includes("api key") || msg.includes("api_key") || msg.includes("invalid"))
        return "🔑 Invalid API key. Please double-check your Gemini API key in script.js.";

    if (
        msg.includes("resource_exhausted") ||
        msg.includes("quota") ||
        msg.includes("rate limit") ||
        msg.includes("429")
    )
        return (
            "📊 Your Gemini API free-tier quota is exhausted for today or this minute. " +
            "Wait a minute and try again, or enable billing at console.cloud.google.com."
        );

    if (msg.includes("503") || msg.includes("unavailable"))
        return "🔧 Gemini service is temporarily unavailable. Please try again shortly.";

    if (msg.includes("empty response") || msg.includes("all gemini models failed"))
        return "🤷 The AI returned no response. Try rephrasing your question.";

    return `❌ Something went wrong: ${err.message || "Please try again."}`;
}

/* ──────────────────────────────────────────────────────────
   TOAST NOTIFICATION
   ────────────────────────────────────────────────────────── */
function showToast(message) {
    // Remove existing toast
    document.getElementById("toast-msg")?.remove();

    const toast = document.createElement("div");
    toast.id = "toast-msg";
    Object.assign(toast.style, {
        position: "fixed",
        bottom: "60px",
        left: "50%",
        transform: "translateX(-50%) translateY(10px)",
        background: "rgba(30, 30, 50, 0.92)",
        color: "#f0f0ff",
        padding: "10px 20px",
        borderRadius: "100px",
        fontSize: "0.82rem",
        fontFamily: "var(--font-base, Inter, sans-serif)",
        border: "1px solid rgba(108, 99, 255, 0.3)",
        backdropFilter: "blur(12px)",
        boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
        zIndex: "9999",
        opacity: "0",
        transition: "opacity 0.25s ease, transform 0.25s ease",
        whiteSpace: "nowrap",
        pointerEvents: "none",
    });
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
        toast.style.opacity = "1";
        toast.style.transform = "translateX(-50%) translateY(0)";
    });

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateX(-50%) translateY(10px)";
        setTimeout(() => toast.remove(), 300);
    }, 2800);
}

/* ──────────────────────────────────────────────────────────
   KICK OFF
   ────────────────────────────────────────────────────────── */
init();
