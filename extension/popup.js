// ── OCR panel elements ────────────────────────────────────────
const statusEl = document.getElementById('status');
const currentPageEl = document.getElementById('current-page');
const fragmentsEl = document.getElementById('fragments');
const shortProgressEl = document.getElementById('short-progress');
const progressEl = document.getElementById('progress');
const resultEl = document.getElementById('result');
const startButton = document.getElementById('start');
const translateButton = document.getElementById('translate-text');
const stopButton = document.getElementById('stop');
const retryButton = document.getElementById('retry');
const copyButton = document.getElementById('copy');
const downloadButton = document.getElementById('download');
const hostInput = document.getElementById('ocr-host');
const portInput = document.getElementById('ocr-port');
const languageSelect = document.getElementById('ocr-language');
const autoscrollCheckbox = document.getElementById('ocr-autoscroll');
const autocopyCheckbox = document.getElementById('ocr-autocopy');
const lastRegionEl = document.getElementById('last-region');

// ── Translate panel elements ──────────────────────────────────
const tlLanguage = document.getElementById('tl-language');
const translatePrompt = document.getElementById('translate-prompt');
const translateInput = document.getElementById('translate-input');
const tlTranslateButton = document.getElementById('tl-translate');
const translateResult = document.getElementById('translate-result');
const tlCopyButton = document.getElementById('tl-copy');
const tlDownloadButton = document.getElementById('tl-download');

// ── Tab state ─────────────────────────────────────────────────
const tabs = document.querySelectorAll('.tab');
const panels = {
  'ocr-panel': document.getElementById('ocr-panel'),
  'translate-panel': document.getElementById('translate-panel')
};

let latestState = null;
let currentTabId = null;

// ── Tab switching ─────────────────────────────────────────────
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    Object.values(panels).forEach(p => p.classList.add('hidden'));
    panels[tab.dataset.panel].classList.remove('hidden');
  });
});

// ── OCR panel listeners ───────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
startButton.addEventListener('click', startCapture);
translateButton.addEventListener('click', translateOcrText);
stopButton.addEventListener('click', stopCapture);
retryButton.addEventListener('click', retryCapture);
copyButton.addEventListener('click', copyOcrText);
downloadButton.addEventListener('click', downloadOcrText);
hostInput.addEventListener('change', saveSettings);
portInput.addEventListener('change', saveSettings);
languageSelect.addEventListener('change', saveSettings);
autoscrollCheckbox.addEventListener('change', saveSettings);
autocopyCheckbox.addEventListener('change', saveSettings);

// ── Translate panel listeners ─────────────────────────────────
tlTranslateButton.addEventListener('click', doTranslate);
tlCopyButton.addEventListener('click', copyTlResult);
tlDownloadButton.addEventListener('click', downloadTlResult);
translateInput.addEventListener('input', saveTlState);
translatePrompt.addEventListener('input', saveTlState);
tlLanguage.addEventListener('change', onTlLanguageChange);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'state:update') {
    if (message.tabId !== currentTabId) return;
    renderState(message.state);
  }
});

// ── Init ──────────────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id || null;

  const items = await chrome.storage.sync.get({
    ocrHost: 'localhost', ocrPort: 8000, ocrLanguage: 'original',
    ocrAutoscroll: true, ocrAutoCopy: true
  });
  hostInput.value = items.ocrHost;
  portInput.value = items.ocrPort;
  languageSelect.value = items.ocrLanguage;
  autoscrollCheckbox.checked = items.ocrAutoscroll;
  autocopyCheckbox.checked = items.ocrAutoCopy;

  const resultKey = currentTabId ? `lastResult:${currentTabId}` : null;
  const stored = resultKey ? await chrome.storage.local.get(resultKey) : {};
  if (resultKey && stored[resultKey]) resultEl.value = stored[resultKey];
  await refreshState();
  if (!resultEl.value && resultKey) {
    const fb = await chrome.storage.local.get(resultKey);
    if (fb[resultKey]) resultEl.value = fb[resultKey];
  }

  // Load translate tab state
  const tl = await chrome.storage.local.get(['tlLanguage', 'translateInput']);
  if (tl.tlLanguage) tlLanguage.value = tl.tlLanguage;
  if (tl.translateInput) translateInput.value = tl.translateInput;
  await loadPromptForLanguage();

  chrome.storage.local.get('lastRegion', (r) => {
    lastRegionEl.textContent = r.lastRegion
      ? `Last region: ${r.lastRegion.width}x${r.lastRegion.height}px`
      : 'No saved region';
  });
}

// ── Per-language prompt persistence ───────────────────────────
async function loadPromptForLanguage() {
  const lang = tlLanguage.value;
  const key = `translatePrompt:${lang}`;
  const result = await chrome.storage.local.get(key);
  translatePrompt.value = result[key] || '';
}

async function saveTlState() {
  const lang = tlLanguage.value;
  await chrome.storage.local.set({
    tlLanguage: lang,
    translateInput: translateInput.value,
    [`translatePrompt:${lang}`]: translatePrompt.value
  });
}

async function onTlLanguageChange() {
  // Save current prompt for old language, then load new language's prompt
  const oldLang = (await chrome.storage.local.get('tlLanguage')).tlLanguage;
  if (oldLang) {
    await chrome.storage.local.set({ [`translatePrompt:${oldLang}`]: translatePrompt.value });
  }
  await chrome.storage.local.set({ tlLanguage: tlLanguage.value });
  await loadPromptForLanguage();
}

async function saveSettings() {
  await chrome.storage.sync.set({
    ocrHost: hostInput.value.trim() || 'localhost',
    ocrPort: parseInt(portInput.value, 10) || 8000,
    ocrLanguage: languageSelect.value || 'original',
    ocrAutoscroll: autoscrollCheckbox.checked,
    ocrAutoCopy: autocopyCheckbox.checked
  });
}

// ── OCR actions ───────────────────────────────────────────────
async function refreshState() {
  const response = await chrome.runtime.sendMessage({ type: 'popup:get-state' });
  if (response?.ok) {
    currentTabId = response.tabId || currentTabId;
    renderState(response.state);
  }
}

async function startCapture() {
  startButton.disabled = true;
  progressEl.textContent = 'Starting region selection.';
  const response = await chrome.runtime.sendMessage({ type: 'popup:start' });
  if (!response?.ok) {
    progressEl.textContent = response?.error || 'Unable to start capture.';
    startButton.disabled = false;
  }
}

async function translateOcrText() {
  const text = resultEl.value.trim();
  if (!text) return;
  const language = languageSelect.value;
  if (language === 'original') { progressEl.textContent = 'Select a target language.'; return; }
  translateButton.disabled = true;
  progressEl.textContent = `Translating to ${language}...`;
  try {
    const host = hostInput.value.trim() || 'localhost';
    const port = parseInt(portInput.value, 10) || 8000;
    const stored = await chrome.storage.local.get('translatePrompt');
    const response = await fetch(`http://${host}:${port}/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language, prompt: stored.translatePrompt || undefined })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error);
    resultEl.value = payload.text || '';
    latestState.mergedText = payload.text || '';
    if (currentTabId) await chrome.storage.local.set({ [`lastResult:${currentTabId}`]: payload.text || '' });
    progressEl.textContent = 'Translation complete.';
    copyButton.disabled = downloadButton.disabled = false;
  } catch (e) {
    progressEl.textContent = `Translation failed: ${e.message}`;
  } finally {
    translateButton.disabled = false;
  }
}

async function stopCapture() { stopButton.disabled = true; await chrome.runtime.sendMessage({ type: 'popup:stop' }); }
async function retryCapture() {
  retryButton.disabled = true;
  progressEl.textContent = 'Retrying...';
  const r = await chrome.runtime.sendMessage({ type: 'popup:retry' });
  if (!r?.ok) { progressEl.textContent = r?.error || 'Retry failed.'; retryButton.disabled = false; }
}

function renderState(state) {
  latestState = state || {};
  const mergedText = latestState.mergedText || '';
  const hasText = (mergedText || resultEl.value || '').trim().length > 0;
  const isActive = Boolean(latestState.active);
  const isError = latestState.status === 'Error';
  const canRetry = (isError && latestState.active && latestState.retryState) || !!latestState.retryStage;

  statusEl.textContent = latestState.status || 'Idle';
  currentPageEl.textContent = String(latestState.currentPage || 0);
  fragmentsEl.textContent = String(latestState.fragmentsCollected || 0);
  shortProgressEl.textContent = latestState.progress || 'Ready';
  progressEl.textContent = latestState.error || latestState.progress || 'Ready';
  if (mergedText) resultEl.value = mergedText;

  startButton.disabled = isActive;
  translateButton.disabled = !hasText || isActive || languageSelect.value === 'original';
  stopButton.classList.toggle('hidden', !isActive);
  retryButton.classList.toggle('hidden', !canRetry);
  copyButton.disabled = !hasText;
  downloadButton.disabled = !hasText;

  const sr = latestState.lastRegion;
  if (sr) lastRegionEl.textContent = `Last region: ${sr.width}x${sr.height}px`;
}

async function copyOcrText() {
  const t = resultEl.value.trim(); if (!t) return;
  try { await navigator.clipboard.writeText(t); copyButton.textContent = 'Copied!'; setTimeout(() => copyButton.textContent = 'Copy', 1500); }
  catch { resultEl.select(); document.execCommand('copy'); }
}
function downloadOcrText() { downloadAsFile(resultEl.value.trim(), 'qidian-ocr'); }

// ── Translate panel actions ───────────────────────────────────
async function doTranslate() {
  const text = translateInput.value.trim();
  if (!text) return;
  const language = tlLanguage.value;
  tlTranslateButton.disabled = true;
  try {
    const host = hostInput.value.trim() || 'localhost';
    const port = parseInt(portInput.value, 10) || 8000;
    const prompt = translatePrompt.value.trim() || undefined;
    const response = await fetch(`http://${host}:${port}/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language, prompt })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error);
    translateResult.value = payload.text || '';
    tlCopyButton.disabled = tlDownloadButton.disabled = false;
  } catch (e) {
    translateResult.value = `Error: ${e.message}`;
  } finally {
    tlTranslateButton.disabled = false;
  }
}

async function copyTlResult() {
  const t = translateResult.value.trim(); if (!t) return;
  try { await navigator.clipboard.writeText(t); tlCopyButton.textContent = 'Copied!'; setTimeout(() => tlCopyButton.textContent = 'Copy', 1500); }
  catch { translateResult.select(); document.execCommand('copy'); }
}
function downloadTlResult() { downloadAsFile(translateResult.value.trim(), 'translate'); }

function downloadAsFile(text, prefix) {
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  chrome.downloads.download({ url, filename: `${prefix}-${ts}.txt`, saveAs: true },
    () => setTimeout(() => URL.revokeObjectURL(url), 30000));
}
