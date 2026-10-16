// Settings of the optional AI assistant. Off by default. The API key / proxy passphrase stay in memory unless the user
// ticks "Remember on this device" (then localStorage); they are never part of workspaces, exports, logs or toasts.
import { create } from 'zustand';

export type ProviderChoice = 'off' | 'auto' | 'claude' | 'apikey' | 'proxy';

export interface AiPrefs {
  provider: ProviderChoice;
  /** API / proxy model id ('' = default from the model list) */
  model: string;
  proxyUrl: string;
  allowImages: boolean;
  /** replace sample and file names by "Sample 1..n" in everything sent */
  anonymize: boolean;
  /** keep the key / passphrase in this browser's localStorage */
  remember: boolean;
  /** workspace of a personal (identity-linked, sk-ant-usr-...) API key: "wrkspc_..." (sent as anthropic-workspace-id) */
  workspaceId: string;
}

interface Secrets {
  apiKey: string;
  proxyPass: string;
}

interface AiSettingsState extends AiPrefs, Secrets {
  set: (p: Partial<AiPrefs & Secrets>) => void;
  forgetSecrets: () => void;
}

const PREFS = 'fs.ai.prefs';
const SECRET = 'fs.ai.secret';
/** A lab build can name its proxy (VITE_LAB_PROXY_URL at build time): labmates then only enter their code. */
const LAB_PROXY_URL = ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_LAB_PROXY_URL ?? '').trim();
export const DEFAULT_PREFS: AiPrefs = { provider: 'off', model: '', proxyUrl: LAB_PROXY_URL, allowImages: true, anonymize: true, remember: false, workspaceId: '' };

function read<T>(key: string): Partial<T> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function write(key: string, v: unknown | null) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* no storage: settings last for this session */
  }
}

function initial(): AiPrefs & Secrets {
  const p = { ...DEFAULT_PREFS, ...read<AiPrefs>(PREFS) };
  const s = p.remember ? read<Secrets>(SECRET) : {};
  return { ...p, apiKey: typeof s.apiKey === 'string' ? s.apiKey : '', proxyPass: typeof s.proxyPass === 'string' ? s.proxyPass : '' };
}

export const useAiSettings = create<AiSettingsState>((set, get) => ({
  ...initial(),
  set: (p) => {
    set(p);
    const s = get();
    const prefs: AiPrefs = { provider: s.provider, model: s.model, proxyUrl: s.proxyUrl, allowImages: s.allowImages, anonymize: s.anonymize, remember: s.remember, workspaceId: s.workspaceId };
    write(PREFS, prefs);
    write(SECRET, s.remember && (s.apiKey || s.proxyPass) ? { apiKey: s.apiKey, proxyPass: s.proxyPass } : null);
  },
  forgetSecrets: () => get().set({ apiKey: '', proxyPass: '', remember: false }),
}));
