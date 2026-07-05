import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendMessage, sendTabMessage, onMessage } from './messaging';
import type { RuntimeMessage } from '../types';

describe('sendMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls chrome.runtime.sendMessage with the message', () => {
    const msg: RuntimeMessage = { type: 'OPEN_OPTIONS_PAGE' };
    const mockPromise = Promise.resolve(undefined);
    vi.mocked(chrome.runtime.sendMessage).mockReturnValue(mockPromise);

    const result = sendMessage(msg);

    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(msg);
    expect(result).toBe(mockPromise);
  });

  it('passes SETTINGS_UPDATED message with payload', () => {
    const msg: RuntimeMessage = {
      type: 'SETTINGS_UPDATED',
      settings: { performanceTier: 'quality' },
      modifiedModeId: 'mode-a',
    };
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);

    sendMessage(msg);

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(msg);
  });
});

describe('sendTabMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls chrome.tabs.sendMessage with tabId and message', () => {
    const tabId = 42;
    const msg: RuntimeMessage = { type: 'WHITELIST_UPDATED' };
    const mockPromise = Promise.resolve(undefined);
    vi.mocked(chrome.tabs.sendMessage).mockReturnValue(mockPromise);

    const result = sendTabMessage(tabId, msg);

    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(tabId, msg);
    expect(result).toBe(mockPromise);
  });

  it('passes URL_UPDATED message with tabId', () => {
    const tabId = 7;
    const msg: RuntimeMessage = { type: 'URL_UPDATED', url: 'https://example.com' };
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue(undefined);

    sendTabMessage(tabId, msg);

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(tabId, msg);
  });
});

describe('onMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers a listener via chrome.runtime.onMessage.addListener', () => {
    const handler = vi.fn();
    const unsub = onMessage(handler);

    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    expect(typeof unsub).toBe('function');
  });

  it('forwards OPEN_OPTIONS_PAGE message to handler', () => {
    const handler = vi.fn();
    onMessage(handler);

    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]![0]!;
    const msg: RuntimeMessage = { type: 'OPEN_OPTIONS_PAGE' };
    const sender: chrome.runtime.MessageSender = { id: 'ext-id' };
    const sendResponse = vi.fn();

    listener(msg, sender, sendResponse);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(msg, sender, sendResponse);
  });

  it('forwards OPEN_ONBOARDING message to handler', () => {
    const handler = vi.fn();
    onMessage(handler);

    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]![0]!;
    const msg: RuntimeMessage = { type: 'OPEN_ONBOARDING' };
    const sender: chrome.runtime.MessageSender = { tab: { id: 1 } } as chrome.runtime.MessageSender;
    const sendResponse = vi.fn();

    listener(msg, sender, sendResponse);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('forwards WHITELIST_UPDATED message to handler', () => {
    const handler = vi.fn();
    onMessage(handler);

    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]![0]!;
    const msg: RuntimeMessage = { type: 'WHITELIST_UPDATED' };
    const sender: chrome.runtime.MessageSender = {};
    const sendResponse = vi.fn();

    listener(msg, sender, sendResponse);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('forwards URL_UPDATED message to handler', () => {
    const handler = vi.fn();
    onMessage(handler);

    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]![0]!;
    const msg: RuntimeMessage = { type: 'URL_UPDATED', url: 'https://example.com' };
    const sender: chrome.runtime.MessageSender = {};
    const sendResponse = vi.fn();

    listener(msg, sender, sendResponse);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('forwards SETTINGS_UPDATED message to handler', () => {
    const handler = vi.fn();
    onMessage(handler);

    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]![0]!;
    const msg: RuntimeMessage = {
      type: 'SETTINGS_UPDATED',
      settings: { performanceTier: 'ultra' },
      modifiedModeId: 'custom-1',
    };
    const sender: chrome.runtime.MessageSender = {};
    const sendResponse = vi.fn();

    listener(msg, sender, sendResponse);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('forwards TOGGLE_ENHANCEMENT message to handler', () => {
    const handler = vi.fn();
    onMessage(handler);

    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]![0]!;
    const msg: RuntimeMessage = { type: 'TOGGLE_ENHANCEMENT' };
    const sender: chrome.runtime.MessageSender = {};
    const sendResponse = vi.fn();

    listener(msg, sender, sendResponse);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown message types (returns false, handler not called)', () => {
    const handler = vi.fn();
    onMessage(handler);

    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]![0]!;
    const sender: chrome.runtime.MessageSender = {};
    const sendResponse = vi.fn();

    const result = listener({ type: 'UNKNOWN_TYPE' }, sender, sendResponse);

    expect(result).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores messages without a type property', () => {
    const handler = vi.fn();
    onMessage(handler);

    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]![0]!;
    const sender: chrome.runtime.MessageSender = {};
    const sendResponse = vi.fn();

    const result = listener({ foo: 'bar' }, sender, sendResponse);

    expect(result).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores null messages', () => {
    const handler = vi.fn();
    onMessage(handler);

    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]![0]!;
    const sender: chrome.runtime.MessageSender = {};
    const sendResponse = vi.fn();

    const result = listener(null, sender, sendResponse);

    expect(result).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores non-object messages', () => {
    const handler = vi.fn();
    onMessage(handler);

    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]![0]!;
    const sender: chrome.runtime.MessageSender = {};
    const sendResponse = vi.fn();

    const result = listener('string-message', sender, sendResponse);

    expect(result).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns an unsubscribe function that calls chrome.runtime.onMessage.removeListener', () => {
    const handler = vi.fn();
    const unsub = onMessage(handler);

    unsub();

    expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalledTimes(1);
  });

  it('handler returning true is passed through', () => {
    const handler = vi.fn().mockReturnValue(true);
    onMessage(handler);

    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]![0]!;
    const msg: RuntimeMessage = { type: 'OPEN_OPTIONS_PAGE' };
    const sender: chrome.runtime.MessageSender = {};
    const sendResponse = vi.fn();

    const result = listener(msg, sender, sendResponse);

    expect(result).toBe(true);
  });

  it('handler returning false is passed through', () => {
    const handler = vi.fn().mockReturnValue(false);
    onMessage(handler);

    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]![0]!;
    const msg: RuntimeMessage = { type: 'OPEN_OPTIONS_PAGE' };
    const sender: chrome.runtime.MessageSender = {};
    const sendResponse = vi.fn();

    const result = listener(msg, sender, sendResponse);

    expect(result).toBe(false);
  });

  it('handler returning undefined is passed through', () => {
    const handler = vi.fn().mockReturnValue(undefined);
    onMessage(handler);

    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]![0]!;
    const msg: RuntimeMessage = { type: 'OPEN_OPTIONS_PAGE' };
    const sender: chrome.runtime.MessageSender = {};
    const sendResponse = vi.fn();

    const result = listener(msg, sender, sendResponse);

    expect(result).toBeUndefined();
  });

  it('multiple listeners can be registered independently', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    const unsub1 = onMessage(handler1);
    onMessage(handler2);

    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(2);

    // Both listeners receive the message
    const listener1 = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]![0]!;
    const listener2 = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[1]![0]!;
    const msg: RuntimeMessage = { type: 'WHITELIST_UPDATED' };
    const sender: chrome.runtime.MessageSender = {};
    const sendResponse = vi.fn();

    listener1(msg, sender, sendResponse);
    listener2(msg, sender, sendResponse);

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);

    // Unsubscribing handler1 calls removeListener
    unsub1();
    expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalledTimes(1);

    // handler2 is still active
    listener2(msg, sender, sendResponse);
    expect(handler2).toHaveBeenCalledTimes(2);
  });
});
