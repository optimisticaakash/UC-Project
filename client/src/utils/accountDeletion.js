export function getAdminDeletionConfirmation(admin, currentAdminId) {
  if (!admin?.adminId || admin.adminId === currentAdminId || !admin.active) return null;
  return `Delete admin account for ${admin.name} (${admin.loginIdentifier})? Its existing sessions will be invalidated. This action cannot be undone.`;
}

export function getCandidateDeactivationConfirmation(candidate) {
  if (!candidate?.candidateId || !candidate.active) return null;
  return `Deactivate ${candidate.name} (${candidate.loginIdentifier})? They will no longer be able to sign in. Interview history, reports, and PDFs will be preserved.`;
}

export function getCandidateDeletionConfirmation(candidate) {
  if (!candidate?.candidateId || candidate.deletedAt) return null;
  return `Remove the sign-in account for ${candidate.name} (${candidate.loginIdentifier})? The account will be marked deleted and existing sessions revoked. Interview history, reports, and PDFs will be retained and will not be deleted.`;
}

export function getCandidateStatusAction(candidate) {
  if (candidate?.deletedAt) return "removed";
  return candidate?.active ? "deactivate" : "activate";
}

export function getReportDeletionConfirmation(session) {
  if (!session?.sessionId) return null;
  const candidate = session.candidateName ? `for ${session.candidateName}` : "";
  return `Delete interview report ${candidate} (Session ID: ${session.sessionId})? This report and its recorded answers will be permanently deleted. This action cannot be undone.`.replace(/\s+/g, " ");
}
