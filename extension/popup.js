const statusEl = document.getElementById('status');
const currentPageEl = document.getElementById('current-page');
const fragmentsEl = document.getElementById('fragments');
const shortProgressEl = document.getElementById('short-progress');
const progressEl = document.getElementById('progress');
const resultEl = document.getElementById('result');
const startButton = document.getElementById('start');
const downloadButton = document.getElementById('download');
const hostInput = document.getElementById('ocr-host');
const portInput = document.getElementById('ocr-port');

let latestState = null;

document.addEventListener('DOMContentLoaded', init);
startButton.addEventListener('click', startCapture);
downloadButton.addEventListener('click', downloadText);
hostInput.addEventListener('change', saveSettings);
portInput.addEventListener('change', saveSettings);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'state:update') {
    renderState(message.state);
  }
  if (message?.type === 'popup:auto-download') {
    downloadText();
  }
});

async function init() {
  const items = await chrome.storage.sync.get({ ocrHost: 'localhost', ocrPort: 8000 });
  hostInput.value = items.ocrHost;
  portInput.value = items.ocrPort;
  await refreshState();
}

async function saveSettings() {
  await chrome.storage.sync.set({
    ocrHost: hostInput.value.trim() || 'localhost',
    ocrPort: parseInt(portInput.value, 10) || 8000
  });
}

async function refreshState() {
  const response = await chrome.runtime.sendMessage({ type: 'popup:get-state' });
  if (response?.ok) {
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

function renderState(state) {
  latestState = state || {};
  const mergedText = latestState.mergedText || '';

  statusEl.textContent = latestState.status || 'Idle';
  currentPageEl.textContent = String(latestState.currentPage || 0);
  fragmentsEl.textContent = String(latestState.fragmentsCollected || 0);
  shortProgressEl.textContent = latestState.progress || 'Ready';
  progressEl.textContent = latestState.error || latestState.progress || 'Ready';
  resultEl.value = mergedText;
  startButton.disabled = Boolean(latestState.active);
  downloadButton.disabled = mergedText.trim().length === 0;
}

function downloadText() {
  const text = latestState?.mergedText || resultEl.value || '';
  if (!text.trim()) {
    return;
  }

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  chrome.downloads.download({
    url,
    filename: `qidian-ocr-${timestamp}.txt`,
    saveAs: true
  }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
}
