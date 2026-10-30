import { contextBridge, ipcRenderer } from 'electron';
import type { PopupRequest, RelayApi, RelayEvent } from '@shared/types';

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
  deleteChats: call('deleteChats') as RelayApi['deleteChats'],
  getDrafts: call('getDrafts') as RelayApi['getDrafts'],
  approveDraft: call('approveDraft') as RelayApi['approveDraft'],
  rejectDraft: call('rejectDraft') as RelayApi['rejectDraft'],
  sendManual: call('sendManual') as RelayApi['sendManual'],
  syncHistory: call('syncHistory') as RelayApi['syncHistory'],
  addChat: call('addChat') as RelayApi['addChat'],
  generateReply: call('generateReply') as RelayApi['generateReply'],
  setChatMode: call('setChatMode') as RelayApi['setChatMode'],
  setChatAsk: call('setChatAsk') as RelayApi['setChatAsk'],
  getPersona: call('getPersona') as RelayApi['getPersona'],
  setPersona: call('setPersona') as RelayApi['setPersona'],
  setPersonaCases: call('setPersonaCases') as RelayApi['setPersonaCases'],
  selectPersona: call('selectPersona') as RelayApi['selectPersona'],
  agentPrompt: call('agentPrompt') as RelayApi['agentPrompt'],
  generatePersona: call('generatePersona') as RelayApi['generatePersona'],
  testAgent: call('testAgent') as RelayApi['testAgent'],
  listMcpTools: call('listMcpTools') as RelayApi['listMcpTools'],
  prepareTool: call('prepareTool') as RelayApi['prepareTool'],
  readScript: call('readScript') as RelayApi['readScript'],
  writeScript: call('writeScript') as RelayApi['writeScript'],
  scriptTypings: call('scriptTypings') as RelayApi['scriptTypings'],
  openScript: call('openScript') as RelayApi['openScript'],
  testScript: call('testScript') as RelayApi['testScript'],
  listMemory: call('listMemory') as RelayApi['listMemory'],
  readMemory: call('readMemory') as RelayApi['readMemory'],
  writeMemory: call('writeMemory') as RelayApi['writeMemory'],
  listSkills: call('listSkills') as RelayApi['listSkills'],
  readSkill: call('readSkill') as RelayApi['readSkill'],
  writeSkill: call('writeSkill') as RelayApi['writeSkill'],
  deleteSkill: call('deleteSkill') as RelayApi['deleteSkill'],
  dreamMemory: call('dreamMemory') as RelayApi['dreamMemory'],
  onEvent: (cb) => {
    const listener = (_: unknown, e: RelayEvent) => cb(e);
    ipcRenderer.on('relay:event', listener);
    return () => ipcRenderer.removeListener('relay:event', listener);
  },
  onPopup: (cb) => {
    const listener = (_: unknown, r: PopupRequest | null) => cb(r);
    ipcRenderer.on('popup:request', listener);
    void ipcRenderer.invoke('popup:current').then(cb);
    return () => ipcRenderer.removeListener('popup:request', listener);
  },
  answerPopup: call('popup:answer') as RelayApi['answerPopup'],
  holdPopup: (id) => ipcRenderer.send('popup:hold', id),
  resizePopup: (h) => ipcRenderer.send('popup:resize', h),
};

contextBridge.exposeInMainWorld('relay', api);
