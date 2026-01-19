const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let creating; 

async function setupOffscreenDocument(path) {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(path)]
  });

  if (existingContexts.length > 0) return;

  if (creating) {
    await creating;
  } else {
    creating = chrome.offscreen.createDocument({
      url: path,
      reasons: ['BLOBS'],
      justification: 'Running AI models',
    });
    await creating;
    creating = null;
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'REQUEST_ANALYSIS') {
    (async () => {
      try {
        await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);

        // Offscreenへ転送し、返事を待つ
        const response = await chrome.runtime.sendMessage({
          type: 'EXECUTE_ANALYSIS',
          imageData: request.imageData
        });

        // Popupへ返事（Offscreenから来た {success: true} など）
        sendResponse(response);
        
      } catch (error) {
        console.error('[SW] Error:', error);
        // エラー時はイベントでPopupに通知
        chrome.runtime.sendMessage({
          type: 'ANALYSIS_ERROR',
          error: `SW Error: ${error.message}`
        });
        sendResponse({ success: false, error: error.message });
      }
    })();

    return true; 
  }
});

// Keep Alive
setInterval(() => { chrome.runtime.getPlatformInfo(() => {}); }, 20000);