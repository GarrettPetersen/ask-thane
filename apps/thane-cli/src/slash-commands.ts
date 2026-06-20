export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
  needsArgument: boolean;
  adminOnly?: boolean;
}

export const slashCommands: SlashCommand[] = [
  { name: "/commands", usage: "/commands", description: "Show slash commands.", needsArgument: false },
  { name: "/menu", usage: "/menu", description: "Open an arrow-key command menu.", needsArgument: false },
  { name: "/update", usage: "/update", description: "Check whether a newer CLI is available.", needsArgument: false },
  { name: "/mfa", usage: "/mfa", description: "Show MFA (2FA) status.", needsArgument: false },
  { name: "/mfa-setup", usage: "/mfa-setup", description: "Start MFA (2FA) authenticator app setup.", needsArgument: false },
  { name: "/mfa-verify", usage: "/mfa-verify <factor-id> <code>", description: "Finish MFA (2FA) setup.", needsArgument: true },
  { name: "/mfa-disable", usage: "/mfa-disable <code>", description: "Disable MFA (2FA).", needsArgument: true },
  { name: "/inbox", usage: "/inbox", description: "Show unread summaries in this team.", needsArgument: false },
  { name: "/inbox all", usage: "/inbox all", description: "Show unread summaries across all teams.", needsArgument: false },
  { name: "/teams", usage: "/teams", description: "List teams.", needsArgument: false },
  { name: "/team", usage: "/team <slug>", description: "Switch team and focus #general.", needsArgument: true },
  { name: "/team-create", usage: "/team-create <name> [--slug <slug>]", description: "Create and switch to a team.", needsArgument: true },
  { name: "/team-leave", usage: "/team-leave", description: "Leave the active team.", needsArgument: false },
  { name: "/team-art", usage: "/team-art", description: "Show team art setup command.", needsArgument: false },
  { name: "/name", usage: "/name <display-name>", description: "Change your display name in this team.", needsArgument: true },
  { name: "/handle", usage: "/handle <handle>", description: "Change your @handle in this team.", needsArgument: true },
  { name: "/account-name", usage: "/account-name <display-name>", description: "Change your default name for new teams.", needsArgument: true },
  { name: "/invite", usage: "/invite <email>", description: "Admin: email a team invite.", needsArgument: true, adminOnly: true },
  { name: "/invite-link", usage: "/invite-link", description: "Admin: create a team invite link.", needsArgument: false, adminOnly: true },
  { name: "/webhooks", usage: "/webhooks", description: "Admin: show webhook setup commands.", needsArgument: false, adminOnly: true },
  { name: "/channels", usage: "/channels", description: "List channels in this team.", needsArgument: false },
  { name: "/join", usage: "/join <channel>", description: "Switch to a channel.", needsArgument: true },
  { name: "/leave", usage: "/leave", description: "Leave the focused channel.", needsArgument: false },
  { name: "/channel-invite", usage: "/channel-invite <handle-or-email>", description: "Admin: add a member to the focused channel.", needsArgument: true, adminOnly: true },
  { name: "/channel-remove", usage: "/channel-remove <handle-or-email>", description: "Admin: remove a member from the focused channel.", needsArgument: true, adminOnly: true },
  { name: "/members", usage: "/members", description: "Show members of the focused channel.", needsArgument: false },
  { name: "/channel-members", usage: "/channel-members", description: "Show members of the focused channel.", needsArgument: false },
  { name: "/team-members", usage: "/team-members", description: "Show members of the active team.", needsArgument: false },
  { name: "/member-remove", usage: "/member-remove <handle-or-email>", description: "Admin: remove a team member.", needsArgument: true, adminOnly: true },
  { name: "/member-role", usage: "/member-role <handle-or-email> <admin|member>", description: "Admin: change a member role.", needsArgument: true, adminOnly: true },
  { name: "/member-ban", usage: "/member-ban <handle-or-email>", description: "Admin: ban a team member.", needsArgument: true, adminOnly: true },
  { name: "/member-unban", usage: "/member-unban <email>", description: "Admin: unban an email.", needsArgument: true, adminOnly: true },
  { name: "/dm", usage: "/dm <handle>", description: "Switch to a DM.", needsArgument: true },
  { name: "/recent", usage: "/recent", description: "Show recent messages in the focused conversation.", needsArgument: false },
  { name: "/thread", usage: "/thread <message-id>", description: "Show a message thread.", needsArgument: true },
  { name: "/reply", usage: "/reply <message-id> <text>", description: "Reply in a thread.", needsArgument: true },
  { name: "/react", usage: "/react <message-id> <emoji>", description: "React to a message.", needsArgument: true },
  { name: "/search", usage: "/search <query>", description: "Search messages in this team.", needsArgument: true },
  { name: "/quit", usage: "/quit", description: "Leave chat.", needsArgument: false },
  { name: "/exit", usage: "/exit", description: "Leave chat.", needsArgument: false }
];

export function slashCommandsForRole(input: { isAdmin: boolean }): SlashCommand[] {
  return slashCommands.filter((command) => input.isAdmin || !command.adminOnly);
}

export function renderSlashCommands(input: { isAdmin: boolean } = { isAdmin: true }): string {
  return slashCommandsForRole(input)
    .map((command) => `${command.usage.padEnd(28)} ${command.description}`)
    .join("\n");
}

export function completeSlashCommand(line: string, input: { isAdmin: boolean } = { isAdmin: true }): [string[], string] {
  if (!line.startsWith("/")) {
    return [[], line];
  }
  const commandPrefix = line.match(/^\/\S*/)?.[0] ?? line;
  const commands = slashCommandsForRole(input);
  const hits = commands
    .map((command) => command.name)
    .filter((name) => name.startsWith(commandPrefix));
  return [hits.length > 0 ? hits : commands.map((command) => command.name), line];
}
