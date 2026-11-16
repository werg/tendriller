import type { BlobTransferClient } from "../../dist/sdk/blobs-client.mjs";

/** Test pages use the same explicit complete-graph publication command as authors. */
export async function publishAssetGraph(client: BlobTransferClient,
  assets: Record<string, { body: string | Uint8Array; type: string }>, entry = "index.html") {
  const { head_revision } = await client.publications.list();
  const files = [];
  for (const path of Object.keys(assets).sort()) {
    const asset = assets[path];
    const bytes = typeof asset.body === "string" ? new TextEncoder().encode(asset.body) : asset.body;
    const { blob } = await client.blobs.upload(bytes, { name: path, type: asset.type, cid: crypto.randomUUID() });
    files.push({ path, blob_id: blob.id, type: asset.type });
  }
  return client.publications.publish({ cid: crypto.randomUUID(), expected_generations: {},
    expected_head_revision: head_revision, entry, files });
}
