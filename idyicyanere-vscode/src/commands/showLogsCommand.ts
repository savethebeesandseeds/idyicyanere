import { log } from "../logging/logger";

export function runShowLogsCommand(): void {
  log.show(true);
  log.info("Command: idyicyanere.showLogs");
}
