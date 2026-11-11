# Caller memory: staging, promotion, backup and recovery

Status: **staging plan, not yet executed.** Creating the service and the
disk are paid account actions only the account owner can take.

## 1. What runs where

| Piece             | Where                                   | Notes                                                                                   |
| ----------------- | --------------------------------------- | --------------------------------------------------------------------------------------- |
| Caller memory     | `<VM_DATA_DIR>/callers/*.vms`           | AES-256-GCM, key = HKDF-SHA256(`VM_STORE_KEY`, `voice-memory/caller-memory/v1`)          |
| Owner workspaces  | `<VM_DATA_DIR>/*.vms`                   | key = `VM_STORE_KEY`. Separate directory and separate key from caller memory            |
| Health            | `GET /healthz` → `callerMemory`         | `{enabled, storage: durable \| memory-only \| unavailable, reason}`; no paths or secrets |

`VM_CALLER_REQUIRE_DURABLE=on` (staging and production): caller memory is
**off** unless the disk is mounted, the key is valid and the startup
self-test (write, read back, delete a canary) passes. It never falls back to
process memory.

## 2. Create staging (account owner)

1. Generate the key locally: `openssl rand -hex 32`. Keep it in a password
   manager. Do not paste it into chat, issues or screenshots.
2. Render Dashboard → New → Blueprint → this repo →
   `docs/deploy/render-staging.yaml`. Review the plan (Starter) and the disk
   (1 GB at `/var/data`) and the monthly cost shown before confirming.
3. Set `VM_STORE_KEY` and `VM_PUBLIC_ORIGIN` in the service's Environment.
4. Deploy. `GET /healthz` must show `callerMemory.enabled: false` (the demo
   flag is still off) and the service must be healthy.

## 3. Enable the demo in staging, only after these pass

Set `VM_CALLER_DEMO=on`, deploy, then from any machine:

```sh
node scripts/caller-memory-smoke.mjs https://<staging>.onrender.com create
# Dashboard: Manual Deploy -> Restart service
node scripts/caller-memory-smoke.mjs https://<staging>.onrender.com verify
# Dashboard: Manual Deploy -> Deploy latest commit (a redeploy, same disk)
node scripts/caller-memory-smoke.mjs https://<staging>.onrender.com verify
node scripts/caller-memory-smoke.mjs https://<staging>.onrender.com forget
# Restart again
node scripts/caller-memory-smoke.mjs https://<staging>.onrender.com verify-gone
```

Fail-closed checks (do once, then restore the real values):

- Set `VM_STORE_KEY` to another 64-hex value and deploy → `/start` for Asha
  returns **503 `unavailable`**; the file is not modified. Restore the key →
  memory is back.
- Remove `VM_STORE_KEY` → the server refuses to start (owner store requires
  it). This is intended.

The same behaviour is tested locally with real processes in
`tests/caller-memory-restart.test.mjs`.

## 4. Promote to production (deliberate)

Production (`voice-memory`, currently Free compute) cannot attach a disk.
Promotion is a separate decision:

1. Merge the reviewed PRs to `main`.
2. Upgrade `voice-memory` to Starter, add a 1 GB disk at `/var/data`, set
   `VM_DATA_DIR=/var/data/voice-memory`, a **new** `VM_STORE_KEY` (never reuse
   staging's), `VM_CALLER_REQUIRE_DURABLE=on`, `VM_CALLER_DEMO=off`.
3. Deploy; check `/healthz`; run section 3 against production; then set
   `VM_CALLER_DEMO=on`.
4. Expect brief downtime on every deploy from now on (disk ⇒ no
   zero-downtime deploys, single instance).

## 5. Backup, restore, key loss

- **Snapshots:** Render snapshots the disk every 24 hours. Restore is
  full-disk, from the Dashboard (Disks → snapshot → Restore). Anything written
  after the snapshot is lost (RPO ≤ 24 h). Restore plus redeploy takes
  minutes; we have not measured it yet. Measure it in staging before relying
  on it.
- **Restore resurrects deletions.** A caller who said "forget everything"
  after the snapshot would be remembered again after a restore. Until a
  deletion log exists, keep a list of deletions made since the snapshot and
  re-apply them after a restore, or do not restore caller memory.
- **Encrypted export:** files are already encrypted at rest; copying the
  `callers/` directory off-box is an encrypted backup. Render does not mount
  a service's disk in one-off jobs, so an authenticated admin export endpoint
  is needed to automate this. **Not built.**
- **Key loss:** without `VM_STORE_KEY` no file can be read, by design; there
  is no recovery. Caller memory reports `unavailable` (503); it never
  re-creates empty records over the old files. Rotating the key is not
  supported yet: changing it makes existing memory unreadable.
- **Disk lost or full:** writes return 503 `unavailable`; nothing unsaved is
  served (tested).
