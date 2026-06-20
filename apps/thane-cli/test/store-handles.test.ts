import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThaneAccount } from "../src/model";
import { ThaneStore } from "../src/store";

let previousStorePath: string | undefined;
let tempDir: string | undefined;

function account(id: string, email: string, displayName: string): ThaneAccount {
  return {
    id,
    email,
    displayName,
    createdAt: "2026-06-20T00:00:00.000Z",
    authToken: `token-${id}`
  };
}

describe("local Thane Chat handle generation", () => {
  beforeEach(async () => {
    previousStorePath = process.env.THANE_STORE_PATH;
    tempDir = await mkdtemp(join(tmpdir(), "thane-store-"));
    process.env.THANE_STORE_PATH = join(tempDir, "store.json");
  });

  afterEach(async () => {
    if (previousStorePath === undefined) {
      delete process.env.THANE_STORE_PATH;
    } else {
      process.env.THANE_STORE_PATH = previousStorePath;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses account display names for generated workspace handles and keeps them unique", async () => {
    const store = await ThaneStore.open();
    await store.acceptVerifiedAccount(account("acct_111111", "garrett@example.com", "Garrett Petersen"));
    await store.createWorkspace("acme", "Acme");
    await store.useWorkspace("acme");

    await store.acceptVerifiedAccount(account("acct_222222", "garrett.two@example.com", "Garrett Two"));

    const handles = store.listMembers().map((member) => member.user.handle);
    expect(handles).toEqual(["garrett", "garrett-2"]);
  });

  it("refreshes old generated account handles when a workspace display name is set", async () => {
    const store = await ThaneStore.open();
    await store.acceptVerifiedAccount(account("acct_333333", "new@example.com", ""));
    await store.createWorkspace("acme", "Acme");
    await store.useWorkspace("acme");

    expect(store.listMembers()[0]?.user.handle).toBe("user-333333");

    await store.setWorkspaceDisplayName("Dana Rivers");

    expect(store.listMembers()[0]?.user.handle).toBe("dana");
  });

  it("reserves the Thane handle for Ask Thane", async () => {
    const store = await ThaneStore.open();
    await store.acceptVerifiedAccount(account("acct_444444", "owner@example.com", "Owner"));
    await store.createWorkspace("acme", "Acme");
    await store.useWorkspace("acme");

    await expect(store.setWorkspaceHandle("thane")).rejects.toThrow("@thane is reserved for Ask Thane.");
    await expect(store.addUser("thane")).rejects.toThrow("@thane is reserved for Ask Thane.");
  });
});
