// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/web/src/components/settings/BrowserImportWizard.tsx
//
// Kurulu bir tarayıcının oturum çerezlerini uygulama içi tarayıcı profiline tek seferlik kopyalayan
// pencere: kaynak tarayıcı + profil seçimi, hedef Orkestra profili, kapatma/anahtar zinciri/Tam Disk
// Erişimi yönlendirmesi ve yalnızca sayılardan oluşan sonuç özeti.
import {
  Alert,
  Button,
  Dialog,
  Input,
  Label,
  RadioGroup,
  Select,
  Spinner,
} from '@orkestra/ui/react/primitives';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BROWSER_IMPORT_FAILURE_COPY,
  isRetryableBrowserImportReason,
  type BrowserImportSource,
} from '@core/features/browser/api/browser-import';
import { getBrowserClient } from '@core/features/browser/api/browser/client';
import type { BrowserProfile } from '@core/primitives/browser/api';
import {
  canStartImport,
  outcomeToStep,
  preferredSourceId,
  selectableSources,
  summaryLines,
  type BrowserImportStep,
} from './browser-import-dialog-logic';

const NEW_PROFILE_VALUE = '__new__';

type TargetSelection = { kind: 'existing'; profileId: string } | { kind: 'new'; name: string };

export type BrowserImportDialogProps = {
  profiles: readonly BrowserProfile[];
  initialTargetProfileId?: string;
  /** Yeni profili ayarlara kaydeder ve kimliğini döner. */
  onCreateProfile: (name: string) => Promise<string>;
  /** Başarılı içe aktarmadan sonra (ör. açık sekmeleri yenilemek için). */
  onImported: (profileId: string) => void;
  onClose: () => void;
};

function cookieCountLabel(count: number | undefined): string | undefined {
  if (count === undefined) return undefined;
  if (count === 0) return 'No cookies';
  return count === 1 ? '1 cookie' : `${count.toLocaleString()} cookies`;
}

export function BrowserImportDialog({
  profiles,
  initialTargetProfileId,
  onCreateProfile,
  onImported,
  onClose,
}: BrowserImportDialogProps) {
  const [step, setStep] = useState<BrowserImportStep>({ step: 'loading' });
  const [sources, setSources] = useState<BrowserImportSource[]>([]);
  const [sourceId, setSourceId] = useState<string | undefined>();
  const [sourceProfileDirectory, setSourceProfileDirectory] = useState('');
  const [target, setTarget] = useState<TargetSelection>(() =>
    initialTargetProfileId
      ? { kind: 'existing', profileId: initialTargetProfileId }
      : { kind: 'new', name: '' }
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const importInFlight = useRef(false);

  const source = sources.find((candidate) => candidate.id === sourceId);

  const loadSources = useCallback(async (keepSelection?: string) => {
    setLoadError(null);
    try {
      const next = await (await getBrowserClient()).listImportSources();
      setSources(next);
      const selectable = selectableSources(next);
      const nextId =
        keepSelection && selectable.some((candidate) => candidate.id === keepSelection)
          ? keepSelection
          : preferredSourceId(next);
      setSourceId(nextId);
      const nextSource = next.find((candidate) => candidate.id === nextId);
      setSourceProfileDirectory((current) =>
        nextSource?.profiles.some((profile) => profile.directory === current)
          ? current
          : (nextSource?.profiles[0]?.directory ?? '')
      );
      setStep({ step: 'configure' });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setStep({ step: 'configure' });
    }
  }, []);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const selectSource = (id: string) => {
    setSourceId(id);
    const next = sources.find((candidate) => candidate.id === id);
    setSourceProfileDirectory(next?.profiles[0]?.directory ?? '');
  };

  const runImport = async () => {
    if (importInFlight.current || !source) return;
    importInFlight.current = true;
    setStep({ step: 'importing' });
    try {
      let profileId: string;
      let profileName: string;
      if (target.kind === 'new') {
        profileName = target.name.trim();
        profileId = await onCreateProfile(profileName);
        // Yeni profil oluşturulduktan sonra tekrar denemede yine onu hedefle.
        setTarget({ kind: 'existing', profileId });
      } else {
        profileId = target.profileId;
        profileName =
          profiles.find((profile) => profile.id === profileId)?.name ?? target.profileId;
      }
      const result = await (
        await getBrowserClient()
      ).importCookies({
        sourceId: source.id,
        sourceProfileDirectory,
        targetProfileId: profileId,
      });
      if (result.success) onImported(profileId);
      setStep(outcomeToStep(result, profileName));
    } catch {
      setStep({ step: 'failed', reason: 'readFailed' });
    } finally {
      importInFlight.current = false;
    }
  };

  const openFullDiskAccess = async () => {
    setPermissionBusy(true);
    try {
      await (await getBrowserClient()).openFullDiskAccessSettings();
    } finally {
      setPermissionBusy(false);
    }
  };

  const recheckSources = async () => {
    setPermissionBusy(true);
    try {
      await loadSources(sourceId);
    } finally {
      setPermissionBusy(false);
    }
  };

  const busy = step.step === 'importing';
  const ready = canStartImport({ source, sourceProfileDirectory, target });

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Content size="md">
        <Dialog.Header showCloseButton={!busy}>
          <Dialog.Title>Import from browser</Dialog.Title>
          <Dialog.Description>
            Copy signed-in sessions (cookies) from a browser installed on this computer into an
            in-app browser profile.
          </Dialog.Description>
        </Dialog.Header>
        <Dialog.Body maxHeight="60vh" className="flex flex-col gap-4 p-4">
          {step.step === 'loading' && (
            <div className="flex items-center gap-2 text-sm text-foreground-muted">
              <Spinner size="sm" />
              Looking for installed browsers…
            </div>
          )}

          {step.step === 'importing' && (
            <div className="flex items-center gap-2 text-sm text-foreground-muted">
              <Spinner size="sm" />
              {source?.engine === 'chromium'
                ? 'Importing cookies… If your system asks for keychain access, choose Allow.'
                : 'Importing cookies…'}
            </div>
          )}

          {step.step === 'done' && (
            <div className="flex flex-col gap-2 text-sm">
              <div className="font-medium text-foreground">
                {`Cookies copied into ${step.targetProfileName}.`}
              </div>
              {summaryLines(step.summary).map((line) => (
                <div key={line} className="text-foreground-muted">
                  {line}
                </div>
              ))}
              {step.summary.skippedDomains.length > 0 && (
                <div className="text-xs text-foreground-passive">
                  {`Skipped sites include: ${step.summary.skippedDomains.join(', ')}`}
                </div>
              )}
              <div className="text-xs text-foreground-passive">
                This was a one-time copy. Later sign-ins and sign-outs stay separate between the two
                browsers, and some sites may still ask you to sign in again.
              </div>
            </div>
          )}

          {step.step === 'failed' && (
            <Alert.Root status="destructive">
              <Alert.Title>Import failed</Alert.Title>
              <Alert.Description>{BROWSER_IMPORT_FAILURE_COPY[step.reason]}</Alert.Description>
            </Alert.Root>
          )}

          {step.step === 'configure' && (
            <ConfigureStep
              sources={sources}
              source={source}
              loadError={loadError}
              sourceProfileDirectory={sourceProfileDirectory}
              onSelectSource={selectSource}
              onSelectSourceProfile={setSourceProfileDirectory}
              profiles={profiles}
              target={target}
              onTargetChange={setTarget}
              permissionBusy={permissionBusy}
              onOpenFullDiskAccess={() => void openFullDiskAccess()}
              onRecheck={() => void recheckSources()}
            />
          )}
        </Dialog.Body>
        <Dialog.Footer>
          {step.step === 'done' ? (
            <Button onClick={onClose}>Done</Button>
          ) : step.step === 'failed' ? (
            <>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              {isRetryableBrowserImportReason(step.reason) ? (
                <Button
                  onClick={() => {
                    if (step.reason === 'browserRunning') void loadSources(sourceId);
                    else void runImport();
                  }}
                >
                  Try again
                </Button>
              ) : (
                <Button onClick={() => void loadSources(sourceId)}>Back</Button>
              )}
            </>
          ) : (
            <>
              <Button variant="ghost" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={!ready || busy} onClick={() => void runImport()}>
                Import cookies
              </Button>
            </>
          )}
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function ConfigureStep({
  sources,
  source,
  loadError,
  sourceProfileDirectory,
  onSelectSource,
  onSelectSourceProfile,
  profiles,
  target,
  onTargetChange,
  permissionBusy,
  onOpenFullDiskAccess,
  onRecheck,
}: {
  sources: BrowserImportSource[];
  source: BrowserImportSource | undefined;
  loadError: string | null;
  sourceProfileDirectory: string;
  onSelectSource: (id: string) => void;
  onSelectSourceProfile: (directory: string) => void;
  profiles: readonly BrowserProfile[];
  target: TargetSelection;
  onTargetChange: (target: TargetSelection) => void;
  permissionBusy: boolean;
  onOpenFullDiskAccess: () => void;
  onRecheck: () => void;
}) {
  const selectable = selectableSources(sources);

  if (loadError) {
    return (
      <Alert.Root status="destructive">
        <Alert.Title>Could not look for installed browsers</Alert.Title>
        <Alert.Description>{loadError}</Alert.Description>
      </Alert.Root>
    );
  }

  if (selectable.length === 0) {
    return (
      <div className="text-sm text-foreground-muted">
        No supported browser with saved cookies was found on this computer. Supported: Chrome, Edge,
        Brave, Arc, Vivaldi, Opera, Helium, Chromium, Firefox, Zen and Safari (macOS).
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label>Import from</Label>
        <Select.Root
          value={source?.id ?? ''}
          onValueChange={(next) => {
            if (typeof next === 'string' && next) onSelectSource(next);
          }}
        >
          <Select.Trigger className="w-full">
            <Select.Value>{source?.name ?? 'Choose a browser'}</Select.Value>
          </Select.Trigger>
          <Select.Content>
            {selectable.map((candidate) => (
              <Select.Item key={candidate.id} value={candidate.id}>
                {candidate.name}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </div>

      {source?.unavailable === 'browserRunning' && (
        <Alert.Root status="warning">
          <Alert.Title>{`Quit ${source.name} first`}</Alert.Title>
          <Alert.Description>
            {`${source.name} is open, so its cookie database cannot be read safely. Quit it completely, then check again.`}
          </Alert.Description>
          <Alert.Action>
            <Button size="sm" variant="secondary" disabled={permissionBusy} onClick={onRecheck}>
              Check again
            </Button>
          </Alert.Action>
        </Alert.Root>
      )}

      {source?.unavailable === 'needsFullDiskAccess' && (
        <Alert.Root status="warning">
          <Alert.Title>Full Disk Access needed</Alert.Title>
          <Alert.Description>
            macOS protects Safari cookies. Open System Settings → Privacy & Security → Full Disk
            Access, add Orkestra and turn it on, then check again. You may need to quit and reopen
            Orkestra before the change applies. You can turn access off again after the import.
          </Alert.Description>
          <Alert.Action className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={permissionBusy}
              onClick={onOpenFullDiskAccess}
            >
              Open System Settings
            </Button>
            <Button size="sm" variant="ghost" disabled={permissionBusy} onClick={onRecheck}>
              Check again
            </Button>
          </Alert.Action>
        </Alert.Root>
      )}

      {source && source.profiles.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label>Browser profile</Label>
          <RadioGroup.Root
            value={sourceProfileDirectory}
            onValueChange={(next) => onSelectSourceProfile(String(next))}
          >
            {source.profiles.map((profile) => {
              const count = cookieCountLabel(profile.cookieCount);
              return (
                <Label
                  key={profile.directory}
                  className="flex cursor-pointer items-center gap-3 font-normal"
                >
                  <RadioGroup.Item value={profile.directory} />
                  <span className="min-w-0 flex-1 truncate">{profile.name}</span>
                  {count && <span className="text-xs text-foreground-passive">{count}</span>}
                </Label>
              );
            })}
          </RadioGroup.Root>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label>Into Orkestra profile</Label>
        <Select.Root
          value={target.kind === 'existing' ? target.profileId : NEW_PROFILE_VALUE}
          onValueChange={(next) => {
            if (next === NEW_PROFILE_VALUE) onTargetChange({ kind: 'new', name: '' });
            else if (typeof next === 'string' && next) {
              onTargetChange({ kind: 'existing', profileId: next });
            }
          }}
        >
          <Select.Trigger className="w-full">
            <Select.Value>
              {target.kind === 'existing'
                ? (profiles.find((profile) => profile.id === target.profileId)?.name ??
                  target.profileId)
                : 'New profile'}
            </Select.Value>
          </Select.Trigger>
          <Select.Content>
            {profiles.map((profile) => (
              <Select.Item key={profile.id} value={profile.id}>
                {profile.name}
              </Select.Item>
            ))}
            <Select.Item value={NEW_PROFILE_VALUE}>New profile</Select.Item>
          </Select.Content>
        </Select.Root>
        {target.kind === 'new' && (
          <Input
            autoFocus
            placeholder="Profile name"
            aria-label="New browser profile name"
            value={target.name}
            onChange={(event) => onTargetChange({ kind: 'new', name: event.currentTarget.value })}
          />
        )}
      </div>

      <div className="flex flex-col gap-1 text-xs text-foreground-passive">
        <div>
          Only cookies are copied: no passwords, history, bookmarks or site storage. Cookie values
          stay on this computer and are never shown or logged.
        </div>
        {source && source.engine !== 'safari' && (
          <div>{`Close ${source.name} before importing so its cookie database is complete.`}</div>
        )}
        {source?.engine === 'chromium' && (
          <div>
            {`Your system may ask to allow access to the ${source.name} cookie encryption key in its keychain. Choose Allow so the cookies can be decrypted; the key is not stored.`}
          </div>
        )}
        <div>
          Partitioned (third-party embedded) cookies and Firefox container cookies are skipped.
        </div>
      </div>
    </>
  );
}
