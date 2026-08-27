import { test } from "node:test";
import assert from "node:assert/strict";
import { failedAttempts, openLoops, openLoopsFromMap, shouldBlockLoop, loopBlockReason } from "../lib/loops.ts";
import { toolResultEvent, toolCallEvent } from "../lib/events.ts";

function ev(session: string, cmd: string, ok: boolean, exit: number): ReturnType<typeof toolResultEvent> {
  return toolResultEvent(session, "bash", { ok, ms: 10, outChars: 5, cmd, exit });
}

const S = "sess-1";

test("loops: counts prior failed attempts per fingerprint and session", () => {
  const events = [
    toolCallEvent(S, "bash"),
    ev(S, "npm test", false, 1),
    ev(S, "npm test", false, 1),
    ev(S, "other cmd", false, 2),
    ev("sess-2", "npm test", false, 1), // other session must not count
  ];
  const map = failedAttempts(events, S);
  assert.equal(map.get("npm test")?.failures, 2);
  assert.equal(map.get("npm test")?.lastExit, 1);
  assert.equal(map.get("other cmd")?.failures, 1);
  assert.equal(map.size, 2);
});

test("loops: success of the same command resets the streak", () => {
  // fail,fail,SUCCESS,fail → 1 (mirrors Python test_success_of_same_command_resets_streak)
  const events = [
    ev(S, "npm test", false, 1),
    ev(S, "npm test", false, 1),
    ev(S, "npm test", true, 0),
    ev(S, "npm test", false, 1),
  ];
  const map = failedAttempts(events, S);
  assert.equal(map.get("npm test")?.failures, 1);
  // a success alone leaves no open streak behind
  assert.equal(failedAttempts([ev(S, "x", false, 1), ev(S, "x", true, 0)], S).size, 0);
});

test("loops: a failing OTHER command does not reset the streak", () => {
  const events = [ev(S, "a", false, 1), ev(S, "b", false, 1), ev(S, "a", false, 1)];
  const map = failedAttempts(events, S);
  assert.equal(map.get("a")?.failures, 2);
  assert.equal(map.get("b")?.failures, 1);
});

test("loops: blocks on the loop_block_after-th attempt (default 3 → 2 prior failures)", () => {
  assert.equal(shouldBlockLoop(0, 3), false);
  assert.equal(shouldBlockLoop(1, 3), false);
  assert.equal(shouldBlockLoop(2, 3), true);
  assert.equal(shouldBlockLoop(5, 3), true);
});

test("loops: threshold clamped so loop_block_after=1 never blocks a fresh command", () => {
  assert.equal(shouldBlockLoop(0, 1), false); // 0 prior failures → never blocked
  assert.equal(shouldBlockLoop(1, 1), true); // 1 prior failure → 2nd attempt blocked
});

test("loops: openLoops only lists commands at/over the threshold", () => {
  const events = [ev(S, "a", false, 1), ev(S, "a", false, 1), ev(S, "b", false, 1)];
  const loops = openLoops(events, S, 3);
  assert.equal(loops.length, 1);
  assert.equal(loops[0]?.cmd, "a");
  assert.equal(loops[0]?.failures, 2);
});

test("loops: openLoops clears after an intervening success", () => {
  const events = [ev(S, "a", false, 1), ev(S, "a", false, 1), ev(S, "a", true, 0)];
  assert.equal(openLoops(events, S, 3).length, 0);
});

test("loops: block reason uses the frozen format", () => {
  const reason = loopBlockReason("npm test", 2);
  assert.equal(
    reason,
    "guard: 'npm test' already failed 2 times this session — do not re-run unchanged; " +
      "change approach or read the error. (Raise loop_block_after in .agent-guard/config.json to override.)",
  );
});

test("loops: openLoopsFromMap mirrors openLoops on the failedAttempts map", () => {
  const events = [ev(S, "a", false, 1), ev(S, "a", false, 1), ev(S, "b", false, 1)];
  const map = failedAttempts(events, S);
  const fromEvents = openLoops(events, S, 3);
  const fromMap = openLoopsFromMap(map, 3);
  assert.deepEqual(fromMap, fromEvents);
  assert.equal(fromMap.length, 1);
  // a success reset in the map clears it too
  map.delete("a");
  assert.equal(openLoopsFromMap(map, 3).length, 0);
});
