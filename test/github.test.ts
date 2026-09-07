import { describe, expect, it, vi } from "vitest";
import { GitHubError, fetchRepoState, tokenFromEnv } from "../src/github/client.js";

function pr(n: number, opts: Partial<{ merged: string | null; state: string; updated: string; title: string }> = {}) {
  return {
    number: n,
    title: opts.title ?? `PR ${n}`,
    html_url: `https://github.com/acme/web/pull/${n}`,
    merged_at: opts.merged ?? null,
    state: opts.state ?? "closed",
    updated_at: opts.updated ?? "2026-09-01T00:00:00Z",
  };
}

function stub(pages: unknown[][]) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string | URL) => {
    calls.push(String(url));
    const page = Number(new URL(String(url)).searchParams.get("page") ?? 1);
    return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("reading a repo", () => {
  it("sorts pull requests into merged, open and closed", async () => {
    const { impl } = stub([
      [
        pr(1, { merged: "2026-08-01T00:00:00Z", state: "closed" }),
        pr(2, { state: "open" }),
        pr(3, { state: "closed" }),
      ],
    ]);
    const st = await fetchRepoState("web", "acme/web", "main", { fetchImpl: impl });
    expect(st.merged.map((p) => p.number)).toEqual([1]);
    expect(st.open.map((p) => p.number)).toEqual([2]);
    expect(st.closed?.map((p) => p.number)).toEqual([3]);
    expect(st.merged[0]).toMatchObject({
      repo: "web",
      state: "merged",
      title: "PR 1",
      url: "https://github.com/acme/web/pull/1",
    });
  });

  it("asks only for pull requests against the shipped branch", async () => {
    const { impl, calls } = stub([[]]);
    await fetchRepoState("web", "acme/web", "release/v2", { fetchImpl: impl });
    expect(calls[0]).toContain("base=release%2Fv2");
    expect(calls[0]).toContain("state=all");
  });

  it("follows pages until one comes back short", async () => {
    const full = Array.from({ length: 100 }, (_, i) => pr(i + 1, { merged: "2026-08-01T00:00:00Z" }));
    const { impl, calls } = stub([full, [pr(101, { merged: "2026-08-01T00:00:00Z" })]]);
    const st = await fetchRepoState("web", "acme/web", "main", { fetchImpl: impl });
    expect(calls).toHaveLength(2);
    expect(st.merged).toHaveLength(101);
  });

  it("stops at the page cap and says the window was cut short", async () => {
    const full = Array.from({ length: 100 }, (_, i) => pr(i + 1, { merged: "2026-08-01T00:00:00Z" }));
    const { impl, calls } = stub([full, full, full]);
    const st = await fetchRepoState("web", "acme/web", "main", { fetchImpl: impl, maxPages: 2 });
    expect(calls).toHaveLength(2);
    expect(st.window?.truncated).toBe(true);
  });

  it("ignores pull requests older than the window", async () => {
    const { impl } = stub([
      [
        pr(9, { merged: "2026-09-01T00:00:00Z", updated: "2026-09-01T00:00:00Z" }),
        pr(8, { merged: "2020-01-01T00:00:00Z", updated: "2020-01-01T00:00:00Z" }),
      ],
    ]);
    const st = await fetchRepoState("web", "acme/web", "main", {
      fetchImpl: impl,
      since: "2026-01-01T00:00:00Z",
    });
    expect(st.merged.map((p) => p.number)).toEqual([9]);
  });

  it("stops early once a whole page falls outside the window", async () => {
    const old = Array.from({ length: 100 }, (_, i) => pr(i + 1, { updated: "2019-01-01T00:00:00Z" }));
    const { impl, calls } = stub([old, old]);
    await fetchRepoState("web", "acme/web", "main", { fetchImpl: impl, since: "2026-01-01T00:00:00Z" });
    expect(calls).toHaveLength(1);
  });

  it("returns merged pull requests oldest first, which is ship order", async () => {
    const { impl } = stub([
      [
        pr(3, { merged: "2026-08-03T00:00:00Z" }),
        pr(1, { merged: "2026-08-01T00:00:00Z" }),
        pr(2, { merged: "2026-08-02T00:00:00Z" }),
      ],
    ]);
    const st = await fetchRepoState("web", "acme/web", "main", { fetchImpl: impl });
    expect(st.merged.map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it("sends the token when there is one, and no header when there isn't", async () => {
    const seen: (HeadersInit | undefined)[] = [];
    const impl = (async (_u: string, init?: RequestInit) => {
      seen.push(init?.headers);
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    await fetchRepoState("web", "acme/web", "main", { fetchImpl: impl, token: "t0ken" });
    expect((seen[0] as Record<string, string>)["Authorization"]).toBe("Bearer t0ken");

    const clean = { ...process.env };
    delete clean["GITHUB_TOKEN"];
    delete clean["GH_TOKEN"];
    expect(tokenFromEnv(clean as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("when GitHub says no", () => {
  const failing = (status: number, body = "") =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;

  it("explains a 404 as access rather than a crash", async () => {
    await expect(fetchRepoState("web", "acme/web", "main", { fetchImpl: failing(404) })).rejects.toThrow(
      /Cannot see acme\/web \(404\)/,
    );
  });

  it("points at the token on a 401", async () => {
    await expect(fetchRepoState("web", "acme/web", "main", { fetchImpl: failing(401) })).rejects.toThrow(
      /Check GITHUB_TOKEN/,
    );
  });

  it("names the rate limit when that is what happened", async () => {
    const impl = failing(403, JSON.stringify({ message: "API rate limit exceeded" }));
    await expect(fetchRepoState("web", "acme/web", "main", { fetchImpl: impl })).rejects.toThrow(
      /rate limit/i,
    );
  });

  it("carries the status code for a caller to inspect", async () => {
    await fetchRepoState("web", "acme/web", "main", { fetchImpl: failing(500) }).catch((e) => {
      expect(e).toBeInstanceOf(GitHubError);
      expect((e as GitHubError).status).toBe(500);
    });
  });
});
