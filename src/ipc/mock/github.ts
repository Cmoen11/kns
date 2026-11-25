// Mock of GithubBackend (contract/github.ts): the shop's ops repository (mock/catalog.ts) with two
// apps in test and prod, one newer in test than in prod, and the commits between two tags of any
// repository of the mock catalog. Like Rust, only repositories of the catalog are read.
import type { BackendError, EnvImage, GithubBackend, GithubCommit } from "../types";
import { MOCK_CATALOG } from "./catalog";
import { delay } from "./shared";

/** Workload version labels of the mock deployments (fwd.ts registers them; deploys view). */
export const MOCK_LIVE_VERSIONS: Readonly<Record<string, string>> = { "shop-web": "2.2.0", "shop-orders": "1.5.0" };

const IMAGES: Record<string, EnvImage[]> = {
  "example/shop-ops": [
    { app: "orders", env: "prod", path: "orders/eks-prod/image.yaml", name: "example/shop-orders", tag: "1.4.0" },
    { app: "orders", env: "test", path: "orders/eks-test/image.yaml", name: "example/shop-orders", tag: "1.5.0" },
    { app: "web", env: "prod", path: "web/eks-prod/image.yaml", name: "example/shop-web", tag: "v2.2.0" },
    { app: "web", env: "test", path: "web/eks-test/image.yaml", name: "example/shop-web", tag: "v2.3.0" },
    { app: "worker", env: "test", path: "worker/eks-test/image.yaml", error: "no image.tag" },
  ],
};

const known = (repo: string) => MOCK_CATALOG.systems.some((s) => s.components.some((c) => c.repo?.toLowerCase() === repo.toLowerCase()));
const refused = (repo: string): BackendError => ({ code: 0, reason: "Invalid", message: `${repo} is not a repository of the catalog` });

const TITLES = ["Retry payment callbacks", "Bump dependencies", "Show the order number on the receipt", "Log the upstream status on timeouts", "Fix rounding of VAT"];
const AUTHORS = ["ada", "bob", "dependabot[bot]"];

function commits(base: string, head: string): GithubCommit[] {
  const n = base === head ? 0 : 3 + ((base.length + head.length) % 3);
  const out: GithubCommit[] = [];
  for (let i = 0; i < n; i++) {
    const pr = i % 3 === 1 ? undefined : 40 + n - i;
    out.push({
      sha: (`${i}`.repeat(8) + "abcdef0123456789abcdef0123456789").slice(0, 40),
      title: `${TITLES[i % TITLES.length]}${pr ? ` (#${pr})` : ""}`,
      author: AUTHORS[i % AUTHORS.length],
      date: new Date(Date.UTC(2026, 10, 20 - i, 10)).toISOString().replace(".000", ""),
      pr,
    });
  }
  return out;
}

export const githubMock: GithubBackend = {
  githubStatus: () => delay({ installed: true, loggedIn: true, login: "dev" }, 100),
  githubEnvImages: (repo, imageFile) => {
    if (!known(repo)) return Promise.reject(refused(repo));
    if (!imageFile.includes("{app}") || !imageFile.includes("{env}")) {
      return Promise.reject({ code: 0, reason: "Invalid", message: "the image file template needs one {app} and one {env} in a relative path" } satisfies BackendError);
    }
    return delay({ repo, sha: "4f2c9e1a7b3d4f2c9e1a7b3d4f2c9e1a7b3d4f2c", images: IMAGES[repo] ?? [], truncated: false }, 400);
  },
  githubCompare: (repo, base, head) => {
    if (!known(repo)) return Promise.reject(refused(repo));
    // the mock's tags are spelled with a v
    const b = base.startsWith("v") ? base : `v${base}`;
    const h = head.startsWith("v") ? head : `v${head}`;
    const list = commits(b, h);
    return delay(
      { repo, base: b, head: h, status: list.length ? "ahead" : "identical", aheadBy: list.length, behindBy: 0, totalCommits: list.length, commits: list, url: `https://github.com/${repo}/compare/${b}...${h}` },
      300,
    );
  },
};
