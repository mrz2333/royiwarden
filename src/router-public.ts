import { LIMITS } from './config/limits';
import { DEFAULT_DEV_SECRET } from './types';
import {
  handleAccessSend,
  handleAccessSendFile,
  handleAccessSendV2,
  handleAccessSendFileV2,
  handleDownloadSendFile,
} from './handlers/sends';
import { handleSetupStatus } from './handlers/setup';
import { handleKnownDevice } from './handlers/devices';
import { handleToken, handlePrelogin, handleRevocation } from './handlers/identity';
import {
  handleRegister,
  handleRecoverTwoFactor,
} from './handlers/accounts';
import { handlePublicDownloadAttachment } from './handlers/attachments';
import {
  handleNotificationsHub,
  handleNotificationsNegotiate,
} from './handlers/notifications';
import { jsonResponse } from './utils/response';
import type { Env } from './types';

type PublicRateLimiter = (category?: string, maxRequests?: number) => Promise<Response | null>;

function isSameOriginWriteRequest(request: Request): boolean {
  const targetOrigin = new URL(request.url).origin;
  const origin = request.headers.get('Origin');
  if (origin) {
    return origin === targetOrigin;
  }

  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      return new URL(referer).origin === targetOrigin;
    } catch {
      return false;
    }
  }

  return false;
}

function getNwIconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" role="img" aria-label="NW icon"><rect x="4" y="4" width="88" height="88" rx="20" fill="#111418"/><text x="48" y="60" text-anchor="middle" font-size="36" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-weight="800" letter-spacing="0.5" fill="#FFFFFF">NW</text></svg>`;
}

function handleNwFavicon(): Response {
  return new Response(getNwIconSvg(), {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': `public, max-age=${LIMITS.cache.iconTtlSeconds}`,
    },
  });
}

function isValidIconHostname(hostname: string): boolean {
  if (!hostname) return false;
  if (hostname.length > 253) return false;

  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;
  const ipv4Pattern = /^(?:\d{1,3}\.){3}\d{1,3}$/;

  if (domainPattern.test(normalized)) return true;
  if (!ipv4Pattern.test(normalized)) return false;

  const parts = normalized.split('.');
  return parts.every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

async function handleGetIcon(env: Env, hostname: string): Promise<Response> {
  try {
    void env;
    const normalizedHostname = hostname.toLowerCase();
    if (!isValidIconHostname(normalizedHostname)) {
      return new Response(null, { status: 204 });
    }

    const cache = caches.default;
    const cacheKey = new Request(`https://nodewarden-icons.local/icons/${normalizedHostname}/icon.png`, { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const resp = await fetch(`https://favicon.im/${normalizedHostname}`, {
      headers: { 'User-Agent': 'NodeWarden/1.0' },
      redirect: 'follow',
      cf: {
        cacheEverything: true,
        cacheTtl: LIMITS.cache.iconTtlSeconds,
      },
    });

    if (!resp.ok) return new Response(null, { status: 204 });

    const body = await resp.arrayBuffer();
    if (body.byteLength === 0) {
      return new Response(null, { status: 204 });
    }

    const iconResponse = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'image/png',
        'Cache-Control': `public, max-age=${LIMITS.cache.iconTtlSeconds}`,
      },
    });
    await cache.put(cacheKey, iconResponse.clone());
    return iconResponse;
  } catch {
    return new Response(null, { status: 204 });
  }
}

export function buildWebConfigResponse(env: Env) {
  const secret = (env.JWT_SECRET || '').trim();
  const jwtUnsafeReason =
    !secret
      ? 'missing'
      : secret === DEFAULT_DEV_SECRET
        ? 'default'
        : secret.length < LIMITS.auth.jwtSecretMinLength
          ? 'too_short'
          : null;

  return {
    defaultKdfIterations: LIMITS.auth.defaultKdfIterations,
    jwtUnsafeReason,
    jwtSecretMinLength: LIMITS.auth.jwtSecretMinLength,
  };
}

export async function handlePublicRoute(
  request: Request,
  env: Env,
  path: string,
  method: string,
  enforcePublicRateLimit: PublicRateLimiter
): Promise<Response | null> {
  if (path === '/setup/status' && method === 'GET') {
    const blocked = await enforcePublicRateLimit('public-read', LIMITS.rateLimit.publicReadRequestsPerMinute);
    if (blocked) return blocked;
    return handleSetupStatus(request, env);
  }

  if (path === '/api/web/config' && method === 'GET') {
    const blocked = await enforcePublicRateLimit('public-read', LIMITS.rateLimit.publicReadRequestsPerMinute);
    if (blocked) return blocked;
    return jsonResponse(buildWebConfigResponse(env));
  }

  if (path === '/.well-known/appspecific/com.chrome.devtools.json' && method === 'GET') {
    return new Response('{}', {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  if ((path === '/favicon.ico' || path === '/favicon.svg') && method === 'GET') {
    return handleNwFavicon();
  }

  const iconMatch = path.match(/^\/icons\/([^/]+)\/icon\.png$/i);
  if (iconMatch) {
    return handleGetIcon(env, iconMatch[1]);
  }

  const publicAttachmentMatch = path.match(/^\/api\/attachments\/([a-f0-9-]+)\/([a-f0-9-]+)$/i);
  if (publicAttachmentMatch && method === 'GET') {
    return handlePublicDownloadAttachment(request, env, publicAttachmentMatch[1], publicAttachmentMatch[2]);
  }

  const sendAccessMatch = path.match(/^\/api\/sends\/access\/([^/]+)$/i);
  if (sendAccessMatch && method === 'POST') {
    const blocked = await enforcePublicRateLimit();
    if (blocked) return blocked;
    return handleAccessSend(request, env, sendAccessMatch[1]);
  }

  if (path === '/api/sends/access' && method === 'POST') {
    const blocked = await enforcePublicRateLimit();
    if (blocked) return blocked;
    return handleAccessSendV2(request, env);
  }

  const sendAccessFileV2Match = path.match(/^\/api\/sends\/access\/file\/([^/]+)\/?$/i);
  if (sendAccessFileV2Match && method === 'POST') {
    const blocked = await enforcePublicRateLimit();
    if (blocked) return blocked;
    return handleAccessSendFileV2(request, env, sendAccessFileV2Match[1]);
  }

  const sendAccessFileMatch = path.match(/^\/api\/sends\/([^/]+)\/access\/file\/([^/]+)\/?$/i);
  if (sendAccessFileMatch && method === 'POST') {
    const blocked = await enforcePublicRateLimit();
    if (blocked) return blocked;
    return handleAccessSendFile(request, env, sendAccessFileMatch[1], sendAccessFileMatch[2]);
  }

  const sendDownloadMatch = path.match(/^\/api\/sends\/([^/]+)\/([^/]+)\/?$/i);
  if (sendDownloadMatch && method === 'GET') {
    return handleDownloadSendFile(request, env, sendDownloadMatch[1], sendDownloadMatch[2]);
  }

  if (path === '/identity/connect/token' && method === 'POST') {
    return handleToken(request, env);
  }

  if (path === '/api/devices/knowndevice' && method === 'GET') {
    const blocked = await enforcePublicRateLimit();
    if (blocked) return jsonResponse(false);
    return handleKnownDevice(request, env);
  }

  if ((path === '/identity/connect/revocation' || path === '/identity/connect/revoke') && method === 'POST') {
    const blocked = await enforcePublicRateLimit('public-sensitive', LIMITS.rateLimit.sensitivePublicRequestsPerMinute);
    if (blocked) return blocked;
    return handleRevocation(request, env);
  }

  if (path === '/identity/accounts/prelogin' && method === 'POST') {
    const blocked = await enforcePublicRateLimit('public-sensitive', LIMITS.rateLimit.sensitivePublicRequestsPerMinute);
    if (blocked) return blocked;
    return handlePrelogin(request, env);
  }

  if ((path === '/identity/accounts/recover-2fa' || path === '/api/accounts/recover-2fa') && method === 'POST') {
    return handleRecoverTwoFactor(request, env);
  }

  if ((path === '/config' || path === '/api/config') && method === 'GET') {
    const blocked = await enforcePublicRateLimit('public-read', LIMITS.rateLimit.publicReadRequestsPerMinute);
    if (blocked) return blocked;
    const origin = new URL(request.url).origin;
    return jsonResponse({
      version: LIMITS.compatibility.bitwardenServerVersion,
      gitHash: 'nodewarden',
      server: null,
      environment: {
        vault: origin,
        api: origin + '/api',
        identity: origin + '/identity',
        notifications: origin + '/notifications',
        sso: '',
      },
      featureStates: {
        'duo-redirect': true,
        'email-verification': true,
        'pm-19051-send-email-verification': false,
        'unauth-ui-refresh': true,
      },
      object: 'config',
    });
  }

  if (path === '/api/version' && method === 'GET') {
    const blocked = await enforcePublicRateLimit('public-read', LIMITS.rateLimit.publicReadRequestsPerMinute);
    if (blocked) return blocked;
    return jsonResponse(LIMITS.compatibility.bitwardenServerVersion);
  }

  if (path === '/api/accounts/register' && method === 'POST') {
    const blocked = await enforcePublicRateLimit('register', LIMITS.rateLimit.registerRequestsPerMinute);
    if (blocked) return blocked;
    if (!isSameOriginWriteRequest(request)) {
      return new Response(JSON.stringify({ error: 'Forbidden origin' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return handleRegister(request, env);
  }

  if (path === '/notifications/hub/negotiate' && method === 'POST') {
    return handleNotificationsNegotiate(request, env);
  }

  if (path === '/notifications/hub' && method === 'GET') {
    return handleNotificationsHub(request, env);
  }
  return null;
}
