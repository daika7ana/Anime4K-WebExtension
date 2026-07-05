/**
 * Type-safe message passing helpers.
 *
 * Replaces stringly-typed chrome.runtime.sendMessage / chrome.tabs.sendMessage /
 * chrome.runtime.onMessage.addListener calls with a discriminated-union contract.
 */
import type { RuntimeMessage } from '../types';

const KNOWN_MESSAGE_TYPES: ReadonlySet<RuntimeMessage['type']> = new Set([
  'SETTINGS_UPDATED',
  'URL_UPDATED',
  'OPEN_OPTIONS_PAGE',
  'OPEN_ONBOARDING',
  'WHITELIST_UPDATED',
]);

/** Type guard: narrows `unknown` to `RuntimeMessage`. */
function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type: unknown }).type === 'string' &&
    KNOWN_MESSAGE_TYPES.has((value as { type: RuntimeMessage['type'] }).type)
  );
}

/**
 * Send a message to the extension's runtime (background service worker + other extension contexts).
 * Wraps `chrome.runtime.sendMessage` with a typed payload.
 */
export function sendMessage(message: RuntimeMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

/**
 * Send a message to a specific tab's content script.
 * Wraps `chrome.tabs.sendMessage` with a typed payload.
 */
export function sendTabMessage(tabId: number, message: RuntimeMessage): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, message);
}

/**
 * Register a typed message listener. Only messages matching the `RuntimeMessage` union
 * are forwarded to `handler`; unknown message types are ignored (return false).
 *
 * @returns An unsubscribe function that removes the listener.
 */
export function onMessage(
  handler: (
    message: RuntimeMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => boolean | void | Promise<boolean | void>,
): () => void {
  const listener = (
    request: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean | void => {
    if (isRuntimeMessage(request)) {
      return handler(request, sender, sendResponse) as boolean | void;
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
