import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

export interface SlackExportUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: {
    email?: string;
    real_name?: string;
    display_name?: string;
  };
}

export interface SlackExportConversation {
  id: string;
  name?: string;
  members?: string[];
  topic?: { value?: string };
  purpose?: { value?: string };
  created?: number;
  is_archived?: boolean;
}

export interface SlackExportReaction {
  name?: string;
  users?: string[];
}

export interface SlackExportFile {
  id?: string;
  name?: string;
  title?: string;
  url_private?: string;
  permalink?: string;
}

export interface SlackExportMessage {
  type?: string;
  subtype?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  reactions?: SlackExportReaction[];
  files?: SlackExportFile[];
}

export interface ParsedSlackConversation {
  source: "channels" | "groups" | "dms" | "mpims";
  conversation: SlackExportConversation;
}

export interface SlackMessageFile {
  path: string;
  folder: string;
  messages: SlackExportMessage[];
}

export interface ParsedSlackExport {
  users: SlackExportUser[];
  conversations: ParsedSlackConversation[];
  messageFiles: SlackMessageFile[];
}

export interface SlackImportPreview {
  users: number;
  accountsWithEmail: number;
  publicChannels: number;
  privateChannels: number;
  dms: number;
  messages: number;
  threadedReplies: number;
  reactions: number;
  files: number;
  skippedFiles: string[];
  requiresTeamPlan: boolean;
}

interface ZipEntry {
  name: string;
  compression: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const textDecoder = new TextDecoder("utf-8");

function uint16(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

function uint32(data: Uint8Array, offset: number): number {
  return (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0;
}

function findEndOfCentralDirectory(data: Uint8Array): number {
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 66_000); offset -= 1) {
    if (uint32(data, offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("This does not look like a ZIP file.");
}

function listZipEntries(data: Uint8Array): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(data);
  const entryCount = uint16(data, eocd + 10);
  const centralDirectoryOffset = uint32(data, eocd + 16);
  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (uint32(data, offset) !== 0x02014b50) {
      throw new Error("Could not read the ZIP central directory.");
    }
    const compression = uint16(data, offset + 10);
    const compressedSize = uint32(data, offset + 20);
    const fileNameLength = uint16(data, offset + 28);
    const extraLength = uint16(data, offset + 30);
    const commentLength = uint16(data, offset + 32);
    const localHeaderOffset = uint32(data, offset + 42);
    const fileNameStart = offset + 46;
    const name = textDecoder.decode(data.slice(fileNameStart, fileNameStart + fileNameLength));
    entries.push({ name, compression, compressedSize, localHeaderOffset });
    offset = fileNameStart + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function readZipEntry(data: Uint8Array, entry: ZipEntry): string {
  const offset = entry.localHeaderOffset;
  if (uint32(data, offset) !== 0x04034b50) {
    throw new Error(`Could not read ZIP entry ${entry.name}.`);
  }
  const fileNameLength = uint16(data, offset + 26);
  const extraLength = uint16(data, offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const compressed = data.slice(dataStart, dataStart + entry.compressedSize);

  if (entry.compression === 0) {
    return textDecoder.decode(compressed);
  }
  if (entry.compression === 8) {
    return textDecoder.decode(inflateRawSync(compressed));
  }
  throw new Error(`Unsupported ZIP compression method ${entry.compression} for ${entry.name}.`);
}

function parseJsonArray<T>(path: string, content: string): T[] {
  const parsed = JSON.parse(content) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected ${path} to contain a JSON array.`);
  }
  return parsed as T[];
}

function stripTopLevelFolder(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length > 1 && !["users.json", "channels.json", "groups.json", "dms.json", "mpims.json"].includes(parts[0]!)) {
    return parts.slice(1).join("/");
  }
  return parts.join("/");
}

function isDateJson(path: string): boolean {
  return /\/\d{4}-\d{2}-\d{2}\.json$/.test(`/${path}`);
}

function folderFromMessagePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2]! : "";
}

export async function parseSlackExportZip(zipPath: string): Promise<ParsedSlackExport> {
  const data = await readFile(zipPath);
  const entries = listZipEntries(data).filter((entry) => !entry.name.endsWith("/") && !entry.name.includes("__MACOSX/"));
  const jsonByPath = new Map<string, string>();

  for (const entry of entries) {
    const normalizedPath = stripTopLevelFolder(entry.name);
    if (!normalizedPath.endsWith(".json")) {
      continue;
    }
    jsonByPath.set(normalizedPath, readZipEntry(data, entry));
  }

  const users = jsonByPath.has("users.json") ? parseJsonArray<SlackExportUser>("users.json", jsonByPath.get("users.json")!) : [];
  const conversations: ParsedSlackConversation[] = [];
  const conversationSources: Array<{ path: string; source: ParsedSlackConversation["source"] }> = [
    { path: "channels.json", source: "channels" },
    { path: "groups.json", source: "groups" },
    { path: "dms.json", source: "dms" },
    { path: "mpims.json", source: "mpims" }
  ];

  for (const source of conversationSources) {
    const content = jsonByPath.get(source.path);
    if (!content) {
      continue;
    }
    for (const conversation of parseJsonArray<SlackExportConversation>(source.path, content)) {
      conversations.push({ source: source.source, conversation });
    }
  }

  const messageFiles: SlackMessageFile[] = [];
  for (const [path, content] of jsonByPath) {
    if (!isDateJson(path)) {
      continue;
    }
    messageFiles.push({
      path,
      folder: folderFromMessagePath(path),
      messages: parseJsonArray<SlackExportMessage>(path, content)
    });
  }

  return { users, conversations, messageFiles };
}

export function previewSlackExport(exportData: ParsedSlackExport, freeLimits: { members: number; privateChannels: number }): SlackImportPreview {
  const publicChannels = exportData.conversations.filter((item) => item.source === "channels").length;
  const privateChannels = exportData.conversations.filter((item) => item.source === "groups").length;
  const dms = exportData.conversations.filter((item) => item.source === "dms" || item.source === "mpims").length;
  const messages = exportData.messageFiles.reduce((sum, file) => sum + file.messages.length, 0);
  const threadedReplies = exportData.messageFiles.reduce(
    (sum, file) => sum + file.messages.filter((message) => message.thread_ts && message.ts && message.thread_ts !== message.ts).length,
    0
  );
  const reactions = exportData.messageFiles.reduce(
    (sum, file) => sum + file.messages.reduce((fileSum, message) => fileSum + (message.reactions?.length ?? 0), 0),
    0
  );
  const files = exportData.messageFiles.reduce(
    (sum, file) => sum + file.messages.reduce((fileSum, message) => fileSum + (message.files?.length ?? 0), 0),
    0
  );

  return {
    users: exportData.users.length,
    accountsWithEmail: exportData.users.filter((user) => user.profile?.email).length,
    publicChannels,
    privateChannels,
    dms,
    messages,
    threadedReplies,
    reactions,
    files,
    skippedFiles: [],
    requiresTeamPlan: exportData.users.length > freeLimits.members || privateChannels > freeLimits.privateChannels
  };
}
