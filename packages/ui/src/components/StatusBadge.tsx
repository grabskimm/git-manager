import type { PrStatus } from "../types";

const LABEL: Record<PrStatus, string> = {
  open: "Open",
  merged: "Merged",
  conflicted: "Conflicted",
  closed: "Closed",
};

export function StatusBadge({ status }: { status: PrStatus }) {
  return (
    <span className={`badge ${status}`}>
      <span className="dotmark" />
      {LABEL[status]}
    </span>
  );
}
