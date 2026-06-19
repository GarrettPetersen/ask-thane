export interface CliCommand {
  category: string;
  command: string;
  description: string;
  examples: string[];
}

export const cliCommands: CliCommand[] = [
  {
    category: "Interactive",
    command: "thane chat [channel]",
    description: "Open live terminal chat focused on a channel.",
    examples: ["thane chat general"]
  },
  {
    category: "Interactive",
    command: "thane dm <handle>",
    description: "Open live terminal chat focused on a DM.",
    examples: ["thane dm alex"]
  },
  {
    category: "Accounts",
    command: "thane init [--email <email>] [--name \"...\"]",
    description: "Start first-run setup, prompt for email, and verify the account.",
    examples: ["thane init"]
  },
  {
    category: "Accounts",
    command: "thane signup <email> [--name \"...\"]",
    description: "Create a local account and print a verification code.",
    examples: ["thane signup <email> --name \"Your Name\""]
  },
  {
    category: "Accounts",
    command: "thane login <email>",
    description: "Start email-code login for an existing or new account.",
    examples: ["thane login <email>"]
  },
  {
    category: "Accounts",
    command: "thane verify <email> <code>",
    description: "Complete email-code login.",
    examples: ["thane verify <email> 123456"]
  },
  {
    category: "Accounts",
    command: "thane whoami [--json]",
    description: "Show the current account, user, workspace, and role.",
    examples: ["thane whoami --json"]
  },
  {
    category: "Accounts",
    command: "thane logout",
    description: "Sign out locally.",
    examples: ["thane logout"]
  },
  {
    category: "Workspaces",
    command: "thane workspaces [--json]",
    description: "List workspaces and mark the active one.",
    examples: ["thane workspaces"]
  },
  {
    category: "Workspaces",
    command: "thane workspace current [--json]",
    description: "Show the active workspace.",
    examples: ["thane workspace current --json"]
  },
  {
    category: "Workspaces",
    command: "thane workspace create <slug> [--name \"...\"]",
    description: "Create a workspace.",
    examples: ["thane workspace create acme --name \"Acme\""]
  },
  {
    category: "Workspaces",
    command: "thane workspace use <slug>",
    description: "Switch the active workspace.",
    examples: ["thane workspace use acme"]
  },
  {
    category: "Workspaces",
    command: "thane workspace art show [--json]",
    description: "Show the active workspace ASCII art.",
    examples: ["thane workspace art show"]
  },
  {
    category: "Workspaces",
    command: "thane workspace art set [--file <path>|--stdin|<text>]",
    description: "Set custom ASCII art for the active workspace.",
    examples: ["thane workspace art set --file ./art.txt", "printf 'ACME\\n====' | thane workspace art set --stdin"]
  },
  {
    category: "Workspaces",
    command: "thane workspace art reset",
    description: "Reset the active workspace to generated ASCII art.",
    examples: ["thane workspace art reset"]
  },
  {
    category: "Workspaces",
    command: "thane workspace create-from-slack <export.zip> [--slug \"...\"] [--name \"...\"] [--apply] [--json]",
    description: "Create or reuse a workspace from a Slack export ZIP, then import it when --apply is set.",
    examples: ["thane workspace create-from-slack ./slack-export.zip --slug acme --apply"]
  },
  {
    category: "Imports",
    command: "thane import slack-export <export.zip> [--preview] [--apply] [--json]",
    description: "Preview or import a Slack export ZIP into the active workspace.",
    examples: ["thane import slack-export ./slack-export.zip --preview --json"]
  },
  {
    category: "Channels",
    command: "thane channels [--json]",
    description: "List readable channels in the active workspace.",
    examples: ["thane channels --json"]
  },
  {
    category: "Channels",
    command: "thane channel create <name> [--topic \"...\"] [--private]",
    description: "Create a public or private channel.",
    examples: ["thane channel create design --topic \"Product design\"", "thane channel create leadership --private"]
  },
  {
    category: "Channels",
    command: "thane channel join <channel>",
    description: "Join or subscribe to a public channel.",
    examples: ["thane channel join design"]
  },
  {
    category: "Channels",
    command: "thane channel leave <channel>",
    description: "Leave or unsubscribe from a channel.",
    examples: ["thane channel leave design"]
  },
  {
    category: "Channels",
    command: "thane channel invite <channel> <handle-or-email>",
    description: "Add a workspace user to a channel.",
    examples: ["thane channel invite leadership alex"]
  },
  {
    category: "Channels",
    command: "thane channel members <channel> [--json]",
    description: "List channel members.",
    examples: ["thane channel members leadership --json"]
  },
  {
    category: "Members",
    command: "thane members [--json]",
    description: "List workspace members.",
    examples: ["thane members --json"]
  },
  {
    category: "Members",
    command: "thane invite <email> [--role admin|member] [--expires 7d] [--handle \"...\"]",
    description: "Email a hosted workspace invite, or add a local workspace member when offline.",
    examples: ["thane invite alex@example.com", "thane invite alex@example.com --role admin --expires 24h"]
  },
  {
    category: "Members",
    command: "thane invite-link create [--role admin|member] [--expires 7d] [--max-uses 10] [--json]",
    description: "Create an expiring workspace invite link.",
    examples: ["thane invite-link create --expires 7d", "thane invite-link create --role admin --max-uses 1"]
  },
  {
    category: "Members",
    command: "thane invite-link accept <link-or-token> [--json]",
    description: "Accept a workspace invite link and switch to that workspace.",
    examples: ["thane invite-link accept https://api.askthane.com/invite/abc123"]
  },
  {
    category: "Members",
    command: "thane member role <handle-or-email> <admin|member>",
    description: "Change a member role.",
    examples: ["thane member role alex member"]
  },
  {
    category: "Users and DMs",
    command: "thane users [--json]",
    description: "List workspace users.",
    examples: ["thane users --json"]
  },
  {
    category: "Users and DMs",
    command: "thane user add <handle> [--name \"...\"]",
    description: "Add a local workspace user without an account.",
    examples: ["thane user add alex --name \"Alex\""]
  },
  {
    category: "Users and DMs",
    command: "thane dms [--json]",
    description: "List DMs.",
    examples: ["thane dms"]
  },
  {
    category: "Users and DMs",
    command: "thane dm-recent <handle> [--limit 20] [--json]",
    description: "Show recent messages in a DM.",
    examples: ["thane dm-recent alex --json"]
  },
  {
    category: "Users and DMs",
    command: "thane dm-send <handle> <message>",
    description: "Send a DM.",
    examples: ["thane dm-send alex \"Can you review this?\""]
  },
  {
    category: "Messages",
    command: "thane inbox [--all-workspaces] [--json]",
    description: "Show unread conversation summaries.",
    examples: ["thane inbox --json", "thane inbox --all-workspaces --json"]
  },
  {
    category: "Messages",
    command: "thane send <channel> <message>",
    description: "Send a channel message.",
    examples: ["thane send general \"Hello everyone\""]
  },
  {
    category: "Messages",
    command: "thane recent [channel] [--limit 20] [--since today] [--json]",
    description: "Show recent messages.",
    examples: ["thane recent general --json"]
  },
  {
    category: "Messages",
    command: "thane see-recent [channel] [--since \"2 days ago\"] [--json]",
    description: "Agent-friendly recent-message lookup with a larger default limit.",
    examples: ["thane see-recent --since \"2 days ago\" --json"]
  },
  {
    category: "Messages",
    command: "thane unread [--json]",
    description: "Show unread messages.",
    examples: ["thane unread --json"]
  },
  {
    category: "Messages",
    command: "thane mentions [--limit 20] [--since yesterday] [--json]",
    description: "Show messages that mention you.",
    examples: ["thane mentions --since yesterday --json"]
  },
  {
    category: "Messages",
    command: "thane search <query> [--json]",
    description: "Search active-workspace messages.",
    examples: ["thane search \"billing\" --json"]
  },
  {
    category: "Messages",
    command: "thane thread <message-id> [--json]",
    description: "Show a message thread.",
    examples: ["thane thread msg_123 --json"]
  },
  {
    category: "Messages",
    command: "thane reply <message-id> <message>",
    description: "Reply in a thread.",
    examples: ["thane reply msg_123 \"I can review this afternoon\""]
  },
  {
    category: "Messages",
    command: "thane react <message-id> <emoji>",
    description: "React to a message.",
    examples: ["thane react msg_123 eyes"]
  },
  {
    category: "Messages",
    command: "thane mark-read <channel>",
    description: "Mark a channel read.",
    examples: ["thane mark-read general"]
  },
  {
    category: "Ask Thane",
    command: "thane ask-thane status [--json]",
    description: "Show whether Ask Thane is enabled in this workspace.",
    examples: ["thane ask-thane status --json"]
  },
  {
    category: "Ask Thane",
    command: "thane ask-thane enable [--json]",
    description: "Enable the local Ask Thane bridge.",
    examples: ["thane ask-thane enable"]
  },
  {
    category: "Ask Thane",
    command: "thane ask-thane disable",
    description: "Disable the local Ask Thane bridge.",
    examples: ["thane ask-thane disable"]
  },
  {
    category: "Notifications",
    command: "thane notify location [origin|thane_cli|slack|both] [--json]",
    description: "Read or update where Ask Thane should ping you.",
    examples: ["thane notify location", "thane notify location both"]
  },
  {
    category: "Billing",
    command: "thane billing status [--json]",
    description: "Show the active workspace plan and free-tier usage.",
    examples: ["thane billing status --json"]
  },
  {
    category: "Billing",
    command: "thane billing checkout",
    description: "Create a signed Stripe checkout URL for Thane Chat Team.",
    examples: ["thane billing checkout"]
  },
  {
    category: "Billing",
    command: "thane billing activate-team-dev",
    description: "Activate Thane Chat Team locally when dev activation is enabled.",
    examples: ["THANE_ALLOW_DEV_BILLING_ACTIVATION=1 thane billing activate-team-dev"]
  },
  {
    category: "Help",
    command: "thane update [--json] [--force]",
    description: "Check npm for a newer Thane CLI and prompt to update.",
    examples: ["thane update", "thane update --json"]
  },
  {
    category: "Help",
    command: "thane doctor [--json]",
    description: "Show version, resolved store path, active workspace, and local store stats.",
    examples: ["thane doctor", "thane doctor --json"]
  },
  {
    category: "Agent",
    command: "thane agent context [--json]",
    description: "Show compact agent-readable context for the active account and workspace.",
    examples: ["thane agent context --json"]
  },
  {
    category: "Agent",
    command: "thane agent install-instructions",
    description: "Print an AGENTS.md-ready snippet for safe Thane Chat reads.",
    examples: ["thane agent install-instructions"]
  },
  {
    category: "Agent",
    command: "thane export messages [--all] [--channel general] [--since \"7 days ago\"] [--jsonl]",
    description: "Export readable messages as JSON or JSONL for agent or script analysis.",
    examples: ["thane export messages --channel general --jsonl", "thane export messages --all --jsonl"]
  },
  {
    category: "Agent",
    command: "thane read <recent|thread|search> ...",
    description: "Read-only aliases for agent-safe message inspection.",
    examples: ["thane read recent --json", "thane read thread msg_123 --json"]
  },
  {
    category: "Agent",
    command: "thane write <send|reply|react> ...",
    description: "Explicit write aliases for sending, replying, and reacting.",
    examples: ["thane write send general \"Shipping now\""]
  },
  {
    category: "Help",
    command: "thane commands [--json]",
    description: "Show the scriptable command registry.",
    examples: ["thane commands", "thane commands --json"]
  },
  {
    category: "Help",
    command: "thane help",
    description: "Show the full prose help screen.",
    examples: ["thane help"]
  }
];

export function renderCliCommands(commands: CliCommand[] = cliCommands): string {
  const categories = [...new Set(commands.map((command) => command.category))];
  return categories
    .map((category) => {
      const rows = commands
        .filter((command) => command.category === category)
        .map((command) => `  ${command.command}\n      ${command.description}`)
        .join("\n");
      return `${category}\n${rows}`;
    })
    .join("\n\n");
}
