import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cliCommands } from "../src/commands";
import { slashCommands } from "../src/slash-commands";

const here = dirname(fileURLToPath(import.meta.url));
const chatAppHtml = readFileSync(resolve(here, "../../landing/public/chat-app.html"), "utf8");

function findCliCommand(command: string) {
  return cliCommands.find((candidate) => candidate.command === command);
}

function findSlashCommand(name: string) {
  return slashCommands.find((candidate) => candidate.name === name);
}

describe("chat profile action parity", () => {
  it("exposes workspace and account display-name actions across web, terminal, and CLI", () => {
    const workspaceCli = findCliCommand("thane profile name <display-name> [--json]");
    expect(workspaceCli?.description).toContain("active workspace");

    const accountCli = findCliCommand("thane profile account-name <display-name> [--json]");
    expect(accountCli?.description).toContain("newly joined workspaces");

    expect(findSlashCommand("/name")).toMatchObject({
      usage: "/name <display-name>",
      description: expect.stringContaining("this workspace"),
      needsArgument: true
    });
    expect(findSlashCommand("/account-name")).toMatchObject({
      usage: "/account-name <display-name>",
      description: expect.stringContaining("new workspaces"),
      needsArgument: true
    });

    expect(chatAppHtml).toContain("updateWorkspaceDisplayName");
    expect(chatAppHtml).toContain('scope: "workspace"');
    expect(chatAppHtml).toContain("Workspace display name");
    expect(chatAppHtml).toContain("updateAccountDisplayName");
    expect(chatAppHtml).toContain('scope: "account"');
    expect(chatAppHtml).toContain("Account default name");
  });
});
