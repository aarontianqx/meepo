import { CURRENT_PROTOCOL_VERSION } from "@meepo/protocol";

export async function startServer(): Promise<void> {
  console.log(`Starting MEEPO Server (Protocol: ${CURRENT_PROTOCOL_VERSION})...`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((err) => {
    console.error("Failed to start MEEPO server:", err);
    process.exit(1);
  });
}
