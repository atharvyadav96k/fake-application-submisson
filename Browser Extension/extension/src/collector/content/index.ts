import type { BackgroundToContent } from '@/common/messages';
import { createLogger } from '@/utils/logger';
import { Observer } from './observer';

/** Content-script entry point (ISOLATED world). */

const log = createLogger('content');

const observer = new Observer(window);

void observer.start().catch((err) => log.warn('observer failed to start', err));

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: BackgroundToContent, _sender, sendResponse) => {
    try {
      observer.handleBackgroundMessage(message);
      sendResponse({ ok: true });
    } catch (err) {
      log.warn('failed to handle background message', err);
      sendResponse({ ok: false });
    }
    return false;
  });
}

// Exposed only when debug logging is on, for manual inspection during development.
declare const __DEV__: boolean | undefined;
if (typeof __DEV__ !== 'undefined' && __DEV__) {
  (window as unknown as Record<string, unknown>).__aav_debug = () => observer.debugState();
}
