import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createVersion, fileKey, listVersions, storeContent, type VersionFile } from "../src/files";
import { create, inDO } from "./helpers";

function bytes(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  const out = new Uint8Array(encoded.byteLength);
  out.set(encoded);
  return out.buffer;
}

describe("Aggressive publication version GC and oldest-version pruning", () => {
  it("keeps a short 3-version window and immediately deletes unreferenced R2 blobs while preserving shared files", async () => {
    const h = await create();
    const hashes: string[] = [];
    let sharedHash = "";

    await inDO(h.id, async (t) => {
      const shared = await storeContent(t, bytes("shared-library-code"), "text/javascript");
      sharedHash = shared.hash;

      for (let i = 1; i <= 5; i++) {
        const unique = await storeContent(t, bytes(`<html>bundle-v${i}-${"x".repeat(200)}</html>`), "text/html");
        hashes.push(unique.hash);
        const files = new Map<string, VersionFile>([
          ["index.html", { path: "index.html", hash: unique.hash, size: unique.size, type: "text/html" }],
          ["shared.js", { path: "shared.js", hash: shared.hash, size: shared.size, type: "text/javascript" }],
        ]);
        await createVersion(t, files, `v${i}`, "agent", {
          entry: "index.html",
          beforeCommit: async () => {},
          commit: () => {},
        });
      }

      // Only the 3 most recent versions (5, 4, 3) are retained
      const retained = listVersions(t).map((v) => v.version);
      expect(retained).toEqual([5, 4, 3]);

      // Pruned versions' unique blobs (v1, v2) were immediately removed from stored_files AND R2
      expect(t.db.one("SELECT 1 AS x FROM stored_files WHERE hash = ?", hashes[0]!)).toBeNull();
      expect(t.db.one("SELECT 1 AS x FROM stored_files WHERE hash = ?", hashes[1]!)).toBeNull();
      expect(await env.FILES.head(fileKey(t, hashes[0]!))).toBeNull();
      expect(await env.FILES.head(fileKey(t, hashes[1]!))).toBeNull();

      // Retained versions (v3, v4, v5) and shared blob remain intact in stored_files & R2
      expect(t.db.one("SELECT status FROM stored_files WHERE hash = ?", sharedHash)).toEqual({ status: "ready" });
      expect(await env.FILES.head(fileKey(t, sharedHash))).not.toBeNull();
      for (const kept of hashes.slice(2)) {
        expect(t.db.one("SELECT status FROM stored_files WHERE hash = ?", kept)).toEqual({ status: "ready" });
        expect(await env.FILES.head(fileKey(t, kept))).not.toBeNull();
      }
    });
  });

  it("automatically prunes the oldest non-current version under tight account storage pressure without ever touching the current version", async () => {
    const h = await create();
    // Tighten this account's storage cap so only ~2 blobs fit simultaneously
    await env.ACCOUNTS.prepare("UPDATE accounts SET storage_cap = 2500 WHERE id = ?").bind(h.account!).run();

    await inDO(h.id, async (t) => {
      const v1 = await storeContent(t, bytes(`<html>v1-${"a".repeat(950)}</html>`), "text/html");
      await createVersion(t, new Map([["index.html", { path: "index.html", hash: v1.hash, size: v1.size, type: "text/html" }]]), "v1", "agent", {
        entry: "index.html",
        beforeCommit: async () => {},
        commit: () => {},
      });

      const v2 = await storeContent(t, bytes(`<html>v2-${"b".repeat(950)}</html>`), "text/html");
      await createVersion(t, new Map([["index.html", { path: "index.html", hash: v2.hash, size: v2.size, type: "text/html" }]]), "v2", "agent", {
        entry: "index.html",
        beforeCommit: async () => {},
        commit: () => {},
      });

      // Uploading v3 (~960 bytes) would exceed 2500 bytes (960*3 = 2880 > 2500),
      // so storeContent must automatically evict v1 (oldest non-current) and succeed!
      const v3 = await storeContent(t, bytes(`<html>v3-${"c".repeat(950)}</html>`), "text/html");
      await createVersion(t, new Map([["index.html", { path: "index.html", hash: v3.hash, size: v3.size, type: "text/html" }]]), "v3", "agent", {
        entry: "index.html",
        beforeCommit: async () => {},
        commit: () => {},
      });

      expect(listVersions(t).map((v) => v.version)).toEqual([3, 2]);
      expect(t.db.one("SELECT 1 AS x FROM stored_files WHERE hash = ?", v1.hash)).toBeNull();
      expect(await env.FILES.head(fileKey(t, v1.hash))).toBeNull();
      expect(t.db.one("SELECT status FROM stored_files WHERE hash = ?", v3.hash)).toEqual({ status: "ready" });

      // A single upload that exceeds the cap even with only the current version retained still rejects cleanly with 413
      await expect(storeContent(t, bytes(`<html>huge-${"z".repeat(2000)}</html>`), "text/html")).rejects.toMatchObject({ status: 413 });
      // And the current version (v3) is still intact!
      expect(listVersions(t).map((v) => v.version)).toEqual([3]);
      expect(t.db.one("SELECT status FROM stored_files WHERE hash = ?", v3.hash)).toEqual({ status: "ready" });
    });
  });
});
