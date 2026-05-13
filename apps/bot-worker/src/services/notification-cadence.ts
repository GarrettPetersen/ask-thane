export type CadenceKind = "workday_daily" | "daily" | "weekly";

export interface NotificationCadenceSpec {
  kind: CadenceKind;
  times: string[];
  weekdays?: number[];
}

export interface NextDigestInput {
  cadenceJson: Record<string, unknown>;
  timezone: string;
  nowIso: string;
  fromIso?: string;
}

const WEEKDAY_NAME_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7
};

function clamp(num: number, min: number, max: number): number {
  return Math.min(Math.max(num, min), max);
}

function parseTimeString(value: string): string | null {
  const trimmed = value.trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseWeekdays(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const weekdays = Array.from(
    new Set(
      value
        .map((entry) => (typeof entry === "number" ? Math.floor(entry) : Number.NaN))
        .filter((entry) => Number.isFinite(entry) && entry >= 1 && entry <= 7)
    )
  ).sort((a, b) => a - b);

  return weekdays.length > 0 ? weekdays : undefined;
}

export function normalizeTimezone(timezone: string | undefined): string {
  const candidate = (timezone ?? "").trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return "UTC";
  }
}

export function defaultCadenceSpec(): NotificationCadenceSpec {
  return {
    kind: "workday_daily",
    times: ["09:00"],
    weekdays: [1, 2, 3, 4, 5]
  };
}

export function normalizeCadenceSpec(cadenceJson: Record<string, unknown> | null | undefined): NotificationCadenceSpec {
  const fallback = defaultCadenceSpec();
  if (!cadenceJson || typeof cadenceJson !== "object") {
    return fallback;
  }

  const rawKind = typeof cadenceJson.kind === "string" ? cadenceJson.kind : fallback.kind;
  const kind: CadenceKind =
    rawKind === "daily" || rawKind === "weekly" || rawKind === "workday_daily" ? rawKind : fallback.kind;

  const parsedTimes = Array.isArray(cadenceJson.times)
    ? cadenceJson.times
        .filter((value): value is string => typeof value === "string")
        .map((value) => parseTimeString(value))
        .filter((value): value is string => Boolean(value))
    : [];

  const times = Array.from(new Set(parsedTimes)).slice(0, 6);
  if (times.length === 0) {
    times.push(...fallback.times);
  }

  let weekdays: number[] | undefined;
  if (kind === "workday_daily") {
    weekdays = [1, 2, 3, 4, 5];
  } else if (kind === "daily") {
    weekdays = [1, 2, 3, 4, 5, 6, 7];
  } else {
    weekdays = parseWeekdays(cadenceJson.weekdays) ?? [1];
  }

  return {
    kind,
    times,
    weekdays
  };
}

function parseOffsetMinutes(shortOffset: string): number {
  const normalized = shortOffset.replace("UTC", "GMT");
  if (normalized === "GMT") {
    return 0;
  }

  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(normalized);
  if (!match) {
    return 0;
  }

  const sign = match[1] === "-" ? -1 : 1;
  const hour = Number(match[2]);
  const minute = Number(match[3] ?? "0");
  return sign * (hour * 60 + minute);
}

function getOffsetMinutesAt(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset"
  });
  const part = formatter.formatToParts(date).find((entry) => entry.type === "timeZoneName")?.value ?? "GMT";
  return parseOffsetMinutes(part);
}

function zonedTimeToUtcDate(input: {
  timezone: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}): Date {
  const utcEpoch = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);
  let guess = utcEpoch;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const offsetMinutes = getOffsetMinutesAt(new Date(guess), input.timezone);
    const nextGuess = utcEpoch - offsetMinutes * 60_000;
    if (Math.abs(nextGuess - guess) < 60_000) {
      guess = nextGuess;
      break;
    }
    guess = nextGuess;
  }

  return new Date(guess);
}

function getZonedParts(date: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekdayIso: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short"
  });

  const parts = formatter.formatToParts(date);
  const byType = Object.fromEntries(parts.map((entry) => [entry.type, entry.value]));

  const weekdayName = String(byType.weekday ?? "Mon");
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour: Number(byType.hour),
    minute: Number(byType.minute),
    weekdayIso: WEEKDAY_NAME_TO_ISO[weekdayName] ?? 1
  };
}

function addDays(base: { year: number; month: number; day: number }, delta: number): {
  year: number;
  month: number;
  day: number;
} {
  const date = new Date(Date.UTC(base.year, base.month - 1, base.day + delta));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function timeToParts(value: string): { hour: number; minute: number } {
  const [hourText, minuteText] = value.split(":");
  const hour = clamp(Number(hourText), 0, 23);
  const minute = clamp(Number(minuteText), 0, 59);
  return { hour, minute };
}

export function computeNextDigestAt(input: NextDigestInput): string | null {
  const timezone = normalizeTimezone(input.timezone);
  const now = new Date(input.nowIso);
  if (Number.isNaN(now.valueOf())) {
    return null;
  }

  const start = input.fromIso ? new Date(input.fromIso) : now;
  if (Number.isNaN(start.valueOf())) {
    return null;
  }

  const cadence = normalizeCadenceSpec(input.cadenceJson);
  const startZoned = getZonedParts(start, timezone);
  const startEpoch = start.valueOf();

  let best: Date | null = null;

  for (let dayOffset = 0; dayOffset <= 31; dayOffset += 1) {
    const dayParts = addDays(
      {
        year: startZoned.year,
        month: startZoned.month,
        day: startZoned.day
      },
      dayOffset
    );

    const weekday = getZonedParts(
      zonedTimeToUtcDate({
        timezone,
        year: dayParts.year,
        month: dayParts.month,
        day: dayParts.day,
        hour: 12,
        minute: 0
      }),
      timezone
    ).weekdayIso;

    if (cadence.weekdays && !cadence.weekdays.includes(weekday)) {
      continue;
    }

    for (const time of cadence.times) {
      const { hour, minute } = timeToParts(time);
      const candidate = zonedTimeToUtcDate({
        timezone,
        year: dayParts.year,
        month: dayParts.month,
        day: dayParts.day,
        hour,
        minute
      });

      if (candidate.valueOf() <= startEpoch) {
        continue;
      }

      if (!best || candidate.valueOf() < best.valueOf()) {
        best = candidate;
      }
    }

    if (best) {
      break;
    }
  }

  return best ? best.toISOString() : null;
}
