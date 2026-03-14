import type { Env } from '../types';
import { StorageService } from './storage';
import { KV_MAX_OBJECT_BYTES, deleteBlobObject, getAttachmentObjectKey, getBlobStorageKind, getSendFileObjectKey, putBlobObject } from './blob-store';
import { normalizeImportedBackupSettings } from './backup-config';
import { type BackupPayload, parseBackupArchive, parseSendFileId, validateBackupPayloadContents } from './backup-archive';

type SqlRow = Record<string, string | number | null>;

export interface BackupImportResultBody {
  object: 'instance-backup-import';
  imported: {
    config: number;
    users: number;
    userRevisions: number;
    folders: number;
    ciphers: number;
    attachments: number;
    sends: number;
    attachmentFiles: number;
    sendFiles: number;
  };
}

export interface BackupImportExecutionResult {
  result: BackupImportResultBody;
  auditActorUserId: string | null;
}

async function queryRows(db: D1Database, sql: string, ...values: unknown[]): Promise<SqlRow[]> {
  const response = await db.prepare(sql).bind(...values).all<SqlRow>();
  return (response.results || []).map((row) => ({ ...row }));
}

async function ensureImportTargetIsFresh(db: D1Database): Promise<void> {
  const counts = await Promise.all([
    db.prepare('SELECT COUNT(*) AS count FROM ciphers').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM folders').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM attachments').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM sends').first<{ count: number }>(),
  ]);
  const total = counts.reduce((sum, row) => sum + Number(row?.count || 0), 0);
  if (total > 0) {
    throw new Error('Backup import requires a fresh instance with no vault or send data');
  }
}

function buildResetImportTargetStatements(db: D1Database): D1PreparedStatement[] {
  return [
    'DELETE FROM attachments',
    'DELETE FROM ciphers',
    'DELETE FROM folders',
    'DELETE FROM sends',
    'DELETE FROM trusted_two_factor_device_tokens',
    'DELETE FROM devices',
    'DELETE FROM refresh_tokens',
    'DELETE FROM invites',
    'DELETE FROM audit_logs',
    'DELETE FROM user_revisions',
    'DELETE FROM users',
    'DELETE FROM config',
    'DELETE FROM login_attempts_ip',
    'DELETE FROM api_rate_limits',
    'DELETE FROM used_attachment_download_tokens',
  ].map((sql) => db.prepare(sql));
}

async function collectCurrentBlobKeys(db: D1Database): Promise<Set<string>> {
  const keys = new Set<string>();
  const attachmentRows = await queryRows(
    db,
    `SELECT a.id, a.cipher_id
     FROM attachments a
     INNER JOIN ciphers c ON c.id = a.cipher_id`
  );
  for (const row of attachmentRows) {
    const cipherId = String(row.cipher_id || '').trim();
    const attachmentId = String(row.id || '').trim();
    if (!cipherId || !attachmentId) continue;
    keys.add(getAttachmentObjectKey(cipherId, attachmentId));
  }

  const sendRows = await queryRows(db, 'SELECT id, data FROM sends');
  for (const row of sendRows) {
    const sendId = String(row.id || '').trim();
    const fileId = parseSendFileId(typeof row.data === 'string' ? row.data : null);
    if (!sendId || !fileId) continue;
    keys.add(getSendFileObjectKey(sendId, fileId));
  }
  return keys;
}

function collectImportedBlobKeys(db: BackupPayload['db']): Set<string> {
  const keys = new Set<string>();
  for (const row of db.attachments) {
    const cipherId = String(row.cipher_id || '').trim();
    const attachmentId = String(row.id || '').trim();
    if (!cipherId || !attachmentId) continue;
    keys.add(getAttachmentObjectKey(cipherId, attachmentId));
  }
  for (const row of db.sends) {
    const sendId = String(row.id || '').trim();
    const fileId = parseSendFileId(typeof row.data === 'string' ? row.data : null);
    if (!sendId || !fileId) continue;
    keys.add(getSendFileObjectKey(sendId, fileId));
  }
  return keys;
}

function validateImportBlobLimits(env: Env, payload: BackupPayload, files: Record<string, Uint8Array>): void {
  if (getBlobStorageKind(env) !== 'kv') return;
  for (const entry of Object.keys(files)) {
    if (!entry.endsWith('.bin')) continue;
    if (files[entry].byteLength > KV_MAX_OBJECT_BYTES) {
      throw new Error(`Backup file ${entry} exceeds the Cloudflare KV object size limit`);
    }
  }
  if ((payload.db.attachments || []).length > 0 || (payload.db.sends || []).length > 0) {
    if (!env.ATTACHMENTS_KV) {
      throw new Error('Backup restore requires ATTACHMENTS_KV when using KV blob storage');
    }
  }
}

function buildInsertStatements(db: D1Database, table: string, columns: string[], rows: SqlRow[], upsert = false): D1PreparedStatement[] {
  if (!rows.length) return [];
  const placeholders = `(${columns.map(() => '?').join(', ')})`;
  const sql = `INSERT ${upsert ? 'OR REPLACE ' : ''}INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}`;
  return rows.map((row) => db.prepare(sql).bind(...columns.map((column) => row[column] ?? null)));
}

async function restoreBlobFiles(env: Env, db: BackupPayload['db'], files: Record<string, Uint8Array>): Promise<{ attachments: number; sendFiles: number }> {
  let attachmentCount = 0;
  let sendFileCount = 0;

  for (const row of db.attachments || []) {
    const cipherId = String(row.cipher_id || '').trim();
    const attachmentId = String(row.id || '').trim();
    if (!cipherId || !attachmentId) continue;
    const key = `attachments/${cipherId}/${attachmentId}.bin`;
    const bytes = files[key];
    if (!bytes) throw new Error(`Backup archive is missing required file: ${key}`);
    await putBlobObject(env, getAttachmentObjectKey(cipherId, attachmentId), bytes, {
      size: bytes.byteLength,
      contentType: 'application/octet-stream',
    });
    attachmentCount += 1;
  }

  for (const row of db.sends || []) {
    const sendId = String(row.id || '').trim();
    const fileId = parseSendFileId(typeof row.data === 'string' ? row.data : null);
    if (!sendId || !fileId) continue;
    const key = `send-files/${sendId}/${fileId}.bin`;
    const bytes = files[key];
    if (!bytes) throw new Error(`Backup archive is missing required file: ${key}`);
    await putBlobObject(env, getSendFileObjectKey(sendId, fileId), bytes, {
      size: bytes.byteLength,
      contentType: 'application/octet-stream',
    });
    sendFileCount += 1;
  }

  return {
    attachments: attachmentCount,
    sendFiles: sendFileCount,
  };
}

async function cleanupOrphanedBlobFiles(env: Env, beforeKeys: Set<string>, afterKeys: Set<string>): Promise<void> {
  const staleKeys = Array.from(beforeKeys).filter((key) => !afterKeys.has(key));
  for (const key of staleKeys) {
    await deleteBlobObject(env, key);
  }
}

async function importBackupRows(db: D1Database, payload: BackupPayload['db']): Promise<void> {
  const statements: D1PreparedStatement[] = [
    ...buildResetImportTargetStatements(db),
    ...buildInsertStatements(db, 'config', ['key', 'value'], payload.config || [], true),
    ...buildInsertStatements(
      db,
      'users',
      ['id', 'email', 'name', 'master_password_hash', 'key', 'private_key', 'public_key', 'kdf_type', 'kdf_iterations', 'kdf_memory', 'kdf_parallelism', 'security_stamp', 'role', 'status', 'totp_secret', 'totp_recovery_code', 'created_at', 'updated_at'],
      payload.users || []
    ),
    ...buildInsertStatements(db, 'user_revisions', ['user_id', 'revision_date'], payload.user_revisions || [], true),
    ...buildInsertStatements(db, 'folders', ['id', 'user_id', 'name', 'created_at', 'updated_at'], payload.folders || []),
    ...buildInsertStatements(
      db,
      'ciphers',
      ['id', 'user_id', 'type', 'folder_id', 'name', 'notes', 'favorite', 'data', 'reprompt', 'key', 'created_at', 'updated_at', 'deleted_at'],
      payload.ciphers || []
    ),
    ...buildInsertStatements(db, 'attachments', ['id', 'cipher_id', 'file_name', 'size', 'size_name', 'key'], payload.attachments || []),
    ...buildInsertStatements(
      db,
      'sends',
      ['id', 'user_id', 'type', 'name', 'notes', 'data', 'key', 'password_hash', 'password_salt', 'password_iterations', 'auth_type', 'emails', 'max_access_count', 'access_count', 'disabled', 'hide_email', 'created_at', 'updated_at', 'expiration_date', 'deletion_date'],
      payload.sends || []
    ),
  ];
  await db.batch(statements);
}

export async function importBackupArchiveBytes(
  archiveBytes: Uint8Array,
  env: Env,
  actorUserId: string,
  replaceExisting: boolean
): Promise<BackupImportExecutionResult> {
  const storage = new StorageService(env.DB);
  const parsed = parseBackupArchive(archiveBytes);
  validateBackupPayloadContents(parsed.payload, parsed.files);
  validateImportBlobLimits(env, parsed.payload, parsed.files);

  try {
    await ensureImportTargetIsFresh(env.DB);
  } catch (error) {
    if (!replaceExisting) {
      throw error instanceof Error ? error : new Error('Backup import requires a fresh instance');
    }
  }

  const previousBlobKeys = replaceExisting ? await collectCurrentBlobKeys(env.DB) : new Set<string>();
  const { db } = parsed.payload;
  await importBackupRows(env.DB, db);
  await normalizeImportedBackupSettings(storage, env, 'UTC');

  const blobCounts = await restoreBlobFiles(env, db, parsed.files);
  if (replaceExisting && previousBlobKeys.size) {
    await cleanupOrphanedBlobFiles(env, previousBlobKeys, collectImportedBlobKeys(db));
  }

  await storage.setRegistered();

  return {
    auditActorUserId: (db.users || []).some((row) => String(row.id || '').trim() === actorUserId) ? actorUserId : null,
    result: {
      object: 'instance-backup-import',
      imported: {
        config: (db.config || []).length,
        users: (db.users || []).length,
        userRevisions: (db.user_revisions || []).length,
        folders: (db.folders || []).length,
        ciphers: (db.ciphers || []).length,
        attachments: (db.attachments || []).length,
        sends: (db.sends || []).length,
        attachmentFiles: blobCounts.attachments,
        sendFiles: blobCounts.sendFiles,
      },
    },
  };
}
