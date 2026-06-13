declare const process: {
  argv: string[];
  cwd(): string;
  env: Record<string, string | undefined>;
  exitCode?: number;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

interface BufferLike extends Uint8Array {
  toString(encoding?: string): string;
}

declare const Buffer: {
  from(value: string, encoding: string): BufferLike;
};

declare namespace NodeJS {
  interface ErrnoException extends Error {
    code?: string;
  }
}

declare module "node:fs" {
  export function readFileSync(path: number | string, encoding: string): string;
}

declare module "node:crypto" {
  export function createHmac(
    algorithm: string,
    key: string
  ): {
    update(data: string): { digest(encoding: string): string };
  };
}

declare module "node:fs/promises" {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function readFile(path: string, encoding: string): Promise<string>;
  export function readFile(path: string): Promise<BufferLike>;
  export function writeFile(path: string, data: string, encoding: string): Promise<void>;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
}

declare module "node:zlib" {
  export function inflateRawSync(data: Uint8Array): BufferLike;
}

declare module "node:process" {
  export const stdin: {
    isTTY?: boolean;
    setRawMode?: (enabled: boolean) => void;
    resume(): void;
    on(event: "keypress", handler: (chunk: string, key: { name?: string; ctrl?: boolean }) => void): void;
    off(event: "keypress", handler: (chunk: string, key: { name?: string; ctrl?: boolean }) => void): void;
  };
  export const stdout: { write(chunk: string): void };
}

declare module "node:readline" {
  export function emitKeypressEvents(input: unknown): void;
}

declare module "node:readline/promises" {
  export function createInterface(options: {
    input: unknown;
    output: { write(chunk: string): void };
    prompt: string;
    completer?: (line: string) => [string[], string];
  }): {
    [Symbol.asyncIterator](): AsyncIterableIterator<string>;
    prompt(): void;
    setPrompt(prompt: string): void;
    pause(): void;
    resume(): void;
    close(): void;
  };
}
