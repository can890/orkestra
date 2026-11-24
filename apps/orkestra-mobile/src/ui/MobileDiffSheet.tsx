import { useCallback, useEffect, useState } from 'react';
import {
  describeCallError,
  fetchChangedFiles,
  fetchFileHunks,
  type MobileGitChange,
  type MobileGitDiffHunk,
  type RemoteApi,
} from '@/core/wire-client';
import { Empty, ErrorNote, Loading } from './components';
import { ChevronLeftIcon, FileCodeIcon, RefreshIcon, XIcon } from './icons';

type DiffScopeTab = 'unstaged' | 'staged';

const STATUS_BADGE: Readonly<Record<string, { label: string; cls: string }>> = {
  added: { label: 'A', cls: 'is-add' },
  modified: { label: 'M', cls: 'is-mod' },
  deleted: { label: 'D', cls: 'is-del' },
  renamed: { label: 'R', cls: 'is-mod' },
};

export function MobileDiffSheet(props: {
  api: RemoteApi;
  workspaceId: string;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<DiffScopeTab>('unstaged');
  const [unstagedFiles, setUnstagedFiles] = useState<MobileGitChange[]>([]);
  const [stagedFiles, setStagedFiles] = useState<MobileGitChange[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedFile, setSelectedFile] = useState<MobileGitChange | null>(null);
  const [hunks, setHunks] = useState<MobileGitDiffHunk[]>([]);
  const [loadingHunks, setLoadingHunks] = useState(false);

  const loadFiles = useCallback(async () => {
    setLoadingFiles(true);
    setError(null);
    try {
      const [unstaged, staged] = await Promise.all([
        fetchChangedFiles(props.api, props.workspaceId, 'working-vs-index'),
        fetchChangedFiles(props.api, props.workspaceId, 'staged-vs-head'),
      ]);
      setUnstagedFiles(unstaged);
      setStagedFiles(staged);
    } catch (cause) {
      setError(describeCallError(cause));
    } finally {
      setLoadingFiles(false);
    }
  }, [props.api, props.workspaceId]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    if (!selectedFile) {
      setHunks([]);
      return;
    }
    let active = true;
    setLoadingHunks(true);
    setError(null);
    void fetchFileHunks(props.api, props.workspaceId, selectedFile.path, scope)
      .then((nextHunks) => {
        if (active) setHunks(nextHunks);
      })
      .catch((cause) => {
        if (active) setError(describeCallError(cause));
      })
      .finally(() => {
        if (active) setLoadingHunks(false);
      });
    return () => {
      active = false;
    };
  }, [props.api, props.workspaceId, selectedFile, scope]);

  const activeFiles = scope === 'unstaged' ? unstagedFiles : stagedFiles;

  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-label="Kod değişiklikleri">
      <div className="sheet-backdrop" onClick={props.onClose} />
      <div className="sheet-panel diff-sheet-panel">
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-header">
          {selectedFile ? (
            <button
              type="button"
              className="wb-icon-btn sm"
              onClick={() => setSelectedFile(null)}
              aria-label="Dosya listesine dön"
            >
              <ChevronLeftIcon size={17} />
            </button>
          ) : null}
          <div className="sheet-title-group">
            <h2 className="sheet-title">
              {selectedFile ? selectedFile.path.split('/').pop() : 'Değişiklikler'}
            </h2>
            <p className="sheet-subtitle mono">
              {selectedFile
                ? selectedFile.path
                : `${unstagedFiles.length} hazırlanmamış · ${stagedFiles.length} hazırlanan`}
            </p>
          </div>
          <button
            type="button"
            className="wb-icon-btn sm"
            onClick={() => void loadFiles()}
            aria-label="Değişiklikleri yenile"
          >
            <RefreshIcon size={15} />
          </button>
          <button
            type="button"
            className="wb-icon-btn sm"
            onClick={props.onClose}
            aria-label="Kapat"
          >
            <XIcon size={17} />
          </button>
        </div>

        <div className="sheet-body diff-sheet-body">
          {!selectedFile ? (
            <div className="diff-scope-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={scope === 'unstaged'}
                className={`diff-scope-tab ${scope === 'unstaged' ? 'is-active' : ''}`}
                onClick={() => setScope('unstaged')}
              >
                Hazırlanmamış ({unstagedFiles.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={scope === 'staged'}
                className={`diff-scope-tab ${scope === 'staged' ? 'is-active' : ''}`}
                onClick={() => setScope('staged')}
              >
                Hazırlanan ({stagedFiles.length})
              </button>
            </div>
          ) : null}

          <ErrorNote message={error} />

          {selectedFile ? (
            loadingHunks ? (
              <Loading label="Diff yükleniyor…" />
            ) : hunks.length === 0 ? (
              <Empty icon={<FileCodeIcon size={28} />} title="Metin diff bulunamadı">
                Dosya ikili olabilir veya bu kapsamda değişiklik içermiyor.
              </Empty>
            ) : (
              <div className="mobile-diff-hunks">
                {hunks.map((hunk) => (
                  <div key={hunk.id} className="mobile-diff-hunk">
                    <div className="mobile-diff-hunk-head mono">{hunk.header}</div>
                    <pre className="mobile-diff-code mono">
                      {hunk.lines.map((line, idx) => {
                        const cls = line.startsWith('+')
                          ? 'is-add'
                          : line.startsWith('-')
                            ? 'is-del'
                            : 'is-ctx';
                        return (
                          <div key={idx} className={`mobile-diff-line ${cls}`}>
                            {line || ' '}
                          </div>
                        );
                      })}
                    </pre>
                  </div>
                ))}
              </div>
            )
          ) : loadingFiles ? (
            <Loading label="Değişen dosyalar alınıyor…" />
          ) : activeFiles.length === 0 ? (
            <Empty icon={<FileCodeIcon size={28} />} title="Değişiklik yok">
              {scope === 'unstaged'
                ? 'Çalışma ağacında hazırlanmamış değişiklik yok.'
                : 'Hazırlanan (staged) dosya yok.'}
            </Empty>
          ) : (
            <div className="diff-file-list">
              {activeFiles.map((file) => {
                const badge = STATUS_BADGE[file.status] ?? STATUS_BADGE['modified']!;
                return (
                  <button
                    key={file.path}
                    type="button"
                    className="diff-file-row"
                    onClick={() => setSelectedFile(file)}
                  >
                    <span className={`diff-status-badge ${badge.cls}`}>{badge.label}</span>
                    <span className="diff-file-path mono">{file.path}</span>
                    <span className="diff-file-counts mono">
                      {file.additions > 0 ? <span className="is-add">+{file.additions}</span> : null}
                      {file.deletions > 0 ? <span className="is-del">-{file.deletions}</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
