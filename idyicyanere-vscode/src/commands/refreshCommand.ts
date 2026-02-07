import { log } from "../logging/logger";

type Refreshables = {
  filesView?: { refresh: () => void };
  chatView?: { refresh: () => void };
  editView?: { refresh: () => void };
  dbView?: { refresh: () => void };
  configView?: { refresh: () => void };
};

export function runRefreshCommand(v: Refreshables): void {
  log.info("Command: idyicyanere.refresh");
  v.filesView?.refresh();
  v.chatView?.refresh();
  v.editView?.refresh();
  v.dbView?.refresh();
  v.configView?.refresh();
}
