import { Alert, Button } from '@orkestra/ui/react/primitives';
import { AlertCircle, CheckCircle, Github, LogIn, RefreshCw, Terminal, User } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  useAccountHealth,
  useAccountSession,
  useAccountSignIn,
} from '@core/features/account/api/browser/useAccount';
import { useImportGitHubCliAccounts } from '@core/features/github/api/browser/use-github-auth';
import {
  classifyGitHubCliImport,
  GITHUB_CLI_IMPORT_FAILED_MESSAGE,
  shouldOfferAccountSignIn,
} from './sign-in-methods';

const GITHUB_CLI_INSTALL_URL = 'https://cli.github.com';

type CliButtonVariant = 'primary' | 'secondary';

export function SignInStep({ onComplete }: { onComplete: () => void }) {
  const { data: session, isLoading: sessionLoading } = useAccountSession();
  const { data: accountServerAvailable } = useAccountHealth();
  const signInMutation = useAccountSignIn();
  const importCliAccountsMutation = useImportGitHubCliAccounts();
  const skippedSignInRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [cliUnavailable, setCliUnavailable] = useState(false);

  // Account sign-in goes through the Orkestra account server and can only fail without one,
  // so it is offered only once the server answers its health check; otherwise the GitHub CLI
  // connection is the primary action.
  const offerAccountSignIn = shouldOfferAccountSignIn(accountServerAvailable);
  const cliButtonVariant: CliButtonVariant = offerAccountSignIn ? 'secondary' : 'primary';
  const busy = signInMutation.isPending || importCliAccountsMutation.isPending;

  const handleSignIn = async () => {
    skippedSignInRef.current = false;
    setError(null);
    try {
      const result = await signInMutation.mutateAsync(undefined);
      if (!result.success) {
        if (skippedSignInRef.current) return;
        setError(result.error || 'Sign in failed');
        return;
      }
      if (skippedSignInRef.current) {
        return;
      }
      onComplete();
    } catch (err) {
      if (skippedSignInRef.current) return;
      setError(err instanceof Error ? err.message : 'Sign in failed');
    }
  };

  // Without an account server, connect GitHub through the machine's `gh` session.
  const handleCliImport = async () => {
    skippedSignInRef.current = false;
    setError(null);
    try {
      const result = await importCliAccountsMutation.mutateAsync();
      if (skippedSignInRef.current) return;
      const outcome = classifyGitHubCliImport(result);
      if (outcome.kind === 'connected') {
        onComplete();
        return;
      }
      // A missing or signed-out `gh` gets setup steps and a retry instead of a bare error.
      setCliUnavailable(outcome.kind === 'cli-unavailable');
      if (outcome.kind === 'failed') setError(outcome.message);
    } catch (err) {
      if (skippedSignInRef.current) return;
      setCliUnavailable(false);
      setError(err instanceof Error ? err.message : GITHUB_CLI_IMPORT_FAILED_MESSAGE);
    }
  };

  const handleSkip = () => {
    skippedSignInRef.current = true;
    onComplete();
  };

  if (sessionLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-foreground-muted">
        Loading...
      </div>
    );
  }

  if (session?.isSignedIn && session.user) {
    const { user } = session;
    return (
      <div className="flex max-w-sm flex-col space-y-8">
        <div className="flex flex-col items-center justify-center gap-6">
          <div className="relative">
            {user.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={user.username}
                className="h-14 w-14 rounded-full border border-border"
              />
            ) : (
              <div className="flex h-14 w-14 items-center justify-center rounded-full border border-border bg-background-1">
                <User className="h-7 w-7 text-foreground-muted" />
              </div>
            )}
            <CheckCircle className="text-primary absolute -right-1 -bottom-1 h-5 w-5 fill-background" />
          </div>
          <div className="flex flex-col items-center justify-center gap-1">
            <h1 className="text-center text-xl">Connected as @{user.username}</h1>
            {user.email && (
              <p className="text-center text-sm text-foreground-muted">{user.email}</p>
            )}
          </div>
        </div>
        <Button variant="primary" size="lg" onClick={onComplete}>
          Continue
        </Button>
      </div>
    );
  }

  return (
    <div className="flex max-w-sm flex-col space-y-8">
      <div className="flex flex-col items-center justify-center gap-6">
        <Github className="h-10 w-10" absoluteStrokeWidth strokeWidth={1.5} />
        <div className="flex flex-col items-center justify-center gap-2">
          <h1 className="text-center text-xl">Connect GitHub</h1>
          <p className="text-md text-center text-foreground-muted">
            Orkestra uses GitHub for git operations, pull requests and issues.
          </p>
        </div>
      </div>
      <div className="flex w-full flex-col gap-2">
        {offerAccountSignIn && (
          <Button variant="primary" size="lg" onClick={handleSignIn} disabled={busy}>
            <LogIn className="h-4 w-4" />
            {signInMutation.isPending ? 'Signing in…' : 'Sign in with GitHub'}
          </Button>
        )}
        {cliUnavailable ? (
          <GitHubCliSetupHelp
            variant={cliButtonVariant}
            retrying={importCliAccountsMutation.isPending}
            disabled={busy}
            onRetry={() => void handleCliImport()}
          />
        ) : (
          <>
            <Button
              variant={cliButtonVariant}
              size="lg"
              onClick={() => void handleCliImport()}
              disabled={busy}
            >
              <Terminal className="h-4 w-4" />
              {importCliAccountsMutation.isPending ? 'Connecting…' : 'Connect with GitHub CLI'}
            </Button>
            <p className="text-center text-xs text-foreground-muted">
              Bu bilgisayardaki <code className="font-mono">gh auth login</code> oturumunu kullanır.
            </p>
          </>
        )}
        {error && (
          <div className="bg-destructive/10 text-destructive flex items-start gap-1.5 rounded-md px-2.5 py-2 text-xs">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <Button size="lg" variant="secondary" onClick={handleSkip}>
          Skip for now
        </Button>
      </div>
    </div>
  );
}

function GitHubCliSetupHelp({
  variant,
  retrying,
  disabled,
  onRetry,
}: {
  variant: CliButtonVariant;
  retrying: boolean;
  disabled: boolean;
  onRetry: () => void;
}) {
  return (
    <>
      <Alert.Root status="warning">
        <Alert.Title>GitHub CLI oturumu bulunamadı</Alert.Title>
        <Alert.Description>
          GitHub CLI kurulu değil ya da oturum açılmamış olabilir.
        </Alert.Description>
        <ol className="mt-1 list-decimal space-y-0.5 pl-4 leading-normal opacity-90">
          <li>
            GitHub CLI uygulamasını kurun:{' '}
            <a
              href={GITHUB_CLI_INSTALL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              cli.github.com
            </a>
          </li>
          <li>
            Terminalde <code className="font-mono">gh auth login</code> çalıştırın.
          </li>
          <li>Ardından “Tekrar dene”ye tıklayın.</li>
        </ol>
      </Alert.Root>
      <Button variant={variant} size="lg" onClick={onRetry} disabled={disabled}>
        <RefreshCw className="h-4 w-4" />
        {retrying ? 'Kontrol ediliyor…' : 'Tekrar dene'}
      </Button>
    </>
  );
}
