import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";
import { connectWs, type WsEvent } from "./ws";
import type { AgentsResponse, AppConfig, Repo, SourceDir } from "./types";

export type Theme = "dark" | "light";

interface AppState {
  repos: Repo[];
  sourceDirs: SourceDir[];
  config: AppConfig | null;
  agents: AgentsResponse | null;
  userName: string;
  connected: boolean;
  error: string | null;
  theme: Theme;
  toggleTheme: () => void;
  reloadRepos: () => Promise<void>;
  reloadSourceDirs: () => Promise<void>;
  reloadConfig: () => Promise<void>;
  reloadAgents: () => Promise<void>;
  setConfig: (patch: Partial<AppConfig>) => Promise<void>;
  onWs: (handler: (e: WsEvent) => void) => () => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [sourceDirs, setSourceDirs] = useState<SourceDir[]>([]);
  const [config, setConfigState] = useState<AppConfig | null>(null);
  const [agents, setAgents] = useState<AgentsResponse | null>(null);
  const [userName, setUserName] = useState<string>("you");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("gm_theme");
    return stored === "dark" || stored === "light" ? stored : "dark";
  });

  const handlers = useRef(new Set<(e: WsEvent) => void>());

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("gm_theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  const reloadRepos = useCallback(async () => {
    try {
      setRepos(await api.listRepos());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  const reloadSourceDirs = useCallback(async () => {
    try {
      setSourceDirs(await api.listSourceDirs());
    } catch {
      // non-fatal: keep stale list
    }
  }, []);
  const reloadConfig = useCallback(async () => {
    try {
      setConfigState(await api.getConfig());
    } catch {
      // non-fatal: keep stale config
    }
  }, []);
  const reloadAgents = useCallback(async () => {
    try {
      setAgents(await api.agents());
    } catch {
      // non-fatal: keep stale agents
    }
  }, []);

  const setConfig = useCallback(async (patch: Partial<AppConfig>) => {
    setConfigState(await api.setConfig(patch));
  }, []);

  const onWs = useCallback((handler: (e: WsEvent) => void) => {
    handlers.current.add(handler);
    return () => handlers.current.delete(handler);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await api.ping();
        setConnected(true);
        void api
          .me()
          .then((m) => m.name && setUserName(m.name))
          .catch(() => {});
        await Promise.all([
          reloadRepos(),
          reloadSourceDirs(),
          reloadConfig(),
          reloadAgents(),
        ]);
      } catch (e) {
        setError((e as Error).message);
      }
    })();

    const disconnect = connectWs((e) => {
      // Fan out to subscribers, and refresh the shared collections on key events.
      handlers.current.forEach((h) => h(e));
      if (e.type === "repos.updated") void reloadRepos();
      if (e.type === "agents.refreshed" || e.type === "agent.updated") void reloadAgents();
    });
    return disconnect;
  }, [reloadRepos, reloadSourceDirs, reloadConfig, reloadAgents]);

  const value = useMemo<AppState>(
    () => ({
      repos,
      sourceDirs,
      config,
      agents,
      userName,
      connected,
      error,
      theme,
      toggleTheme,
      reloadRepos,
      reloadSourceDirs,
      reloadConfig,
      reloadAgents,
      setConfig,
      onWs,
    }),
    [
      repos,
      sourceDirs,
      config,
      agents,
      userName,
      connected,
      error,
      theme,
      toggleTheme,
      reloadRepos,
      reloadSourceDirs,
      reloadConfig,
      reloadAgents,
      setConfig,
      onWs,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
