export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
  needsArgument: boolean;
}

export const slashCommands: SlashCommand[] = [
  { name: "/commands", usage: "/commands", description: "Show slash commands.", needsArgument: false },
  { name: "/menu", usage: "/menu", description: "Open an arrow-key command menu.", needsArgument: false },
  { name: "/update", usage: "/update", description: "Check whether a newer CLI is available.", needsArgument: false },
  { name: "/mfa", usage: "/mfa", description: "Show MFA status.", needsArgument: false },
  { name: "/mfa-setup", usage: "/mfa-setup", description: "Start authenticator app setup.", needsArgument: false },
  { name: "/mfa-verify", usage: "/mfa-verify <factor-id> <code>", description: "Finish MFA setup.", needsArgument: true },
  { name: "/mfa-disable", usage: "/mfa-disable <code>", description: "Disable MFA.", needsArgument: true },
  { name: "/inbox", usage: "/inbox", description: "Show unread summaries in this workspace.", needsArgument: false },
  { name: "/inbox all", usage: "/inbox all", description: "Show unread summaries across all workspaces.", needsArgument: false },
  { name: "/workspaces", usage: "/workspaces", description: "List workspaces.", needsArgument: false },
  { name: "/workspace", usage: "/workspace <slug>", description: "Switch workspace and focus #general.", needsArgument: true },
  { name: "/workspace-create", usage: "/workspace-create <slug> [name]", description: "Create and switch to a workspace.", needsArgument: true },
  { name: "/workspace-leave", usage: "/workspace-leave", description: "Leave the active workspace.", needsArgument: false },
  { name: "/workspace-art", usage: "/workspace-art", description: "Show workspace art setup command.", needsArgument: false },
  { name: "/name", usage: "/name <display-name>", description: "Change your display name.", needsArgument: true },
  { name: "/invite", usage: "/invite <email>", description: "Email a workspace invite.", needsArgument: true },
  { name: "/invite-link", usage: "/invite-link", description: "Create a workspace invite link.", needsArgument: false },
  { name: "/channels", usage: "/channels", description: "List channels in this workspace.", needsArgument: false },
  { name: "/join", usage: "/join <channel>", description: "Switch to a channel.", needsArgument: true },
  { name: "/leave", usage: "/leave", description: "Leave the focused channel.", needsArgument: false },
  { name: "/channel-invite", usage: "/channel-invite <handle-or-email>", description: "Add a member to the focused channel.", needsArgument: true },
  { name: "/channel-remove", usage: "/channel-remove <handle-or-email>", description: "Admin: remove a member from the focused channel.", needsArgument: true },
  { name: "/members", usage: "/members", description: "Show members of the focused channel.", needsArgument: false },
  { name: "/member-remove", usage: "/member-remove <handle-or-email>", description: "Admin: remove a workspace member.", needsArgument: true },
  { name: "/member-role", usage: "/member-role <handle-or-email> <admin|member>", description: "Admin: change a member role.", needsArgument: true },
  { name: "/member-ban", usage: "/member-ban <handle-or-email>", description: "Admin: ban a workspace member.", needsArgument: true },
  { name: "/member-unban", usage: "/member-unban <email>", description: "Admin: unban an email.", needsArgument: true },
  { name: "/dm", usage: "/dm <handle>", description: "Switch to a DM.", needsArgument: true },
  { name: "/recent", usage: "/recent", description: "Show recent messages in the focused conversation.", needsArgument: false },
  { name: "/thread", usage: "/thread <message-id>", description: "Show a message thread.", needsArgument: true },
  { name: "/reply", usage: "/reply <message-id> <text>", description: "Reply in a thread.", needsArgument: true },
  { name: "/react", usage: "/react <message-id> <emoji>", description: "React to a message.", needsArgument: true },
  { name: "/search", usage: "/search <query>", description: "Search messages in this workspace.", needsArgument: true },
  { name: "/quit", usage: "/quit", description: "Leave chat.", needsArgument: false },
  { name: "/exit", usage: "/exit", description: "Leave chat.", needsArgument: false }
];

export function renderSlashCommands(): string {
  return slashCommands
    .map((command) => `${command.usage.padEnd(28)} ${command.description}`)
    .join("\n");
}

export function completeSlashCommand(line: string): [string[], string] {
  if (!line.startsWith("/")) {
    return [[], line];
  }
  const commandPrefix = line.match(/^\/\S*/)?.[0] ?? line;
  const hits = slashCommands
    .map((command) => command.name)
    .filter((name) => name.startsWith(commandPrefix));
  return [hits.length > 0 ? hits : slashCommands.map((command) => command.name), line];
}
