import type { Env } from "../env";
import { serviceSession } from "./auth";
import { errorResponse, readBody } from "../http";
import { publicBase } from "../urls";

type FileRow = { hash: string; size: number };
type BlobRow = { id: string; size: number };
type TendrilExport = { id: string; stored_files: FileRow[]; blobs: BlobRow[]; [key: string]: unknown };

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}

function stub(env: Env, id: string): DurableObjectStub { return env.TENDRIL.get(env.TENDRIL.idFromName(id)); }
function accountRequest(account: string, path: string, method = "GET"): Request {
  return new Request(`https://tendril.internal/account/${path}`, { method, headers: { "x-account-id": account } });
}

export async function accountData(req: Request, env: Env, url: URL): Promise<Response> {
  const session = await serviceSession(req, env);
  if (!session) return errorResponse(401, "unauthorized", "Sign in first");
  const account = session.accountId;
  if (url.pathname === "/dashboard/export" && req.method === "GET") {
    const rows = await env.ACCOUNTS.prepare("SELECT id, created_at, lifetime, state FROM tendrils WHERE owner_account = ? ORDER BY created_at")
      .bind(account).all<{ id: string; created_at: number; lifetime: string; state: string }>();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const put = (value: string) => controller.enqueue(encoder.encode(value));
        try {
          put(`{"account":{"id":${JSON.stringify(account)},"email":${JSON.stringify(session.email)}},"tendrils":[`);
          let first = true;
          for (const row of rows.results) {
            const response = await stub(env, row.id).fetch(accountRequest(account, "export"));
            if (!response.ok) throw new Error(`Could not export tendril ${row.id}`);
            const data = await response.json() as TendrilExport;
            const { stored_files, blobs, ...meta } = data;
            if (!first) put(",");
            first = false;
            put(`${JSON.stringify({ ...row, ...meta, blobs }).slice(0, -1)},"files":[`);
            let firstFile = true;
            for (const file of stored_files) {
              const object = await env.FILES.get(`t/${row.id}/files/${file.hash}`);
              if (!object) throw new Error(`Missing file ${file.hash}`);
              const bytes = new Uint8Array(await object.arrayBuffer());
              const content = base64(bytes);
              if (!firstFile) put(",");
              firstFile = false;
              put(JSON.stringify({ hash: file.hash, size: file.size, base64: content }));
            }
            put(`],"blob_contents":[`);
            let firstBlob = true;
            for (const blob of blobs) {
              const object = await env.FILES.get(`t/${row.id}/blobs/${blob.id}`);
              if (!object) throw new Error(`Missing blob ${blob.id}`);
              const bytes = new Uint8Array(await object.arrayBuffer());
              const content = base64(bytes);
              if (!firstBlob) put(",");
              firstBlob = false;
              put(JSON.stringify({ id: blob.id, size: blob.size, base64: content }));
            }
            put("]}");
          }
          put("]}");
          controller.close();
        } catch (error) { controller.error(error); }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": "attachment; filename=tendriller-export.json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
  if (url.pathname === "/dashboard/delete" && req.method === "POST") {
    if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) return errorResponse(403, "bad_origin");
    const form = new URLSearchParams(new TextDecoder().decode(await readBody(req, 4096)));
    if (form.get("confirm") !== "DELETE") return errorResponse(400, "bad_request", "Type DELETE to confirm");
    await env.ACCOUNTS.prepare("UPDATE accounts SET deleting_at = COALESCE(deleting_at, ?) WHERE id = ?")
      .bind(Date.now(), account).run();
    await env.ACCOUNTS.prepare("DELETE FROM api_keys WHERE account_id = ?").bind(account).run();
    const rows = await env.ACCOUNTS.prepare("SELECT id FROM tendrils WHERE owner_account = ?").bind(account).all<{ id: string }>();
    const results = await Promise.allSettled(rows.results.map(async row => {
      const response = await stub(env, row.id).fetch(accountRequest(account, "delete", "POST"));
      if (!response.ok) throw new Error(`Deletion failed for ${row.id}`);
    }));
    if (results.some(result => result.status === "rejected")) return errorResponse(503, "retry", "Some tendrils could not be deleted. Retry account deletion.");
    await env.ACCOUNTS.prepare("DELETE FROM accounts WHERE id = ?").bind(account).run();
    return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": "__Host-tendriller=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0" } });
  }
  return errorResponse(404, "not_found");
}
