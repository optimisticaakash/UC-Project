/**
 * Shared API URL normalization and endpoint construction helpers.
 */

/**
 * Normalizes a base API URL by trimming whitespace and removing trailing slashes.
 * Returns an empty string for non-string or falsy values.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
export function normalizeApiUrl(rawUrl) {
  if (typeof rawUrl !== "string") return "";
  return rawUrl.trim().replace(/\/+$/, "");
}

/**
 * Safely joins a base API URL and an endpoint path without duplicate slashes.
 *
 * @param {string} baseUrl
 * @param {string} endpoint
 * @returns {string}
 */
export function buildApiUrl(baseUrl, endpoint = "") {
  const base = normalizeApiUrl(baseUrl);
  const path = typeof endpoint === "string" ? endpoint.trim() : "";
  if (!base) {
    if (!path) return "";
    return path.startsWith("/") ? path : `/${path}`;
  }
  if (!path) return base;
  const cleanPath = path.replace(/^\/+/, "");
  return `${base}/${cleanPath}`;
}

