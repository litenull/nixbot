import { z } from "zod";

export const config = z.object({
  groupsDir: z.string().default("./groups"),
  dataDir: z.string().default("./data"),
  sandboxBin: z.string().default("./result/bin/browser-agent"),
}).parse({
  groupsDir: process.env.NANIX_GROUPS_DIR,
  dataDir: process.env.NANIX_DATA_DIR,
  sandboxBin: process.env.NANIX_SANDBOX_BIN,
});
