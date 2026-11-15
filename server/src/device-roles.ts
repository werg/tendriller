import type { Tendril } from "./tendril";
import { addActivity } from "./activity";
import { HttpError, isPlainObject } from "./http";
import { DEVICE_PURPOSES } from "../../contract/index.mjs";
import type { Focus as DeviceFocus, DeviceConfiguration } from "../../contract/index.mjs";
export { DEVICE_PURPOSES } from "../../contract/index.mjs";
export type { DevicePurpose, Focus as DeviceFocus } from "../../contract/index.mjs";

export function getFocus(t: Tendril): DeviceFocus | null {
  const focus = t.db.get<DeviceFocus | null>("device_focus", null);
  return focus && focus.expires_at > t.now() && t.device(focus.device) ? focus : null;
}

export function deviceConfiguration(t: Tendril): DeviceConfiguration {
  return { devices: t.listDevices(), focus: getFocus(t) };
}

export function announceDevices(t: Tendril): void {
  t.broadcastOwners({ t: "device_config", ...deviceConfiguration(t) });
  // Guests and displays may learn their own presentation purpose, but the owner
  // roster (names, user agents and link identifiers) stays owner-only.
  for (const { ws, att } of t.connectedSockets()) {
    const device = t.device(att.deviceId);
    if (!device) continue;
    const role = att.sessionRole ?? device.role;
    if (role === "owner" && (att.sessionRole || !device.pending)) continue;
    t.send(ws, { t: "device_config", devices: [{ id: device.id, purpose: device.purpose ?? "general" }], focus: null });
  }
}

export function updateDevice(t: Tendril, id: string, body: unknown, by: string) {
  if (!isPlainObject(body)) throw new HttpError(400, "bad_request", "Expected device settings");
  if (body.role !== undefined) throw new HttpError(403, "forbidden", "Device purpose does not change access permissions");
  const device = t.device(id);
  if (!device) throw new HttpError(404, "not_found", "No such device");
  if (body.name !== undefined && body.name !== null && (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100))
    throw new HttpError(400, "bad_request", "name must be 1–100 characters");
  if (body.purpose !== undefined && !DEVICE_PURPOSES.includes(body.purpose))
    throw new HttpError(400, "bad_request", `purpose must be ${DEVICE_PURPOSES.join(", ")}`);
  if (body.name !== undefined) t.db.run("UPDATE devices SET name = ? WHERE id = ?", body.name?.trim() ?? null, id);
  if (body.purpose !== undefined) t.db.run("UPDATE devices SET purpose = ? WHERE id = ?", body.purpose, id);
  addActivity(t, { kind: "device", summary: "Device presentation settings updated", device: id, by });
  announceDevices(t);
  return t.listDevices().find(d => d.id === id)!;
}

export function setFocus(t: Tendril, body: unknown, by: string): DeviceFocus | null {
  if (!isPlainObject(body)) throw new HttpError(400, "bad_request", "Expected a device");
  if (body.device === null) { t.db.del("device_focus"); announceDevices(t); return null; }
  const device = typeof body.device === "string" ? t.device(body.device) : null;
  if (!device) throw new HttpError(400, "bad_request", "Choose an owner device");
  const socket = t.deviceSockets().get(device.id), sessionRole = socket ? t.att(socket)?.sessionRole : null;
  if ((sessionRole ?? device.role) !== "owner" || !sessionRole && device.pending) throw new HttpError(400, "bad_request", "Choose an owner device");
  if (!socket) throw new HttpError(409, "offline", "Open the destination page before continuing there");
  const ttl = body.ttl_seconds ?? 900;
  if (!Number.isInteger(ttl) || ttl < 30 || ttl > 86400) throw new HttpError(400, "bad_request", "ttl_seconds must be 30–86400");
  const focus = { device: device.id, expires_at: t.now() + ttl * 1000 };
  t.db.set("device_focus", focus);
  addActivity(t, { kind: "device", summary: "Continued on this device; it has audio focus", device: device.id, by });
  announceDevices(t);
  return focus;
}

/** One eligible owner speaks. A disconnected explicitly chosen speaker is never replaced silently. */
export function speechTarget(t: Tendril, requested?: string, origin?: string | null): string | null {
  if (requested === "none") return null;
  const connected = t.deviceSockets();
  const eligible = t.listDevices().filter(d => {
    const socket = connected.get(d.id);
    const sessionRole = socket ? t.att(socket)?.sessionRole : null;
    return !!socket && (sessionRole ?? d.role) === "owner" && (!!sessionRole || !d.pending);
  });
  if (requested && requested !== "primary") {
    if (!t.device(requested)) throw new HttpError(404, "not_found", "No such speaker device");
    return eligible.find(d => d.id === requested)?.id ?? null;
  }
  if (requested === "primary") return eligible.find(d => d.id === t.primaryDevice())?.id ?? null;
  const focus = getFocus(t);
  return eligible.find(d => d.id === focus?.device)?.id
    ?? eligible.find(d => d.purpose === "speaker")?.id
    ?? eligible.find(d => d.id === origin)?.id
    ?? eligible.find(d => d.primary)?.id
    ?? eligible[0]?.id ?? null;
}
