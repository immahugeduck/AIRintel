/**
 * Short identifier of the code that is running: the Vercel git commit, a Cloud Run revision, or GIT_COMMIT_SHA.
 * Reported on /health and in sweep summaries so a sweep caller pointed at an old or different deployment shows up.
 * Commit ids and revision names are not secrets.
 */
export function buildId(env: Record<string, string | undefined> = process.env): string | null {
  const commit = env.VERCEL_GIT_COMMIT_SHA?.trim() || env.GIT_COMMIT_SHA?.trim();
  if (commit) return commit.slice(0, 7);
  const revision = env.K_REVISION?.trim();
  return revision ? revision.slice(0, 64) : null;
}
