/** Snapshot-aware, replay-safe, complete Contract 3 publication uploads. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { uploadBlob } from "./blobs.mjs";
const digest = value => createHash("sha256").update(value).digest("hex");
const sorted = entries => [...entries].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
function readRecord(path) { return path && existsSync(path) ? JSON.parse(readFileSync(path,"utf8")) : null; }
function saveRecord(path, value) {
  if (!path) return;
  const tmp = path + "." + randomUUID() + ".tmp";
  try { writeFileSync(tmp, JSON.stringify(value) + "\n", {mode:0o600,flag:"wx"}); renameSync(tmp,path); }
  finally { try {unlinkSync(tmp);} catch {} }
}
/** Capture the original head, guards and every upload identity before transport. */
export async function publishFiles(api, enumeration, {
  merge = false, generations = {}, scope, cid, resumeFile,
  maxBytes = 5 * 1024 * 1024, concurrency = 3,
} = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new RangeError("Upload concurrency must be 1..8");
  const filesToUpload = sorted(enumeration.files);
  const fingerprint = digest(JSON.stringify({merge,files:filesToUpload.map(f=>({path:f.path,size:f.size,sha256:f.sha256,type:f.type})),
    entry:enumeration.entry??null,message:enumeration.message??null,generations,scope:scope??null}));
  let record = readRecord(resumeFile);
  if (record && (record.fingerprint !== fingerprint || (cid && record.cid !== cid)))
    throw new Error("A saved publication belongs to different bytes/guards. Choose a new resume record for a new publication");
  if (!record) {
    const head = await api.get("/publications");
    if (!Number.isSafeInteger(head.head_revision) || head.head_revision < 0)
      throw new Error("Service did not return an authoritative publication head revision");
    const previous = head.current ? await api.get(`/publications/${head.current}`) : null;
    if (merge && !previous) throw new Error("--no-replace requires an existing publication");
    const oldFiles = previous ? previous.files : [];
    if (!Array.isArray(oldFiles) || oldFiles.some(file => typeof file.path !== "string" ||
      !/^b_[a-z2-7]{20}$/.test(file.blob_id) || !/^[0-9a-f]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.type !== "string"))
      throw new Error("Service did not return a complete verified publication manifest");
    record = {
      fingerprint, cid:cid ?? randomUUID(), expected_head_revision:head.head_revision,
      entry:enumeration.entry ?? previous?.entry,
      oldFiles: merge ? oldFiles : [], knownFiles: oldFiles,
      uploads: Object.fromEntries(filesToUpload.map(f=>[f.path,{cid:randomUUID()}])),
      status:"prepared",
    };
    saveRecord(resumeFile, record);
  }
  if (record.status === "accepted") return record.result;
  const contentKey = file => `${file.sha256}:${file.size}`;
  const matching = new Map(record.knownFiles.map(file => [contentKey(file), file.blob_id]));
  const results = new Array(filesToUpload.length);
  const inflight = new Map();
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= filesToUpload.length) break;
      const f = filesToUpload[i];
      const key = contentKey(f);
      let blobId = matching.get(key);
      if (!blobId) {
        let work = inflight.get(key);
        if (!work) {
          const own = record.uploads[f.path];
          work = uploadBlob(api,f.bytes,{type:f.type,cid:own.cid,maxBytes,
            resumeFile:resumeFile && `${resumeFile}.${i}.upload.json`}).then(r => r.blob.id);
          inflight.set(key,work);
        }
        blobId = await work;
      }
      results[i] = {path:f.path,blob_id:blobId,type:f.type};
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,filesToUpload.length)},()=>worker()));
  const map = new Map(record.oldFiles.map(f=>[f.path,{path:f.path,blob_id:f.blob_id,type:f.type}]));
  for (const value of results) map.set(value.path,value);
  const files = sorted(map.values());
  if (!files.some(f=>f.path === record.entry)) throw new Error(`Publication entry not found: ${record.entry}`);
  // Save the complete immutable publish request before sending; lost replies repeat this exact CID+manifest.
  const request = record.publishRequest ?? {
    cid:record.cid, expected_generations:generations,
    ...(scope?{scope}:{}),expected_head_revision:record.expected_head_revision,
    entry:record.entry,files,...(enumeration.message === undefined ? {} : {message:enumeration.message})
  };
  record = {...record, publishRequest:request,status:"publishing"};
  saveRecord(resumeFile, record);
  const published = await api.post("/publications", request);
  const result = {...published,files:files.length,reused:results.filter((_,i)=>matching.has(contentKey(filesToUpload[i]))).length};
  saveRecord(resumeFile,{...record,result,status:"accepted"});
  return result;
}
