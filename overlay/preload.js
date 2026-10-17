'use strict';

/**
 * The overlay window's only door into the app.
 *
 * It is deliberately tiny: the panel can read a sample and nothing else, and it
 * cannot reach the main window, the state file or the shell.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('perf', {
  sample: () => ipcRenderer.invoke('perf:sample'),
  status: () => ipcRenderer.invoke('perf:status'),
  onHide: (cb) => ipcRenderer.on('perf:hide', () => cb())
});
