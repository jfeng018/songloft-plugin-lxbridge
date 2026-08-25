export type LyricTranslationMode = 'merge' | 'original' | 'translation';
export type LyricPreferredSource = 'auto' | 'kw' | 'kg' | 'tx' | 'wy' | 'mg' | 'lrclib';

export interface LyricSettings {
  auto_fetch: boolean;
  provider_enabled: boolean;
  fallback_enabled: boolean;
  preferred_source: LyricPreferredSource;
  translation_mode: LyricTranslationMode;
  request_interval_ms: number;
}

const STORAGE_KEY = 'neo-lxbridge:lyric_settings:v1';
const DEFAULTS: LyricSettings = {
  auto_fetch: true,
  provider_enabled: false,
  fallback_enabled: true,
  preferred_source: 'auto',
  translation_mode: 'merge',
  request_interval_ms: 600,
};
let cached: LyricSettings | null = null;

function normalize(value: Partial<LyricSettings> | null | undefined): LyricSettings {
  const mode = String(value?.translation_mode || DEFAULTS.translation_mode);
  const preferredSource = String(value?.preferred_source || DEFAULTS.preferred_source);
  const interval = Number(value?.request_interval_ms ?? DEFAULTS.request_interval_ms);
  return {
    auto_fetch: value?.auto_fetch !== false,
    provider_enabled: value?.provider_enabled === true,
    fallback_enabled: value?.fallback_enabled !== false,
    preferred_source: ['auto', 'kw', 'kg', 'tx', 'wy', 'mg', 'lrclib'].includes(preferredSource) ? preferredSource as LyricPreferredSource : DEFAULTS.preferred_source,
    translation_mode: ['merge', 'original', 'translation'].includes(mode) ? mode as LyricTranslationMode : DEFAULTS.translation_mode,
    request_interval_ms: Math.max(300, Math.min(5000, Number.isFinite(interval) ? Math.round(interval) : DEFAULTS.request_interval_ms)),
  };
}

export async function getLyricSettings(): Promise<LyricSettings> {
  if (cached) return { ...cached };
  try {
    const raw = await songloft.persistentStorage.get(STORAGE_KEY);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    cached = normalize(parsed && typeof parsed === 'object' ? parsed as Partial<LyricSettings> : null);
  } catch {
    cached = { ...DEFAULTS };
  }
  return { ...cached };
}

export async function setLyricSettings(value: Partial<LyricSettings>): Promise<LyricSettings> {
  const next = normalize({ ...(await getLyricSettings()), ...value });
  await songloft.persistentStorage.set(STORAGE_KEY, JSON.stringify(next));
  cached = next;
  return { ...next };
}

export function resetLyricSettingsCache(): void {
  cached = null;
}
