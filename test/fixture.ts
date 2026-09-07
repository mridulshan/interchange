import type { InterchangeMap } from "../src/core/types.js";

/** The topology from the notepad sketch: five repos, a merge, a revert. */
export function sketch(): InterchangeMap {
  return {
    version: 1,
    repos: [
      { id: "web", remote: "acme/web" },
      { id: "be", remote: "acme/be" },
      { id: "rn", remote: "acme/rn" },
      { id: "admin", remote: "acme/admin" },
      { id: "kyc", label: "secure-kyc", remote: "acme/secure-kyc" },
    ],
    features: [
      {
        id: "routes",
        name: "Payment routes",
        status: "live",
        repos: ["admin", "kyc"],
        prs: [
          { repo: "web", number: 214 },
          { repo: "be", number: 661 },
        ],
      },
      {
        id: "users",
        name: "Users tab",
        status: "live",
        deps: ["routes"],
        prs: [
          { repo: "web", number: 231 },
          { repo: "be", number: 690 },
        ],
      },
      {
        id: "merge",
        name: "Merge: routes + users",
        status: "live",
        merge: true,
        deps: ["routes", "users"],
        prs: [{ repo: "web", number: 240 }],
      },
      {
        id: "pending",
        name: "Application pending actions",
        status: "live",
        deps: ["merge"],
        prs: [
          { repo: "be", number: 722 },
          { repo: "rn", number: 63 },
        ],
      },
      {
        id: "payout",
        name: "Payout webhooks",
        status: "reverted",
        deps: ["routes"],
        prs: [{ repo: "be", number: 730 }],
      },
      {
        id: "e2e",
        name: "End-to-end coverage",
        status: "flight",
        deps: ["pending"],
        prs: [{ repo: "web", number: 266 }],
      },
      {
        id: "notify",
        name: "Notification preferences",
        status: "planned",
        repos: ["web", "rn"],
        deps: ["pending"],
      },
    ],
  };
}

/**
 * The sketch with the prose filled in and the decision that the payout revert
 * broke, so the context and decision tests exercise a realistic map.
 */
export function sketchWithDecisions(): InterchangeMap {
  const m = sketch();

  const prose: Record<string, { assumes: string; exposes: string }> = {
    routes: {
      assumes: "Nothing. This is the base layer.",
      exposes: "`POST /routes` returns `providerId` and `settlementDelay`.",
    },
    users: {
      assumes: "A user record carries `providerId` from payment routes.",
      exposes: "User list and role assignment.",
    },
    merge: {
      assumes: "Both layers below, unchanged.",
      exposes: "Route visibility is gated on user role.",
    },
    pending: {
      assumes: "The role-gated route list. Reads `settlementDelay`.",
      exposes: "A pending-action queue the mobile app polls.",
    },
  };
  for (const f of m.features) {
    const p = prose[f.id];
    if (p) Object.assign(f, p);
  }
  m.features.find((f) => f.id === "pending")!.prs!.unshift({ repo: "web", number: 258 });

  m.decisions = [
    {
      id: "fixed-delay",
      chose: "Treat settlementDelay as a fixed number per provider",
      over: "Ask the provider per call",
      cost: "Async providers do not fit this model",
      feature: "routes",
      affects: ["pending", "payout"],
    },
    {
      id: "shared-route-table",
      chose: "One shared route table",
      over: "Per-provider tables",
      feature: "routes",
    },
    {
      id: "roles-on-user",
      chose: "Roles as a string on the user record",
      feature: "users",
      supersededBy: "roles-service",
    },
    {
      id: "roles-service",
      chose: "Roles behind a permissions service",
      feature: "merge",
    },
  ];
  return m;
}
