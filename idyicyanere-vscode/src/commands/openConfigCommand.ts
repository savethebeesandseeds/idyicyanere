import { log } from "../logging/logger";
import { ConfigService } from "../storage/configService";

export async function runOpenConfigCommand(config: ConfigService): Promise<void> {
  log.info("Command: idyicyanere.openConfig");
  await config.openInEditor();
}
