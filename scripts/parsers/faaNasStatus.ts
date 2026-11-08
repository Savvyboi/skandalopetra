import type { HazardFeature } from "../../src/types/schema.ts";
import { computeDurationHours } from "../utils/geometry.ts";
import { resolveIcaoMetadata } from "../utils/icaoRegions.ts";

const SOURCE = "https://nasstatus.faa.gov/";
const ID_PREFIX = "FAA-NAS-STATUS-";
const USER_AGENT = "GlobalHazardTracker/1.0 (+https://github.com/Savvyboi/skandalopetra)";

interface NasEvent {
  id?: string;
  startTime?: string;
  endTime?: string;
  issuedDate?: string;
  sourceTimeStamp?: string;
  createdAt?: string;
  impactingCondition?: string;
  simpleText?: string;
  text?: string;
  includedFlights?: string;
  includedFacilities?: string[];
  advisoryUrl?: string;
  gsCancelReceivedTs?: string;
  gsCancelSourceTs?: string;
}

interface NasAirport {
  airportId?: string;
  airportLongName?: string;
  latitude?: string | number;
  longitude?: string | number;
  groundStop?: NasEvent | null;
  airportClosure?: NasEvent | null;
  freeForm?: NasEvent | null;
}

const EVENT_FIELDS = ["groundStop", "airportClosure", "freeForm"] as const;
type EventField = (typeof EVENT_FIELDS)[number];

function utcSeconds(value: string | undefined): number | undefined {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined;
  const seconds = Math.floor(Date.parse(value) / 1000);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function coordinate(value: string | number | undefined, limit: number): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : undefined;
}

function officialAdvisory(value: string | undefined): string {
  if (value) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && url.hostname === "www.fly.faa.gov" && !url.username && !url.password) {
        return url.href;
      }
    } catch {
      // The NAS Status page remains the source when no valid advisory link is supplied.
    }
  }
  return SOURCE;
}

function normalizeEvent(
  airport: NasAirport,
  airportId: string,
  field: EventField,
  event: NasEvent,
  id: string,
  nowSec: number
): HazardFeature | null {
  const validFrom = utcSeconds(event.startTime);
  const validTo = utcSeconds(event.endTime);
  const lon = coordinate(airport.longitude, 180);
  const lat = coordinate(airport.latitude, 90);
  if (validFrom === undefined || validTo === undefined || validTo <= validFrom ||
      validTo < nowSec - 7 * 86400 || lon === undefined || lat === undefined || (lon === 0 && lat === 0)) {
    return null;
  }

  const groundStop = field === "groundStop";
  const bulletin = event.simpleText || event.text || "";
  if (field === "freeForm" && !/\bAD\s+AP\s+CLSD\b/i.test(bulletin)) return null;
  // Recurring closure schedules need separate intervals. Their outer window alone is not an active closure.
  const schedule = /(?:^|\s)D\)\s*\S|\b(?:DLY|DAILY|WEEKLY)\b|\b(?:MON|TUE|WED|THU|FRI|SAT|SUN)\s*[-–/]\s*(?:MON|TUE|WED|THU|FRI|SAT|SUN)\b/i;
  if (!groundStop && schedule.test(`${bulletin} ${event.text ?? ""}`)) return null;
  const qualified = !groundStop && /\b(?:CLSD\s+TO|EXC(?:EPT)?|PPR|NON\s+SKED)\b/i.test(bulletin);
  const label = groundStop ? "Ground stop" : qualified ? "Airport access restriction" : "Airport closure";
  const issuedAt = utcSeconds(event.issuedDate) ?? utcSeconds(event.sourceTimeStamp) ??
    utcSeconds(event.createdAt) ?? validFrom;
  const scope = groundStop && event.includedFlights?.replace(/^\s*:\s*/, "");
  const facilities = groundStop && Array.isArray(event.includedFacilities) && event.includedFacilities.join(", ");
  const rawText = [
    groundStop ? event.impactingCondition : bulletin || event.impactingCondition,
    scope && `Included flights: ${scope}`,
    facilities && `Departure facilities: ${facilities}`,
  ].filter(Boolean).join("\n");
  const { country, region } = resolveIcaoMetadata(airportId.length === 3 ? `K${airportId}` : airportId, "notam");

  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: {
      id,
      domain: "notam",
      subType: "NAS STATUS",
      severity: groundStop || qualified ? "warning" : "danger",
      title: `${airportId} ${label}`,
      rawText: rawText || `${label} reported by FAA NAS Status.`,
      stationOrArea: airport.airportLongName ? `${airportId} · ${airport.airportLongName}` : airportId,
      issuer: "FAA NAS Status (US)",
      country,
      region,
      areaSqKm: 0,
      durationHours: computeDurationHours(validFrom, validTo),
      issuedAt,
      validFrom,
      validTo,
      sourceUrl: officialAdvisory(event.advisoryUrl),
      geometryNote: "Airport reference point published by FAA NAS Status. See the source for affected flights and exceptions.",
    },
  };
}

export async function fetchFaaNasStatusHazards(
  nowSec: number,
  onSnapshot?: (idPrefix: string, activeIds: ReadonlySet<string>) => void
): Promise<HazardFeature[]> {
  const response = await fetch(new URL("api/airport-events", SOURCE), {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    cache: "no-cache",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`[faaNasStatus] FAA NAS Status HTTP ${response.status}`);
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error("[faaNasStatus] Expected an airport event list");

  const activeIds = new Set<string>();
  const features = new Map<string, HazardFeature>();
  let complete = true;
  for (const airport of data as NasAirport[]) {
    const airportId = airport?.airportId;
    if (typeof airportId !== "string" || !/^[A-Z0-9]{3,4}$/.test(airportId)) {
      complete = false;
      continue;
    }
    for (const field of EVENT_FIELDS) {
      const event = airport[field];
      if (event === null) continue;
      if (!event || typeof event.id !== "string" || !event.id) {
        complete = false;
        continue;
      }
      if (field === "groundStop" && (event.gsCancelReceivedTs || event.gsCancelSourceTs)) continue;
      const id = `${ID_PREFIX}${airportId}-${event.id}`;
      activeIds.add(id);
      const feature = normalizeEvent(airport, airportId, field, event, id, nowSec);
      if (feature) features.set(id, feature);
    }
  }
  if (complete) onSnapshot?.(ID_PREFIX, activeIds);
  console.log(`[faaNasStatus] Parsed ${features.size} airport closures, restrictions and ground stops from ${data.length} airports`);
  return [...features.values()];
}
