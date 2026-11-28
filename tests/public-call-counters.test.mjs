// A failed counter write must not change the cached state. Before the fix a
// transient disk error kept the refused mint's increment and journal entry in
// memory, so retries leaked capacity and eventually filled the journal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCallCounters } from "../src/public-call-counters.mjs";

const LIM = { perIpDay: 3, globalDay: 50, lifetimeMax: 500 };
const setup = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vm-counters-"));
  const file = path.join(dir, "c.json");
  // Writes go through `${file}.tmp`; a directory there makes every save fail,
  // even for root, until it is removed.
  const breakDisk = () => mkdirSync(`${file}.tmp`);
  const fixDisk = () => rmSync(`${file}.tmp`, { recursive: true });
  return { c: createCallCounters({ file }), file, breakDisk, fixDisk };
};

test("a failed visitor admission leaves no count or journal entry behind", async () => {
  const { c, breakDisk, fixDisk } = setup();
  assert.equal((await c.admitVisitor("9.9.9.9", LIM)).ok, true);
  breakDisk();
  for (let i = 0; i < 5; i++)
    await assert.rejects(c.admitVisitor("9.9.9.9", LIM), { status: 503 });
  fixDisk();
  const p = await c.peek();
  assert.equal(p.lifetime, 1);
  assert.equal(p.today.perIp["9.9.9.9"], 1);
  // The visitor still has the two calls they were never given.
  assert.equal((await c.admitVisitor("9.9.9.9", LIM)).ok, true);
  assert.equal((await c.admitVisitor("9.9.9.9", LIM)).ok, true);
  assert.equal((await c.admitVisitor("9.9.9.9", LIM)).scope, "visitor-day");
});

test("repeated write failures cannot fill the journal and block the owner", async () => {
  const { c, breakDisk, fixDisk } = setup();
  await c.peek();
  breakDisk();
  for (let i = 0; i < 120; i++)
    await assert.rejects(c.admitOwner(), { status: 503 });
  fixDisk();
  assert.equal((await c.listAmbiguous({ staleMs: -1 })).length, 0);
  assert.equal((await c.admitOwner()).ok, true);
  assert.equal((await c.peek()).ownerLifetime, 1);
});

test("a failed refund or settle keeps the reservation so it can be retried", async () => {
  const { c, breakDisk, fixDisk } = setup();
  const a = await c.admitVisitor("8.8.8.8", LIM);
  const b = await c.admitVisitor("8.8.8.8", LIM);
  breakDisk();
  await assert.rejects(c.refundReservation(a.reservation), { status: 503 });
  await assert.rejects(c.settleReservation(b.reservation), { status: 503 });
  fixDisk();
  assert.equal((await c.peek()).lifetime, 2);
  await c.refundReservation(a.reservation);
  await c.settleReservation(b.reservation);
  const p = await c.peek();
  assert.equal(p.lifetime, 1);
  assert.equal(p.today.perIp["8.8.8.8"], 1);
});
