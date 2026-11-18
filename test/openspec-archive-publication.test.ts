import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createArchivePublisher } from "../scripts/openspec-archive-publication.mjs";

describe("event-triggering App publication", () => {
  it("does not fall back to a workflow token when setup is missing", async () => {
    await expect(createArchivePublisher({ repository: "owner/repo" })).rejects.toThrow("publication-app-setup");
  });

  it("limits token permissions and mutation routes and revokes the installation token", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const requests: { path: string; method: string; body: string }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      requests.push({ path, method: init?.method ?? "GET", body: String(init?.body ?? "") });
      const value = path === "/app" ? { id: 42, slug: "archive-app" }
        : path.startsWith("/users/") ? { id: 1234, login: "archive-app[bot]", type: "Bot" }
        : path.endsWith("/installation") ? { id: 90, app_id: 42 }
        : path.endsWith("/access_tokens") ? { token: "short-lived-token", permissions: { contents: "write", pull_requests: "write" } }
        : path === "/graphql" ? { data: { markPullRequestReadyForReview: { pullRequest: { number: 50 } } } }
        : { number: 50 };
      return path === "/installation/token" ? new Response(null, { status: 204 }) : Response.json(value);
    };
    const publisher = await createArchivePublisher({ repository: "owner/repo", appId: "42",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), fetchImpl });
    await expect(publisher.mutate("/repos/owner/repo/pulls/50/merge", "PUT", {})).rejects.toThrow("publication-route");
    await expect(publisher.mutate("/repos/owner/repo/git/refs/heads/docs/accept-example-20", "PATCH", {})).rejects.toThrow("publication-route");
    await expect(publisher.mutate("/repos/owner/repo/git/refs", "POST", { ref: "refs/heads/docs/archive-example", sha: "a".repeat(40) })).rejects.toThrow("publication-route");
    await publisher.mutate("/repos/owner/repo/git/trees", "POST", { tree: [] });
    await publisher.mutate("/repos/owner/repo/git/commits", "POST", { message: "owned" });
    await publisher.mutate("/repos/owner/repo/git/refs", "POST", { ref: "refs/heads/docs/accept-example-20", sha: "a".repeat(40) });
    await publisher.mutate("/repos/owner/repo/pulls", "POST", { head: "docs/archive-example" });
    await publisher.ready(50, "PR_accepted");
    await publisher.close();
    expect(JSON.parse(requests.find(item => item.path.endsWith("/access_tokens"))!.body)).toEqual({
      repositories: ["repo"], permissions: { contents: "write", pull_requests: "write" },
    });
    expect(requests.at(-1)).toMatchObject({ path: "/installation/token", method: "DELETE" });
  });
});
