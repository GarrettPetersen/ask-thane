import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cliCommands } from "../src/commands";
import { renderMembers } from "../src/render";
import { slashCommands, slashCommandsForRole } from "../src/slash-commands";

const here = dirname(fileURLToPath(import.meta.url));
const chatAppHtml = readFileSync(resolve(here, "../../landing/public/chat-app.html"), "utf8");

function findCliCommand(command: string) {
  return cliCommands.find((candidate) => candidate.command === command);
}

function findSlashCommand(name: string) {
  return slashCommands.find((candidate) => candidate.name === name);
}

describe("chat profile action parity", () => {
  it("exposes workspace handle plus display-name actions across web, terminal, and CLI", () => {
    const workspaceCli = findCliCommand("thane profile name <display-name> [--json]");
    expect(workspaceCli?.description).toContain("active workspace");

    const handleCli = findCliCommand("thane profile handle <handle> [--json]");
    expect(handleCli?.description).toContain("@handle");

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
    expect(findSlashCommand("/handle")).toMatchObject({
      usage: "/handle <handle>",
      description: expect.stringContaining("@handle"),
      needsArgument: true
    });

    expect(chatAppHtml).toContain("updateWorkspaceDisplayName");
    expect(chatAppHtml).toContain('scope: "workspace"');
    expect(chatAppHtml).toContain("Workspace display name");
    expect(chatAppHtml).toContain("updateWorkspaceHandle");
    expect(chatAppHtml).toContain("Workspace handle");
    expect(chatAppHtml).toContain("pendingHandle");
    expect(chatAppHtml).toContain("updateAccountDisplayName");
    expect(chatAppHtml).toContain('scope: "account"');
    expect(chatAppHtml).toContain("Account default name");
  });

  it("keeps admin member email access visible across web, terminal, and CLI", () => {
    const rendered = renderMembers([
      {
        user: {
          id: "tcm_1",
          workspaceId: "wsp_1",
          accountId: "acct_1",
          handle: "danika",
          displayName: "Danika",
          email: "danika@example.com"
        },
        role: "member",
        joinedAt: "2026-06-18T00:00:00.000Z"
      }
    ]);

    expect(rendered).toContain("Danika @danika (member) - danika@example.com");
    expect(chatAppHtml).toContain("const emailText = isAdmin && user.email");
    expect(chatAppHtml).toContain("${emailText}${canManage");
  });

  it("exposes MFA setup guidance across web, terminal, and CLI", () => {
    const mfaSetupCli = findCliCommand("thane mfa setup");
    expect(mfaSetupCli?.description).toContain("MFA (2FA)");
    expect(mfaSetupCli?.description).toContain("QR code");

    expect(findSlashCommand("/mfa-setup")).toMatchObject({
      usage: "/mfa-setup",
      description: expect.stringContaining("MFA (2FA)"),
      needsArgument: false
    });

    expect(chatAppHtml).toContain("Start MFA (2FA) setup");
    expect(chatAppHtml).toContain("Scan this QR code with your authenticator app.");
    expect(chatAppHtml).toContain("Google Authenticator");
    expect(chatAppHtml).toContain("qr-card");
  });

  it("keeps admin-only slash commands out of non-admin terminal menus", () => {
    const adminCommands = slashCommandsForRole({ isAdmin: true }).map((command) => command.name);
    const memberCommands = slashCommandsForRole({ isAdmin: false }).map((command) => command.name);

    expect(adminCommands).toContain("/invite-link");
    expect(adminCommands).toContain("/member-ban");
    expect(memberCommands).not.toContain("/invite-link");
    expect(memberCommands).not.toContain("/member-ban");
    expect(memberCommands).toContain("/mfa-setup");
    expect(memberCommands).toContain("/workspace-leave");
  });
});
