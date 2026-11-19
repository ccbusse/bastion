// Unsichtbares Dokument, das ausschließlich die Zwischenablage leert
chrome.runtime.onMessage.addListener((msg: { type?: string }, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || msg.type !== 'offscreen-clear-clipboard') return false;
  const onCopy = (e: ClipboardEvent) => {
    e.preventDefault();
    e.clipboardData?.setData('text/plain', '');
  };
  document.addEventListener('copy', onCopy, { once: true });
  document.execCommand('copy');
  sendResponse({ ok: true });
  return false;
});
