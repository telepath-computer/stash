import { createServiceController } from "./controller.ts";

const service = createServiceController();

export const install = service.install;
export const uninstall = service.uninstall;
export const status = service.status;
