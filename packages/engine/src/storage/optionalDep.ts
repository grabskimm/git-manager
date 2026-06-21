/**
 * Dynamic import for optional cloud SDKs. The SDKs are declared as regular
 * dependencies, but a stale `node_modules` (e.g. deps added after the last
 * `npm install`) can leave them missing at runtime. We surface that as a clear,
 * actionable error instead of letting it masquerade as an auth failure.
 */

export class MissingDepError extends Error {
  constructor(public readonly pkg: string) {
    super(
      `${pkg} is not installed. Your dependencies are out of date — run \`npm install\` ` +
        `in the GitManager project (or reinstall the gitm CLI), then restart the engine.`,
    );
    this.name = "MissingDepError";
  }
}

function isModuleNotFound(e: unknown): boolean {
  const code = (e as { code?: string }).code;
  const msg = (e as Error)?.message ?? "";
  return (
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    /Cannot find (package|module)/i.test(msg)
  );
}

/** Import an optional dependency, throwing MissingDepError if it isn't installed. */
export async function loadDep(name: string): Promise<any> {
  try {
    return await import(name);
  } catch (e) {
    if (isModuleNotFound(e)) throw new MissingDepError(name);
    throw e;
  }
}
