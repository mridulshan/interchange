import type { CheckResult } from "../core/check.js";
import type { Finding } from "../core/drift.js";

const ESC = String.fromCharCode(27);
const useColor = Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"];
const c = (code: string, s: string): string => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s);

export const red = (s: string): string => c("31", s);
export const yellow = (s: string): string => c("33", s);
export const green = (s: string): string => c("32", s);
export const dim = (s: string): string => c("2", s);
export const bold = (s: string): string => c("1", s);

const KIND_LABEL: Record<Finding["kind"], string> = {
  "unmapped-pr": "not on the map",
  "status-behind": "map is behind",
  "status-ahead": "map is ahead",
  "pr-abandoned": "abandoned work",
};

/** The terminal form of the drift banner. */
export function formatCheck(result: CheckResult, mapPath: string): string {
  const out: string[] = [];
  const errors = result.issues.filter((i) => i.severity === "error");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  out.push(bold(`Interchange - ${mapPath}`));

  if (errors.length || warnings.length) {
    out.push("");
    out.push(bold("The map itself"));
    for (const i of errors) out.push(`  ${red("error")}   ${i.message}`);
    for (const i of warnings) out.push(`  ${yellow("check")}   ${i.message}`);
  }

  out.push("");
  out.push(bold("The map against the repos"));

  if (!result.findings.length) {
    out.push(`  ${green("clean")}   nothing shipped that isn't drawn`);
  } else {
    const width = Math.max(...result.findings.map((f) => f.source.length));
    for (const f of result.findings) {
      const tag = f.severity === "error" ? red(KIND_LABEL[f.kind]) : yellow(KIND_LABEL[f.kind]);
      out.push(`  ${f.source.padEnd(width)}  ${tag}`);
      out.push(`  ${" ".repeat(width)}  ${dim(f.message)}`);
      if (f.suggestion?.deps?.length) {
        out.push(`  ${" ".repeat(width)}  ${dim(`probably sits on: ${f.suggestion.deps.join(", ")}`)}`);
      }
    }
  }

  if (result.skipped.length) {
    out.push("");
    out.push(bold("Not checked"));
    for (const s of result.skipped) out.push(`  ${s.repo} - ${dim(s.reason)}`);
  }

  const truncated = result.states.filter((s) => s.window?.truncated).map((s) => s.repo);
  if (truncated.length) {
    out.push("");
    out.push(
      dim(`  Window hit its page cap for ${truncated.join(", ")}; raise --max-pages to look further back.`),
    );
  }

  out.push("");
  return out.join("\n");
}

export type FailOn = "none" | "warning" | "error";

/** Whether this result should fail a build. */
export function shouldFail(result: CheckResult, failOn: FailOn): boolean {
  if (failOn === "none") return false;
  const hasError =
    result.issues.some((i) => i.severity === "error") ||
    result.findings.some((f) => f.severity === "error");
  if (hasError) return true;
  if (failOn === "warning") return result.issues.length > 0 || result.findings.length > 0;
  return false;
}
