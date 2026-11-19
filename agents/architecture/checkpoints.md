# Conversation Checkpoints (rewind)

Every user prompt sent to an ACP conversation is preceded by a snapshot of the task worktree.
A user message can later be rewound: the working files return to the state they had right before
that message was sent. Only files are rewound. The provider's conversation history and the agent's
context are untouched, and the UI says so.

## Storage

A checkpoint is a commit stored at `refs/orkestra/checkpoints/<conversationId>/<seq>` in the
checkout's repository (linked worktrees share it). `seq` is a per-conversation counter starting at
1. The commit's tree is the worktree content; its parent is the checkout's HEAD (when it has one) so
objects stay delta-friendly. Commit trailers carry the metadata:

- `Orkestra-Kind: prompt | safety`
- `Orkestra-Conversation: <conversationId>`
- `Orkestra-Prompt: <promptId>` (prompt checkpoints; the UI joins on the transcript item's
  `promptId`)
- `Orkestra-Label: <text>` (safety checkpoints)

No migration or app database is involved; git is the only store. Conversation ids must match
`[A-Za-z0-9_-]{1,128}` because they become a ref path segment.

## Snapshot (never touches the index, HEAD, or branch)

Implemented in `packages/core/src/runtimes/git/node/checkout/ops/checkpoint.ts`:

1. Copy the checkout's real index to a temporary `GIT_INDEX_FILE` (so staged-new and
   tracked-but-ignored files are kept).
2. `git add -A` and `git write-tree` against that temporary index. Untracked, non-ignored files are
   included; ignored files are not.
3. `git commit-tree` (with a fixed Orkestra identity and `commit.gpgsign=false`), then
   `git update-ref <ref> <commit> ''`. The empty old value makes the update fail if another writer
   took the sequence; creation retries with the next number.
4. At most 50 checkpoints are kept per conversation (`MAX_CHECKPOINTS_PER_CONVERSATION`); the oldest
   refs are deleted when a new one is created. Objects are left to git's own gc.

All commands run through `BoundExec`, so local and SSH hosts behave identically: the git runtime
executes on the host that owns the worktree.

## Restore

`restoreCheckpoint(conversationId, seq)`:

1. Take a **safety checkpoint** (`kind: safety`) of the current state. If this fails the restore is
   aborted before anything changes. The restore target is protected from pruning.
2. Diff the safety snapshot tree against the target tree (`git diff-tree -r -z --no-renames`).
3. Delete files that exist only in the safety snapshot (after validating each path: no `.git`
   segment, no traversal, parent resolves inside the checkout; emptied parent directories are
   removed).
4. Write added/modified files with `git checkout-index -f` against a temporary index loaded from the
   target tree, in argv chunks.

The real index, HEAD, the current branch, and ignored files are never modified; after a restore the
index simply no longer matches the working tree, as after any edit. Because the safety checkpoint is
a normal checkpoint, "Geri sarmayı geri al" is just a restore of its sequence number.

`previewCheckpointRestore` computes the same diff without changing the checkout (it only writes
objects). The preview lists at most 500 files; counts are always complete.

## Wire surface

- Git contract (`gitCheckoutContract`): `createCheckpoint`, `listCheckpoints`,
  `previewCheckpointRestore`, `restoreCheckpoint`, `deleteCheckpoints`, all selected by checkout.
  They run under the repository execution lane, so they serialize with other git commands.
- Conversations contract (`conversationsContract.checkpoints`): `list`, `preview`, `restore`, taking
  a conversation id; main resolves the worktree path and host (renderer never supplies a path).
- `acp.sendPrompt` in `conversations/node/wire-controller.ts` takes the checkpoint first
  (30 s timeout). A failed or timed-out snapshot is logged once per conversation and never blocks the
  prompt. `checkpoints.restore` refuses while the session is generating.
- Deleting a conversation (`deleteConversation`, `deleteHostConversation`) drops its checkpoint refs
  on a best-effort basis.

## UI

`@orkestra/chat-ui` exposes `ChatCommands.onRewind({ itemId, promptId })`; user messages with a
`promptId` show a hover action. `acp-chat-panel.tsx` opens `rewindCheckpointModal`
(`conversations/browser/rewind-checkpoint-modal.tsx`), which lists the files that would change,
states that only files are rewound, and offers "Geri sarmayı geri al" afterwards.

## Known limits

- A prompt queued behind a running turn is snapshotted when it is submitted, not when the agent
  starts it, so rewinding to it also undoes the rest of the earlier turn's work.
- Ignored files are neither snapshotted nor restored. Files that become ignored after a checkpoint
  are overwritten if the target snapshot contains them.
- Submodule contents, sparse-checkout/skip-worktree state, and Git LFS content (pointer files are
  what git stores) are not specially handled.
- Refs for conversations deleted while their worktree is already gone stay in the repository until
  removed manually (`git for-each-ref refs/orkestra/checkpoints`).
- An older remote workspace-server without these procedures rejects them; the prompt still goes
  through and the rewind action reports an error.

## Yok sayılan (ignore) içeriğin korunması

Geri yükleme, yazacağı bir yolun yerinde hiçbir checkpoint'te bulunmayan içerik varsa o yolu
atlar ve sonucun `skipped` alanında bildirir: yolun yerinde bir dizin duruyorsa (içinde ignore
edilmiş dosyalar kalmıştır), yolun üst bileşenlerinden biri dizin değilse ya da anlık görüntüde
olmayan bir yol diskte zaten varsa (ignore edilmiş dosya). `git checkout-index -f` bu durumlarda
içeriği sessizce silerdi. Onay penceresi atlanan yolları listeler.

