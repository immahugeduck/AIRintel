import { useEffect, useRef, useState } from "react";
import { loadEvidenceImage, uploadEvidenceImage, type EvidenceBlob } from "../api/evidence";
import "./evidence-upload.css";

export function EvidenceUploadPanel() {
  const inputFileRef = useRef<HTMLInputElement>(null);
  const [blob, setBlob] = useState<EvidenceBlob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "uploading" | "opening">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const file = inputFileRef.current?.files?.[0];
    if (!file) return;

    setError(null);
    setStatus("uploading");
    try {
      const uploaded = await uploadEvidenceImage(file);
      setBlob(uploaded);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      if (inputFileRef.current) inputFileRef.current.value = "";
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Evidence upload failed.");
    } finally {
      setStatus("idle");
    }
  };

  const openBlob = async () => {
    if (!blob) return;
    setError(null);
    setStatus("opening");
    try {
      if (blob.access === "public") {
        window.open(blob.url, "_blank", "noopener,noreferrer");
        return;
      }
      const file = await loadEvidenceImage(blob.pathname);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const nextUrl = URL.createObjectURL(file);
      setPreviewUrl(nextUrl);
      window.open(nextUrl, "_blank", "noopener,noreferrer");
    } catch (viewError) {
      setError(viewError instanceof Error ? viewError.message : "Evidence file could not be opened.");
    } finally {
      setStatus("idle");
    }
  };

  return (
    <section className="evidence-upload section-panel" aria-labelledby="evidence-upload-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Vercel Blob</p>
          <h2 id="evidence-upload-heading">Evidence image upload</h2>
        </div>
        <span className="status-chip ready">Private-ready</span>
      </div>

      <div className="evidence-upload-body">
        <p>
          Add aircraft screenshots or supporting images to the connected Blob store.
          Uploads require your AIRIntel sign-in and use the existing history access grant.
        </p>

        <form onSubmit={handleSubmit}>
          <label htmlFor="evidence-file">Image file</label>
          <input
            id="evidence-file"
            name="file"
            ref={inputFileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            required
          />
          <small>JPEG, PNG, or WebP. Maximum 4 MB per upload in this server-upload version.</small>
          <button type="submit" disabled={status !== "idle"}>
            {status === "uploading" ? "Uploading…" : "Upload evidence"}
          </button>
        </form>

        {blob && (
          <div className="evidence-upload-result" aria-live="polite">
            <div>
              <strong>Upload complete</strong>
              <span>{blob.pathname}</span>
            </div>
            <button type="button" className="ghost-button" onClick={() => void openBlob()} disabled={status !== "idle"}>
              {status === "opening" ? "Opening…" : "View file"}
            </button>
          </div>
        )}

        {error && <p className="evidence-upload-error" role="alert">{error}</p>}
      </div>
    </section>
  );
}
