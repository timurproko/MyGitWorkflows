import { createSign } from "node:crypto";
import { archiveFailure } from "./openspec-archive-policy.mjs";
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");

export async function createArchivePublisher({ repository, appId, privateKey, fetchImpl = fetch, deadline = Infinity }) {
  if (!/^\d+$/.test(appId ?? "") || !privateKey) throw archiveFailure("publication-app-setup");
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) throw archiveFailure("repository-identity");
  const issued = Math.floor(Date.now() / 1000) - 30;
  const message = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: issued, exp: issued + 540, iss: appId })}`;
  let jwt;
  try { jwt = `${message}.${createSign("RSA-SHA256").update(message).sign(privateKey, "base64url")}`; }
  catch { throw archiveFailure("publication-app-key"); }
  async function request(path, method, body, token) {
    const remaining = method === "DELETE" ? 20_000 : deadline - Date.now();
    if (remaining <= 0) throw archiveFailure("archive-deadline");
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${path}`, { method, redirect: "error", signal: AbortSignal.timeout(Math.min(20_000, remaining)),
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw archiveFailure("publication-unavailable"); }
    if (!response.ok) throw archiveFailure("publication-request", String(response.status));
    if (response.status === 204) return null;
    return await response.json();
  }
  const app = await request("/app", "GET", undefined, jwt);
  const installation = await request(`/repos/${repository}/installation`, "GET", undefined, jwt);
  if (String(app.id) !== appId || installation.app_id !== app.id || !Number.isSafeInteger(installation.id)
    || !/^[a-z0-9-]+$/.test(app.slug)) throw archiveFailure("publication-app-identity");
  const access = await request(`/app/installations/${installation.id}/access_tokens`, "POST", {
    repositories: [repository.split("/")[1]], permissions: { contents: "write", pull_requests: "write" },
  }, jwt);
  let bot;
  try {
    if (typeof access.token !== "string" || access.permissions?.contents !== "write" || access.permissions?.pull_requests !== "write"
      || Object.keys(access.permissions).some(key => !["contents", "pull_requests", "metadata"].includes(key))) {
      throw archiveFailure("publication-app-permissions");
    }
    bot = await request(`/users/${app.slug}[bot]`, "GET", undefined, access.token);
    if (!Number.isSafeInteger(bot.id) || bot.id < 1 || bot.login !== `${app.slug}[bot]` || bot.type !== "Bot") throw archiveFailure("publication-app-identity");
  } catch (error) {
    if (typeof access.token === "string") {
      try { await request("/installation/token", "DELETE", undefined, access.token); }
      catch { /* Security: expiry remains the final bound when revocation is unavailable. */ }
    }
    throw error;
  }
  const prefix = `/repos/${repository}`;
  return {
    repository, deadline, actor: bot.login, actorEmail: `${bot.id}+${bot.login}@users.noreply.github.com`, token: access.token,
    async mutate(path, method, body) {
      const route = path.slice(prefix.length);
      if (!path.startsWith(`${prefix}/`) || !(
        method === "POST" && (/^\/pulls$/.test(route) || /^\/issues\/\d+\/comments$/.test(route)
          || /^\/git\/(trees|commits)$/.test(route)
          || route === "/git/refs" && /^refs\/heads\/docs\/accept-[a-z0-9-]+-\d+$/.test(body?.ref ?? ""))
        || method === "PATCH" && (/^\/pulls\/\d+$/.test(route) || /^\/issues\/comments\/\d+$/.test(route)))) {
        throw archiveFailure("publication-route");
      }
      return await request(path, method, body, access.token);
    },
    async ready(number, nodeId) {
      if (!Number.isSafeInteger(number) || number < 1 || typeof nodeId !== "string" || !nodeId) throw archiveFailure("acceptance-pr-identity");
      const result = await request("/graphql", "POST", {
        query: "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { number } } }",
        variables: { id: nodeId },
      }, access.token);
      if (result.errors || result.data?.markPullRequestReadyForReview?.pullRequest?.number !== number) throw archiveFailure("pull-request-ready-failed");
    },
    async close() { await request("/installation/token", "DELETE", undefined, access.token); },
  };
}
