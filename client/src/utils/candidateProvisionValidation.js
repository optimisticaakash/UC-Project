export const EMAIL_GUIDANCE = "Enter a valid email address of 160 characters or fewer.";

export function normalizeCandidateLoginIdentifier(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isValidCandidateEmail(value) {
  return typeof value === "string" && value.length <= 160 &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(value);
}

export function isValidLegacyCandidateIdentifier(value) {
  return typeof value === "string" && /^[a-z0-9._+-]{3,80}$/u.test(value);
}

export function validateCandidateProvision({ name, loginIdentifier, password }) {
  const normalizedName = typeof name === "string" ? name.trim() : "";
  const identifier = normalizeCandidateLoginIdentifier(loginIdentifier);
  if (!normalizedName) return { field: "name", message: "Enter the candidate’s name." };
  if (normalizedName.length > 160) return { field: "name", message: "Candidate name must be 160 characters or fewer." };
  if (!identifier) return { field: "email", message: "Enter the candidate’s email address." };
  if (!isValidCandidateEmail(identifier)) return { field: "email", message: EMAIL_GUIDANCE };
  if (typeof password !== "string" || !password.length) return { field: "password", message: "Enter an initial password." };
  if (password.length < 8) return { field: "password", message: "Initial password must be at least 8 characters." };
  if (password.length > 1024) return { field: "password", message: "Initial password must be 1,024 characters or fewer." };
  return null;
}
