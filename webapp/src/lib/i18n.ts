export type Locale = 'en' | 'zh-CN';

const LOCALE_STORAGE_KEY = 'nodewarden.locale';

type MessageTable = Record<string, string>;

let locale: Locale = resolveInitialLocale();
let activeMessages: MessageTable = {};
let englishMessages: MessageTable | null = null;
const loadedMessages = new Map<Locale, MessageTable>();

function resolveInitialLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved === 'en' || saved === 'zh-CN') return saved;
  } catch {
    // ignore storage errors
  }
  if (typeof navigator !== 'undefined') {
    const langs = Array.isArray(navigator.languages) ? navigator.languages : [navigator.language];
    for (const lang of langs) {
      if (String(lang || '').toLowerCase().startsWith('zh')) return 'zh-CN';
    }
  }
  return 'en';
}

async function loadEnglishMessages(): Promise<MessageTable> {
  if (englishMessages) return englishMessages;
  const mod = await import('./i18n/locales/en');
  englishMessages = mod.default;
  loadedMessages.set('en', englishMessages);
  return englishMessages;
}

async function loadLocaleMessages(next: Locale): Promise<MessageTable> {
  const cached = loadedMessages.get(next);
  if (cached) return cached;

  if (next === 'en') {
    return loadEnglishMessages();
  }

  const [base, overridesMod] = await Promise.all([
    loadEnglishMessages(),
    import('./i18n/locales/zh-CN'),
  ]);
  const merged = { ...base, ...overridesMod.default };
  loadedMessages.set(next, merged);
  return merged;
}

export type I18nParams = Record<string, string | number | null | undefined>;

export async function initI18n(): Promise<void> {
  activeMessages = await loadLocaleMessages(locale);
}

export function t(key: string, params?: I18nParams): string {
  const template = activeMessages[key] ?? englishMessages?.[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
}

export function getLocale(): Locale {
  return locale;
}

export async function setLocale(next: Locale): Promise<void> {
  locale = next;
  activeMessages = await loadLocaleMessages(next);
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    // ignore storage errors
  }
}
