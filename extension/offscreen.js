// Offscreen document for clipboard + download access from service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'offscreen:copy') {
    navigator.clipboard.writeText(message.text).then(() => {
      chrome.runtime.sendMessage({ type: 'offscreen:copied' });
    }).catch(() => {
      chrome.runtime.sendMessage({ type: 'offscreen:copy-failed' });
    });
  }
  if (message?.type === 'offscreen:download') {
    const { text, filename } = message;
    if (!text || !filename) return;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: 'overwrite'
    }, (downloadId) => {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      if (chrome.runtime.lastError) {
        console.error('Download failed:', chrome.runtime.lastError.message);
      }
    });
  }
});
