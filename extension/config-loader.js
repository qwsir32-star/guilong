/* Personal rules are optional. Check the package directory before requesting
 * config.local.js so a clean Git checkout never requests a missing script.
 * Firefox distribution builds contain no personal rules; use built-in defaults.
 */
globalThis.GL_CONFIG_READY = new Promise(resolve => {
  if (typeof chrome.runtime.getPackageDirectoryEntry !== 'function') {
    resolve();
    return;
  }
  try {
    chrome.runtime.getPackageDirectoryEntry(root => {
      if (!root) { resolve(); return; }
      root.getFile('config.local.js', { create: false }, () => {
        const script = document.createElement('script');
        script.src = 'config.local.js';
        script.onload = script.onerror = resolve;
        document.head.appendChild(script);
      }, () => resolve());
    });
  } catch {
    resolve();
  }
});
