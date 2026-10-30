import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { App } from 'antd';
import type { AppConfig, AppId, ChatMessage, Draft, LogEntry, MonitorStatus, SessionRow, Snapshot } from '@shared/types';

interface RelayState {
  /** WeChat's status (the dashboard watches its screenshots). */
  status: MonitorStatus | null;
  /** Status of every app. */
  statuses: Partial<Record<AppId, MonitorStatus>>;
  config: AppConfig | null;
  snapshot: Snapshot | null;
  /** Latest session list of apps without screenshots (wecom). */
  sessions: Partial<Record<AppId, { at: number; rows: SessionRow[]; tree?: string }>>;
  /** Newest messages seen per app (live feed of the dashboard), newest first. */
  recent: Array<{ chat: string; message: ChatMessage }>;
  logs: LogEntry[];
  drafts: Draft[];
  /** Bumped whenever a chat message arrives (pages refetch history). */
  chatVersion: number;
  saveConfig: (mutate: (c: AppConfig) => void) => Promise<void>;
  reloadDrafts: () => Promise<void>;
}

const Ctx = createContext<RelayState | null>(null);

export function RelayProvider({ children }: { children: ReactNode }) {
  const { message } = App.useApp();
  const [statuses, setStatuses] = useState<Partial<Record<AppId, MonitorStatus>>>({});
  const status = statuses.wechat ?? null;
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [sessions, setSessions] = useState<RelayState['sessions']>({});
  const [recent, setRecent] = useState<RelayState['recent']>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [chatVersion, setChatVersion] = useState(0);
  const configRef = useRef<AppConfig | null>(null);
  configRef.current = config;

  const reloadDrafts = useCallback(async () => setDrafts(await window.relay.getDrafts()), []);

  useEffect(() => {
    void window.relay.getStatus().then((list) => setStatuses(Object.fromEntries(list.map((s) => [s.app, s]))));
    void window.relay.getConfig().then(setConfig);
    void window.relay.getLogs().then(setLogs);
    void reloadDrafts();
    return window.relay.onEvent((e) => {
      switch (e.type) {
        case 'status': setStatuses((s) => ({ ...s, [e.status.app]: e.status })); break;
        case 'config': setConfig(e.config); break;
        case 'snapshot': setSnapshot(e.snapshot); break;
        case 'sessions': setSessions((s) => ({ ...s, [e.app]: { at: e.at, rows: e.sessions, tree: e.tree ?? s[e.app]?.tree } })); break;
        case 'log': setLogs((l) => (l.length > 1500 ? [...l.slice(-1000), e.entry] : [...l, e.entry])); break;
        case 'chat':
          setChatVersion((v) => v + 1);
          if (e.message) setRecent((r) => [{ chat: e.chat, message: e.message! }, ...r].slice(0, 40));
          break;
        case 'draft': setDrafts((ds) => [e.draft, ...ds.filter((d) => d.id !== e.draft.id)]); break;
      }
    });
  }, [reloadDrafts]);

  const saveConfig = useCallback(async (mutate: (c: AppConfig) => void) => {
    if (!configRef.current) return;
    const next = structuredClone(configRef.current);
    mutate(next);
    try {
      await window.relay.saveConfig(next);
      setConfig(next);
      message.success('已保存');
    } catch (e) {
      message.error(`保存失败：${(e as Error).message}`);
      throw e;
    }
  }, [message]);

  const value = useMemo(() => ({ status, statuses, config, snapshot, sessions, recent, logs, drafts, chatVersion, saveConfig, reloadDrafts }),
    [status, statuses, config, snapshot, sessions, recent, logs, drafts, chatVersion, saveConfig, reloadDrafts]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRelay(): RelayState {
  const v = useContext(Ctx);
  if (!v) throw new Error('RelayProvider missing');
  return v;
}

/** Strips Electron's "Error invoking remote method 'x': Error: " prefix. */
export function errMsg(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
