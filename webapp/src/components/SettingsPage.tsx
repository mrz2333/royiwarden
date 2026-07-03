import { useEffect, useMemo, useState } from 'preact/hooks';
import { Clipboard, KeyRound, RefreshCw, ShieldCheck, ShieldOff, Trash2 } from 'lucide-preact';
import { copyTextToClipboard } from '@/lib/clipboard';
import qrcode from 'qrcode-generator';
import type { AccountPasskeyCredential, Profile } from '@/lib/types';
import { AVAILABLE_LOCALES, getLocale, setLocale, t, type Locale } from '@/lib/i18n';
import ConfirmDialog from '@/components/ConfirmDialog';

interface SettingsPageProps {
  profile: Profile;
  totpEnabled: boolean;
  themePreference: ThemePreference;
  lockTimeoutMinutes: 0 | 1 | 5 | 15 | 30;
  sessionTimeoutAction: 'lock' | 'logout';
  onThemePreferenceChange: (preference: ThemePreference) => void;
  onVerifyMasterPassword: (email: string, password: string) => Promise<void>;
  onChangePassword: (currentPassword: string, nextPassword: string, nextPassword2: string) => Promise<void>;
  onSavePasswordHint: (masterPasswordHint: string) => Promise<void>;
  onEnableTotp: (secret: string, token: string, masterPassword: string) => Promise<void>;
  onOpenDisableTotp: () => void;
  onGetRecoveryCode: (masterPassword: string) => Promise<string>;
  onGetApiKey: (masterPassword: string) => Promise<string>;
  onRotateApiKey: (masterPassword: string) => Promise<string>;
  onListAccountPasskeys: () => Promise<AccountPasskeyCredential[]>;
  onCreateAccountPasskey: (name: string, masterPassword: string, directUnlock: boolean) => Promise<AccountPasskeyCredential | null>;
  onEnableAccountPasskeyDirectUnlock: (id: string, masterPassword: string) => Promise<void>;
  onDeleteAccountPasskey: (id: string, masterPassword: string) => Promise<void>;
  onLockTimeoutChange: (minutes: 0 | 1 | 5 | 15 | 30) => void;
  onSessionTimeoutActionChange: (action: 'lock' | 'logout') => void;
  onNotify?: (type: 'success' | 'error' | 'warning', text: string) => void;
}

type ThemePreference = 'system' | 'light' | 'dark';
type SettingsSection = 'appearance' | 'session' | 'masterPassword' | 'twoStep' | 'keys';

type MasterPasswordPromptAction =
  | 'enableTotp'
  | 'recovery'
  | 'apiKey'
  | 'rotateApiKey'
  | 'manageTotp'
  | 'createPasskey'
  | 'enablePasskeyDirectUnlock'
  | 'deletePasskey';

const LOCK_TIMEOUT_OPTIONS = [
  { value: 1, labelKey: 'txt_timeout_1_minute' },
  { value: 5, labelKey: 'txt_timeout_5_minutes' },
  { value: 15, labelKey: 'txt_timeout_15_minutes' },
  { value: 30, labelKey: 'txt_timeout_30_minutes' },
  { value: 0, labelKey: 'txt_timeout_never' },
] as const;

function randomBase32Secret(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  const maxUnbiasedByte = Math.floor(256 / alphabet.length) * alphabet.length;
  while (out.length < length) {
    const random = crypto.getRandomValues(new Uint8Array(length));
    for (const x of random) {
      if (x >= maxUnbiasedByte) continue;
      out += alphabet[x % alphabet.length];
      if (out.length >= length) break;
    }
  }
  return out;
}

function buildOtpUri(email: string, secret: string): string {
  const issuer = 'NodeWarden';
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${email}`)}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function clearLegacyTotpSetupSecrets(): void {
  if (typeof window === 'undefined') return;
  const prefix = 'nodewarden.totp.secret.';
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  for (const key of keys) {
    window.localStorage.removeItem(key);
  }
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return t('txt_dash');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('txt_dash');
  return date.toLocaleString();
}

export default function SettingsPage(props: SettingsPageProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPassword2, setNewPassword2] = useState('');
  const [passwordHint, setPasswordHint] = useState(props.profile.masterPasswordHint || '');
  const [secret, setSecret] = useState(() => randomBase32Secret(32));
  const [token, setToken] = useState('');
  const [totpLocked, setTotpLocked] = useState(props.totpEnabled);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [accountPasskeys, setAccountPasskeys] = useState<AccountPasskeyCredential[]>([]);
  const [accountPasskeysLoading, setAccountPasskeysLoading] = useState(false);
  const [accountPasskeyName, setAccountPasskeyName] = useState(t('txt_account_passkey'));
  const [accountPasskeyDirectUnlock, setAccountPasskeyDirectUnlock] = useState(false);
  const [accountPasskeyPromptId, setAccountPasskeyPromptId] = useState<string | null>(null);
  const [createPasskeyDialogOpen, setCreatePasskeyDialogOpen] = useState(false);
  const [createPasskeyMasterPassword, setCreatePasskeyMasterPassword] = useState('');
  const [rotateApiKeyConfirmOpen, setRotateApiKeyConfirmOpen] = useState(false);
  const [apiKeyDialogOpen, setApiKeyDialogOpen] = useState(false);
  const [totpManageDialogOpen, setTotpManageDialogOpen] = useState(false);
  const [recoveryCodeDialogOpen, setRecoveryCodeDialogOpen] = useState(false);
  const [totpManagePassword, setTotpManagePassword] = useState('');
  const [masterPasswordPrompt, setMasterPasswordPrompt] = useState<MasterPasswordPromptAction | null>(null);
  const [masterPasswordPromptValue, setMasterPasswordPromptValue] = useState('');
  const [masterPasswordPromptSubmitting, setMasterPasswordPromptSubmitting] = useState(false);
  const [selectedLocale, setSelectedLocale] = useState<Locale>(() => getLocale());
  const [activeSection, setActiveSection] = useState<SettingsSection>('appearance');

  useEffect(() => {
    clearLegacyTotpSetupSecrets();
  }, []);

  useEffect(() => {
    if (!props.totpEnabled) {
      setTotpLocked(false);
      return;
    }
    setTotpLocked(true);
  }, [props.totpEnabled]);

  useEffect(() => {
    setPasswordHint(props.profile.masterPasswordHint || '');
  }, [props.profile.masterPasswordHint]);

  useEffect(() => {
    void refreshAccountPasskeys();
  }, [props.profile.id]);

  const qrDataUrl = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(buildOtpUri(props.profile.email, secret));
    qr.make();
    // Keep a visible quiet zone so authenticator apps can scan reliably in both themes.
    const svg = qr.createSvgTag({ scalable: true, margin: 4 });
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }, [props.profile.email, secret]);

  async function enableTotp(): Promise<void> {
    if (totpLocked) return;
    if (!secret.trim() || !token.trim()) {
      props.onNotify?.('error', t('txt_secret_and_code_are_required'));
      return;
    }
    openMasterPasswordPrompt('enableTotp');
  }

  async function refreshAccountPasskeys(): Promise<void> {
    setAccountPasskeysLoading(true);
    try {
      setAccountPasskeys(await props.onListAccountPasskeys());
    } catch (error) {
      props.onNotify?.('error', error instanceof Error ? error.message : t('txt_account_passkeys_load_failed'));
    } finally {
      setAccountPasskeysLoading(false);
    }
  }

  function openMasterPasswordPrompt(action: MasterPasswordPromptAction, credentialId?: string): void {
    setMasterPasswordPrompt(action);
    setAccountPasskeyPromptId(credentialId || null);
    setMasterPasswordPromptValue('');
  }

  function closeMasterPasswordPrompt(): void {
    if (masterPasswordPromptSubmitting) return;
    setMasterPasswordPrompt(null);
    setAccountPasskeyPromptId(null);
    setMasterPasswordPromptValue('');
  }

  async function submitMasterPasswordPrompt(): Promise<void> {
    if (!masterPasswordPrompt || masterPasswordPromptSubmitting) return;
    const masterPassword = masterPasswordPromptValue;
    setMasterPasswordPromptSubmitting(true);
    try {
      if (masterPasswordPrompt === 'enableTotp') {
        await props.onEnableTotp(secret, token, masterPassword);
        setTotpLocked(true);
      } else if (masterPasswordPrompt === 'recovery') {
        const code = await props.onGetRecoveryCode(masterPassword);
        setRecoveryCode(code);
        setRecoveryCodeDialogOpen(true);
        props.onNotify?.('success', t('txt_recovery_code_loaded'));
      } else if (masterPasswordPrompt === 'apiKey') {
        const key = await props.onGetApiKey(masterPassword);
        setApiKey(key);
        setApiKeyDialogOpen(true);
      } else if (masterPasswordPrompt === 'rotateApiKey') {
        const key = await props.onRotateApiKey(masterPassword);
        setApiKey(key);
        setApiKeyDialogOpen(true);
        props.onNotify?.('success', t('txt_api_key_rotated'));
      } else if (masterPasswordPrompt === 'manageTotp') {
        await props.onVerifyMasterPassword(props.profile.email, masterPassword);
        setTotpManagePassword(masterPassword);
        setTotpManageDialogOpen(true);
      } else if (masterPasswordPrompt === 'createPasskey') {
        await props.onVerifyMasterPassword(props.profile.email, masterPassword);
        setCreatePasskeyMasterPassword(masterPassword);
        setCreatePasskeyDialogOpen(true);
      } else if (masterPasswordPrompt === 'enablePasskeyDirectUnlock') {
        if (!accountPasskeyPromptId) throw new Error(t('txt_account_passkey_not_found'));
        await props.onEnableAccountPasskeyDirectUnlock(accountPasskeyPromptId, masterPassword);
        await refreshAccountPasskeys();
      } else if (masterPasswordPrompt === 'deletePasskey') {
        if (!accountPasskeyPromptId) throw new Error(t('txt_account_passkey_not_found'));
        await props.onDeleteAccountPasskey(accountPasskeyPromptId, masterPassword);
        await refreshAccountPasskeys();
      }
      setMasterPasswordPrompt(null);
      setAccountPasskeyPromptId(null);
      setMasterPasswordPromptValue('');
    } catch (error) {
      props.onNotify?.('error', error instanceof Error ? error.message : t('txt_master_password_is_required_2'));
    } finally {
      setMasterPasswordPromptSubmitting(false);
    }
  }

  const masterPasswordPromptTitle =
    masterPasswordPrompt === 'enableTotp'
      ? t('txt_enable_totp')
      : masterPasswordPrompt === 'recovery'
      ? t('txt_view_recovery_code')
      : masterPasswordPrompt === 'rotateApiKey'
        ? t('txt_rotate_api_key')
        : masterPasswordPrompt === 'manageTotp'
          ? t('txt_totp')
          : masterPasswordPrompt === 'createPasskey'
            ? t('txt_add_account_passkey')
            : masterPasswordPrompt === 'enablePasskeyDirectUnlock'
              ? t('txt_enable_passkey_direct_unlock')
              : masterPasswordPrompt === 'deletePasskey'
                ? t('txt_delete_account_passkey')
                : t('txt_view_api_key');

  function accountPasskeyStatusText(credential: AccountPasskeyCredential): string {
    if (credential.prfStatus === 0) return t('txt_direct_unlock');
    if (credential.prfStatus === 1) return t('txt_login_only');
    return t('txt_prf_not_supported');
  }

  async function changeLocale(next: Locale): Promise<void> {
    if (next === getLocale()) return;
    setSelectedLocale(next);
    await setLocale(next);
    window.location.reload();
  }

  function closeTotpManageDialog(): void {
    setTotpManageDialogOpen(false);
    setTotpManagePassword('');
  }

  async function enableTotpFromManageDialog(): Promise<void> {
    if (totpLocked) return;
    if (!secret.trim() || !token.trim()) {
      props.onNotify?.('error', t('txt_secret_and_code_are_required'));
      return;
    }
    try {
      await props.onEnableTotp(secret, token, totpManagePassword);
      setTotpLocked(true);
    } catch (error) {
      props.onNotify?.('error', error instanceof Error ? error.message : t('txt_enable_totp_failed'));
    }
  }

  function closeCreatePasskeyDialog(): void {
    setCreatePasskeyDialogOpen(false);
    setCreatePasskeyMasterPassword('');
    setAccountPasskeyName(t('txt_account_passkey'));
    setAccountPasskeyDirectUnlock(false);
  }

  async function submitCreatePasskeyDialog(): Promise<void> {
    if (!createPasskeyMasterPassword || masterPasswordPromptSubmitting) return;
    setMasterPasswordPromptSubmitting(true);
    try {
      const credential = await props.onCreateAccountPasskey(accountPasskeyName, createPasskeyMasterPassword, accountPasskeyDirectUnlock);
      if (credential) await refreshAccountPasskeys();
      closeCreatePasskeyDialog();
    } catch (error) {
      props.onNotify?.('error', error instanceof Error ? error.message : t('txt_account_passkeys_load_failed'));
    } finally {
      setMasterPasswordPromptSubmitting(false);
    }
  }

  const settingsSections: Array<{ id: SettingsSection; label: string }> = [
    { id: 'appearance', label: t('txt_settings_appearance') },
    { id: 'session', label: t('txt_session_timeout') },
    { id: 'masterPassword', label: t('txt_master_password') },
    { id: 'twoStep', label: t('txt_two_step_login') },
    { id: 'keys', label: t('txt_keys') },
  ];

  return (
    <div className="settings-page-categorized">
      <div className="settings-category-layout">
        <nav className="settings-category-tabs" aria-label={t('nav_account_settings')}>
          {settingsSections.map((section) => (
            <button
              key={section.id}
              type="button"
              className={`settings-category-tab ${activeSection === section.id ? 'active' : ''}`}
              onClick={() => setActiveSection(section.id)}
            >
              {section.label}
            </button>
          ))}
        </nav>

        <section className="settings-category-panel">
          {activeSection === 'appearance' && (
            <div className="settings-section-stack">
              <section className="settings-submodule">
                <label className="field">
                  <span>{t('txt_theme')}</span>
                  <select
                    className="input"
                    value={props.themePreference}
                    onInput={(e) => props.onThemePreferenceChange((e.currentTarget as HTMLSelectElement).value as ThemePreference)}
                  >
                    <option value="system">{t('txt_use_system_theme')}</option>
                    <option value="light">{t('txt_light_theme')}</option>
                    <option value="dark">{t('txt_dark_theme')}</option>
                  </select>
                  <div className="field-help">{t('txt_theme_saved_locally')}</div>
                </label>
              </section>

              <section className="settings-submodule">
                <label className="field">
                  <span>{t('txt_display_language')}</span>
                  <select
                    className="input"
                    value={selectedLocale}
                    onInput={(e) => void changeLocale((e.currentTarget as HTMLSelectElement).value as Locale)}
                  >
                    {AVAILABLE_LOCALES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <div className="field-help">{t('txt_display_language_help')}</div>
                </label>
              </section>
            </div>
          )}

          {activeSection === 'session' && (
            <div className="settings-section-stack">
              <section className="settings-submodule">
                <div className="session-timeout-fields">
                  <label className="field">
                    <span>{t('txt_timeout_time')}</span>
                    <select
                      className="input"
                      value={String(props.lockTimeoutMinutes)}
                      onInput={(e) => props.onLockTimeoutChange(Number((e.currentTarget as HTMLSelectElement).value) as 0 | 1 | 5 | 15 | 30)}
                    >
                      {LOCK_TIMEOUT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {t(option.labelKey)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>{t('txt_timeout_action')}</span>
                    <select
                      className="input"
                      value={props.sessionTimeoutAction}
                      onInput={(e) => props.onSessionTimeoutActionChange((e.currentTarget as HTMLSelectElement).value === 'logout' ? 'logout' : 'lock')}
                    >
                      <option value="logout">{t('txt_timeout_action_logout')}</option>
                      <option value="lock">{t('txt_timeout_action_lock')}</option>
                    </select>
                  </label>
                </div>
              </section>
            </div>
          )}

          {activeSection === 'masterPassword' && (
            <div className="settings-section-stack">
              <section className="settings-submodule">
                <h3>{t('txt_change_master_password')}</h3>
                <label className="field">
                  <span>{t('txt_current_password')}</span>
                  <input
                    className="input"
                    type="password"
                    value={currentPassword}
                    onInput={(e) => setCurrentPassword((e.currentTarget as HTMLInputElement).value)}
                  />
                </label>
                <div className="settings-vertical-fields">
                  <label className="field">
                    <span>{t('txt_new_password')}</span>
                    <input className="input" type="password" value={newPassword} onInput={(e) => setNewPassword((e.currentTarget as HTMLInputElement).value)} />
                  </label>
                  <label className="field">
                    <span>{t('txt_confirm_password')}</span>
                    <input className="input" type="password" value={newPassword2} onInput={(e) => setNewPassword2((e.currentTarget as HTMLInputElement).value)} />
                  </label>
                </div>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void props.onChangePassword(currentPassword, newPassword, newPassword2)}
                >
                  <KeyRound size={14} className="btn-icon" />
                  {t('txt_change_password')}
                </button>
              </section>

              <section className="settings-submodule">
                <label className="field">
                  <span>{t('txt_password_hint_optional')}</span>
                  <input
                    className="input"
                    maxLength={120}
                    value={passwordHint}
                    placeholder={t('txt_password_hint_placeholder')}
                    onInput={(e) => setPasswordHint((e.currentTarget as HTMLInputElement).value)}
                  />
                  <div className="field-help">{t('txt_password_hint_register_help')}</div>
                </label>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void props.onSavePasswordHint(passwordHint)}
                >
                  {t('txt_save')}
                </button>
              </section>

              <section className="settings-submodule account-passkeys-module">
                <div className="settings-module-head">
                  <h3>{t('txt_account_passkeys')}</h3>
                  <button
                    type="button"
                    className="btn btn-secondary small"
                    disabled={accountPasskeysLoading}
                    title={t('txt_refresh')}
                    aria-label={t('txt_refresh')}
                    onClick={() => void refreshAccountPasskeys()}
                  >
                    <RefreshCw size={14} className="btn-icon" />
                    {t('txt_refresh')}
                  </button>
                </div>
                <p className="muted-inline settings-field-note">{t('txt_account_passkey_login_only_help')}</p>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={masterPasswordPromptSubmitting}
                    onClick={() => openMasterPasswordPrompt('createPasskey')}
                  >
                    <KeyRound size={14} className="btn-icon" />
                    {t('txt_add_account_passkey')}
                  </button>
                </div>
                <div className="account-passkeys-list">
                  {accountPasskeysLoading ? (
                    <div className="settings-module-placeholder">
                      <RefreshCw size={20} />
                      <span>{t('txt_loading')}</span>
                    </div>
                  ) : accountPasskeys.length === 0 ? (
                    <div className="settings-module-placeholder">
                      <KeyRound size={20} />
                      <span>{t('txt_no_account_passkeys')}</span>
                    </div>
                  ) : (
                    accountPasskeys.map((credential) => (
                      <div key={credential.id} className="account-passkey-row">
                        <div className="account-passkey-main">
                          <strong>{credential.name || t('txt_account_passkey')}</strong>
                          <small>{t('txt_created_value', { value: formatDateTime(credential.creationDate) })}</small>
                        </div>
                        <span className={`account-passkey-status account-passkey-status-${credential.prfStatus}`}>
                          {accountPasskeyStatusText(credential)}
                        </span>
                        <div className="actions account-passkey-actions">
                          {credential.prfStatus === 1 && (
                            <button
                              type="button"
                              className="btn btn-secondary small"
                              disabled={masterPasswordPromptSubmitting}
                              onClick={() => openMasterPasswordPrompt('enablePasskeyDirectUnlock', credential.id)}
                            >
                              <ShieldCheck size={14} className="btn-icon" />
                              {t('txt_enable_passkey_direct_unlock')}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-danger small"
                            disabled={masterPasswordPromptSubmitting}
                            onClick={() => openMasterPasswordPrompt('deletePasskey', credential.id)}
                          >
                            <Trash2 size={14} className="btn-icon" />
                            {t('txt_delete')}
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          )}

          {activeSection === 'twoStep' && (
            <div className="settings-section-stack">
              <section className="settings-submodule two-step-recovery-warning">
                <div className="two-step-warning-head">
                  <ShieldOff size={16} aria-hidden="true" />
                  <strong>{t('txt_warning')}</strong>
                </div>
                <p>{t('txt_two_step_recovery_code_warning')}</p>
                <button type="button" className="btn btn-danger" onClick={() => openMasterPasswordPrompt('recovery')}>
                  {t('txt_view_recovery_code')}
                </button>
              </section>

              <section className="settings-submodule two-step-providers-module">
                <h3>{t('txt_providers')}</h3>
                <div className="two-step-provider-list">
                  <div className="two-step-provider-row">
                    <div className="two-step-provider-icon">
                      <ShieldCheck size={28} />
                    </div>
                    <div className="two-step-provider-copy">
                      <div className="two-step-provider-title">
                        <strong>{t('txt_authenticator_app')}</strong>
                        {totpLocked && <span className="two-step-enabled-badge">{t('txt_enabled')}</span>}
                      </div>
                      <span>{t('txt_authenticator_app_help')}</span>
                    </div>
                    <button type="button" className="btn btn-secondary" onClick={() => openMasterPasswordPrompt('manageTotp')}>
                      {t('txt_manage')}
                    </button>
                  </div>

                  <div className="two-step-provider-row">
                    <div className="two-step-provider-icon">
                      <KeyRound size={28} />
                    </div>
                    <div className="two-step-provider-copy">
                      <strong>{t('txt_passkeys')}</strong>
                      <span>{t('txt_passkey_provider_help')}</span>
                    </div>
                    <button type="button" className="btn btn-secondary" disabled>
                      {t('txt_manage')}
                    </button>
                  </div>

                  <div className="two-step-provider-row">
                    <div className="two-step-provider-icon two-step-provider-yubico">yubico</div>
                    <div className="two-step-provider-copy">
                      <strong>{t('txt_yubico_otp_security_key')}</strong>
                      <span>{t('txt_yubico_otp_security_key_help')}</span>
                    </div>
                    <button type="button" className="btn btn-secondary" disabled>
                      {t('txt_manage')}
                    </button>
                  </div>
                </div>
              </section>
            </div>
          )}

          {activeSection === 'keys' && (
            <div className="settings-section-stack">
              <section className="settings-submodule sensitive-action">
                <div>
                  <h3>{t('txt_api_key')}</h3>
                  <p className="muted-inline settings-field-note">{t('txt_api_key_dialog_intro')}</p>
                </div>
                <div className="actions">
                  <button type="button" className="btn btn-secondary" onClick={() => openMasterPasswordPrompt('apiKey')}>
                    <KeyRound size={14} className="btn-icon" />
                    {t('txt_view_api_key')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setRotateApiKeyConfirmOpen(true)}
                  >
                    <RefreshCw size={14} className="btn-icon" />
                    {t('txt_rotate_api_key')}
                  </button>
                </div>
              </section>
            </div>
          )}
        </section>
      </div>
      <ConfirmDialog
        open={masterPasswordPrompt !== null}
        title={masterPasswordPromptTitle}
        message={t('txt_enter_master_password_to_continue')}
        confirmText={t('txt_continue')}
        cancelText={t('txt_cancel')}
        confirmDisabled={masterPasswordPromptSubmitting || !masterPasswordPromptValue.trim()}
        cancelDisabled={masterPasswordPromptSubmitting}
        onConfirm={() => void submitMasterPasswordPrompt()}
        onCancel={closeMasterPasswordPrompt}
      >
        <label className="field">
          <span>{t('txt_master_password')}</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={masterPasswordPromptValue}
            onInput={(e) => setMasterPasswordPromptValue((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        open={totpManageDialogOpen}
        title={t('txt_totp')}
        message={totpLocked ? t('txt_totp_enabled') : t('txt_totp_manage_intro')}
        hideCancel
        hideConfirm
        closeButton
        onConfirm={() => {}}
        onCancel={closeTotpManageDialog}
      >
        <div className="totp-manage-dialog-body">
          <div className="totp-grid">
            <div className="totp-qr">
              <img src={qrDataUrl} alt="TOTP QR" />
            </div>
            <div>
              <label className="field">
                <span>{t('txt_authenticator_key')}</span>
                <div className="totp-secret-input-wrap">
                  <input className="input totp-secret-input" value={secret} disabled={totpLocked} onInput={(e) => setSecret((e.currentTarget as HTMLInputElement).value.toUpperCase())} />
                  <div className="totp-secret-actions">
                    <button
                      type="button"
                      className="btn btn-secondary small totp-secret-icon-btn"
                      disabled={totpLocked}
                      title={t('txt_regenerate')}
                      aria-label={t('txt_regenerate')}
                      onClick={() => setSecret(randomBase32Secret(32))}
                    >
                      <RefreshCw size={14} className="btn-icon" />
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary small totp-secret-icon-btn"
                      disabled={totpLocked}
                      title={t('txt_copy_secret')}
                      aria-label={t('txt_copy_secret')}
                      onClick={() => {
                        void copyTextToClipboard(secret, { successMessage: t('txt_secret_copied') });
                      }}
                    >
                      <Clipboard size={14} className="btn-icon" />
                    </button>
                  </div>
                </div>
              </label>
              <label className="field">
                <span>{t('txt_verification_code')}</span>
                <input className="input" value={token} disabled={totpLocked} onInput={(e) => setToken((e.currentTarget as HTMLInputElement).value)} />
              </label>
              <div className="actions">
                {totpLocked ? (
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => {
                      closeTotpManageDialog();
                      props.onOpenDisableTotp();
                    }}
                  >
                    <ShieldOff size={14} className="btn-icon" />
                    {t('txt_disable_totp')}
                  </button>
                ) : (
                  <button type="button" className="btn btn-primary" disabled={!totpManagePassword} onClick={() => void enableTotpFromManageDialog()}>
                    <ShieldCheck size={14} className="btn-icon" />
                    {t('txt_enable_totp')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={recoveryCodeDialogOpen}
        title={`${t('txt_two_step_login')} ${t('txt_recovery_code')}`}
        message={t('txt_your_two_step_recovery_code')}
        hideConfirm
        closeButton
        cancelText={t('txt_close')}
        onConfirm={() => {}}
        onCancel={() => setRecoveryCodeDialogOpen(false)}
        afterActions={(
          <button
            type="button"
            className="btn btn-primary dialog-btn"
            disabled={!recoveryCode}
            onClick={() => {
              void copyTextToClipboard(recoveryCode, { successMessage: t('txt_recovery_code_copied') });
            }}
          >
            <Clipboard size={14} className="btn-icon" />
            {t('txt_copy_code')}
          </button>
        )}
      >
        <div className="two-step-recovery-code-dialog-value">{recoveryCode}</div>
      </ConfirmDialog>
      <ConfirmDialog
        open={createPasskeyDialogOpen}
        title={t('txt_add_account_passkey')}
        message={t('txt_name_account_passkey_after_verification')}
        confirmText={t('txt_save')}
        cancelText={t('txt_cancel')}
        confirmDisabled={masterPasswordPromptSubmitting}
        cancelDisabled={masterPasswordPromptSubmitting}
        onConfirm={() => void submitCreatePasskeyDialog()}
        onCancel={closeCreatePasskeyDialog}
      >
        <label className="field">
          <span>{t('txt_passkey_name')}</span>
          <input
            className="input"
            maxLength={128}
            value={accountPasskeyName}
            placeholder={t('txt_account_passkey_name_placeholder')}
            onInput={(e) => setAccountPasskeyName((e.currentTarget as HTMLInputElement).value)}
          />
          <div className="field-help">{t('txt_account_passkey_name_help')}</div>
        </label>
        <div className="field account-passkey-mode-field">
          <span>{t('txt_account_passkey_mode')}</span>
          <label className="account-passkey-toggle">
            <input
              type="checkbox"
              checked={accountPasskeyDirectUnlock}
              onInput={(e) => setAccountPasskeyDirectUnlock((e.currentTarget as HTMLInputElement).checked)}
            />
            <span>{t('txt_account_passkey_direct_unlock_mode')}</span>
          </label>
          <div className="field-help">
            {accountPasskeyDirectUnlock ? t('txt_account_passkey_direct_unlock_help') : t('txt_account_passkey_login_only_help')}
          </div>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={apiKeyDialogOpen}
        title={t('txt_api_key')}
        message={t('txt_api_key_dialog_intro')}
        hideCancel
        confirmText={t('txt_close')}
        onConfirm={() => setApiKeyDialogOpen(false)}
        onCancel={() => setApiKeyDialogOpen(false)}
      >
        <div className="api-key-warning-panel">
          <div className="api-key-warning-title">{t('txt_warning')}</div>
          <div className="api-key-warning-body">{t('txt_api_key_warning_body')}</div>
        </div>

        <div className="api-key-credentials-panel">
          <div className="api-key-credentials-title">
            <KeyRound size={15} />
            <span>{t('txt_oauth_client_credentials')}</span>
          </div>
          {([
            [t('txt_client_id'), `user.${props.profile.id}`],
            [t('txt_client_secret'), apiKey],
            [t('txt_scope'), 'api'],
            [t('txt_grant_type'), 'client_credentials'],
          ] as [string, string][]).map(([label, value]) => (
            <label key={label} className="field">
              <span>{label}</span>
              <div className="api-key-credential-row">
                <input className="input" readOnly value={value} onFocus={(e) => (e.currentTarget as HTMLInputElement).select()} />
                <button
                  type="button"
                  className="btn btn-secondary small"
                  onClick={() => void copyTextToClipboard(value, { successMessage: t('txt_copied') })}
                >
                  <Clipboard size={14} className="btn-icon" />
                  {t('txt_copy')}
                </button>
              </div>
            </label>
          ))}
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={rotateApiKeyConfirmOpen}
        title={t('txt_rotate_api_key')}
        message={t('txt_rotate_api_key_confirm')}
        danger
        onConfirm={() => {
          setRotateApiKeyConfirmOpen(false);
          openMasterPasswordPrompt('rotateApiKey');
        }}
        onCancel={() => setRotateApiKeyConfirmOpen(false)}
      />
    </div>
  );
}
