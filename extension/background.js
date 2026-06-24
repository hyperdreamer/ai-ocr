const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 8000;
const OVERLAP_PX = 50;
const AFTER_SEND_DELAY_MS = 1000;

async function getOcrEndpoint() {
  const items = await chrome.storage.sync.get({ ocrHost: DEFAULT_HOST, ocrPort: DEFAULT_PORT });
  return `http://${items.ocrHost}:${items.ocrPort}/ocr`;
}

const state = {
  active: false,
  status: 'Idle',
  currentPage: 0,
  fragmentsCollected: 0,
  progress: 'Ready',
  mergedText: '',
  fragments: [],
  error: ''
};

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'start-region-capture') {
    return;
  }

  const tab = await getActiveTab();
  if (!tab?.id) {
    updateState({ status: 'Error', error: 'No active tab found.' });
    return;
  }

  await startRegionSelection(tab.id);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'popup:start') {
    getActiveTab()
      .then((tab) => startRegionSelection(tab.id))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'popup:get-state') {
    sendResponse({ ok: true, state });
    return false;
  }

  if (message?.type === 'selection:complete') {
    runCaptureLoop(sender.tab, message.region)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        updateState({ active: false, status: 'Error', error: error.message });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message?.type === 'selection:cancelled') {
    updateState({ active: false, status: 'Cancelled', progress: 'Selection cancelled.' });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function startRegionSelection(tabId) {
  if (!tabId) {
    throw new Error('No active tab found.');
  }

  resetState();
  updateState({
    active: true,
    status: 'Selecting',
    progress: 'Drag a rectangle over the area to OCR.'
  });

  await sendTabMessage(tabId, { type: 'selection:start' });
}

async function runCaptureLoop(tab, region) {
  if (!tab?.id || !tab.windowId) {
    throw new Error('Missing tab context for capture.');
  }

  const normalizedRegion = normalizeRegion(region);
  if (normalizedRegion.width < 2 || normalizedRegion.height < 2) {
    throw new Error('Selected region is too small.');
  }

  resetState();
  updateState({
    active: true,
    status: 'Capturing',
    progress: 'Starting capture loop.'
  });

  const fragments = [];
  let lastScrollY = -1;

  while (true) {
    const pageNumber = fragments.length + 1;
    updateState({
      currentPage: pageNumber,
      fragmentsCollected: fragments.length,
      progress: `Capturing page ${pageNumber}.`
    });

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const croppedBlob = await cropVisibleCapture(dataUrl, normalizedRegion);

    updateState({ progress: `Sending page ${pageNumber} to OCR.` });
    const text = await postImageForOcr(croppedBlob, pageNumber);
    fragments.push(text);

    updateState({
      fragments,
      fragmentsCollected: fragments.length,
      mergedText: mergeFragments(fragments),
      progress: `Collected ${fragments.length} fragment${fragments.length === 1 ? '' : 's'}.`
    });

    await sleep(AFTER_SEND_DELAY_MS);

    const scrollResult = await sendTabMessage(tab.id, {
      type: 'page:scroll-down',
      overlapPx: OVERLAP_PX
    });

    if (!scrollResult?.changed || scrollResult.scrollY === lastScrollY) {
      break;
    }

    lastScrollY = scrollResult.scrollY;
  }

  const mergedText = mergeFragments(fragments);
  updateState({
    active: false,
    status: 'Done',
    currentPage: fragments.length,
    fragmentsCollected: fragments.length,
    progress: 'Finished.',
    fragments,
    mergedText
  });
}

async function cropVisibleCapture(dataUrl, region) {
  const imageBitmap = await createImageBitmap(await dataUrlToBlob(dataUrl));
  const scaleX = imageBitmap.width / region.viewportWidth;
  const scaleY = imageBitmap.height / region.viewportHeight;
  const cropX = Math.max(0, Math.round(region.x * scaleX));
  const cropY = Math.max(0, Math.round(region.y * scaleY));
  const cropWidth = Math.min(imageBitmap.width - cropX, Math.round(region.width * scaleX));
  const cropHeight = Math.min(imageBitmap.height - cropY, Math.round(region.height * scaleY));

  if (cropWidth <= 0 || cropHeight <= 0) {
    throw new Error('Selected crop is outside the captured viewport.');
  }

  const canvas = new OffscreenCanvas(cropWidth, cropHeight);
  const context = canvas.getContext('2d');
  context.drawImage(imageBitmap, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  imageBitmap.close();

  return canvas.convertToBlob({ type: 'image/png' });
}

async function postImageForOcr(blob, pageNumber) {
  const formData = new FormData();
  formData.append('image', blob, `qidian-page-${String(pageNumber).padStart(4, '0')}.png`);

  const response = await fetch(await getOcrEndpoint(), {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    throw new Error(`OCR request failed with HTTP ${response.status}.`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const payload = await response.json();
    return String(payload.text ?? payload.result ?? payload.content ?? '').trim();
  }

  return (await response.text()).trim();
}

function mergeFragments(fragments) {
  return fragments.reduce((merged, fragment) => {
    const cleanFragment = normalizeText(fragment);
    if (!merged) {
      return cleanFragment;
    }
    return mergeTwoFragments(merged, cleanFragment);
  }, '');
}

function mergeTwoFragments(previous, next) {
  if (!next) {
    return previous;
  }

  const previousLines = splitLines(previous);
  const nextLines = splitLines(next);
  const overlap = findLineOverlap(previousLines, nextLines);
  return previousLines.concat(nextLines.slice(overlap)).join('\n').trim();
}

function findLineOverlap(previousLines, nextLines) {
  const maxOverlap = Math.min(previousLines.length, nextLines.length);

  for (let length = maxOverlap; length > 0; length -= 1) {
    const previousSuffix = previousLines.slice(previousLines.length - length).map(normalizeLine);
    const nextPrefix = nextLines.slice(0, length).map(normalizeLine);
    if (previousSuffix.every((line, index) => line === nextPrefix[index])) {
      return length;
    }
  }

  return findLcsPrefixOverlap(previousLines, nextLines);
}

function findLcsPrefixOverlap(previousLines, nextLines) {
  const previousTail = previousLines.slice(-20).map(normalizeLine);
  const nextHead = nextLines.slice(0, 20).map(normalizeLine);
  let best = 0;

  for (let start = 0; start < previousTail.length; start += 1) {
    let matched = 0;
    for (let i = start, j = 0; i < previousTail.length && j < nextHead.length; i += 1, j += 1) {
      if (previousTail[i] === nextHead[j]) {
        matched += 1;
      }
    }
    if (matched >= 2 && matched > best) {
      best = matched;
    }
  }

  return best;
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitLines(text) {
  return normalizeText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeLine(line) {
  return line.replace(/\s+/g, ' ').trim();
}

function normalizeRegion(region) {
  return {
    x: Math.max(0, Number(region.x) || 0),
    y: Math.max(0, Number(region.y) || 0),
    width: Math.max(0, Number(region.width) || 0),
    height: Math.max(0, Number(region.height) || 0),
    viewportWidth: Math.max(1, Number(region.viewportWidth) || 1),
    viewportHeight: Math.max(1, Number(region.viewportHeight) || 1)
  };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendTabMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (message.type === 'selection:start') {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['overlay.css']
      });
      return chrome.tabs.sendMessage(tabId, message);
    }
    throw error;
  }
}

async function dataUrlToBlob(dataUrl) {
  return fetch(dataUrl).then((response) => response.blob());
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resetState() {
  Object.assign(state, {
    active: false,
    status: 'Idle',
    currentPage: 0,
    fragmentsCollected: 0,
    progress: 'Ready',
    mergedText: '',
    fragments: [],
    error: ''
  });
  broadcastState();
}

function updateState(partial) {
  Object.assign(state, partial);
  broadcastState();
}

function broadcastState() {
  chrome.runtime.sendMessage({ type: 'state:update', state }).catch(() => {});
}
