import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { t, applyI18n } from './i18n';

// The default stub in test-setup.ts returns the key itself.
// We override per-test via vi.mocked(...).mockImplementation(...) as needed.

describe('t', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chrome.i18n.getMessage).mockImplementation((key: string) => key);
  });

  it('returns the message when getMessage returns a non-empty string', () => {
    vi.mocked(chrome.i18n.getMessage).mockReturnValue('Settings saved');
    expect(t('settingsSaved')).toBe('Settings saved');
  });

  it('returns the fallback when getMessage returns empty string and fallback is provided', () => {
    vi.mocked(chrome.i18n.getMessage).mockReturnValue('');
    expect(t('missingKey', 'Default text')).toBe('Default text');
  });

  it('returns the key when getMessage returns empty string and no fallback is provided', () => {
    vi.mocked(chrome.i18n.getMessage).mockReturnValue('');
    expect(t('noTranslationKey')).toBe('noTranslationKey');
  });

  it('passes substitutions to chrome.i18n.getMessage when provided', () => {
    vi.mocked(chrome.i18n.getMessage).mockReturnValue('Hello World');
    const result = t('greeting', undefined, ['World']);

    expect(chrome.i18n.getMessage).toHaveBeenCalledWith('greeting', ['World']);
    expect(result).toBe('Hello World');
  });

  it('returns the message when both message and fallback exist (message takes priority)', () => {
    vi.mocked(chrome.i18n.getMessage).mockReturnValue('Translated text');
    expect(t('myKey', 'Fallback text')).toBe('Translated text');
  });

  it('handles @@ui_locale special key (passes through)', () => {
    vi.mocked(chrome.i18n.getMessage).mockReturnValue('en');
    expect(t('@@ui_locale')).toBe('en');
  });
});

describe('applyI18n', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    document.title = '';
    vi.mocked(chrome.i18n.getMessage).mockImplementation((key: string) => key);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.title = '';
  });

  it('sets textContent for elements with data-i18n attribute when message exists', () => {
    document.body.innerHTML = '<span data-i18n="hello">placeholder</span>';
    vi.mocked(chrome.i18n.getMessage).mockReturnValue('Hello, World!');

    applyI18n();

    const el = document.querySelector<HTMLElement>('[data-i18n]')!;
    expect(el.textContent).toBe('Hello, World!');
  });

  it('does NOT set textContent when message is empty (key not found)', () => {
    document.body.innerHTML = '<span data-i18n="missing">original text</span>';
    vi.mocked(chrome.i18n.getMessage).mockReturnValue('');

    applyI18n();

    const el = document.querySelector<HTMLElement>('[data-i18n]')!;
    expect(el.textContent).toBe('original text');
  });

  it('sets document.title when the element is a <title> tag', () => {
    document.title = 'Original Title';
    // Create a <title> element directly (not via innerHTML, since browsers
    // may relocate <title> tags during HTML parsing).
    const titleEl = document.createElement('title');
    titleEl.setAttribute('data-i18n', 'pageTitle');
    titleEl.textContent = 'placeholder';
    document.body.appendChild(titleEl);

    vi.mocked(chrome.i18n.getMessage).mockReturnValue('Options Page');

    applyI18n();

    // document.title is set; textContent on the element itself is not touched
    expect(document.title).toBe('Options Page');
    expect(titleEl.textContent).toBe('placeholder');
  });

  it('sets the title attribute for elements with data-i18n-title', () => {
    document.body.innerHTML = '<button data-i18n-title="tooltipHelp">?</button>';
    vi.mocked(chrome.i18n.getMessage).mockReturnValue('Get help with this setting');

    applyI18n();

    const el = document.querySelector<HTMLElement>('[data-i18n-title]')!;
    expect(el.getAttribute('title')).toBe('Get help with this setting');
  });

  it('does NOT set title attribute when message is empty', () => {
    document.body.innerHTML = '<button data-i18n-title="missingKey" title="original">?</button>';
    vi.mocked(chrome.i18n.getMessage).mockReturnValue('');

    applyI18n();

    const el = document.querySelector<HTMLElement>('[data-i18n-title]')!;
    expect(el.getAttribute('title')).toBe('original');
  });

  it('respects the root parameter (only applies within the given root)', () => {
    // Set up elements outside the root — these should NOT be touched
    document.body.innerHTML = '<span id="outside" data-i18n="outside">untouched</span>';
    const root = document.createElement('div');
    root.id = 'inside';
    root.innerHTML = '<span data-i18n="inside">placeholder</span>';
    document.body.appendChild(root);

    vi.mocked(chrome.i18n.getMessage).mockImplementation((key: string) => {
      if (key === 'inside') return 'Inside Text';
      if (key === 'outside') return 'Outside Text';
      return key;
    });

    applyI18n(root);

    const outside = document.querySelector<HTMLElement>('#outside')!;
    const inside = root.querySelector<HTMLElement>('[data-i18n]')!;
    expect(outside.textContent).toBe('untouched');
    expect(inside.textContent).toBe('Inside Text');
  });

  it('handles elements without data-i18n attributes (no-op)', () => {
    document.body.innerHTML = '<span>plain text</span><div class="box">another</div>';
    vi.mocked(chrome.i18n.getMessage).mockReturnValue('should not be called');

    applyI18n();

    // No elements should have been modified; getMessage might be called if querySelectorAll
    // matched something — but since nothing matches, getMessage should not be called at all.
    // However, getMessage is only called when an element has the attribute, so it's fine.
    const span = document.querySelector('span')!;
    expect(span.textContent).toBe('plain text');
  });

  it('applies both data-i18n and data-i18n-title on the same element', () => {
    document.body.innerHTML = '<button data-i18n="btnLabel" data-i18n-title="btnTooltip">placeholder</button>';
    vi.mocked(chrome.i18n.getMessage).mockImplementation((key: string) => {
      if (key === 'btnLabel') return 'Submit';
      if (key === 'btnTooltip') return 'Click to submit the form';
      return key;
    });

    applyI18n();

    const el = document.querySelector<HTMLElement>('button')!;
    expect(el.textContent).toBe('Submit');
    expect(el.getAttribute('title')).toBe('Click to submit the form');
  });
});
