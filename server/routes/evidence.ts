import { get, put } from "@vercel/blob";
import { Hono } from "hono";
import type { AppVariables } from "../http.js";

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const allowedContentTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

type BlobAccess = "private" | "public";

function blobAccess(): BlobAccess {
  return process.env.BLOB_ACCESS === "public" ? "public" : "private";
}

function safeFilename(value: string) {
  // Hono query parameters are already decoded. Decoding twice rejects filenames containing a literal percent sign.
  const decoded = value.trim();
  const basename = decoded.split(/[\\/]/).pop() ?? "";
  const safe = basename.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.slice(0, 120);
}

/**
 * Authenticated evidence-image storage backed by Vercel Blob.
 *
 * Server uploads intentionally cap files below Vercel Function's request-body
 * limit. If AIRIntel later needs videos or large evidence files, migrate this
 * route to @vercel/blob/client direct uploads rather than increasing this cap.
 */
export function evidenceRoutes() {
  const app = new Hono<{ Variables: AppVariables }>();

  app.post("/upload", async (c) => {
    const filenameParam = c.req.query("filename");
    if (!filenameParam) return c.json({ error: "filename_required" }, 400);

    const filename = safeFilename(filenameParam);
    if (!filename) return c.json({ error: "invalid_filename" }, 400);

    const contentType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!allowedContentTypes.has(contentType)) {
      return c.json({ error: "unsupported_media_type", allowed: [...allowedContentTypes] }, 415);
    }

    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
      return c.json({ error: "file_too_large", maxBytes: MAX_UPLOAD_BYTES }, 413);
    }

    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0) return c.json({ error: "empty_file" }, 400);
    if (body.byteLength > MAX_UPLOAD_BYTES) {
      return c.json({ error: "file_too_large", maxBytes: MAX_UPLOAD_BYTES }, 413);
    }

    const access = blobAccess();
    try {
      const blob = await put(`airintel/evidence/${filename}`, body, {
        access,
        addRandomSuffix: true,
        contentType,
      });

      return c.json({
        pathname: blob.pathname,
        url: blob.url,
        downloadUrl: blob.downloadUrl,
        contentType: blob.contentType,
        access,
      }, 201);
    } catch (error) {
      console.error("Vercel Blob upload failed", error);
      return c.json({ error: "blob_upload_failed" }, 502);
    }
  });

  app.get("/view", async (c) => {
    const pathname = c.req.query("pathname")?.trim();
    if (!pathname || !pathname.startsWith("airintel/evidence/")) {
      return c.json({ error: "invalid_pathname" }, 400);
    }

    try {
      const result = await get(pathname, { access: blobAccess() });
      if (!result || result.statusCode !== 200 || !result.stream) {
        return c.json({ error: "blob_not_found" }, 404);
      }

      return new Response(result.stream, {
        status: 200,
        headers: {
          "Content-Type": result.blob.contentType || "application/octet-stream",
          "Content-Disposition": result.blob.contentDisposition || "inline",
          "Cache-Control": "private, max-age=60",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      console.error("Vercel Blob read failed", error);
      return c.json({ error: "blob_read_failed" }, 502);
    }
  });

  return app;
}
