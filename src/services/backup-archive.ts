import { zipSync, unzipSync } from 'fflate';
import type { Env } from '../types';
import {
  getAttachmentObjectKey,
  getBlobObject,
  getBlobStorageKind,
  getSendFileObjectKey,
} from './blob-store';

type SqlRow = Record<string, string | number | null>;

const BACKUP_FORMAT_VERSION = 1;
const BACKUP_APP_VERSION = '1.3.0';
const BACKUP_ZIP_COMPRESSION_LEVEL = 6;
const MAX_BACKUP_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_ARCHIVE_ENTRY_COUNT = 10_000;
const MAX_BACKUP_EXTRACTED_BYTES = 128 * 1024 * 1024;
const MAX_BACKUP_DB_JSON_BYTES = 32 * 1024 * 1024;

export interface BackupManifest {
  formatVersion: 1;
  exportedAt: string;
  appVersion: string;
  storageKind: 'r2' | 'kv' | null;
  tableCounts: Record<string, number>;
  includes: {
    attachments: boolean;
    sendFiles: boolean;
  };
  blobSummary: {
    attachmentFiles: number;
    sendFiles: number;
    totalBytes: number;
    largestObjectBytes: number;
  };
}

export interface BackupPayload {
  manifest: BackupManifest;
  db: {
    config: SqlRow[];
    users: SqlRow[];
    user_revisions: SqlRow[];
    folders: SqlRow[];
    ciphers: SqlRow[];
    attachments: SqlRow[];
    sends: SqlRow[];
  };
}

export interface BackupArchiveBundle {
  bytes: Uint8Array;
  fileName: string;
  manifest: BackupManifest;
}

export function parseSendFileId(data: string | null): string | null {
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    return typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : null;
  } catch {
    return null;
  }
}

async function queryRows(db: D1Database, sql: string, ...values: unknown[]): Promise<SqlRow[]> {
  const result = await db.prepare(sql).bind(...values).all<SqlRow>();
  return (result.results || []).map((row) => ({ ...row }));
}

async function streamToBytes(stream: ReadableStream | null): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

function buildBackupFileName(date: Date = new Date()): string {
  const parts = [
    date.getUTCFullYear().toString().padStart(4, '0'),
    (date.getUTCMonth() + 1).toString().padStart(2, '0'),
    date.getUTCDate().toString().padStart(2, '0'),
    date.getUTCHours().toString().padStart(2, '0'),
    date.getUTCMinutes().toString().padStart(2, '0'),
    date.getUTCSeconds().toString().padStart(2, '0'),
  ];
  return `nodewarden_backup_${parts[0]}${parts[1]}${parts[2]}_${parts[3]}${parts[4]}${parts[5]}.zip`;
}

function validateArchiveSize(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_BACKUP_ARCHIVE_BYTES) {
    throw new Error(`Backup archive is too large. The current restore limit is ${Math.floor(MAX_BACKUP_ARCHIVE_BYTES / (1024 * 1024))} MiB`);
  }
}

function getRequiredZipEntries(db: BackupPayload['db']): string[] {
  const entries: string[] = [];
  for (const row of db.attachments) {
    const cipherId = String(row.cipher_id || '').trim();
    const attachmentId = String(row.id || '').trim();
    if (!cipherId || !attachmentId) continue;
    entries.push(`attachments/${cipherId}/${attachmentId}.bin`);
  }
  for (const row of db.sends) {
    const sendId = String(row.id || '').trim();
    const fileId = parseSendFileId(typeof row.data === 'string' ? row.data : null);
    if (!sendId || !fileId) continue;
    entries.push(`send-files/${sendId}/${fileId}.bin`);
  }
  return entries;
}

function ensureRowArray(value: unknown, table: string): SqlRow[] {
  if (!Array.isArray(value)) {
    throw new Error(`Backup archive table ${table} is invalid`);
  }
  return value as SqlRow[];
}

export function parseBackupArchive(bytes: Uint8Array): { payload: BackupPayload; files: Record<string, Uint8Array> } {
  validateArchiveSize(bytes);
  let zipped: Record<string, Uint8Array>;
  try {
    zipped = unzipSync(bytes);
  } catch {
    throw new Error('Invalid backup archive');
  }

  const entryNames = Object.keys(zipped);
  if (entryNames.length > MAX_BACKUP_ARCHIVE_ENTRY_COUNT) {
    throw new Error('Backup archive contains too many files');
  }

  let totalExtractedBytes = 0;
  for (const entry of entryNames) {
    const entryBytes = zipped[entry];
    totalExtractedBytes += entryBytes.byteLength;
    if (entry === 'db.json' && entryBytes.byteLength > MAX_BACKUP_DB_JSON_BYTES) {
      throw new Error('Backup archive database payload is too large');
    }
    if (totalExtractedBytes > MAX_BACKUP_EXTRACTED_BYTES) {
      throw new Error('Backup archive expands beyond the current restore limit');
    }
  }

  const manifestBytes = zipped['manifest.json'];
  const dbBytes = zipped['db.json'];
  if (!manifestBytes || !dbBytes) {
    throw new Error('Backup archive is missing manifest.json or db.json');
  }

  const decoder = new TextDecoder();
  let manifest: BackupManifest;
  let db: BackupPayload['db'];
  try {
    manifest = JSON.parse(decoder.decode(manifestBytes)) as BackupManifest;
    db = JSON.parse(decoder.decode(dbBytes)) as BackupPayload['db'];
  } catch {
    throw new Error('Backup archive contains invalid JSON metadata');
  }

  if (manifest?.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error('Unsupported backup format version');
  }
  if (!db || typeof db !== 'object') {
    throw new Error('Backup archive database payload is invalid');
  }

  const requiredEntries = getRequiredZipEntries(db);
  for (const entry of requiredEntries) {
    if (!zipped[entry]) {
      throw new Error(`Backup archive is missing required file: ${entry}`);
    }
  }

  return {
    payload: { manifest, db },
    files: zipped,
  };
}

export function validateBackupPayloadContents(payload: BackupPayload, files: Record<string, Uint8Array>): void {
  const configRows = ensureRowArray(payload.db.config, 'config');
  const userRows = ensureRowArray(payload.db.users, 'users');
  const revisionRows = ensureRowArray(payload.db.user_revisions, 'user_revisions');
  const folderRows = ensureRowArray(payload.db.folders, 'folders');
  const cipherRows = ensureRowArray(payload.db.ciphers, 'ciphers');
  const attachmentRows = ensureRowArray(payload.db.attachments, 'attachments');
  const sendRows = ensureRowArray(payload.db.sends, 'sends');

  const userIds = new Set<string>();
  for (const row of userRows) {
    const id = String(row.id || '').trim();
    const email = String(row.email || '').trim();
    if (!id || !email) throw new Error('Backup archive contains an invalid user row');
    if (userIds.has(id)) throw new Error(`Backup archive contains duplicate user id: ${id}`);
    userIds.add(id);
  }

  for (const row of configRows) {
    const key = String(row.key || '').trim();
    if (!key) throw new Error('Backup archive contains an invalid config row');
  }

  for (const row of revisionRows) {
    const userId = String(row.user_id || '').trim();
    if (!userId || !userIds.has(userId)) {
      throw new Error(`Backup archive contains a revision for an unknown user: ${userId || '(empty)'}`);
    }
  }

  const folderIds = new Set<string>();
  for (const row of folderRows) {
    const id = String(row.id || '').trim();
    const userId = String(row.user_id || '').trim();
    if (!id || !userIds.has(userId)) throw new Error('Backup archive contains an invalid folder row');
    if (folderIds.has(id)) throw new Error(`Backup archive contains duplicate folder id: ${id}`);
    folderIds.add(id);
  }

  const cipherIds = new Set<string>();
  for (const row of cipherRows) {
    const id = String(row.id || '').trim();
    const userId = String(row.user_id || '').trim();
    const folderId = String(row.folder_id || '').trim();
    if (!id || !userIds.has(userId)) throw new Error('Backup archive contains an invalid cipher row');
    if (folderId && !folderIds.has(folderId)) {
      throw new Error(`Backup archive contains a cipher for an unknown folder: ${folderId}`);
    }
    if (cipherIds.has(id)) throw new Error(`Backup archive contains duplicate cipher id: ${id}`);
    cipherIds.add(id);
  }

  for (const row of attachmentRows) {
    const id = String(row.id || '').trim();
    const cipherId = String(row.cipher_id || '').trim();
    if (!id || !cipherId || !cipherIds.has(cipherId)) {
      throw new Error('Backup archive contains an invalid attachment row');
    }
    if (!files[`attachments/${cipherId}/${id}.bin`]) {
      throw new Error(`Backup archive is missing required file: attachments/${cipherId}/${id}.bin`);
    }
  }

  const sendIds = new Set<string>();
  for (const row of sendRows) {
    const id = String(row.id || '').trim();
    const userId = String(row.user_id || '').trim();
    if (!id || !userIds.has(userId)) throw new Error('Backup archive contains an invalid send row');
    if (sendIds.has(id)) throw new Error(`Backup archive contains duplicate send id: ${id}`);
    sendIds.add(id);
    const fileId = parseSendFileId(typeof row.data === 'string' ? row.data : null);
    if (fileId && !files[`send-files/${id}/${fileId}.bin`]) {
      throw new Error(`Backup archive is missing required file: send-files/${id}/${fileId}.bin`);
    }
  }
}

export async function buildBackupArchive(env: Env, date: Date = new Date()): Promise<BackupArchiveBundle> {
  const encoder = new TextEncoder();
  const [configRows, userRows, revisionRows, folderRows, cipherRows, attachmentRows, sendRows] = await Promise.all([
    queryRows(env.DB, 'SELECT key, value FROM config ORDER BY key ASC'),
    queryRows(env.DB, 'SELECT id, email, name, master_password_hash, key, private_key, public_key, kdf_type, kdf_iterations, kdf_memory, kdf_parallelism, security_stamp, role, status, totp_secret, totp_recovery_code, created_at, updated_at FROM users ORDER BY created_at ASC'),
    queryRows(env.DB, 'SELECT user_id, revision_date FROM user_revisions ORDER BY user_id ASC'),
    queryRows(env.DB, 'SELECT id, user_id, name, created_at, updated_at FROM folders ORDER BY created_at ASC'),
    queryRows(env.DB, 'SELECT id, user_id, type, folder_id, name, notes, favorite, data, reprompt, key, created_at, updated_at, deleted_at FROM ciphers ORDER BY created_at ASC'),
    queryRows(env.DB, 'SELECT id, cipher_id, file_name, size, size_name, key FROM attachments ORDER BY cipher_id ASC, id ASC'),
    queryRows(env.DB, 'SELECT id, user_id, type, name, notes, data, key, password_hash, password_salt, password_iterations, auth_type, emails, max_access_count, access_count, disabled, hide_email, created_at, updated_at, expiration_date, deletion_date FROM sends ORDER BY created_at ASC'),
  ]);

  let attachmentBlobCount = 0;
  let sendFileBlobCount = 0;
  let totalBlobBytes = 0;
  let largestObjectBytes = 0;
  const manifestBase = {
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: date.toISOString(),
    appVersion: BACKUP_APP_VERSION,
    storageKind: getBlobStorageKind(env),
    tableCounts: {
      config: configRows.length,
      users: userRows.length,
      user_revisions: revisionRows.length,
      folders: folderRows.length,
      ciphers: cipherRows.length,
      attachments: attachmentRows.length,
      sends: sendRows.length,
    },
    includes: {
      attachments: true,
      sendFiles: true,
    },
    blobSummary: {
      attachmentFiles: 0,
      sendFiles: 0,
      totalBytes: 0,
      largestObjectBytes: 0,
    },
  } satisfies BackupManifest;

  const files: Record<string, Uint8Array> = {
    'manifest.json': encoder.encode(JSON.stringify(manifestBase, null, 2)),
    'db.json': encoder.encode(JSON.stringify({
      config: configRows,
      users: userRows,
      user_revisions: revisionRows,
      folders: folderRows,
      ciphers: cipherRows,
      attachments: attachmentRows,
      sends: sendRows,
    }, null, 2)),
  };

  for (const row of attachmentRows) {
    const cipherId = String(row.cipher_id || '').trim();
    const attachmentId = String(row.id || '').trim();
    if (!cipherId || !attachmentId) continue;
    const object = await getBlobObject(env, getAttachmentObjectKey(cipherId, attachmentId));
    if (!object) {
      throw new Error(`Attachment blob missing for ${cipherId}/${attachmentId}`);
    }
    const bytes = await streamToBytes(object.body);
    files[`attachments/${cipherId}/${attachmentId}.bin`] = bytes;
    attachmentBlobCount += 1;
    totalBlobBytes += bytes.byteLength;
    largestObjectBytes = Math.max(largestObjectBytes, bytes.byteLength);
  }

  for (const row of sendRows) {
    const sendId = String(row.id || '').trim();
    const fileId = parseSendFileId(typeof row.data === 'string' ? row.data : null);
    if (!sendId || !fileId) continue;
    const object = await getBlobObject(env, getSendFileObjectKey(sendId, fileId));
    if (!object) {
      throw new Error(`Send file blob missing for ${sendId}/${fileId}`);
    }
    const bytes = await streamToBytes(object.body);
    files[`send-files/${sendId}/${fileId}.bin`] = bytes;
    sendFileBlobCount += 1;
    totalBlobBytes += bytes.byteLength;
    largestObjectBytes = Math.max(largestObjectBytes, bytes.byteLength);
  }

  const manifest: BackupManifest = {
    ...manifestBase,
    blobSummary: {
      attachmentFiles: attachmentBlobCount,
      sendFiles: sendFileBlobCount,
      totalBytes: totalBlobBytes,
      largestObjectBytes,
    },
  };
  files['manifest.json'] = encoder.encode(JSON.stringify(manifest, null, 2));

  return {
    bytes: zipSync(files, { level: BACKUP_ZIP_COMPRESSION_LEVEL }),
    fileName: buildBackupFileName(date),
    manifest,
  };
}
