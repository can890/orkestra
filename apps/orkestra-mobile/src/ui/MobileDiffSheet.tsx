import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { triggerHaptic } from '@/core/native-bridge';
import {
  fetchReviewFiles,
  fetchReviewHunks,
  listReviewPullRequests,
  setReviewViewed,
  type ReviewFile,
  type ReviewPullRequest,
} from '@/core/pull-request-review';
import {
  describeCallError,
  fetchChangedFiles,
  fetchFileHunks,
  type MobileGitChange,
  type MobileGitDiffHunk,
  type RemoteApi,
} from '@/core/wire-client';
import { Empty, ErrorNote, Loading } from './components';
import {
  CheckIcon,
  ChevronLeftIcon,
  CopyIcon,
  FileCodeIcon,
  MessageSquareIcon,
  RefreshIcon,
  SearchIcon,
  XIcon,
} from './icons';

type DiffScopeTab = 'unstaged' | 'staged' | 'pr';

const STATUS_BADGE: Readonly<Record<string, { label: string; cls: string }>> = {
  added: { label: 'A', cls: 'is-add' },
  modified: { label: 'M', cls: 'is-mod' },
  deleted: { label: 'D', cls: 'is-del' },
  renamed: { label: 'R', cls: 'is-mod' },
};

export function MobileDiffSheet(props: {
  api: RemoteApi;
  workspaceId: string;
  onAskAboutFile?: (filePath: string) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<DiffScopeTab>('unstaged');
  const [unstagedFiles, setUnstagedFiles] = useState<MobileGitChange[]>([]);
  const [stagedFiles, setStagedFiles] = useState<MobileGitChange[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileFilter, setFileFilter] = useState('');

  const [selectedFile, setSelectedFile] = useState<MobileGitChange | null>(null);
  const [hunks, setHunks] = useState<MobileGitDiffHunk[]>([]);
  const [loadingHunks, setLoadingHunks] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pullRequests, setPullRequests] = useState<ReviewPullRequest[]>([]);
  const [reviewUrl, setReviewUrl] = useState('');
  const [reviewAccount, setReviewAccount] = useState('');
  const reviewWriteVersion = useRef(0);
  const [reviewFiles, setReviewFiles] = useState<ReviewFile[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewRefresh, setReviewRefresh] = useState(0);
  const [savingReview, setSavingReview] = useState(false);
  const reviewFile =
    scope === 'pr' && selectedFile
      ? reviewFiles.find((file) => file.path === selectedFile.path)
      : undefined;
  const reviewRevision = reviewFile?.revision;
  const patchPath = selectedFile?.path;

  useEffect(() => {
    if (scope !== 'pr') return;
    let active = true;
    setReviewLoading(true);
    setError(null);
    void listReviewPullRequests(props.api, props.workspaceId)
      .then((items) => {
        if (!active) return;
        setPullRequests(items);
        setReviewUrl((current) =>
          items.some(({ url }) => url === current) ? current : (items[0]?.url ?? '')
        );
      })
      .catch((cause) => {
        if (active) setError(describeCallError(cause));
      })
      .finally(() => {
        if (active) setReviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [scope, props.api, props.workspaceId, reviewRefresh]);

  useEffect(() => {
    if (scope !== 'pr' || !reviewUrl) return;
    let active = true;
    let fetching = false;
    const read = async () => {
      if (fetching) return;
      fetching = true;
      const version = reviewWriteVersion.current;
      try {
        const result = await fetchReviewFiles(props.api, props.workspaceId, reviewUrl);
        if (active && version === reviewWriteVersion.current) {
          setReviewAccount(result.account);
          setReviewFiles(result.files);
        }
      } catch (cause) {
        if (active) setError(describeCallError(cause));
      } finally {
        fetching = false;
        if (active) setReviewLoading(false);
      }
    };
    setReviewLoading(true);
    void read();
    const timer = setInterval(() => void read(), 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [scope, props.api, props.workspaceId, reviewUrl, reviewRefresh]);

  async function toggleReview(file: ReviewFile) {
    if (savingReview || !reviewAccount) return;
    setSavingReview(true);
    reviewWriteVersion.current += 1;
    setError(null);
    try {
      await setReviewViewed(props.api, props.workspaceId, reviewUrl, file, reviewAccount);
      reviewWriteVersion.current += 1;
      setReviewFiles((current) =>
        current.map((value) =>
          value.path === file.path && value.revision === file.revision
            ? { ...value, viewed: !file.viewed }
            : value
        )
      );
    } catch (cause) {
      setError(describeCallError(cause));
    } finally {
      setSavingReview(false);
    }
  }

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
    if (!patchPath || (scope === 'pr' && !reviewRevision)) {
      setHunks([]);
      setLoadingHunks(false);
      return;
    }
    let active = true;
    setLoadingHunks(true);
    setError(null);
    const patch =
      scope === 'pr'
        ? fetchReviewHunks(props.api, props.workspaceId, reviewUrl, {
            path: patchPath,
            revision: reviewRevision!,
          })
        : fetchFileHunks(props.api, props.workspaceId, patchPath, scope);
    void patch
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
  }, [props.api, props.workspaceId, patchPath, scope, reviewUrl, reviewRevision]);

  const activeFiles =
    scope === 'pr' ? reviewFiles : scope === 'unstaged' ? unstagedFiles : stagedFiles;
  const unreadFile = reviewFiles.find((file) => !file.viewed);
  const reviewedCount = reviewFiles.filter((file) => file.viewed).length;
  const filesBusy = scope === 'pr' ? reviewLoading : loadingFiles;
  const filteredFiles = useMemo(() => {
    const q = fileFilter.trim().toLowerCase();
    if (!q) return activeFiles;
    return activeFiles.filter((f) => f.path.toLowerCase().includes(q));
  }, [activeFiles, fileFilter]);

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const f of activeFiles) {
      additions += f.additions;
      deletions += f.deletions;
    }
    return { additions, deletions };
  }, [activeFiles]);

  async function copyText(id: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      triggerHaptic('light');
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1800);
    } catch {
      // yoksay
    }
  }

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
                : scope === 'pr'
                  ? `${reviewedCount} / ${reviewFiles.length} dosya incelendi`
                  : `${unstagedFiles.length} hazırlanmamış · ${stagedFiles.length} hazırlanan`}
            </p>
          </div>
          {selectedFile ? (
            <button
              type="button"
              className="wb-icon-btn sm"
              onClick={() => void copyText('path', selectedFile.path)}
              aria-label="Dosya yolunu kopyala"
              title="Dosya yolunu kopyala"
            >
              {copiedId === 'path' ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
            </button>
          ) : (
            <button
              type="button"
              className={`wb-icon-btn sm ${filesBusy ? 'is-spinning' : ''}`}
              onClick={() =>
                scope === 'pr' ? setReviewRefresh((revision) => revision + 1) : void loadFiles()
              }
              aria-label="Değişiklikleri yenile"
            >
              <RefreshIcon size={15} />
            </button>
          )}
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
            <>
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
                <button
                  type="button"
                  role="tab"
                  aria-selected={scope === 'pr'}
                  className={`diff-scope-tab ${scope === 'pr' ? 'is-active' : ''}`}
                  onClick={() => {
                    setFileFilter('');
                    setScope('pr');
                  }}
                >
                  PR İnceleme
                </button>
              </div>

              {scope === 'pr' && pullRequests.length > 0 ? (
                <div className="diff-file-actions-bar">
                  <select
                    className="btn btn-secondary btn-sm flex1"
                    aria-label="İncelenecek PR"
                    value={reviewUrl}
                    onChange={(event) => {
                      setReviewFiles([]);
                      setReviewUrl(event.target.value);
                    }}
                  >
                    {pullRequests.map((pr) => (
                      <option key={pr.url} value={pr.url}>
                        #{pr.number} {pr.title}
                      </option>
                    ))}
                  </select>
                  {unreadFile ? (
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      disabled={reviewLoading}
                      onClick={() => setSelectedFile(unreadFile)}
                    >
                      Devam et
                    </button>
                  ) : null}
                </div>
              ) : null}

              {activeFiles.length > 0 ? (
                <div className="diff-summary-strip mono">
                  <span>{activeFiles.length} dosya</span>
                  <span className="diff-summary-counts">
                    {totals.additions > 0 ? (
                      <span className="is-add">+{totals.additions}</span>
                    ) : null}
                    {totals.deletions > 0 ? (
                      <span className="is-del">-{totals.deletions}</span>
                    ) : null}
                  </span>
                </div>
              ) : null}

              {activeFiles.length > 4 ? (
                <div className="search-field">
                  <SearchIcon size={14} className="search-field-icon" />
                  <input
                    type="search"
                    className="search-field-input"
                    value={fileFilter}
                    placeholder="Dosya filtrele…"
                    onChange={(e) => setFileFilter(e.target.value)}
                  />
                  {fileFilter ? (
                    <button
                      type="button"
                      className="search-clear-btn"
                      onClick={() => setFileFilter('')}
                      aria-label="Filtreyi temizle"
                    >
                      <XIcon size={13} />
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : scope === 'pr' && reviewFile ? (
            <div className="diff-file-actions-bar">
              <button
                type="button"
                className="btn btn-secondary btn-sm flex1"
                aria-pressed={reviewFile.viewed}
                disabled={savingReview || loadingHunks || !reviewAccount}
                onClick={() => void toggleReview(reviewFile)}
              >
                {reviewFile.viewed ? <CheckIcon size={15} /> : null}
                {reviewFile.viewed ? 'İncelenmedi olarak işaretle' : 'İncelendi olarak işaretle'}
              </button>
            </div>
          ) : props.onAskAboutFile ? (
            <div className="diff-file-actions-bar">
              <button
                type="button"
                className="btn btn-secondary btn-sm flex1"
                onClick={() => {
                  triggerHaptic('light');
                  props.onAskAboutFile?.(selectedFile.path);
                  props.onClose();
                }}
              >
                <MessageSquareIcon size={13} />
                <span>Bu dosya hakkında ajana sor</span>
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
                    <div className="mobile-diff-hunk-head mono">
                      <span className="mobile-diff-hunk-title">{hunk.header}</span>
                      <button
                        type="button"
                        className="md-copy-btn"
                        onClick={() =>
                          void copyText(hunk.id, `${hunk.header}\n${hunk.lines.join('\n')}`)
                        }
                      >
                        {copiedId === hunk.id ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                        <span>{copiedId === hunk.id ? 'Kopyalandı' : 'Kopyala'}</span>
                      </button>
                    </div>
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
          ) : filesBusy ? (
            <Loading label="Değişen dosyalar alınıyor…" />
          ) : filteredFiles.length === 0 ? (
            <Empty icon={<FileCodeIcon size={28} />} title="Değişiklik yok">
              {fileFilter
                ? 'Filtreye uyan dosya bulunamadı.'
                : scope === 'pr'
                  ? 'Bu çalışma alanında incelenecek açık PR dosyası yok.'
                  : scope === 'unstaged'
                    ? 'Çalışma ağacında hazırlanmamış değişiklik yok.'
                    : 'Hazırlanan (staged) dosya yok.'}
            </Empty>
          ) : (
            <div className="diff-file-list">
              {filteredFiles.map((file) => {
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
                    {'viewed' in file && file.viewed ? (
                      <span aria-label="İncelendi">
                        <CheckIcon size={16} />
                      </span>
                    ) : null}
                    <span className="diff-file-counts mono">
                      {file.additions > 0 ? (
                        <span className="is-add">+{file.additions}</span>
                      ) : null}
                      {file.deletions > 0 ? (
                        <span className="is-del">-{file.deletions}</span>
                      ) : null}
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
