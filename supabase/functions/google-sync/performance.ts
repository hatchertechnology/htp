import { SyncError } from "./google.ts";

// v1 source identity: legacy device, or device|canonical HTTPS URL.
// The fixed Google endpoints do the fetching; never fetch this URL directly.
export function performanceSource(kind: string, fqdn: string, source: string) {
  const separator = source.indexOf("|");
  const device = separator < 0 ? source : source.slice(0, separator);
  const raw = separator < 0 ? `https://${fqdn}/` : source.slice(separator + 1);
  const devices = kind === "pagespeed"
    ? ["mobile", "desktop"]
    : ["PHONE", "DESKTOP"];
  if (!devices.includes(device) || source.length > 2048) {
    throw new SyncError("invalid_report");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SyncError("invalid_report");
  }
  if (
    url.protocol !== "https:" || url.hostname !== fqdn || url.port ||
    url.username || url.password || raw.includes("#") || url.hash ||
    url.href !== raw ||
    raw.includes("|")
  ) {
    throw new SyncError("invalid_report");
  }
  const scope = kind === "crux" && separator < 0 ? "origin" : "url";
  return {
    semantics_version: 1,
    scope,
    target: scope === "origin" ? url.origin : url.href,
    device,
  };
}
