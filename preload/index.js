import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('gitDesk', Object.freeze({
  getAppInfo: () => ipcRenderer.invoke('app:info')
}));
