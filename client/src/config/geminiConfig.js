export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5001";
export const MODEL = "gemini-3.8-live";
export const BACKEND_WAIT_ANNOUNCEMENT_MS = Math.max(
  500,
  Number(import.meta.env.VITE_BACKEND_WAIT_ANNOUNCEMENT_MS) || 1400,
);
