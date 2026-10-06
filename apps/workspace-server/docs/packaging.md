# Workspace Server Packaging

The workspace server is distributed as a self-contained archive for each supported operating
system and architecture. A remote machine does not need Node.js, npm, pnpm, or the Orkestra
monorepo installed.

## Supported Targets

- `linux-x64`
- `linux-arm64`
- `darwin-arm64`

Darwin artifacts must be built on a matching Darwin host. Linux artifacts are built with Docker
Buildx, so either Linux architecture can be produced from a supported Docker host.

## Build an Artifact

Run the packaging command from `apps/workspace-server/` and provide one or more targets:

```bash
pnpm run package --target darwin-arm64
pnpm run package --target linux-x64 --target linux-arm64
```

Add `--verify` to smoke-test each finished archive:

```bash
pnpm run package --target darwin-arm64 --verify
pnpm run package --target linux-x64 --verify
```

Darwin verification extracts the archive into a temporary directory and runs the daemon's
`start`, `status`, and `stop` commands with an isolated socket. Linux verification runs the same
sequence in `debian:bookworm-slim`, where no host Node.js installation is available.

The packaging process:

1. Bundles the server and its ten workers with all pure-JavaScript dependencies emitted into the
   entry files or shared chunks.
2. Installs only `node-pty`, `better-sqlite3`, `@parcel/watcher`, and their runtime dependencies for
   the target platform. Linux native modules are compiled in the Docker builder; Darwin modules
   are installed with the downloaded target Node.js runtime.
3. Downloads the pinned ripgrep release for the target, verifies its repository-owned SHA-256,
   and copies `rg` plus its license files into the artifact.
4. Downloads the official Node version pinned by the repository's `.nvmrc`, verifies it against
   Node's published `SHASUMS256.txt`, and copies its `node` executable into the artifact.
5. Writes the launcher and manifest, then creates the archive under `dist-artifacts/`.
6. Writes a sibling `<archive>.sha256` file suitable for `sha256sum -c` verification.

Artifact URLs are immutable. Once an archive has been published for a workspace-server version,
that version must never be rebuilt with different contents. Any change that affects the packaged
artifact requires a version bump in `apps/workspace-server/package.json` before publication. The
desktop installer deliberately treats an existing `versions/<version>/` directory as final.

## Orkestra dağıtımını yayınlama

Bu depo eski projenin yayın sunucusuna veya CI hesabına bağlı değildir. Arşivleri kendi HTTPS dağıtım alanınızda yayınlayın. `scripts/package.ts` ile platform arşivleri ve SHA-256 dosyaları oluşturulabilir; R2 yükleme araçları yalnızca kendi erişim bilgilerinizi açıkça sağladığınızda kullanılmalıdır.

İstemci, kurulum adresinin altında `channels/stable/protocol-<major>.json` kanal dosyasını ve `<version>/install.sh` dosyasını bekler. Aynı sürüm altında platform arşivlerini ve SHA-256 dosyalarını yayınlayın. Sürüm ve protokol değerleri sunucu manifestiyle eşleşmelidir; mevcut sürümü farklı içerikle yeniden yayınlamayın.

Kurulum adresini Orkestra'nın Makine ayarlarından veya `ORKESTRA_WORKSPACE_SERVER_ARTIFACTS_URL` ile belirtin. Doğrudan kurulum betiğine `--base-url` ve `--version` verin. Yapılandırılmamış bir istemci eski yayın sunucusuna bağlanmaz.

Bu kaynak yayını henüz herkese açık sunucu arşivleri sağlamaz. Paketleme, platform doğrulaması ve dağıtım alanı kurulumu ayrıca yapılmalıdır.

## Otomatik yayın (`release-workspace-server.yml`)

`apps/workspace-server/package.json` sürümü `main`'de değiştiğinde iş akışı Linux x64 arşivini
derleyip doğrular, `workspace-server-v<sürüm>` GitHub sürümünü açar ve `workspace-server-dist`
dalına `<sürüm>/install.sh`, SHA-256 dosyasını ve stable/canary `protocol-<major>.json` kanal
dosyalarını yazar. Sürüm notu `docs/releases/workspace-server-v<sürüm>.md` dosyasından okunur.
Aynı sürüm zaten yayımlanmışsa çalıştırma atlanır.

## Publish to Local Minio

The Docker remote dev loop uses the same object layout as R2, but publishes to the local minio
service from `docker-compose.yaml`:

```bash
pnpm run dev:remote
```

For manual iteration after minio is running, package one Linux target and publish the newest
matching artifact:

```bash
ORKESTRA_WS_DEV_VERSION=0.1.0-dev.manual pnpm run package --target linux-arm64
pnpm run upload:dev
```

`upload:dev` points the S3 uploader at `http://localhost:9000/orkestra-releases` with the local minio
credentials. It defaults to the host's Linux target, picks the newest matching artifact under
`dist-artifacts/`, uploads `workspace-server/<version>/<artifact>` and its `.sha256` sidecar, then
advances the selected channel pointer. `pnpm run dev:remote` publishes both channel pointers for its
dev artifact. Pass `--version` and `--target` when you need an explicit override.

Downloaded Node archives are cached under `~/.cache/orkestra/workspace-server/`. Set
`ORKESTRA_WS_PACKAGE_CACHE_DIR` to use another cache directory.

## Artifact Layout

```text
orkestra-workspace-server/
  bin/orkestra-workspace-server
  bin/rg
  node
  dist/
    index.mjs
    <ten worker>.mjs
    <shared chunks>.mjs
  licenses/
    ripgrep/
      COPYING
      LICENSE-MIT
      UNLICENSE
  node_modules/
    <native packages and runtime dependencies>
  manifest.json
```

The POSIX shell launcher resolves the artifact relative to its own path, exports the packaged app
version as `ORKESTRA_WS_APP_VERSION`, selects the bundled `bin/rg` through
`ORKESTRA_WS_RIPGREP_PATH`, and executes `dist/index.mjs` with the bundled Node runtime. The archive
may therefore be extracted to any directory. Source development runs do not set the ripgrep
override and continue to resolve `rg` from `PATH`.

`manifest.json` records the package name and version, workspace-server protocol version, target OS
and architecture, and bundled Node and ripgrep versions.

## Linux Compatibility

Linux artifacts use the official glibc-linked Node.js distribution and native modules built on
Debian Bookworm. The bundled ripgrep executable uses its upstream static musl target, but the
complete workspace-server artifact is still intended for glibc-based Linux hosts. Alpine and other
musl-based systems are not supported; a separate musl build pipeline would be required for those
hosts.

See `docker-remote.md` for the bare SSH container used to exercise installation and socket
forwarding with these artifacts.
