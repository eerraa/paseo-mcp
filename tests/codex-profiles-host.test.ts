import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signInState } from "../shared/servers";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-codex-profiles-"));
const codexHome = join(home, ".codex");
const aiStudioHome = join(home, ".paseo", "codex-aistudio");
const exaUrl = "https://mcp.exa.ai/mcp?login";
mkdirSync(codexHome, { recursive: true });
mkdirSync(aiStudioHome, { recursive: true });
mkdirSync(join(home, ".claude"), { recursive: true });
writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { exa: { type: "http", url: exaUrl } } }));
writeFileSync(join(codexHome, "config.toml"), `[mcp_servers.exa]\nurl = "${exaUrl}"\n`);
writeFileSync(join(aiStudioHome, "config.toml"), `[mcp_servers.exa]\nurl = "${exaUrl}"\n`);
// Model authentication is deliberately absent. MCP OAuth belongs to CODEX_HOME,
// so a missing ChatGPT id token must not hide the connector account.
writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "local-router" }));
writeFileSync(join(codexHome, ".credentials.json"), JSON.stringify({
  "exa|primary": { server_name: "exa", server_url: exaUrl, client_id: "client", access_token: "present", expires_at: Date.now() + 3_600_000 },
}));
writeFileSync(join(aiStudioHome, ".credentials.json"), JSON.stringify({
  "exa|expired": { server_name: "exa", server_url: exaUrl, client_id: "", access_token: "" },
}));

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PASEO_HOME = join(home, ".paseo");
process.env.PASEO_LISTEN = "127.0.0.1:9";
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;

const { collectAccounts, handleMcpAuth } = await import("../server/handlers");
const { codexChecksSettled, resetCodexAuthForTests, setCodexRunnerForTests } = await import("../server/codex-auth");
const { handleMcpAgentServers } = await import("../server/enabled");
const { providerSettings } = await import("../server/daemon-cache");
const calls: string[] = [];
setCodexRunnerForTests(async (dir) => {
  calls.push(dir);
  return { exa: dir === codexHome ? "not-connected" : "connected" };
});
const context = {
  paseo: {
    config: { get: async () => ({ config: { providers: { "aistudio-bridge": { extends: "codex", env: { CODEX_HOME: aiStudioHome } } }, mcp: { enabled: false } } }) },
    projects: { list: async () => ({ entries: [] }) },
    workspaces: { list: async () => ({ entries: [{ id: "ws", name: "test", workspaceDirectory: home, projectRootPath: home }] }) },
  },
} as never;

test("primary Codex MCP auth is visible without a model email, and derived profiles stay separate", () => {
  const destinations = [{
    id: join(aiStudioHome, "config.toml"),
    label: "Codex · codex-aistudio (aistudio-bridge)",
    provider: "codex",
    providerId: "aistudio-bridge",
    account: "codex-aistudio",
    configPath: join(aiStudioHome, "config.toml"),
    format: "toml-mcp" as const,
  }];
  const accounts = collectAccounts({ askCodex: false, destinations });
  const primary = accounts.find((account) => account.provider === "codex" && account.isPrimary);
  const aiStudio = accounts.find((account) => account.dir === aiStudioHome);
  assert.ok(primary);
  assert.equal(primary!.email, "");
  assert.equal(primary!.authStatus.exa, "connected");
  assert.ok(aiStudio);
  assert.equal(aiStudio!.email, "codex-aistudio");
  assert.equal(aiStudio!.authStatus.exa, "not-connected");
  assert.equal(signInState("exa", accounts), "needs", "one signed-in profile cannot hide another profile's missing grant");
  assert.equal(collectAccounts({ askCodex: false, destinations, only: { provider: "codex", email: "codex-aistudio", dir: aiStudioHome } }).length, 1);
  assert.equal(calls.length, 0, "cached-only reads do not start Codex");
  assert.doesNotMatch(JSON.stringify(accounts), /present|local-router/);
});

test("the auth RPC discovers a derived CODEX_HOME and asks the CLI once per directory", async () => {
  // Modern Codex can keep grants in its encrypted store. The plugin must ask
  // each CLI home even though neither has the legacy .credentials.json.
  rmSync(join(codexHome, ".credentials.json"));
  rmSync(join(aiStudioHome, ".credentials.json"));
  resetCodexAuthForTests();
  calls.length = 0;
  const first = await handleMcpAuth({ refresh: true }, context);
  assert.equal(first.checking, true);
  await codexChecksSettled();
  const result = await handleMcpAuth({}, context);
  assert.deepEqual(result.accounts.filter((account) => account.provider === "claude").map((account) => account.dir), [join(home, ".claude")], "the primary Claude config does not create a second account rooted at HOME");
  assert.deepEqual(calls.sort(), [codexHome, aiStudioHome].sort());
  assert.equal(result.accounts.find((account) => account.dir === codexHome)?.authStatus.exa, "not-connected");
  assert.equal(result.accounts.find((account) => account.dir === aiStudioHome)?.authStatus.exa, "connected");
  assert.equal(signInState("exa", result.accounts), "needs");
});

test("an agent panel reads the selected provider's grants without borrowing the primary login", async () => {
  const primary = await handleMcpAgentServers({ workspaceId: "ws", providerId: "codex" }, context, { probe: false });
  const derived = await handleMcpAgentServers({ workspaceId: "ws", providerId: "aistudio-bridge" }, context, { probe: false });
  assert.equal(primary.account?.dir, codexHome);
  assert.equal(primary.account?.authStatus.exa, "not-connected");
  assert.equal(derived.account?.dir, aiStudioHome);
  assert.equal(derived.account?.authStatus.exa, "connected");
  assert.equal(calls.length, 2, "the panel reuses each home's last CLI answer");
});

test("the same model email in two directories stays separate, and aliases do not duplicate a home", () => {
  const destination = {
    id: join(aiStudioHome, "config.toml"), label: "AIStudio", provider: "codex", providerId: "aistudio-bridge",
    account: "", configPath: join(aiStudioHome, "config.toml"), format: "toml-mcp" as const,
  };
  const accounts = collectAccounts({ askCodex: false, destinations: [destination, destination] });
  assert.equal(accounts.filter((account) => account.dir === aiStudioHome).length, 1);
  const only = collectAccounts({ askCodex: false, destinations: [destination], only: { provider: "codex", email: "", dir: aiStudioHome } });
  assert.deepEqual(only.map((account) => account.dir), [aiStudioHome]);
  assert.equal(only[0]!.authStatus.exa, "connected");
});

test.after(() => providerSettings.reset());
test.after(() => rmSync(home, { recursive: true, force: true }));
