let _verbose = false;

export function setVerbose(v: boolean): void {
  _verbose = v;
}

export function isVerbose(): boolean {
  return _verbose;
}

export function log(msg: string): void {
  process.stderr.write(`[gitm] ${msg}\n`);
}

export function debug(msg: string): void {
  if (_verbose) process.stderr.write(`[gitm] ${msg}\n`);
}
