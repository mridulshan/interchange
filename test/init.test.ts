import { describe, expect, it } from "vitest";
import { parseRemote } from "../src/cli/git.js";

describe("reading a git remote", () => {
  it("understands the ssh form private repos are usually cloned with", () => {
    expect(parseRemote("git@github.com:acme/secret-payments.git")).toEqual({
      id: "secret-payments",
      remote: "acme/secret-payments",
    });
  });

  it("understands the https form", () => {
    expect(parseRemote("https://github.com/acme/secret-payments.git")).toEqual({
      id: "secret-payments",
      remote: "acme/secret-payments",
    });
  });

  it("works without the .git suffix", () => {
    expect(parseRemote("https://github.com/acme/secret-payments")).toEqual({
      id: "secret-payments",
      remote: "acme/secret-payments",
    });
  });

  it("keeps a dot that belongs to the repo name", () => {
    expect(parseRemote("git@github.com:acme/my.app.git")).toEqual({
      id: "my.app",
      remote: "acme/my.app",
    });
    expect(parseRemote("https://github.com/acme/docs.site")).toEqual({
      id: "docs.site",
      remote: "acme/docs.site",
    });
  });

  it("tolerates a trailing slash", () => {
    expect(parseRemote("https://github.com/acme/web/")).toEqual({
      id: "web",
      remote: "acme/web",
    });
  });

  it("returns nothing for a remote that is not GitHub", () => {
    expect(parseRemote("git@gitlab.com:acme/web.git")).toBeUndefined();
    expect(parseRemote("")).toBeUndefined();
  });
});
