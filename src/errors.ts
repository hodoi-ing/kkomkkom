import type { MessageKey } from "./i18n.js";

export class KkomkkomError extends Error {
  readonly key: MessageKey;
  readonly vars: Record<string, string | number>;

  constructor(key: MessageKey, vars: Record<string, string | number> = {}) {
    super(key);
    this.name = "KkomkkomError";
    this.key = key;
    this.vars = vars;
  }
}
