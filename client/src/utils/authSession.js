export async function loadAdminSession(apiUrl, fetchImpl = fetch) {
  const response = await fetchImpl(`${apiUrl}/api/admin/me`, {
    credentials: "include",
  });

  if (response.status === 401) return { status: "signed_out" };
  if (!response.ok) throw new Error("Could not verify the admin session.");

  const data = await response.json();
  if (data?.success && data.user?.role === "admin") {
    return { status: "authenticated", role: "admin" };
  }
  return { status: "signed_out" };
}

export async function logoutAdmin(apiUrl, fetchImpl = fetch) {
  const response = await fetchImpl(`${apiUrl}/api/admin/logout`, {
    method: "POST",
    credentials: "include",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success) {
    throw new Error("Admin sign out failed. Please try again.");
  }
  return true;
}

export async function loadCandidateSession(apiUrl, fetchImpl = fetch) {
  const response = await fetchImpl(`${apiUrl}/api/candidate/me`, {
    credentials: "include",
  });
  if (response.status === 401) return { status: "signed_out" };
  if (!response.ok) throw new Error("Could not verify the candidate session.");
  const data = await response.json();
  if (data?.success && data.user?.role === "candidate") {
    return {
      status: "authenticated",
      role: "candidate",
      candidateId: data.user.candidateId,
      name: data.user.name,
      loginIdentifier: data.user.loginIdentifier,
    };
  }
  return { status: "signed_out" };
}

export async function loadAuthSession(apiUrl, fetchImpl = fetch) {
  const adminResponse = await fetchImpl(`${apiUrl}/api/admin/me`, { credentials: "include" });
  if (adminResponse.ok) {
    const data = await adminResponse.json();
    if (data?.success && data.user?.role === "admin") {
      return { status: "authenticated", role: "admin" };
    }
  } else if (adminResponse.status !== 401) {
    throw new Error("Could not verify the Admin session.");
  }
  return loadCandidateSession(apiUrl, fetchImpl);
}

export async function loginCandidate(apiUrl, loginIdentifier, password, fetchImpl = fetch) {
  const response = await fetchImpl(`${apiUrl}/api/candidate/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginIdentifier, password }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success || data.user?.role !== "candidate") {
    throw new Error(data?.message || "Candidate sign-in failed.");
  }
  return data.user;
}

export async function logoutCandidate(apiUrl, fetchImpl = fetch) {
  const response = await fetchImpl(`${apiUrl}/api/candidate/logout`, {
    method: "POST",
    credentials: "include",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success) throw new Error("Candidate sign out failed. Please try again.");
  return true;
}
