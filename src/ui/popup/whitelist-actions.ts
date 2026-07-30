// whitelist-actions.ts — Whitelist toggle and add-rule button handlers
import { saveSettings } from '@utils/settings';
import { addWhitelistRule } from '@utils/whitelist';
import { showToast } from '../common/toast';
import { t } from '@utils/i18n';

export function initWhitelistActions(opts: {
  whitelistToggle: HTMLInputElement;
  addCurrentPageBtn: HTMLButtonElement;
  addCurrentDomainBtn: HTMLButtonElement;
  addParentPathBtn: HTMLButtonElement;
}): void {
  const { whitelistToggle, addCurrentPageBtn, addCurrentDomainBtn, addParentPathBtn } = opts;

  // Whitelist enable/disable toggle change handler
  whitelistToggle.addEventListener('change', async () => {
    try {
      await saveSettings({ whitelistEnabled: whitelistToggle.checked });
      console.log('Whitelist enabled:', whitelistToggle.checked);
    } catch (error) {
      console.error('Error saving whitelist toggle:', error);
    }
  });

  // "Add to whitelist" button event handlers
  addCurrentPageBtn.addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0 && tabs[0].url) {
        const url = new URL(tabs[0].url);
        const cleanUrl = url.hostname + url.pathname;
        await addWhitelistRule(cleanUrl);
        showToast(t('pageAdded', 'URL added to whitelist'), 'success');
      }
    } catch (error) {
      console.error('Error adding current URL:', error);
      showToast('Failed to add URL to whitelist', 'error');
    }
  });

  addCurrentDomainBtn.addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0 && tabs[0].url) {
        const url = new URL(tabs[0].url);
        await addWhitelistRule(`${url.hostname}/*`);
        showToast(t('domainAdded', 'Domain added to whitelist'), 'success');
      }
    } catch (error) {
      console.error('Error adding current domain:', error);
      showToast('Failed to add domain to whitelist', 'error');
    }
  });

  addParentPathBtn.addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0 && tabs[0].url) {
        const url = new URL(tabs[0].url);
        const pathParts = url.pathname.split('/').filter(p => p);
        const parentPath = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : '';
        await addWhitelistRule(`${url.hostname}/${parentPath}/*`);
        showToast(t('parentPathAdded', 'Parent path added to whitelist'), 'success');
      }
    } catch (error) {
      console.error('Error adding parent path:', error);
      showToast('Failed to add parent path to whitelist', 'error');
    }
  });
}
