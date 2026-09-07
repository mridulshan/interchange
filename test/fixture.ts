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
