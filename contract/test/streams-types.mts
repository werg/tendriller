import { createClient } from "../client.mjs";
import type { RuntimeApi, StreamBatch, StreamLatest, StreamTrimResult, StreamRecord, DeliveryProbe } from "../index.mjs";
const client = createClient({ api: "https://example.test/api/t/id", token: "tp_example" });
void client.streams.create({ name: "training.loss", durability: "durable", max_records: 1000 });
void client.streams.append("training.loss", { records: [{ id: "run:1", type: "metric", data: { loss: 0.4 } }] });
void client.streams.append("live.pointer", { records: [{ type: "pointer", data: { x: 10, y: 20 } }] });
const batch: Promise<StreamBatch> = client.streams.read("training.loss", { after: 0 });
void batch;
const latest: Promise<StreamLatest> = client.streams.latest("training.loss");
const recovered: Promise<DeliveryProbe> = client.checkDeliveryProbe();
void latest; void recovered;
const trimmed: Promise<StreamTrimResult> = client.streams.trim("training.loss", { through: 1 });
void trimmed;
// @ts-expect-error deletion requires an explicit observed bound
void client.streams.trim("training.loss", {});
// @ts-expect-error replay requires an explicit cursor
void client.streams.read("training.loss", {});
// @ts-expect-error ephemeral streams have no retention
void client.streams.create({ name: "utilization", durability: "ephemeral", max_records: 10 });
declare const page: RuntimeApi;
const snapshot: StreamLatest = await page.streams.latest("training.loss");
const current: StreamRecord | null = snapshot.record;
void current;
const unsubscribe: () => void = page.streams.subscribe("training.loss", (record: StreamRecord) => { console.log(record.data); }, { after: 0 });
unsubscribe();
