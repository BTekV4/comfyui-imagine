/**
 * The bridge the app's own pages use (the splash and the failure page).
 *
 * The studio's page is loaded from `http://127.0.0.1:<port>` and must stay a
 * normal web page: nothing is exposed to it. Only the files this app loads
 * from disk (`file://`) get `window.imagine`.
 */
const { contextBridge, ipcRenderer } = require('electron')

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('imagine', {
    /** Ask the app to do something it owns: `restart`, `logs`, `data`, `quit`. */
    action: (name) => {
      if (typeof name !== 'string') return
      ipcRenderer.send('imagine:action', name)
    },
  })
}
