#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${1:-maomao-docker-smoke:local}"
CONTAINER="maomao-docker-smoke-$$"
TMP="$(mktemp -d)"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

printf 'Building %s\n' "$IMAGE"
docker build -t "$IMAGE" "$ROOT"

mkdir -p "$TMP/trusted"
cp -R "$ROOT/trusted-checks/." "$TMP/trusted/"
git -C "$TMP/trusted" init -q
git -C "$TMP/trusted" add .
git -C "$TMP/trusted" -c user.name='Maomao Docker Smoke' -c user.email='smoke@example.invalid' commit -qm 'trusted checks fixture'
REVISION="$(git -C "$TMP/trusted" rev-parse HEAD)"

cat > "$TMP/smoke.mjs" <<'NODE'
import { mkdir, writeFile } from "node:fs/promises";
import { TrustedCheckRunner } from "/app/dist/checks/trusted.js";

const revision = process.env.TRUSTED_REVISION;
if (!revision) throw new Error("TRUSTED_REVISION is required");

const workspaceDir = "/work/workspace";
const repoDir = "/work/repo";
const diffPath = "/work/pr.diff";
await mkdir(workspaceDir, { recursive: true });
await mkdir(repoDir, { recursive: true });
await writeFile(`${repoDir}/example.ts`, "export const smoke = 1;\n");
await writeFile(diffPath, "diff --git a/example.ts b/example.ts\n");

const config = {
  workspaceRoot: workspaceDir,
  trustedChecks: {
    repoUrl: "",
    localPath: "/trusted",
    revision,
    allowUnsafeLocal: false,
  },
};
const runner = new TrustedCheckRunner(config, () => ({
  ...config.trustedChecks,
  enabledChecks: ["secrets", "security"],
}));

for (const name of ["secrets", "security"]) {
  const result = await runner.run({ name, repoDir, workspaceDir, diffPath, repoFullName: "smoke/test" });
  console.log(`${name}: ${result.status} (${result.scannerName} ${result.scannerVersion ?? "unknown"})`);
  if (result.diagnostics) console.log(result.diagnostics);
  if (result.status !== "success") {
    throw new Error(`${name} smoke check returned ${result.status}`);
  }
}
NODE

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker create --name "$CONTAINER" --user root \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --entrypoint sh "$IMAGE" -c 'sleep 300' >/dev/null
docker start "$CONTAINER" >/dev/null
docker exec "$CONTAINER" mkdir -p /trusted /work
docker cp "$TMP/trusted/." "$CONTAINER:/trusted"
docker cp "$TMP/smoke.mjs" "$CONTAINER:/smoke.mjs"
docker exec "$CONTAINER" chown -R node:node /trusted /work /smoke.mjs

docker exec --user node --env TRUSTED_REVISION="$REVISION" "$CONTAINER" node /smoke.mjs
printf 'Docker trusted-check smoke test passed\n'
