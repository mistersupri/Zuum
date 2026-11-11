import { config } from "./config";
import { buildApp } from "./app";
import { relayOutbox } from "./lib/queue";
import { startEventHub } from "./routes/stream";
import { prepareStorage } from "./lib/storage";
import { prisma } from "@zuum/db";

const app = await buildApp();
await startEventHub(app.log);

const relay = setInterval(() => {
  relayOutbox(app.log).catch((err) => app.log.error({ err }, "outbox relay error"));
}, 1000);

const shutdown = async () => {
  clearInterval(relay);
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
// Not awaited: storage may start after the API; ensureBucket retries on its own.
void prepareStorage(app.log);
