import { z } from "zod";
import { resolve } from "path";

export const config = z.object({
  groupsDir: z.string().default("./groups"),
  dataDir: z.string().default("./data"),
  sandboxBin: z.string().default(resolve("./result/bin/run-in-sandbox")),
}).parse({
  groupsDir: process.env.NIXBOT_GROUPS_DIR,
  dataDir: process.env.NIXBOT_DATA_DIR,
  sandboxBin: process.env.NIXBOT_SANDBOX_BIN ? resolve(process.env.NIXBOT_SANDBOX_BIN) : undefined,
});
