// The context sidebar offers `aws sso login` only while it is needed (needsSsoLogin).
import { describe, expect, it } from "vitest";
import type { ContextInfo } from "../ipc/types";
import { clusterStore, looksLikeAuthError, needsSsoLogin, type ClusterState } from "./cluster";

const ctx: ContextInfo = { name: "eks-test", cluster: "c", user: "u", awsProfile: "sso-test" };
const state = (patch: Partial<ClusterState>): ClusterState => ({ ...clusterStore.getState(), ...patch });

describe("needsSsoLogin", () => {
  it("hides the button while the token is valid or the CLI renews it", () => {
    expect(needsSsoLogin(ctx, state({ sso: { "eks-test": { state: "valid", expiresAt: "2099-01-01T00:00:00Z" } } }))).toBe(false);
    expect(needsSsoLogin(ctx, state({ sso: { "eks-test": { state: "refreshable" } } }))).toBe(false);
  });

  it("shows it when the token expired, is missing, or the check failed", () => {
    expect(needsSsoLogin(ctx, state({ sso: { "eks-test": { state: "expired" } } }))).toBe(true);
    expect(needsSsoLogin(ctx, state({ sso: { "eks-test": { state: "unknown" } } }))).toBe(true);
    expect(needsSsoLogin(ctx, state({ sso: {} }))).toBe(true);
  });

  it("shows nothing before the first check, and never for a context without an AWS profile", () => {
    expect(needsSsoLogin(ctx, state({ sso: null }))).toBe(false);
    expect(needsSsoLogin({ ...ctx, awsProfile: undefined }, state({ sso: {} }))).toBe(false);
  });

  it("shows it when the cluster refused the credentials, whatever the cache says", () => {
    const conn = { ...clusterStore.getState(), status: "offline" as const, error: { code: 0, reason: "Config", message: "exec plugin: Error when retrieving token from sso: Token has expired and refresh failed" } };
    expect(needsSsoLogin(ctx, state({ sso: { "eks-test": { state: "refreshable" } }, conns: { "eks-test": conn } }))).toBe(true);
  });
});

describe("looksLikeAuthError", () => {
  it("tells credential failures from network ones", () => {
    expect(looksLikeAuthError({ code: 401, reason: "Unauthorized", message: "" })).toBe(true);
    expect(looksLikeAuthError({ code: 0, reason: "Network", message: "connection refused" })).toBe(false);
    expect(looksLikeAuthError(null)).toBe(false);
  });
});
