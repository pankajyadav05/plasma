import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Segmented } from '@/components/ui/workbench';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import {
  type McpAccess,
  type McpSetupInfo,
  type McpStatus,
  claudeCodeSnippet,
  codexSnippet,
  cursorSnippet,
  effectiveAccess,
  maskToken,
  parseMcpPort,
  stdioSnippet,
} from '@shared/mcp';
import { Check, Copy, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

type Client = 'claude-code' | 'cursor' | 'codex' | 'desktop';

const ACCESS_LABEL: Record<McpAccess, string> = {
  off: 'Off',
  schema: 'Structure only',
  read: 'Structure and read queries',
  propose: 'Read, and propose changes',
};

const OUTCOME_LABEL = {
  ok: 'Done',
  error: 'Failed',
  declined: 'Declined',
  denied: 'Refused',
} as const;

/** Settings → MCP server: let Claude Code, Cursor, Codex and others use your databases through Plasma. */
export function McpSection() {
  const settings = useSession((s) => s.settings);
  const saved = useSession((s) => s.savedConnections);
  const updateSettings = useSession((s) => s.updateSettings);
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [token, setToken] = useState('');
  const [setup, setSetup] = useState<McpSetupInfo | null>(null);
  const [shown, setShown] = useState(false);
  const [client, setClient] = useState<Client>('claude-code');
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [portDraft, setPortDraft] = useState(String(settings.mcpPort));
  const enabled = settings.mcpEnabled === true;

  const refresh = useCallback(() => {
    void ipc.mcp.status().then(setStatus, () => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 1500);
    return () => window.clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    setPortDraft(String(settings.mcpPort));
  }, [settings.mcpPort]);

  useEffect(() => {
    if (!enabled) {
      setToken('');
      return;
    }
    void ipc.mcp.token().then(setToken, () => undefined);
    void ipc.mcp.setup().then(setSetup, () => undefined);
  }, [enabled]);

  const copy = (id: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    });
  };

  const commitPort = () => {
    const p = parseMcpPort(portDraft);
    if (p === null) {
      setPortDraft(String(settings.mcpPort));
      return;
    }
    if (p !== settings.mcpPort) void updateSettings({ mcpPort: p }).then(refresh);
  };

  const port = status?.port || settings.mcpPort;
  const snippetFor = (revealToken: boolean): string => {
    if (!setup) return '';
    const input = { port, token: revealToken ? token : maskToken(token), setup };
    switch (client) {
      case 'claude-code':
        return claudeCodeSnippet(input);
      case 'cursor':
        return cursorSnippet(input);
      case 'codex':
        return codexSnippet(input);
      case 'desktop':
        return stdioSnippet(input);
    }
  };
  const clientHint: Record<Client, string> = {
    'claude-code': 'Run this once in a terminal.',
    cursor: 'Add it to ~/.cursor/mcp.json.',
    codex: 'Add it to ~/.codex/config.toml.',
    desktop: setup?.launcherInstalled
      ? 'For Claude Desktop and any client that only speaks stdio. Add it to its MCP config file.'
      : 'For Claude Desktop and any client that only speaks stdio. Install the command-line tool in Advanced to get the short "plasma mcp" form; this one runs the app directly.',
  };

  const setAccess = (id: string, access: McpAccess) =>
    void updateSettings({
      connectionMcpAccess: { ...(settings.connectionMcpAccess ?? {}), [id]: access },
    });
  const setUnmasked = (id: string, on: boolean) =>
    void updateSettings({
      connectionMcpUnmasked: { ...(settings.connectionMcpUnmasked ?? {}), [id]: on },
    });

  return (
    <div className="flex flex-col gap-4 px-4 pb-4" data-testid="mcp-section">
      <p className="text-[12px] leading-snug text-[var(--wb-text-3)]">
        Let AI tools such as Claude Code, Cursor and Codex use your databases through Plasma. They
        read in a read-only session, with sensitive values masked, and can only change data when you
        approve it here. They never get a password. Off by default, and every connection starts with
        no access.
      </p>

      <div className="flex items-center gap-2">
        <Checkbox
          id="mcp-enable"
          data-testid="mcp-enable"
          checked={enabled}
          onCheckedChange={(v) => void updateSettings({ mcpEnabled: v === true }).then(refresh)}
        />
        <label htmlFor="mcp-enable" className="cursor-pointer text-[13px] text-[var(--wb-text)]">
          Turn on the MCP server
        </label>
        <output
          data-testid="mcp-status"
          className={
            status?.state === 'listening'
              ? 'ml-auto text-[12px] text-[var(--wb-text-2)]'
              : status && status.state !== 'off'
                ? 'ml-auto text-[12px] text-destructive'
                : 'ml-auto text-[12px] text-[var(--wb-text-3)]'
          }
        >
          {status?.message ?? 'Off'}
        </output>
      </div>

      <div className="grid grid-cols-[100px_1fr] items-center gap-x-4 gap-y-3">
        <label htmlFor="mcp-port" className="text-right text-[13px] text-[var(--wb-text-2)]">
          Port
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="mcp-port"
            data-testid="mcp-port"
            inputMode="numeric"
            className="w-[100px]"
            value={portDraft}
            onChange={(e) => setPortDraft(e.target.value)}
            onBlur={commitPort}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitPort();
            }}
            aria-describedby="mcp-port-hint"
          />
          <span id="mcp-port-hint" className="text-[12px] text-[var(--wb-text-3)]">
            1024 to 65535, on 127.0.0.1 only
          </span>
        </div>

        {enabled && (
          <>
            <span className="text-right text-[13px] text-[var(--wb-text-2)]">Token</span>
            <div className="flex min-w-0 items-center gap-2">
              <code
                data-testid="mcp-token"
                className="min-w-0 flex-1 truncate rounded-[6px] bg-[var(--wb-field)] px-2 py-1 font-mono text-[12px] text-[var(--wb-text-2)]"
              >
                {shown ? token : maskToken(token)}
              </code>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShown((v) => !v)}
                aria-label={shown ? 'Hide token' : 'Show token'}
              >
                {shown ? <EyeOff /> : <Eye />}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                data-testid="mcp-token-copy"
                onClick={() => copy('token', token)}
              >
                {copied === 'token' ? <Check /> : <Copy />}
                Copy
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirmRotate(true)}>
                <RefreshCw />
                Regenerate
              </Button>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title="Regenerate the token?"
        description="Clients using the old token will stop working."
        confirmLabel="Regenerate"
        onConfirm={() => void ipc.mcp.regenerateToken().then(setToken)}
      />

      {enabled && setup && (
        <section aria-label="Set up a client" className="flex flex-col gap-2">
          <h4 className="text-[13px] font-semibold text-[var(--wb-text)]">Set up a client</h4>
          <Segmented<Client>
            ariaLabel="Client"
            variant="track"
            value={client}
            onChange={setClient}
            options={[
              { value: 'claude-code', label: 'Claude Code' },
              { value: 'cursor', label: 'Cursor' },
              { value: 'codex', label: 'Codex' },
              { value: 'desktop', label: 'Claude Desktop' },
            ]}
          />
          <p className="text-[12px] text-[var(--wb-text-3)]">{clientHint[client]}</p>
          <div className="relative">
            <pre
              data-testid="mcp-snippet"
              className="overflow-x-auto whitespace-pre-wrap break-all rounded-[6px] bg-[var(--wb-field)] p-2 pr-20 font-mono text-[12px] text-[var(--wb-text-2)]"
            >
              {snippetFor(shown)}
            </pre>
            <Button
              variant="secondary"
              size="sm"
              className="absolute right-2 top-2"
              data-testid="mcp-snippet-copy"
              onClick={() => copy('snippet', snippetFor(true))}
            >
              {copied === 'snippet' ? <Check /> : <Copy />}
              Copy
            </Button>
          </div>
        </section>
      )}

      <section aria-label="Connections" className="flex flex-col gap-2">
        <h4 className="text-[13px] font-semibold text-[var(--wb-text)]">What AI tools may do</h4>
        {saved.length === 0 ? (
          <p className="text-[12px] text-[var(--wb-text-3)]">
            Save a connection to allow AI tools on it.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--wb-separator)] rounded-[8px] border border-[var(--wb-separator)]">
            {saved.map((c) => {
              const readOnly = c.readOnly === true;
              const prod = settings.connectionTags?.[c.id] === 'prod';
              const chosen = settings.connectionMcpAccess?.[c.id] ?? 'off';
              const shownValue = effectiveAccess(chosen, readOnly);
              return (
                <li key={c.id} className="flex flex-col gap-1 px-3 py-2">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-[var(--wb-text)]">{c.name}</div>
                      <div className="text-[11px] text-[var(--wb-text-3)]">
                        {[
                          c.engine ?? 'postgres',
                          prod ? 'production' : null,
                          readOnly ? 'read-only' : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                    <Select
                      value={shownValue}
                      onValueChange={(v) => setAccess(c.id, v as McpAccess)}
                    >
                      <SelectTrigger
                        className="w-[230px]"
                        data-testid={`mcp-access-${c.id}`}
                        aria-label={`AI tool access for ${c.name}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(ACCESS_LABEL) as McpAccess[]).map((a) => (
                          <SelectItem key={a} value={a} disabled={a === 'propose' && readOnly}>
                            {ACCESS_LABEL[a]}
                            {a === 'propose' && readOnly ? ' (connection is read-only)' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {prod && (shownValue === 'read' || shownValue === 'propose') && (
                    <p className="text-[12px] text-[var(--status-warn)]" role="note">
                      This is a production connection. AI tools will read live data
                      {shownValue === 'propose' ? ' and can propose changes to it' : ''}.
                    </p>
                  )}
                  {(shownValue === 'read' || shownValue === 'propose') && (
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={`mcp-unmasked-${c.id}`}
                        data-testid={`mcp-unmasked-${c.id}`}
                        checked={settings.connectionMcpUnmasked?.[c.id] === true}
                        onCheckedChange={(v) => setUnmasked(c.id, v === true)}
                      />
                      <label
                        htmlFor={`mcp-unmasked-${c.id}`}
                        className="cursor-pointer text-[12px] text-[var(--wb-text-2)]"
                      >
                        Send unmasked values to MCP clients
                      </label>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="Recent calls" className="flex flex-col gap-2">
        <h4 className="text-[13px] font-semibold text-[var(--wb-text)]">Recent calls</h4>
        <div data-testid="mcp-activity">
          {!status || status.activity.length === 0 ? (
            <p className="text-[12px] text-[var(--wb-text-3)]">Nothing yet.</p>
          ) : (
            <table className="w-full text-left text-[12px] text-[var(--wb-text-2)]">
              <thead className="text-[11px] text-[var(--wb-text-3)]">
                <tr>
                  <th className="py-1 pr-2 font-normal">Time</th>
                  <th className="py-1 pr-2 font-normal">Client</th>
                  <th className="py-1 pr-2 font-normal">Tool</th>
                  <th className="py-1 pr-2 font-normal">Connection</th>
                  <th className="py-1 font-normal">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {status.activity.map((a, i) => (
                  <tr key={`${a.ts}-${i}`} className="border-t border-[var(--wb-separator)]">
                    <td className="py-1 pr-2 tabular-nums">
                      {new Date(a.ts).toLocaleTimeString()}
                    </td>
                    <td className="py-1 pr-2">{a.client}</td>
                    <td className="py-1 pr-2 font-mono">{a.tool}</td>
                    <td className="py-1 pr-2">{a.connectionName ?? ''}</td>
                    <td className="py-1">{OUTCOME_LABEL[a.outcome]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
