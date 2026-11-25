/**
 * Depolama temizliğinin bir öğeyi neden kaldırdığını ya da tuttuğunu anlatan metinler.
 *
 * Nedenler ana süreçte üretilip rapor olarak saklanır ve RPC ile ayarlar sayfasına gider; Türkçe
 * yama (`tooling/localization/patch-tr.cjs`) yalnızca belirli kod biçimlerindeki metinleri görür.
 * Ana süreçte `keep('…')` çağrı argümanları ve küçük harfle başlayan `reason:` değerleri
 * çevrilmiyordu, `has ${n} ${n === 1 ? 'commit' : 'commits'} …` gibi parçalı metinler ise
 * sözlükte hiç eşleşemiyordu. Bu yüzden her neden burada, tam cümle olarak, adı `_LABELS` ile
 * biten bir etiket tablosunda durur: yama tablodaki her değeri (işlevlerin döndürdüğü şablonlar
 * dahil) çevirir. Yeni bir neden eklerken parça birleştirmeyin; tekil/çoğul için iki tam metin
 * yazın ve `tooling/localization/ui-tr.json` sözlüğüne ekleyin.
 *
 * Metinler küçük harfle başlar; gösterilmeden önce `sentence()` ilk harfi büyütür. Türkçe
 * karşılıklar küçük "i" ile başlamamalıdır (JavaScript "i"yi "I" yapar, "İ" değil).
 */
export const STORAGE_CLEANUP_REASON_LABELS = {
  // Worktree yolu güvenliği.
  folderMissing: 'worktree folder is missing',
  symbolicLink: 'worktree is a symbolic link',
  notAFolder: 'worktree is not a folder',
  unresolvedPath: 'worktree path could not be resolved',
  outsideManagedRoots: 'outside the Orkestra worktree folders',
  mainCheckout: 'main checkout of the project',
  containsCheckout: 'contains a project checkout',
  notLinkedWorktree: 'not a linked worktree',
  // Yerel değişiklikler.
  changesNotInspected: 'local changes could not be inspected',
  uncommittedChanges: (files: number) =>
    files === 1 ? 'has uncommitted changes (1 file)' : `has uncommitted changes (${files} files)`,
  gitOperationInProgress: 'has a git operation in progress',
  // Görev ve oturum durumu.
  sharedByTasks: (tasks: number) => `shared by ${tasks} tasks`,
  noTask: 'no task uses this worktree',
  pinned: 'task is pinned',
  agentBusy: 'an agent is working in this task',
  recentlyOpened: 'opened or active in the last hour',
  repositoryNotInspected: 'repository could not be inspected',
  branchChanged: 'repository or branch changed',
  sessionsNotChecked: 'running sessions could not be checked',
  sessionOpen: 'an agent or terminal session is open',
  // Kurallar.
  inactiveFor: (days: number) => `inactive for ${days} days`,
  archivedFor: (days: number) => `archived for ${days} days`,
  settledFor: (days: number) => `settled for ${days} days`,
  inactiveNotDue: (days: number, limit: number) => `inactive for ${days} of ${limit} days`,
  settledNotDue: (days: number, limit: number) => `settled for ${days} of ${limit} days`,
  notSettled: 'task is not settled or archived',
  notMerged: 'not merged',
  hasOwnCommits: 'has commits beyond the default branch',
  noCommit: 'worktree has no commit',
  projectBranchUnavailable: 'project branch is unavailable',
  defaultBranchUnavailable: 'default branch is unavailable',
  noCommitsBeyondDefault: 'no commits beyond the default branch',
  noCommitsBeyondProject: 'no commits beyond the project branch',
  merged: 'branch was merged into the default branch',
  unpushedNotInspected: 'unpushed commits could not be inspected',
  unpushedCommits: (commits: number) =>
    commits === 1
      ? 'has 1 commit not pushed to a remote'
      : `has ${commits} commits not pushed to a remote`,
  // Kaldırmadan hemen önceki yeniden denetim.
  taskChangedSinceCheck: 'task or worktree changed since check',
  settingsChangedSinceCheck: 'settings changed since check',
  movedSinceCheck: 'worktree moved since check',
  commitChangedSinceCheck: 'commit changed since check',
  branchChangedSinceCheck: 'repository or branch changed since check',
  // Günlük ve önbellek dosyaları.
  noExpiredFiles: (days: number) => `No files older than ${days} days`,
  expiredFiles: (files: number, days: number) =>
    files === 1 ? `1 file older than ${days} days` : `${files} files older than ${days} days`,
  expiredFilesWithFailures: (files: number, days: number, failed: number) =>
    files === 1
      ? `1 file older than ${days} days (${failed} could not be removed)`
      : `${files} files older than ${days} days (${failed} could not be removed)`,
};
