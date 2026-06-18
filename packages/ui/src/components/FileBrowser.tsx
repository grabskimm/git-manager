import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { FileViewer } from "./FileViewer";
import type { Branch, FileContent, TreeEntry } from "../types";

export function FileBrowser({
  repoId,
  branches,
  defaultRef,
}: {
  repoId: string;
  branches: Branch[];
  defaultRef: string;
}) {
  const [ref, setRef] = useState(defaultRef);
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadDir = useCallback(
    async (r: string, path: string) => {
      setError(null);
      setLoading(true);
      try {
        const res = await api.tree(repoId, r, path);
        setEntries(res.entries);
        setDir(path);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [repoId],
  );

  // Reset the browser when the repo (or its default ref) changes, so we never
  // issue tree/file requests with a previous repo's ref/path.
  useEffect(() => {
    setRef(defaultRef);
    setDir("");
    setFile(null);
  }, [repoId, defaultRef]);

  useEffect(() => {
    setFile(null);
    void loadDir(ref, "");
  }, [ref, loadDir]);

  const openEntry = async (entry: TreeEntry) => {
    if (entry.type === "tree") {
      setFile(null);
      void loadDir(ref, entry.path);
    } else {
      setError(null);
      try {
        setFile(await api.file(repoId, ref, entry.path));
      } catch (e) {
        setError((e as Error).message);
      }
    }
  };

  const crumbs = dir ? dir.split("/").filter(Boolean) : [];

  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="faint">ref</span>
        <select value={ref} onChange={(e) => setRef(e.target.value)} style={{ width: 200 }}>
          {branches.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        </select>
      </div>

      <div className="breadcrumbs">
        <button type="button" className="crumb" onClick={() => { setFile(null); void loadDir(ref, ""); }}>
          {repoId.slice(0, 8)}
        </button>
        {crumbs.map((c, i) => {
          const p = crumbs.slice(0, i + 1).join("/");
          return (
            <span key={p}>
              {" / "}
              <button type="button" className="crumb" onClick={() => { setFile(null); void loadDir(ref, p); }}>
                {c}
              </button>
            </span>
          );
        })}
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="file-layout">
        <div className="file-tree">
          {dir && (
            <div
              className="tree-row"
              onClick={() => {
                const parent = crumbs.slice(0, -1).join("/");
                setFile(null);
                void loadDir(ref, parent);
              }}
            >
              <span className="ic">↩</span> ..
            </div>
          )}
          {loading && <div className="tree-row faint">Loading…</div>}
          {!loading && entries.length === 0 && <div className="tree-row faint">Empty</div>}
          {entries.map((e) => (
            <div
              key={e.path}
              className={`tree-row ${file?.path === e.path ? "active" : ""}`}
              onClick={() => openEntry(e)}
            >
              <span className="ic">{e.type === "tree" ? "▸" : "·"}</span>
              {e.name}
            </div>
          ))}
        </div>

        <div>
          {file ? (
            <FileViewer file={file} />
          ) : (
            <div className="empty subtle">Select a file to view its contents.</div>
          )}
        </div>
      </div>
    </div>
  );
}
