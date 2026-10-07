import { getAccessToken, getAuthClient } from "../lib/auth";
import { AuthenticationRequiredError, ProviderNotConfiguredError } from "../providers/contracts";

export type EvidenceBlob = {
  pathname: string;
  url: string;
  downloadUrl: string;
  contentType: string;
  access: "private" | "public";
};

async function authHeaders() {
  if (!getAuthClient()) throw new ProviderNotConfiguredError();
  const token = await getAccessToken();
  if (!token) throw new AuthenticationRequiredError();
  return { Authorization: `Bearer ${token}` };
}

export async function uploadEvidenceImage(file: File, signal?: AbortSignal): Promise<EvidenceBlob> {
  const headers = await authHeaders();
  const url = new URL("/api/evidence/upload", window.location.origin);
  url.searchParams.set("filename", file.name);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string; maxBytes?: number } | null;
    if (response.status === 413 && payload?.maxBytes) {
      throw new Error(`Image is too large. Maximum upload size is ${Math.floor(payload.maxBytes / 1024 / 1024)} MB.`);
    }
    throw new Error(payload?.error ? `Evidence upload failed: ${payload.error}` : `Evidence upload failed with status ${response.status}`);
  }

  return response.json() as Promise<EvidenceBlob>;
}

export async function loadEvidenceImage(pathname: string, signal?: AbortSignal) {
  const headers = await authHeaders();
  const url = new URL("/api/evidence/view", window.location.origin);
  url.searchParams.set("pathname", pathname);
  const response = await fetch(url, { headers, ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`Evidence file could not be opened (${response.status})`);
  return response.blob();
}
