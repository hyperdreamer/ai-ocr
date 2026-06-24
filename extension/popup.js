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
translateInput.addEventListener('input', saveTranslateInput);

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
    ocrHost: 'localhost',
    ocrPort: 8000,
    ocrLanguage: 'original',
    ocrAutoscroll: true,
    ocrAutoCopy: true
  });
  hostInput.value = items.ocrHost;
  portInput.value = items.ocrPort;
  languageSelect.value = items.ocrLanguage;
  autoscrollCheckbox.checked = items.ocrAutoscroll;
  autocopyCheckbox.checked = items.ocrAutoCopy;

  // Load OCR result for this tab
  const resultKey = currentTabId ? `lastResult:${currentTabId}` : null;
  const stored = resultKey ? await chrome.storage.local.get(resultKey) : {};
  if (resultKey && stored[resultKey]) resultEl.value = stored[resultKey];

  await refreshState();

  if (!resultEl.value && resultKey) {
    const fb = await chrome.storage.local.get(resultKey);
    if (fb[resultKey]) resultEl.value = fb[resultKey];
  }

  // Load translate input
  const tl = await chrome.storage.local.get('translateInput');
  if (tl.translateInput) translateInput.value = tl.translateInput;

  chrome.storage.local.get('lastRegion', (r) => {
    if (r.lastRegion) {
      lastRegionEl.textContent = `Last region: ${r.lastRegion.width}x${r.lastRegion.height}px`;
    } else {
      lastRegionEl.textContent = 'No saved region';
    }
  });
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

async function saveTranslateInput() {
  await chrome.storage.local.set({ translateInput: translateInput.value });
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
  if (language === 'original') {
    progressEl.textContent = 'Select a target language first.';
    return;
  }
  translateButton.disabled = true;
  progressEl.textContent = `Translating to ${language}...`;
  try {
    const host = hostInput.value.trim() || 'localhost';
    const port = parseInt(portInput.value, 10) || 8000;
    const response = await fetch(`http://${host}:${port}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error);
    const translated = payload.text || '';
    resultEl.value = translated;
    latestState.mergedText = translated;
    if (currentTabId) {
      await chrome.storage.local.set({ [`lastResult:${currentTabId}`]: translated });
    }
    progressEl.textContent = 'Translation complete.';
    copyButton.disabled = false;
    downloadButton.disabled = false;
  } catch (e) {
    progressEl.textContent = `Translation failed: ${e.message}`;
  } finally {
    translateButton.disabled = false;
  }
}

async function stopCapture() {
  stopButton.disabled = true;
  await chrome.runtime.sendMessage({ type: 'popup:stop' });
}

async function retryCapture() {
  retryButton.disabled = true;
  progressEl.textContent = 'Retrying...';
  const response = await chrome.runtime.sendMessage({ type: 'popup:retry' });
  if (!response?.ok) {
    progressEl.textContent = response?.error || 'Retry failed.';
    retryButton.disabled = false;
  }
}

function renderState(state) {
  latestState = state || {};
  const mergedText = latestState.mergedText || '';
  const hasText = (mergedText || resultEl.value || '').trim().length > 0;
  const savedRegion = latestState.lastRegion;
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

  if (savedRegion) {
    lastRegionEl.textContent = `Last region: ${savedRegion.width}x${savedRegion.height}px`;
  }
}

async function copyOcrText() {
  const text = resultEl.value.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const prev = copyButton.textContent;
    copyButton.textContent = 'Copied!';
    setTimeout(() => { copyButton.textContent = prev; }, 1500);
  } catch {
    resultEl.select();
    document.execCommand('copy');
  }
}

function downloadOcrText() {
  const text = resultEl.value.trim();
  if (!text) return;
  downloadAsFile(text, 'qidian-ocr');
}

// ── Translate panel actions ───────────────────────────────────
async function doTranslate() {
  const text = translateInput.value.trim();
  if (!text) return;
  const language = languageSelect.value;
  if (language === 'original') return;
  tlTranslateButton.disabled = true;
  try {
    const host = hostInput.value.trim() || 'localhost';
    const port = parseInt(portInput.value, 10) || 8000;
    const response = await fetch(`http://${host}:${port}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error);
    translateResult.value = payload.text || '';
    tlCopyButton.disabled = false;
    tlDownloadButton.disabled = false;
  } catch (e) {
    translateResult.value = `Error: ${e.message}`;
  } finally {
    tlTranslateButton.disabled = false;
  }
}

async function copyTlResult() {
  const text = translateResult.value.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const prev = tlCopyButton.textContent;
    tlCopyButton.textContent = 'Copied!';
    setTimeout(() => { tlCopyButton.textContent = prev; }, 1500);
  } catch {
    translateResult.select();
    document.execCommand('copy');
  }
}

function downloadTlResult() {
  const text = translateResult.value.trim();
  if (!text) return;
  downloadAsFile(text, 'translate');
}

function downloadAsFile(text, prefix) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  chrome.downloads.download({
    url,
    filename: `${prefix}-${timestamp}.txt`,
    saveAs: true
  }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
}
