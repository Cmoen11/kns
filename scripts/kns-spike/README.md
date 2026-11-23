# kns-spike fixtures

Objects for checking the feature waves of `docs/plan-features.md` against a real cluster. The owner applies them **by hand**; an agent applies them only when the owner starts it for that. Everything is in namespace `kns-spike`, the only namespace where kns checks may write.

```sh
kubectl --context <ctx> apply -k scripts/kns-spike     # create / update
kubectl --context <ctx> delete namespace kns-spike     # remove everything
```

| Object | What it is | Checks |
|---|---|---|
| `deploy/crashy` | busybox, prints a line to stderr and exits 1 after 3 s | `:why` (CrashLoopBackOff, exit code, last log line), crash card, trap |
| `deploy/oomy` | buffers a newline-free stream past its 32Mi limit | `:why` and the crash card: OOMKilled, limit shown |
| `deploy/pullfail` | an image tag that does not exist | `:why`: ImagePullBackOff with the image name |
| `deploy/web` + `svc/web` | nginx; container port and Service port named `http` | forwards to a Service and to a named port, failover, open in browser, names on one port, `:reach` |
| `deploy/envdemo` | env literal `WEB_URL` = `http://web.kns-spike.svc.cluster.local:80`; `envFrom` ConfigMap `envdemo` (with an `application.yaml` holding `password: x`, also mounted at `/config`); `secretKeyRef` to Secret `envdemo` (`PASSWORD`, `DATABASE_URL=postgres://app:pw@db...`); `KAFKA_CONSUMER_GROUP_ID=envdemo`; `args: ["--db-password=x"]` | dev from workload (`E`), env export and rewriting, consumer-group warning, mounted config to a folder, redaction of env, file-valued ConfigMaps, CLI flags and URL userinfo |
| `svc/db` | a Service whose selector matches nothing | `:why` on a Service without endpoints; a dev-set dependency that is down |
| `deploy/logsy` | 2 replicas printing plain, JSON and logfmt lines, an error every 7 s | merged logs (mark both pods, `l`), structured logs (`J`), patterns (`P`) |

The secret values are fake (`x`, `pw`): a check asserts that kns masks them (`mustNotContain`). Requests are tiny (5m CPU, 8 to 16Mi), so the set fits a small node.

Not verified until the owner applies them: that `oomy` reaches its limit with busybox `tail` (if it does not, raise the `head -c` size), that the cluster can pull `busybox:1.37.0` and `nginx:1.27-alpine`, and that the `kubectl` in use supports the kustomize `labels` field (kubectl 1.27 or newer).
