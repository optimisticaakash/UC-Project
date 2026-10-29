import { normalizeApiUrl, buildApiUrl } from "../utils/apiUrl.js";

const defaultDevApiUrl =
  typeof window !== "undefined" && window.location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:5001"
    : "http://localhost:5001";

const rawApiUrl =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_URL) ||
  (typeof import.meta !== "undefined" && import.meta.env?.DEV
    ? defaultDevApiUrl
    : "https://uc-project-o71w.onrender.com");

export const API_URL =
  normalizeApiUrl(rawApiUrl) || "https://uc-project-o71w.onrender.com";

export { normalizeApiUrl, buildApiUrl };

export const MODEL = "gemini-3.8-live";

export const BACKEND_WAIT_ANNOUNCEMENT_MS = Math.max(
  500,
  Number(
    (typeof import.meta !== "undefined" &&
      import.meta.env?.VITE_BACKEND_WAIT_ANNOUNCEMENT_MS) ||
      1400,
  ),
);

