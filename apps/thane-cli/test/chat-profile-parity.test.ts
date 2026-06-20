import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cliCommands } from "../src/commands";
import { renderMembers, renderMessages } from "../src/render";
import { slashCommands, slashCommandsForRole } from "../src/slash-commands";

const here = dirname(fileURLToPath(import.meta.url));
const chatAppHtml = readFileSync(resolve(here, "../../landing/public/chat-app.html"), "utf8");
const cliIndexSource = readFileSync(resolve(here, "../src/index.ts"), "utf8");
const terminalChatSource = readFileSync(resolve(here, "../src/chat.ts"), "utf8");
const hostedSource = readFileSync(resolve(here, "../src/hosted.ts"), "utf8");

function findCliCommand(command: string) {
  return cliCommands.find((candidate) => candidate.command === command);
}

function findSlashCommand(name: string) {
  return slashCommands.find((candidate) => candidate.name === name);
}

describe("chat profile action parity", () => {
  it("exposes team handle plus display-name actions across web, terminal, and CLI", () => {
    const workspaceCli = findCliCommand("thane profile name <display-name> [--json]");
    expect(workspaceCli?.description).toContain("active team");

    const handleCli = findCliCommand("thane profile handle <handle> [--json]");
    expect(handleCli?.description).toContain("@handle");

    const accountCli = findCliCommand("thane profile account-name <display-name> [--json]");
    expect(accountCli?.description).toContain("newly joined teams");

    expect(findSlashCommand("/name")).toMatchObject({
      usage: "/name <display-name>",
      description: expect.stringContaining("this team"),
      needsArgument: true
    });
    expect(findSlashCommand("/account-name")).toMatchObject({
      usage: "/account-name <display-name>",
      description: expect.stringContaining("new teams"),
      needsArgument: true
    });
    expect(findSlashCommand("/handle")).toMatchObject({
      usage: "/handle <handle>",
      description: expect.stringContaining("@handle"),
      needsArgument: true
    });

    expect(chatAppHtml).toContain("updateWorkspaceDisplayName");
    expect(chatAppHtml).toContain('scope: "workspace"');
    expect(chatAppHtml).toContain("Team display name");
    expect(chatAppHtml).toContain("updateWorkspaceHandle");
    expect(chatAppHtml).toContain("Team handle");
    expect(chatAppHtml).toContain("If you leave handle blank, Thane creates a unique @handle from your name.");
    expect(chatAppHtml).not.toContain("pendingHandle");
    expect(chatAppHtml).toContain("updateAccountDisplayName");
    expect(chatAppHtml).toContain('scope: "account"');
    expect(chatAppHtml).toContain("Account default name");
  });

  it("surfaces mention autocomplete in web and terminal chat", () => {
    expect(chatAppHtml).toContain("function mentionCandidates");
    expect(chatAppHtml).toContain("mention-suggestions");
    expect(chatAppHtml).toContain("insertMention");

    expect(terminalChatSource).toContain("trailingMention");
    expect(terminalChatSource).toContain("Tab completes:");
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
    expect(chatAppHtml).toContain("(${esc(memberRole)})${emailText}</span>");
    expect(chatAppHtml).toContain("openDmComposer");
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

    expect(chatAppHtml).toContain("MFA: ${esc(mfaStatusLabel())}");
    expect(chatAppHtml).toContain("Set up MFA");
    expect(chatAppHtml).toContain("Scan this QR code with your authenticator app.");
    expect(chatAppHtml).toContain("Google Authenticator");
    expect(chatAppHtml).toContain("qr-card");
  });

  it("renders team join events across web, terminal, and CLI commands", () => {
    const rendered = renderMessages([
      {
        id: "evt_join_mbr_1",
        workspace: "acme",
        channel: "general",
        conversationKind: "channel",
        author: "Garrett",
        text: "Garrett joined the team.",
        createdAt: "2026-06-18T00:00:00.000Z",
        replyCount: 0,
        reactions: [],
        mentions: [],
        mentionsMe: false
      }
    ]);

    expect(rendered).toContain("#general * Garrett joined the team.");
    expect(chatAppHtml).toContain("isWorkspaceJoinMessage");
    expect(chatAppHtml).toContain("message system-event");
    expect(terminalChatSource).toContain("isWorkspaceJoinMessage");
  });

  it("surfaces optimistic send states across web and terminal chat", () => {
    expect(chatAppHtml).toContain("optimisticMessages");
    expect(chatAppHtml).toContain("Message failed:");
    expect(chatAppHtml).toContain(" sending");

    expect(terminalChatSource).toContain("addOptimisticMessage");
    expect(terminalChatSource).toContain("Send failed:");
    expect(terminalChatSource).toContain("(sending)");
    expect(terminalChatSource).toContain("const sent = await sendChatMessage(text, root.threadRootId ?? root.id);");
  });

  it("surfaces unread channels and DMs across chat surfaces", () => {
    expect(chatAppHtml).toContain("workspaceUnreadCounts");
    expect(chatAppHtml).toContain("data-menu-toggle=\"dms\"");
    expect(chatAppHtml).toContain("unreadBadge(conversationUnreadCount(item.id))");
    expect(chatAppHtml).toContain("conversationKindUnreadCount(\"dm\")");
    expect(chatAppHtml).toContain("conversationDisplayLabel(item, users)");
    expect(chatAppHtml).toContain("document.title = count > 0 ? `(${count}) Thane Chat` : \"Thane Chat\"");

    expect(terminalChatSource).toContain("unreadCount");
    expect(terminalChatSource).toContain("conversationDisplayLabel");
    expect(findCliCommand("thane inbox [--all-teams] [--json]")?.description).toContain("unread");
    expect(findCliCommand("thane unread [--json]")?.description).toContain("unread");
  });

  it("keeps admin-only slash commands out of non-admin terminal menus", () => {
    const adminCommands = slashCommandsForRole({ isAdmin: true }).map((command) => command.name);
    const memberCommands = slashCommandsForRole({ isAdmin: false }).map((command) => command.name);

    expect(adminCommands).toContain("/invite-link");
    expect(adminCommands).toContain("/member-ban");
    expect(memberCommands).not.toContain("/invite-link");
    expect(memberCommands).not.toContain("/member-ban");
    expect(memberCommands).toContain("/mfa-setup");
    expect(memberCommands).toContain("/team-leave");
  });

  it("surfaces hosted rate-limit retry hints across web, terminal, and CLI", () => {
    expect(cliIndexSource).toContain("rate_limited: try again in");
    expect(terminalChatSource).toContain("rate_limited: try again in");
    expect(hostedSource).toContain("rate_limited: try again in");
    expect(chatAppHtml).toContain("rate_limited: try again in");
  });
});
