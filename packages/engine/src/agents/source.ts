// The single adapter interface all agent data flows through (§6). The UI renders
// against `capabilities`, so control buttons simply don't exist until a source
// flips the flag. Implement the read half now; declare control as stubs.

export interface AgentEvent {
  ts: string;
  type: string;
  payload: unknown;
}

export interface AgentSession {
  id: string;
  source: string;
  cwd: string;
  branch?: string;
  repoId?: string;
  prId?: string;
  status: "running" | "waiting" | "idle" | "done";
  startedAt?: string;
  lastEventAt?: string;
  recentEvents: AgentEvent[];
}

export interface AgentCapabilities {
  observe: boolean;
  control: boolean;
}

export class NotSupported extends Error {
  constructor(op: string) {
    super(`Operation not supported by this agent source: ${op}`);
    this.name = "NotSupported";
  }
}

export interface AgentSource {
  id: string;
  capabilities: AgentCapabilities;

  // read — implemented now
  discoverSessions(): Promise<AgentSession[]>;
  subscribe(onEvent: (e: AgentEvent) => void): () => void;

  // control — declared only; throw NotSupported in v1
  start?(repoId: string, prompt: string): Promise<AgentSession>;
  stop?(sessionId: string): Promise<void>;
  resume?(sessionId: string): Promise<void>;
}
