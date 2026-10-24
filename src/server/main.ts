import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { Director } from "./director.js";
import { createApp } from "./app.js";
import { LiveProvider } from "./live.js";
import { DemoProvider } from "../effects/demo.js";

const config = loadConfig();
const live = config.mode === "live" ? new LiveProvider(config) : undefined;
const director = new Director(config, live || new DemoProvider());
if (live) live.director = director;
await director.initialize();
const server = createServer(createApp(director, live));
server.listen(config.port, config.host, () => {
  console.log(`Director's Cut · ${config.mode.toUpperCase()}\nControl room: http://localhost:${config.port}\nOBS overlay:  http://localhost:${config.port}/overlay`);
  if (live) void live.resume();
});
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  live?.stop(); server.close(); server.closeAllConnections();
  await director.stop();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
server.on("error", error => { console.error(error.message); void shutdown(); process.exitCode = 1; });
