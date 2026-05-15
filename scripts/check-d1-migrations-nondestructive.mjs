import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const migrationsDir = path.join(repoRoot, "infra", "d1", "migrations");

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ");
}

function normalize(statement) {
  return statement.replace(/\s+/g, " ").trim();
}

function isAllowedStatement(statement) {
  if (/^PRAGMA\s+/i.test(statement)) {
    return true;
  }
  if (/^CREATE\s+(UNIQUE\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+/i.test(statement)) {
    return true;
  }
  if (/^CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+/i.test(statement)) {
    return true;
  }
  if (/^ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN\s+/i.test(statement)) {
    return true;
  }
  if (/^INSERT\s+INTO\s+/i.test(statement)) {
    return true;
  }
  return false;
}

function hasExplicitDestructivePattern(statement) {
  const patterns = [
    /\bDROP\s+(TABLE|INDEX|VIEW|TRIGGER|COLUMN)\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bTRUNCATE\b/i,
    /\bUPDATE\b/i,
    /\bREPLACE\s+INTO\b/i,
    /\bVACUUM\b/i,
    /\bATTACH\b/i,
    /\bDETACH\b/i,
    /\bALTER\s+TABLE\b(?!\s+\S+\s+ADD\s+COLUMN\b)/i
  ];
  return patterns.some((pattern) => pattern.test(statement));
}

if (!fs.existsSync(migrationsDir)) {
  console.error(`Migrations directory not found: ${migrationsDir}`);
  process.exit(1);
}

const files = fs
  .readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort((a, b) => a.localeCompare(b));

const violations = [];

for (const file of files) {
  const fullPath = path.join(migrationsDir, file);
  const sql = fs.readFileSync(fullPath, "utf8");
  const stripped = stripSqlComments(sql);
  const statements = stripped
    .split(";")
    .map((part) => normalize(part))
    .filter((part) => part.length > 0);

  for (const statement of statements) {
    if (hasExplicitDestructivePattern(statement)) {
      violations.push({
        file,
        reason: "destructive_pattern",
        statement
      });
      continue;
    }
    if (!isAllowedStatement(statement)) {
      violations.push({
        file,
        reason: "statement_not_allowlisted",
        statement
      });
    }
  }
}

if (violations.length > 0) {
  console.error("Non-destructive migration check failed.");
  for (const violation of violations) {
    console.error(`- ${violation.file} [${violation.reason}] ${violation.statement}`);
  }
  process.exit(1);
}

console.log(`Migration safety check passed for ${files.length} files.`);
