/**
 * hope/reflected/segmentation.ts — dedicated, isolated container paths for Reflected Hopes.
 *
 * A Reflected Hope is a per-user mirror that MUST live in its own storage namespace and can
 * never share a path with the Core Hope or Prime Hope stores. This module derives the
 * deterministic container path for a reflected id and hard-asserts that path can never
 * collide with the core/prime roots (which would be a contamination breach).
 */

/** Storage root of the authoritative Core Hope store. Reflected Hopes may NEVER write here. */
export const CORE_HOPE_ROOT = 'hope/core';
/** Storage root of the Prime Hope store. Reflected Hopes may NEVER write here. */
export const PRIME_HOPE_ROOT = 'hope/prime';
/** Storage root reserved exclusively for isolated Reflected Hope containers. */
export const REFLECTED_ROOT = 'hope/reflected/containers';

/** A reflected id is a safe slug: lowercase alphanumerics, dash and underscore only. */
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/**
 * Derive a stable, filesystem-safe reflected id for a userId. Deterministic: the same userId
 * always maps to the same reflected id, and different userIds never collide (a short FNV-1a
 * hash disambiguates ids that slugify to the same thing).
 */
export function reflectedId(userId: string): string {
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    throw new Error('reflectedId: userId must be a non-empty string');
  }
  const slug = userId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  const digest = fnv1a(userId).toString(16).padStart(8, '0');
  const base = slug.length > 0 ? slug : 'user';
  return `${base}-${digest}`;
}

/** The dedicated container path for a reflected id (always under REFLECTED_ROOT). */
export function containerPath(reflectedId: string): string {
  if (!SAFE_ID.test(reflectedId)) {
    throw new Error(`containerPath: unsafe reflected id "${reflectedId}"`);
  }
  return `${REFLECTED_ROOT}/${reflectedId}`;
}

/** True only for paths inside the reserved reflected container root. */
export function isReflectedPath(path: string): boolean {
  return path === REFLECTED_ROOT || path.startsWith(`${REFLECTED_ROOT}/`);
}

/** True for any path that belongs to the Core Hope or Prime Hope stores. */
export function isCoreOrPrimePath(path: string): boolean {
  return (
    path === CORE_HOPE_ROOT ||
    path.startsWith(`${CORE_HOPE_ROOT}/`) ||
    path === PRIME_HOPE_ROOT ||
    path.startsWith(`${PRIME_HOPE_ROOT}/`)
  );
}

/**
 * Hard isolation guard. Throws unless the reflected id resolves to a dedicated container path
 * that is strictly inside REFLECTED_ROOT and provably outside the core/prime roots. Call this
 * before any read/write on a reflected container.
 */
export function assertIsolation(reflectedId: string): string {
  const path = containerPath(reflectedId);
  if (!isReflectedPath(path) || isCoreOrPrimePath(path)) {
    throw new Error(
      `assertIsolation: reflected container "${path}" is not isolated from Core/Prime Hope`,
    );
  }
  return path;
}

/** 32-bit FNV-1a hash (unsigned). */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
