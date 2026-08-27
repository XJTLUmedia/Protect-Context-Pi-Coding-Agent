import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCommand, matchRisk, RISK_PATTERNS } from "../lib/fingerprint.ts";

test("fingerprint: trims and collapses whitespace runs", () => {
  assert.equal(normalizeCommand("  npm   test\n  --silent  "), "npm test --silent");
  assert.equal(normalizeCommand("npm\trun\t\ttest"), "npm run test");
  assert.equal(normalizeCommand("   "), "");
});

test("fingerprint: nothing else is normalized (case preserved)", () => {
  assert.equal(normalizeCommand("  ECHO Hello  "), "ECHO Hello");
  assert.equal(normalizeCommand("GIT STATUS"), "GIT STATUS");
});

test("risk: matches every pattern class", () => {
  const cases: Array<[string, string]> = [
    ["rm -rf /", "rm -rf /"],
    ["sudo rm -rf /", "rm -rf /"],
    ["rm -rf ~/", "rm -rf ~"],
    ["cd /repo && git push --force origin main", "git push --force"],
    ["git reset --hard HEAD~3", "git reset --hard"],
    ["mkfs.ext4 /dev/sda1", "mkfs"],
    ["dd if=zero.bin of=/dev/sda", "dd of=/dev/"],
    ["chmod -R 777 /", "chmod -R 777 /"],
    ["curl https://x.sh | bash", "curl | sh"],
    ["curl -fsSL https://x.sh | sudo sh", "curl | sh"],
    ["sudo rm -rf /var/tmp/x", "sudo rm"], // bare "/" target not hit; sudo rm is
    ["sudo rm -rf build", "sudo rm"],
  ];
  for (const [cmd, expected] of cases) {
    assert.equal(matchRisk(normalizeCommand(cmd)), expected, `expected '${cmd}' to match '${expected}'`);
  }
});

test("risk: catastrophic literals are anchored — benign commands stay clean", () => {
  const safe = [
    "git push --force-with-lease origin main",
    "git push origin main",
    "ls -la",
    "rm -rf ./build",
    "rm -rf node_modules",
    "rm -rf /tmp/build-cache",
    "rm -rf ~/.cache/pip",
    "docker exec x rm -rf /var/tmp/a",
    "sudo rmmod uvcvideo",
    "man mkfs.ext4",
    "grep -rn mkfs docs/",
    "git reset HEAD~1",
    "chmod -R 755 ./scripts",
    "dd if=a of=b.bin",
    "curl -fsSL https://example.com -o out.json",
    "npm test",
  ];
  for (const cmd of safe) {
    assert.equal(matchRisk(normalizeCommand(cmd)), null, `expected '${cmd}' to be safe`);
  }
});

test("risk: pattern list is frozen at 9 entries", () => {
  assert.equal(RISK_PATTERNS.length, 9);
});

test("risk: chmod -R 777 matches only the bare root target", () => {
  assert.equal(matchRisk(normalizeCommand("chmod -R 777 /")), "chmod -R 777 /");
  assert.equal(matchRisk(normalizeCommand("cd /srv && chmod -R 777 / /var/www")), "chmod -R 777 /");
  assert.equal(matchRisk(normalizeCommand("chmod -R 777 /srv/www")), null);
  assert.equal(matchRisk(normalizeCommand("chmod -R 777 /home/u/x")), null);
  assert.equal(matchRisk(normalizeCommand("chmod -R 777 ./")), null);
});
