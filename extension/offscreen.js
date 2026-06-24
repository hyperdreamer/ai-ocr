// Offscreen document for clipboard access from service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'offscreen:copy') {
    navigator.clipboard.writeText(message.text).then(() => {
      chrome.runtime.sendMessage({ type: 'offscreen:copied' });
    }).catch(() => {
      chrome.runtime.sendMessage({ type: 'offscreen:copy-failed' });
    });
  }
});
