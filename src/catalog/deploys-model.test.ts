import { describe, expect, it } from "vitest";
import { MOCK_CATALOG } from "../ipc/mock/catalog";
import type { EnvImage } from "../ipc/types";
import { changesDoc } from "./deploys";
import { appComponent, deployGroups, envOrder, prodEnv, rowGlyph, rowStatus, sameVersion } from "./deploys-model";

const shop = MOCK_CATALOG.systems.find((s) => s.name === "shop")!;
const IMAGES: EnvImage[] = [
  { app: "orders", env: "prod", path: "orders/eks-prod/image.yaml", name: "example/shop-orders", tag: "1.4.0" },
  { app: "orders", env: "test", path: "orders/eks-test/image.yaml", name: "example/shop-orders", tag: "1.5.0" },
  { app: "web", env: "prod", path: "web/eks-prod/image.yaml", name: "ghcr.io/example/shop-web", tag: "v2.3.0" },
  { app: "web", env: "test", path: "web/eks-test/image.yaml", name: "ghcr.io/example/shop-web", tag: "2.3.0" },
  { app: "worker", env: "test", path: "worker/eks-test/image.yaml", error: "no image.tag" },
];

describe("deploys model", () => {
  it("compares versions with and without a leading v", () => {
    expect(sameVersion("v1.2.0", "1.2.0")).toBe(true);
    expect(sameVersion("1.2.0", "1.2.1")).toBe(false);
    expect(sameVersion("very", "ery")).toBe(false);
    expect(sameVersion(undefined, "1")).toBe(false);
  });

  it("orders environments as the catalog does and finds production", () => {
    const envs = envOrder(MOCK_CATALOG, [...IMAGES, { app: "x", env: "dev", path: "x/eks-dev/image.yaml", tag: "1" }]);
    expect(envs).toEqual(["test", "prod", "dev"]);
    expect(prodEnv(MOCK_CATALOG, envs)).toBe("prod");
    expect(prodEnv(null, ["test", "production"])).toBe("production");
    expect(prodEnv(null, ["test"])).toBeUndefined();
  });

  it("finds the app repository by image name, else by workload", () => {
    expect(appComponent(shop, "ghcr.io/example/shop-web:1.0", "shop-web")?.name).toBe("shop-web");
    expect(appComponent(shop, "registry/shop-orders", "nope")?.name).toBe("shop-orders");
    // no image name: the workload `orders` is listed by shop-orders
    expect(appComponent(shop, undefined, "orders")?.name).toBe("shop-orders");
    // never the ops repository
    expect(appComponent(shop, "shop-ops", "shop-ops")).toBeUndefined();
  });

  it("builds one group per app with the live version, drift and what production is behind", () => {
    const live = new Map([["shop-orders", "1.4.9"], ["shop-web", "2.3.0"]]);
    const groups = deployGroups({ catalog: MOCK_CATALOG, system: shop, images: IMAGES, appPrefix: "shop-", paneEnv: "test", live });
    expect(groups.map((g) => g.app)).toEqual(["orders", "web", "worker"]);

    const orders = groups[0];
    expect(orders.workload).toBe("shop-orders");
    expect(orders.component?.repo).toBe("example/shop-orders");
    expect(orders.rows.map((r) => r.env)).toEqual(["test", "prod"]);
    const [test, prod] = orders.rows;
    expect(test).toMatchObject({ here: true, live: "1.4.9", drift: true, compare: { repo: "example/shop-orders", base: "1.4.0", head: "1.5.0" } });
    expect(rowStatus(test, "v")).toBe("live 1.4.9 ≠ 1.5.0");
    expect(rowGlyph(test)).toBe("warn");
    // production compares with the newest environment
    expect(prod).toMatchObject({ here: false, live: undefined, behind: { env: "test", tag: "1.5.0" }, compare: { base: "1.4.0", head: "1.5.0", label: "prod 1.4.0 → test 1.5.0" } });
    expect(rowStatus(prod, "v")).toBe("test has 1.5.0");

    const web = groups[1];
    // v2.3.0 and 2.3.0 are the same version: nothing to compare, nothing behind
    expect(web.rows.every((r) => !r.compare && !r.behind)).toBe(true);
    expect(rowStatus(web.rows[0], "v")).toBe("live");
    expect(rowGlyph(web.rows[0])).toBe("ok");

    const worker = groups[2];
    expect(worker.rows[0]).toMatchObject({ error: "no image.tag", missing: true });
    expect(rowStatus(worker.rows[0], "v")).toBe("no image.tag");
    expect(rowGlyph(worker.rows[0])).toBe("error");
  });

  it("says a workload is not running, and that the catalog has no version label", () => {
    const [orders] = deployGroups({ catalog: MOCK_CATALOG, system: shop, images: IMAGES, appPrefix: "shop-", paneEnv: "test", live: new Map() });
    expect(rowStatus(orders.rows[0], "v")).toBe("not running here");
    const [noLabel] = deployGroups({ catalog: MOCK_CATALOG, system: shop, images: IMAGES, appPrefix: "shop-", paneEnv: "test", live: new Map([["shop-orders", ""]]) });
    expect(rowStatus(noLabel.rows[0], undefined)).toBe("live: no version label in the catalog");
    // not synced yet: nothing is said about live
    const [unknown] = deployGroups({ catalog: MOCK_CATALOG, system: shop, images: IMAGES, appPrefix: "shop-", paneEnv: "test", live: null });
    expect(unknown.rows[0]).toMatchObject({ missing: false, live: undefined, drift: false });
  });
});

describe("changes document", () => {
  it("lists pull requests once and every commit", () => {
    const doc = changesDoc({
      repo: "example/shop-orders", base: "v1.4.0", head: "v1.5.0", status: "ahead", aheadBy: 3, behindBy: 0, totalCommits: 300,
      url: "https://github.com/example/shop-orders/compare/v1.4.0...v1.5.0",
      commits: [
        { sha: "b".repeat(40), title: "Retry callbacks (#42)", author: "ada", date: "2026-11-20T10:00:00Z", pr: 42 },
        { sha: "c".repeat(40), title: "Retry callbacks, again (#42)", author: "ada", date: "2026-11-20T09:00:00Z", pr: 42 },
        { sha: "a".repeat(40), title: "Bump deps", author: "bob", date: "2026-11-19T09:00:00Z" },
      ],
    });
    const body = (id: string) => doc.sections.find((s) => s.id === id)!.body;
    expect(body("summary")).toContain("3 commits · 1 pull requests");
    expect(body("summary")).toContain("3 of 300");
    expect(body("prs")).toBe("#42  Retry callbacks  (ada)\n    https://github.com/example/shop-orders/pull/42");
    expect(body("commits").split("\n")).toEqual(["bbbbbbb  2026-11-20  ada  Retry callbacks (#42)", "ccccccc  2026-11-20  ada  Retry callbacks, again (#42)", "aaaaaaa  2026-11-19  bob  Bump deps"]);
  });
});

describe("github mock", () => {
  it("reads only repositories of the catalog, like Rust", async () => {
    const { githubMock } = await import("../ipc/mock/github");
    const imgs = await githubMock.githubEnvImages("example/shop-ops", "{app}/eks-{env}/image.yaml");
    expect(imgs.images.map((i) => `${i.app}/${i.env}`)).toContain("orders/prod");
    await expect(githubMock.githubEnvImages("someone/else", "{app}/{env}")).rejects.toMatchObject({ reason: "Invalid" });
    const c = await githubMock.githubCompare("example/shop-orders", "1.4.0", "1.5.0");
    expect(c.url).toBe("https://github.com/example/shop-orders/compare/v1.4.0...v1.5.0");
    expect(c.commits.length).toBe(c.totalCommits);
  });
});
