export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
  needsArgument: boolean;
}

export const slashCommands: SlashCommand[] = [
  { name: "/commands", usage: "/commands", description: "Show slash commands.", needsArgument: false },
  { name: "/menu", usage: "/menu", description: "Open an arrow-key command menu.", needsArgument: false },
  { name: "/inbox", usage: "/inbox", description: "Show unread summaries in this workspace.", needsArgument: false },
  { name: "/inbox all", usage: "/inbox all", description: "Show unread summaries across all workspaces.", needsArgument: false },
  { name: "/workspaces", usage: "/workspaces", description: "List workspaces.", needsArgument: false },
  { name: "/workspace", usage: "/workspace <slug>", description: "Switch workspace and focus #general.", needsArgument: true },
  { name: "/channels", usage: "/channels", description: "List channels in this workspace.", needsArgument: false },
  { name: "/join", usage: "/join <channel>", description: "Switch to a channel.", needsArgument: true },
  { name: "/leave", usage: "/leave", description: "Leave the focused channel.", needsArgument: false },
  { name: "/members", usage: "/members", description: "Show members of the focused channel.", needsArgument: false },
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
  const hits = slashCommands
    .map((command) => command.name)
    .filter((name) => name.startsWith(line));
  return [hits.length > 0 ? hits : slashCommands.map((command) => command.name), line];
}
