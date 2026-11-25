/**
 * api.ts — the bearer token and the REST calls. A 401 drops the token and is reported
 * through onUnauthorized (the shell shows the token screen).
 */

import type { ApiErrorResponse } from './types.ts';

const STORAGE_TOKEN = 'herdr_token';

let token: string | null = null;
let unauthorized: () => void = () => {};

/** The token from ?token= (stored, and stripped from the URL without a reload), else the stored one. */
export function loadToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  if (urlToken) {
    localStorage.setItem(STORAGE_TOKEN, urlToken);
    params.delete('token');
    const newSearch = params.toString();
    const newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash;
    history.replaceState(null, '', newUrl);
    token = urlToken;
  } else {
    token = localStorage.getItem(STORAGE_TOKEN);
  }
  return token;
}

export const getToken = (): string | null => token;

export function setToken(t: string): void {
  token = t;
  localStorage.setItem(STORAGE_TOKEN, t);
}

export function clearToken(): void {
  localStorage.removeItem(STORAGE_TOKEN);
  token = null;
}

/** Called after a 401 has cleared the token. */
export function onUnauthorized(fn: () => void): void {
  unauthorized = fn;
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...((options.headers ?? {}) as Record<string, string>),
  };
  const resp = await fetch(path, { ...options, headers });
  if (resp.status === 401) {
    clearToken();
    unauthorized();
    throw new Error('401');
  }
  return resp;
}

// A failed request's body: the bridge's error envelope (types.ts, checked against its
// recordings), or whatever came back instead ({} when it wasn't JSON).
type ErrorBody = Partial<ApiErrorResponse> | null;

// T: the response type the caller reads (types.ts's REST responses), unchecked at runtime.
export async function apiGet<T = unknown>(path: string): Promise<T> {
  const resp = await apiFetch(path);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as ErrorBody;
    throw new Error(body?.error?.message ?? `HTTP ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

export function apiError(data: ErrorBody, status: number): Error & { code?: string; status?: number } {
  const e = new Error(data?.error?.message ?? `HTTP ${status}`) as Error & { code?: string; status?: number };
  e.code = data?.error?.code; // e.g. 'prompt_changed'/'no_profile' — lets callers branch on the reason
  e.status = status;
  return e;
}

export async function apiPost<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const resp = await apiFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw apiError(await resp.json().catch(() => ({})) as ErrorBody, resp.status);
  return resp.json() as Promise<T>;
}

export async function apiDelete(path: string): Promise<unknown> {
  const resp = await apiFetch(path, { method: 'DELETE' });
  if (!resp.ok) throw apiError(await resp.json().catch(() => ({})) as ErrorBody, resp.status);
  return resp.json();
}
