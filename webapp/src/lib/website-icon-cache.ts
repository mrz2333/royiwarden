type WebsiteIconStatus = 'idle' | 'loading' | 'loaded' | 'error';

interface WebsiteIconRecord {
  status: WebsiteIconStatus;
  imageUrl: string | null;
  listeners: Set<(status: WebsiteIconStatus) => void>;
}

const iconRecords = new Map<string, WebsiteIconRecord>();

function ensureRecord(host: string): WebsiteIconRecord {
  let record = iconRecords.get(host);
  if (!record) {
    record = {
      status: 'idle',
      imageUrl: null,
      listeners: new Set(),
    };
    iconRecords.set(host, record);
  }
  return record;
}

function notifyRecord(host: string, status: WebsiteIconStatus): void {
  const record = ensureRecord(host);
  record.status = status;
  for (const listener of Array.from(record.listeners)) {
    listener(status);
  }
}

export function getWebsiteIconStatus(host: string): WebsiteIconStatus {
  if (!host) return 'idle';
  return ensureRecord(host).status;
}

export function getWebsiteIconImageUrl(host: string): string {
  if (!host) return '';
  return ensureRecord(host).imageUrl || '';
}

export function subscribeWebsiteIconStatus(host: string, listener: (status: WebsiteIconStatus) => void): () => void {
  if (!host) return () => undefined;
  const record = ensureRecord(host);
  record.listeners.add(listener);
  return () => {
    record.listeners.delete(listener);
  };
}

export function markWebsiteIconLoaded(host: string, imageUrl?: string): void {
  if (!host) return;
  const record = ensureRecord(host);
  if (imageUrl) {
    record.imageUrl = imageUrl;
  }
  notifyRecord(host, 'loaded');
}

export function markWebsiteIconErrored(host: string): void {
  if (!host) return;
  const record = ensureRecord(host);
  record.imageUrl = null;
  notifyRecord(host, 'error');
}

export function beginWebsiteIconLoad(host: string, src: string): boolean {
  if (!host || !src) return false;
  const record = ensureRecord(host);
  if (record.status !== 'idle') return false;
  record.imageUrl = src;
  notifyRecord(host, 'loading');
  return true;
}
