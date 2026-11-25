import { resourceUriSchema } from '@orkestra/core/primitives/path/api';
import {
  exclusionPatternsSchema,
  filesContract,
  MAX_FILE_UPLOAD_BYTES,
  readFileOptionsSchema,
} from '@orkestra/core/runtimes/files/api';
import { diffModeSchema, gitObjectRefSchema } from '@orkestra/core/runtimes/git/api';
import {
  defineContract,
  downloadFile,
  fallible,
  liveModel,
  liveState,
  procedure,
  uploadFile,
} from '@orkestra/wire/rpc';
import { z } from 'zod';
import {
  runtimeFallibleMutations,
  runtimeFallibleProcedure,
  runtimeResolveErrorUnion,
} from '@core/primitives/desktop-runtime/api/fallible-contract';
import { mediaStreamErrorSchema, mediaStreamHandleSchema } from './media-stream';

// Every key in this domain is a ResourceUri — a serialized HostFileRef carrying
// the host and the absolute path (spec §2/§8). Workspace→root resolution happens
// at the renderer edge; no workspaceId reaches the wire.
const uriKeySchema = z.object({ uri: resourceUriSchema });

// The wire form of the GitRef vocabulary (`DiffMode | GitObjectRef`, spec §6),
// composed from the git runtime's schemas rather than duplicated here.
const gitRefSchema = z.union([diffModeSchema, gitObjectRefSchema]);

// Disk content is live-watched and writable; a git source serves the file's
// read-only snapshot at that ref through the git runtime (spec §6/§8). The
// checkout root is resolved at the seam and never part of the key.
const contentSourceSchema = z.union([z.literal('disk'), z.object({ ref: gitRefSchema })]);

const contentKeySchema = z.object({
  uri: resourceUriSchema,
  source: contentSourceSchema,
});

// `sessionId` keeps two consumers of the same root (e.g. two windows) from
// sharing one server-side tree resource and its expansion state.
const treeKeySchema = z.object({
  root: resourceUriSchema,
  sessionId: z.string(),
  exclusions: exclusionPatternsSchema,
});

const readOptionsShape = { options: readFileOptionsSchema.optional() };

// Two-endpoint mutations address source and target as URIs on the same host.
const fromToUriKeySchema = z.object({ from: resourceUriSchema, to: resourceUriSchema });

const filesFsContract = defineContract({
  exists: runtimeFallibleProcedure(uriKeySchema, filesContract.fs.exists.output),
  realPath: runtimeFallibleProcedure(uriKeySchema, filesContract.fs.realPath.output),
  readText: runtimeFallibleProcedure(
    uriKeySchema.extend(readOptionsShape),
    filesContract.fs.readText.output
  ),
  readBytes: downloadFile({
    input: uriKeySchema.extend(readOptionsShape),
    meta: filesContract.fs.readBytes.meta,
    error: runtimeResolveErrorUnion(filesContract.fs.readBytes.error),
  }),
  upload: uploadFile({
    input: uriKeySchema.extend({ overwrite: z.boolean().optional() }),
    maxSize: MAX_FILE_UPLOAD_BYTES,
    result: filesContract.fs.upload.result,
    error: runtimeResolveErrorUnion(filesContract.fs.upload.error),
  }),
  createFile: runtimeFallibleProcedure(uriKeySchema, filesContract.fs.createFile.output),
  createDirectory: runtimeFallibleProcedure(uriKeySchema, filesContract.fs.createDirectory.output),
  rename: runtimeFallibleProcedure(fromToUriKeySchema, filesContract.fs.rename.output),
  move: runtimeFallibleProcedure(fromToUriKeySchema, filesContract.fs.move.output),
  copy: runtimeFallibleProcedure(fromToUriKeySchema, filesContract.fs.copy.output),
  delete: runtimeFallibleProcedure(
    uriKeySchema.extend({ recursive: z.boolean().optional() }),
    filesContract.fs.delete.output
  ),
});

// Short-lived tokens that stream media/PDF outputs through `orkestra-media://`. `open` mints a
// token, `release` drops it; `saveCopy` streams the file to a user-picked path without buffering.
const filesMediaContract = defineContract({
  open: fallible({
    input: uriKeySchema,
    data: mediaStreamHandleSchema,
    error: mediaStreamErrorSchema,
  }),
  release: procedure({ input: z.object({ token: z.string() }), output: z.void() }),
  saveCopy: fallible({
    input: uriKeySchema,
    data: z.object({ path: z.string().optional() }),
    error: mediaStreamErrorSchema,
  }),
});

export const filesDomain = 'files' as const;

export const filesWireContract = defineContract({
  fs: filesFsContract,
  media: filesMediaContract,
  tree: defineContract({
    model: liveModel({
      key: treeKeySchema,
      states: {
        tree: liveState({ data: filesContract.tree.model.states.tree.dataSchema }),
      },
      mutations: runtimeFallibleMutations(filesContract.tree.model.mutations),
    }),
  }),
  content: liveModel({
    key: contentKeySchema,
    states: {
      content: liveState({ data: filesContract.content.states.content.dataSchema }),
    },
    mutations: runtimeFallibleMutations(filesContract.content.mutations),
  }),
});

export type FilesWireContract = typeof filesWireContract;
export type FilesContentKey = z.infer<typeof filesWireContract.content.keySchema>;
export type FilesContentModel = z.infer<typeof filesWireContract.content.states.content.dataSchema>;
export type FilesTreeKey = z.infer<typeof filesWireContract.tree.model.keySchema>;
export type FilesTreeModel = z.infer<typeof filesWireContract.tree.model.states.tree.dataSchema>;
