// Options: pairing with a Host (ADR 0004, ADR 0005, ADR 0006). Unpaired, this is one hint and a Pair button (the
// default address unless the reviewer opens Other address): the extension is the whole product without a Host. A Host
// on another computer in network mode is found with Find hubs (its `.local` names and saved addresses), or given as
// an address or as the `inkup://pair` link its TUI shows (pasted, or scanned as its QR code); it pairs with
// the 6-digit code it shows. Paired, this shows the connection, what is waiting to be sent, the Sessions recorded
// before pairing (Upload), and Forget, which has the Host revoke this browser's token first.
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { type FoundHost, isLoopbackUrl, normalizeAddress, parsePairLink } from '@/adapters/host';
import { HostBackfill } from '@/components/host-backfill';
import { Button } from '@/components/ui/button';
import { db } from '@/db';
import { useStorageItem } from '@/lib/use-storage-item';
import { sendMessage } from '@/messaging';
import { platform } from '@/platform';
import { hostStatus } from '@/session-state';
import { type HostStatus, hostPairing, hostUrl } from '@/settings';

/** What a Host on another computer needs: plain http and ws to any address on the LAN (optional_host_permissions). */
const NETWORK_ORIGINS = ['http://*/*', 'ws://*/*'];

export const NETWORK_NOTE =
  'Unencrypted network hub: recordings cross the LAN in the clear. Use it on trusted networks only.';

function statusText(status: HostStatus | undefined): string {
  switch (status?.state) {
    case 'connected':
      return `Connected (host ${status.host_version})`;
    case 'offline':
      return status.retry ? `Host offline, will sync. ${status.error}` : status.error;
    case 'connecting':
      return 'Connecting…';
    default:
      return 'Not connected';
  }
}

/**
 * Asks for plain http and ws to the LAN from the click that needs them. Chrome and Safari already hold them through
 * `<all_urls>` (ADR 0003), so nothing is asked there; a browser that has not granted them asks now.
 */
async function ensureNetworkAccess(): Promise<boolean> {
  try {
    if (await chrome.permissions.contains({ origins: NETWORK_ORIGINS })) return true;
    return await chrome.permissions.request({ origins: NETWORK_ORIGINS });
  } catch {
    return false;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function HostSection() {
  const pairing = useStorageItem(hostPairing);
  const status = useStorageItem(hostStatus);
  const savedUrl = useStorageItem(hostUrl);
  const waiting = useLiveQuery(() => db.outbox.count(), [], 0);
  const [url, setUrl] = useState('');
  const [pairingNow, setPairingNow] = useState(false);
  const [editingUrl, setEditingUrl] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<FoundHost[] | null>(null);
  /** The Host on another computer waiting for its code, and the code typed so far. */
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  /** After a Forget the Host could not hear: it is asked again once it can be reached. */
  const [forgetNote, setForgetNote] = useState<string | null>(null);
  const canScan = platform.capabilities().qrScan;

  useEffect(() => {
    if (savedUrl) setUrl(savedUrl);
  }, [savedUrl]);

  /** Pairs with `address`. A Host on another computer answers the first try by showing a code to type here. */
  async function pairWith(address: string, pairingCode?: string) {
    setError(null);
    setPairingNow(true);
    try {
      await hostUrl.setValue(address);
      const result = await sendMessage(
        'hostPair',
        pairingCode ? { url: address, code: pairingCode } : { url: address },
      );
      if (result.ok) {
        setCodeFor(null);
        setFound(null);
        return;
      }
      if (result.needsCode) {
        setCodeFor(address);
        setCode('');
      }
      setError(result.error);
    } catch (err) {
      setError(message(err));
    } finally {
      setPairingNow(false);
    }
  }

  /** An address, or a pair link that carries its code. */
  async function connectTo(input: string) {
    const link = parsePairLink(input);
    const address = link?.url ?? normalizeAddress(input);
    if (!address) return setError('Give a host address (like 192.168.1.20 or inkup.local) or an inkup://pair link.');
    if (!isLoopbackUrl(address) && !(await ensureNetworkAccess()))
      return setError('Connecting to another computer needs access to the local network.');
    await pairWith(address, link?.code);
  }

  async function forget() {
    setForgetting(true);
    setForgetNote(null);
    try {
      const { revoked } = await sendMessage('hostForget');
      if (!revoked)
        setForgetNote(
          'Forgotten here. The host could not be reached, so it is asked to revoke this browser once it can be.',
        );
    } catch (err) {
      setError(message(err));
    } finally {
      setForgetting(false);
    }
  }

  async function findHubs() {
    setError(null);
    if (!(await ensureNetworkAccess())) return setError('Finding hubs needs access to the local network.');
    setFinding(true);
    try {
      setFound(await sendMessage('hostFind'));
    } catch (err) {
      setError(message(err));
    } finally {
      setFinding(false);
    }
  }

  if (pairing === undefined) return <HostShell />;
  if (pairing) {
    return (
      <HostShell>
        <div className="flex flex-col gap-2">
          <p data-testid="host-status" data-state={status?.state ?? 'connecting'}>
            {statusText(status)}
          </p>
          <p className="text-muted-foreground">
            Paired with <span className="font-mono">{pairing.url}</span> since{' '}
            {new Date(pairing.paired_at).toLocaleString()}.
          </p>
          {!isLoopbackUrl(pairing.url) && (
            <p className="text-amber-700 dark:text-amber-400" data-testid="host-network-note">
              {NETWORK_NOTE}
            </p>
          )}
          <p className="text-muted-foreground" data-testid="host-waiting" data-count={waiting}>
            {waiting === 0
              ? 'Everything is sent.'
              : `${waiting} ${waiting === 1 ? 'item' : 'items'} waiting to be sent.`}
          </p>
          <HostBackfill variant="section" />
          <div>
            <Button variant="outline" onClick={() => void forget()} disabled={forgetting} data-testid="host-forget">
              {forgetting ? 'Forgetting…' : 'Forget this host'}
            </Button>
          </div>
        </div>
      </HostShell>
    );
  }

  return (
    <HostShell>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void connectTo(url);
        }}
        className="flex flex-col gap-3"
      >
        {forgetNote && (
          <p className="text-muted-foreground" data-testid="host-forget-note">
            {forgetNote}
          </p>
        )}
        <p className="text-muted-foreground" data-testid="host-hint">
          Pair a host to hand items to agents. Run <code className="font-mono">inkup</code> on this computer, then pair.
          A host on another computer must run in network mode: find it, or give its address or pair link.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {editingUrl && (
            <input
              aria-label="Host address or pair link"
              data-testid="host-url"
              className="min-w-64 flex-1 rounded-md border px-3 py-2 font-mono"
              placeholder="192.168.1.20, inkup.local or inkup://pair?…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={pairingNow}
            />
          )}
          <Button type="submit" data-testid="host-pair" disabled={pairingNow || !url.trim()}>
            {pairingNow ? 'Waiting for the host…' : 'Pair'}
          </Button>
          {!editingUrl && (
            <Button type="button" variant="ghost" onClick={() => setEditingUrl(true)} data-testid="host-other-address">
              Other address
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => void findHubs()}
            disabled={finding || pairingNow}
            data-testid="host-find"
          >
            {finding ? 'Looking…' : 'Find hubs'}
          </Button>
          {canScan && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setScanning(true)}
              disabled={pairingNow || scanning}
              data-testid="host-scan"
            >
              Scan QR
            </Button>
          )}
        </div>
      </form>

      {found && (
        <div className="flex flex-col gap-2" data-testid="host-found" data-count={found.length}>
          {found.length === 0 ? (
            <p className="text-muted-foreground">
              No hub answered. Is it running in network mode (<code className="font-mono">inkup --network</code>, or N
              in its window) on this network? Give its address instead.
            </p>
          ) : (
            found.map((hub) => (
              <div
                key={hub.url}
                className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2"
                data-testid="host-found-item"
                data-url={hub.url}
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{hub.name ?? 'inkup'}</span>
                  <span className="text-muted-foreground font-mono text-xs">
                    {hub.url} · {hub.version}
                  </span>
                  {!isLoopbackUrl(hub.url) && (
                    <span className="text-xs text-amber-700 dark:text-amber-400">Unencrypted network hub</span>
                  )}
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void connectTo(hub.url)}
                  disabled={pairingNow}
                  data-testid="host-connect"
                >
                  Connect
                </Button>
              </div>
            ))
          )}
        </div>
      )}

      {scanning && (
        <QrScanner
          onLink={(link) => {
            setScanning(false);
            void connectTo(link);
          }}
          onClose={(problem) => {
            setScanning(false);
            if (problem) setError(problem);
          }}
        />
      )}

      {codeFor && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void pairWith(codeFor, code.replace(/\s/g, ''));
          }}
          className="flex flex-col gap-2 rounded-md border p-3"
          data-testid="host-code-form"
        >
          <p>
            Type the 6-digit code the host at <span className="font-mono">{codeFor}</span> shows. It lasts 2 minutes.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Pairing code"
              data-testid="host-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              className="w-32 rounded-md border px-3 py-2 font-mono tracking-widest"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={pairingNow}
            />
            <Button
              type="submit"
              data-testid="host-code-submit"
              disabled={pairingNow || !/^\d{6}$/.test(code.replace(/\s/g, ''))}
            >
              Pair
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => void pairWith(codeFor)}
              disabled={pairingNow}
              data-testid="host-code-new"
            >
              New code
            </Button>
          </div>
        </form>
      )}

      {pairingNow && !codeFor && (
        <p className="text-muted-foreground">Approve this browser where the host is running.</p>
      )}
      {error && (
        <p role="alert" className="text-destructive" data-testid="host-error">
          {error}
        </p>
      )}
    </HostShell>
  );
}

function HostShell({ children }: { children?: React.ReactNode }) {
  return (
    <section aria-labelledby="host" className="flex flex-col gap-4" data-testid="host-section">
      <h2 id="host" className="text-base font-semibold">
        Host
      </h2>
      {children}
    </section>
  );
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

/** The camera, until it sees a QR code holding a pair link. Shown only where BarcodeDetector exists (capabilities). */
function QrScanner({ onLink, onClose }: { onLink: (link: string) => void; onClose: (problem?: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const done = useRef({ onLink, onClose });
  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    const Detector = (
      globalThis as unknown as { BarcodeDetector: new (options: { formats: string[] }) => BarcodeDetectorLike }
    ).BarcodeDetector;
    void (async () => {
      try {
        const detector = new Detector({ formats: ['qr_code'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (stopped || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        while (!stopped) {
          const codes = await detector.detect(video.current).catch(() => []);
          const link = codes.map((c) => c.rawValue).find((value) => parsePairLink(value));
          if (link) return done.current.onLink(link);
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch (err) {
        if (!stopped) done.current.onClose(`The camera is not available: ${message(err)}`);
      }
    })();
    return () => {
      stopped = true;
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
  }, []);
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="host-scanner">
      <p>Point the camera at the QR code the host shows.</p>
      <video ref={video} muted playsInline className="max-h-64 w-full max-w-sm rounded bg-black" />
      <div>
        <Button type="button" variant="ghost" onClick={() => onClose()}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
