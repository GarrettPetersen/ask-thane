export function parseSince(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim().toLowerCase();
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const now = new Date();
  if (trimmed === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (trimmed === "yesterday") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  }

  const relative = trimmed.match(/^(\d+)\s*(minute|minutes|hour|hours|day|days|week|weeks)\s*ago$/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2] ?? "days";
    const multipliers: Record<string, number> = {
      minute: 60_000,
      minutes: 60_000,
      hour: 3_600_000,
      hours: 3_600_000,
      day: 86_400_000,
      days: 86_400_000,
      week: 604_800_000,
      weeks: 604_800_000
    };
    const multiplier = multipliers[unit];
    if (!multiplier) {
      throw new Error(`Unsupported relative time unit "${unit}".`);
    }
    return new Date(now.getTime() - amount * multiplier);
  }

  throw new Error(`Could not parse --since "${value}". Try an ISO date, "today", "yesterday", or "2 days ago".`);
}
