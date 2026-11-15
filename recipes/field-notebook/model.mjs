export const MAX_ENTRIES = 100;
export function observation(input, id = crypto.randomUUID(), now = Date.now()) {
  const note = String(input.note || "").trim().slice(0, 4000);
  const tags = [...new Set(String(input.tags || "").split(",").map(tag => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
  const location = input.location;
  if (!note && !input.photo) throw Error("Add a note or a photo first.");
  if (location && (!Number.isFinite(location.latitude) || Math.abs(location.latitude) > 90 || !Number.isFinite(location.longitude) || Math.abs(location.longitude) > 180 || !Number.isFinite(location.accuracy) || location.accuracy < 0))
    throw Error("Location was incomplete. Try locating again, or leave it out.");
  return { id, created_at: now, note, tags, ...(location ? { location: { latitude: location.latitude, longitude: location.longitude, accuracy: location.accuracy } } : {}) };
}
export function entries(shared = {}, pending = {}, query = "") {
  const merged = { ...pending, ...shared };
  const search = query.toLowerCase().trim();
  return Object.values(merged).filter(entry => entry && typeof entry.id === "string")
    .filter(entry => !search || [entry.note, ...(entry.tags || []), entry.interpretation].join(" ").toLowerCase().includes(search))
    .sort((a, b) => b.created_at - a.created_at).slice(0, MAX_ENTRIES);
}
export function exportNotebook(items, now = Date.now()) {
  return { format: "tendriller-field-notebook", version: 1, exported_at: now,
    media: "References only. Download an include-data bundle from Settings for a complete media backup.",
    entries: items.map(({ capture_id, error, ...entry }) => entry) };
}
