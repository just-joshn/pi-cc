/** The `timeFormat` and `timeZone` settings: what they resolve to and how one instant is written. */

export type CcClockPreset = "12-hour" | "24-hour" | "24-hour-utc";

/** `auto` is the host's own rendering, so a caller that gets no text from `formatCcClock` keeps it. */
export type CcClock =
	| { readonly kind: "auto"; readonly timeZone: string | undefined }
	| { readonly kind: "preset"; readonly preset: CcClockPreset; readonly timeZone: string | undefined }
	| { readonly kind: "pattern"; readonly pattern: string; readonly timeZone: string | undefined };

export const CC_DEFAULT_CLOCK: CcClock = { kind: "auto", timeZone: undefined };

const PRESETS: readonly string[] = ["12-hour", "24-hour", "24-hour-utc"];
const PATTERN_LIMIT = 100;

/** Resolves the two settings. An unknown zone falls back to the system zone, and a value with no `%` reads as `auto`. */
export function resolveCcClock(timeFormat: unknown, timeZone: unknown): CcClock {
	const zone = typeof timeZone === "string" ? knownZone(timeZone) : undefined;
	if (timeFormat === "24-hour-utc") {
		return { kind: "preset", preset: "24-hour-utc", timeZone: "UTC" };
	}
	if (typeof timeFormat === "string" && PRESETS.includes(timeFormat)) {
		return { kind: "preset", preset: timeFormat as CcClockPreset, timeZone: zone };
	}
	if (typeof timeFormat === "string") {
		// Control characters never reach a status line, and the pattern is capped like CC's.
		const pattern = timeFormat.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, PATTERN_LIMIT);
		if (pattern.includes("%")) {
			return { kind: "pattern", pattern, timeZone: zone };
		}
	}
	return { kind: "auto", timeZone: zone };
}

function knownZone(name: string): string | undefined {
	if (name === "") {
		return undefined;
	}
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: name });
		return name;
	} catch {
		return undefined;
	}
}

/** The clock text for `date`, or undefined when the setting leaves the rendering to the host (`auto`). */
export function formatCcClock(
	clock: CcClock,
	date: Date,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	switch (clock.kind) {
		case "auto":
			return undefined;
		case "preset":
			return formatPreset(clock.preset, clock.timeZone, date);
		case "pattern":
			return strftime(clock.pattern, date, clock.timeZone, localeFromEnv(env));
	}
}

function formatPreset(preset: CcClockPreset, timeZone: string | undefined, date: Date): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: preset === "12-hour" ? "h12" : "h23",
		...(timeZone === undefined ? {} : { timeZone }),
	}).formatToParts(date);
	if (preset !== "24-hour-utc") {
		return parts.map((part) => part.value).join("");
	}
	const last = parts.findLastIndex((part) => part.type === "minute" || part.type === "second");
	return parts.map((part, index) => (index === last ? `${part.value}Z` : part.value)).join("");
}

function localeFromEnv(env: Readonly<Record<string, string | undefined>>): string | undefined {
	const raw = env.LC_ALL || env.LC_TIME || env.LANG || "";
	const name = raw.split(".")[0]?.split("@")[0] ?? "";
	if (name === "" || name === "C" || name === "POSIX") {
		return undefined;
	}
	const tag = name.replaceAll("_", "-");
	try {
		new Intl.DateTimeFormat(tag);
		return tag;
	} catch {
		return undefined;
	}
}

const pad = (value: number, width: number, flag: string, fill = "0"): string =>
	flag === "-" ? String(value) : String(value).padStart(width, fill);

/** The strftime directives CC accepts, `%-x` dropping the padding. An unknown directive is left as typed. */
function strftime(pattern: string, date: Date, timeZone: string | undefined, locale: string | undefined): string {
	const fields: Record<string, string> = {};
	for (const part of new Intl.DateTimeFormat("en-US", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		timeZoneName: "short",
		...(timeZone === undefined ? {} : { timeZone }),
	}).formatToParts(date)) {
		fields[part.type] = part.value;
	}
	const year = Number(fields.year);
	const month = Number(fields.month);
	const day = Number(fields.day);
	const hour = Number(fields.hour);
	const minute = fields.minute ?? "00";
	const second = fields.second ?? "00";
	const hour12 = ((hour + 11) % 12) + 1;
	const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
	const named = (options: Intl.DateTimeFormatOptions): string =>
		new Intl.DateTimeFormat(locale, {
			...options,
			calendar: "gregory",
			...(timeZone === undefined ? {} : { timeZone }),
		}).format(date);
	const meridiem = hour < 12 ? "AM" : "PM";
	return pattern.replace(/%(-?)([\s\S])/g, (whole, flag: string, directive: string) => {
		switch (directive) {
			case "Y":
				return String(year);
			case "y":
				return pad(year % 100, 2, flag);
			case "C":
				return pad(Math.floor(year / 100), 2, flag);
			case "m":
				return pad(month, 2, flag);
			case "d":
				return pad(day, 2, flag);
			case "e":
				return pad(day, 2, flag, " ");
			case "j":
				return pad((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86400000 + 1, 3, flag);
			case "u":
				return String(weekday === 0 ? 7 : weekday);
			case "w":
				return String(weekday);
			case "H":
				return pad(hour, 2, flag);
			case "k":
				return pad(hour, 2, flag, " ");
			case "I":
				return pad(hour12, 2, flag);
			case "l":
				return pad(hour12, 2, flag, " ");
			case "M":
				return flag === "-" ? String(Number(minute)) : minute;
			case "S":
				return flag === "-" ? String(Number(second)) : second;
			case "p":
				return meridiem;
			case "P":
				return meridiem.toLowerCase();
			case "s":
				return String(Math.floor(date.getTime() / 1000));
			case "a":
				return named({ weekday: "short" });
			case "A":
				return named({ weekday: "long" });
			case "b":
			case "h":
				return named({ month: "short" });
			case "B":
				return named({ month: "long" });
			case "Z":
				return fields.timeZoneName ?? "";
			case "z":
				return numericOffset(date, year, month, day, hour, minute, second);
			case "F":
				return `${year}-${pad(month, 2, "")}-${pad(day, 2, "")}`;
			case "D":
				return `${pad(month, 2, "")}/${pad(day, 2, "")}/${pad(year % 100, 2, "")}`;
			case "T":
				return `${pad(hour, 2, "")}:${minute}:${second}`;
			case "R":
				return `${pad(hour, 2, "")}:${minute}`;
			case "r":
				return `${pad(hour12, 2, "")}:${minute}:${second} ${meridiem}`;
			case "%":
				return "%";
			default:
				return whole;
		}
	});
}

function numericOffset(
	date: Date,
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: string,
	second: string,
): string {
	const local = Date.UTC(year, month - 1, day, hour, Number(minute), Number(second));
	const instant = Math.floor(date.getTime() / 1000) * 1000;
	const minutes = Math.round((local - instant) / 60000);
	const magnitude = Math.abs(minutes);
	const sign = minutes < 0 ? "-" : "+";
	return `${sign}${String(Math.floor(magnitude / 60)).padStart(2, "0")}${String(magnitude % 60).padStart(2, "0")}`;
}
