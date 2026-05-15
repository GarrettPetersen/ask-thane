import { describe, expect, it } from "vitest";
import { OrgRegistry } from "../src/services/org-registry";

type Operation = {
  kind: "first" | "run";
  sql: string;
  args: unknown[];
};

function makeDbRecorder(handler: (sql: string, args: unknown[], ops: Operation[]) => unknown) {
  const operations: Operation[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => ({
          first: async () => {
            operations.push({ kind: "first", sql, args });
            return handler(sql, args, operations);
          },
          run: async () => {
            operations.push({ kind: "run", sql, args });
            return { meta: { changes: 1 } };
          }
        })
      };
    }
  };

  return { db: db as unknown as D1Database, operations };
}

describe("OrgRegistry", () => {
  it("returns an existing workspace mapping and backfills external account mapping", async () => {
    const { db, operations } = makeDbRecorder((sql) => {
      if (sql.includes("FROM workspaces") && sql.includes("external_workspace_id")) {
        return { id: "ws_existing", organization_id: "org_existing" };
      }
      return null;
    });

    const registry = new OrgRegistry(db);
    const resolved = await registry.resolveOrCreateSlackWorkspace({
      externalWorkspaceId: "T_EXISTING"
    });

    expect(resolved).toEqual({
      organizationId: "org_existing",
      workspaceId: "ws_existing",
      externalWorkspaceId: "T_EXISTING"
    });
    const externalAccountUpsert = operations.find(
      (op) => op.kind === "run" && op.sql.includes("INSERT INTO organization_external_accounts")
    );
    expect(externalAccountUpsert).toBeTruthy();
    expect(externalAccountUpsert?.args[1]).toBe("org_existing");
    expect(externalAccountUpsert?.args[2]).toBe("workspace");
    expect(externalAccountUpsert?.args[3]).toBe("T_EXISTING");
  });

  it("creates a new org mapping for a workspace install", async () => {
    const { db, operations } = makeDbRecorder((sql, _args, ops) => {
      if (sql.includes("FROM workspaces") && sql.includes("external_workspace_id")) {
        const workspaceInsert = ops.find(
          (op) => op.kind === "run" && op.sql.includes("INSERT INTO workspaces")
        );
        if (workspaceInsert) {
          return {
            id: String(workspaceInsert.args[0]),
            organization_id: String(workspaceInsert.args[1])
          };
        }
        return null;
      }
      if (sql.includes("FROM organization_external_accounts")) {
        return null;
      }
      if (sql.includes("FROM organizations") && sql.includes("WHERE id = ?")) {
        return null;
      }
      if (sql.includes("FROM organizations") && sql.includes("WHERE slug = ?")) {
        return null;
      }
      return null;
    });

    const registry = new OrgRegistry(db);
    const resolved = await registry.resolveOrCreateSlackWorkspace({
      externalWorkspaceId: "T_NEW",
      workspaceName: "Pilot Team"
    });

    const externalAccountUpsert = operations.find(
      (op) => op.kind === "run" && op.sql.includes("INSERT INTO organization_external_accounts")
    );
    expect(externalAccountUpsert).toBeTruthy();
    expect(externalAccountUpsert?.args[2]).toBe("workspace");
    expect(externalAccountUpsert?.args[3]).toBe("T_NEW");

    const workspaceInsert = operations.find(
      (op) => op.kind === "run" && op.sql.includes("INSERT INTO workspaces")
    );
    expect(workspaceInsert).toBeTruthy();
    expect(String(workspaceInsert?.args[2])).toBe("T_NEW");
    expect(resolved.externalWorkspaceId).toBe("T_NEW");
    expect(resolved.organizationId.startsWith("org_")).toBe(true);
  });

  it("reuses enterprise org mapping when enterprise_id is present", async () => {
    const { db, operations } = makeDbRecorder((sql, _args, ops) => {
      if (sql.includes("FROM workspaces") && sql.includes("external_workspace_id")) {
        const workspaceInsert = ops.find(
          (op) => op.kind === "run" && op.sql.includes("INSERT INTO workspaces")
        );
        if (workspaceInsert) {
          return {
            id: String(workspaceInsert.args[0]),
            organization_id: String(workspaceInsert.args[1])
          };
        }
        return null;
      }
      if (sql.includes("FROM organization_external_accounts")) {
        return { organization_id: "org_enterprise" };
      }
      if (sql.includes("FROM organizations") && sql.includes("WHERE id = ?")) {
        return { slug: "acme" };
      }
      return null;
    });

    const registry = new OrgRegistry(db);
    const resolved = await registry.resolveOrCreateSlackWorkspace({
      externalWorkspaceId: "T_GRID_CHILD",
      workspaceName: "Acme R&D",
      externalOrganizationId: "E12345",
      organizationName: "Acme"
    });

    const externalAccountUpsert = operations.find(
      (op) => op.kind === "run" && op.sql.includes("INSERT INTO organization_external_accounts")
    );
    expect(externalAccountUpsert).toBeTruthy();
    expect(externalAccountUpsert?.args[2]).toBe("enterprise");
    expect(externalAccountUpsert?.args[3]).toBe("E12345");

    const workspaceInsert = operations.find(
      (op) => op.kind === "run" && op.sql.includes("INSERT INTO workspaces")
    );
    expect(workspaceInsert?.args[1]).toBe("org_enterprise");
    expect(resolved.organizationId).toBe("org_enterprise");
    expect(resolved.workspaceId).toBe(String(workspaceInsert?.args[0]));
  });
});
