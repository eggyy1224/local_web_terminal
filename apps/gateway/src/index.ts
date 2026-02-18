import { buildApp } from "./app.js";

const port = Number(process.env.GATEWAY_PORT ?? 8787);

async function main() {
  const app = await buildApp();
  await app.listen({
    host: "127.0.0.1",
    port
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
