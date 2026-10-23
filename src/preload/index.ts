import { contextBridge, ipcRenderer } from 'electron';
import type { RelayApi, RelayEvent } from '@shared/types';

const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api: RelayApi = {
  getStatus: call('status') as RelayApi['getStatus'],
  start: call('start') as RelayApi['start'],
  stop: call('stop') as RelayApi['stop'],
  tickOnce: call('tickOnce') as RelayApi['tickOnce'],
  getConfig: call('getConfig') as RelayApi['getConfig'],
  saveConfig: call('saveConfig') as RelayApi['saveConfig'],
  getConfigYaml: call('getConfigYaml') as RelayApi['getConfigYaml'],
  saveConfigYaml: call('saveConfigYaml') as RelayApi['saveConfigYaml'],
  openConfigFile: call('openConfigFile') as RelayApi['openConfigFile'],
  getLogs: call('getLogs') as RelayApi['getLogs'],
  getChats: call('getChats') as RelayApi['getChats'],
  getHistory: call('getHistory') as RelayApi['getHistory'],
  setChatPaused: call('setChatPaused') as RelayApi['setChatPaused'],
  clearHistory: call('clearHistory') as RelayApi['clearHistory'],
  getDrafts: call('getDrafts') as RelayApi['getDrafts'],
  approveDraft: call('approveDraft') as RelayApi['approveDraft'],
  rejectDraft: call('rejectDraft') as RelayApi['rejectDraft'],
  sendManual: call('sendManual') as RelayApi['sendManual'],
  testAgent: call('testAgent') as RelayApi['testAgent'],
  listMcpTools: call('listMcpTools') as RelayApi['listMcpTools'],
  onEvent: (cb) => {
    const listener = (_: unknown, e: RelayEvent) => cb(e);
    ipcRenderer.on('relay:event', listener);
    return () => ipcRenderer.removeListener('relay:event', listener);
  },
};

contextBridge.exposeInMainWorld('relay', api);
