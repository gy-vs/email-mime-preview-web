import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlaskConical, Import, RefreshCw, ShieldAlert } from 'lucide-react';
import { api } from './api';
import type {
  ClientProfile,
  MessageSummary,
  PartDetail,
  SelectionResult,
  TreeResponse,
} from './types';
import MimeTreeView from './MimeTreeView';
import PartInspector from './PartInspector';
import { RenderNodeView, ResourcePanel } from './Panels';
import { RequestToken } from './requestToken';

export default function App() {
  const [profiles, setProfiles] = useState<ClientProfile[]>([]);
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [messageId, setMessageId] = useState<string>('');
  const [profileId, setProfileId] = useState<string>('strict_html');

  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [selection, setSelection] = useState<SelectionResult | null>(null);
  const [partId, setPartId] = useState<string | null>(null);
  const [part, setPart] = useState<PartDetail | null>(null);
  const [partLoading, setPartLoading] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importName, setImportName] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Guards against stale responses: tree and selection use separate
  // generations (both effects can be in flight simultaneously); an older
  // response is always discarded in favour of the latest request.
  const treeToken = useRef(new RequestToken());
  const selectionToken = useRef(new RequestToken());
  const treeAbort = useRef<AbortController | null>(null);
  const selectionAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    api.profiles().then(setProfiles).catch(() => undefined);
    api.messages().then((list) => {
      setMessages(list);
      if (list[0]) setMessageId(list[0].id);
    });
  }, []);

  // Load the MIME tree whenever the chosen message changes.
  useEffect(() => {
    if (!messageId) return;
    const token = treeToken.current.next();
    treeAbort.current?.abort();
    const controller = new AbortController();
    treeAbort.current = controller;
    setTree(null);
    setSelection(null);
    setPart(null);
    setPartId(null);
    api
      .tree(messageId, controller.signal)
      .then((t) => {
        if (treeToken.current.isStale(token)) return; // superseded
        setTree(t);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') console.error(err);
      });
  }, [messageId]);

  // (Re)compute the client selection. Keyed by message+profile; a slow earlier
  // response can never overwrite the current selection because of the token.
  useEffect(() => {
    if (!messageId || !tree) return;
    const token = selectionToken.current.next();
    selectionAbort.current?.abort();
    const controller = new AbortController();
    selectionAbort.current = controller;
    setSelection(null);
    api
      .selection(messageId, profileId, controller.signal)
      .then((sel) => {
        if (selectionToken.current.isStale(token)) return; // profile changed
        setSelection(sel);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') console.error(err);
      });
  }, [messageId, profileId, tree]);

  // Load details for the inspected part.
  useEffect(() => {
    if (!messageId || !partId) {
      setPart(null);
      setPartLoading(false);
      return;
    }
    const controller = new AbortController();
    setPartLoading(true);
    setPart(null);
    api
      .part(messageId, partId, controller.signal)
      .then(setPart)
      .catch((err) => {
        if (err.name !== 'AbortError') console.error(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setPartLoading(false);
      });
    return () => controller.abort();
  }, [messageId, partId]);

  const refreshMessages = useCallback(async () => {
    setMessages(await api.messages());
  }, []);

  async function doImport() {
    setImportError(null);
    if (!importText.trim()) {
      setImportError('Paste a raw MIME message first.');
      return;
    }
    setBusy(true);
    try {
      const { id } = await api.importMessage(importText, importName || 'Imported message');
      await refreshMessages();
      setMessageId(id);
      setImportOpen(false);
      setImportText('');
      setImportName('');
    } catch (err) {
      setImportError(String(err));
    } finally {
      setBusy(false);
    }
  }

  const resourcePartIds = useMemo(
    () => new Set((selection?.resources ?? []).map((r) => r.targetPartId).filter(Boolean) as string[]),
    [selection],
  );
  const attachmentPartIds = useMemo(
    () => new Set((selection?.attachments ?? []).map((a) => a.partId)),
    [selection],
  );
  const activeProfile = profiles.find((p) => p.id === profileId) ?? null;

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={18} />
        <strong>Email Rendering Lab</strong>
        <span className="muted">parse · select · preview — nothing is sent</span>
        <span className="spacer" />
        <button className="btn" onClick={() => setImportOpen((v) => !v)}>
          <Import size={14} /> Import MIME
        </button>
        <button className="btn icon" onClick={refreshMessages} title="Reload message list">
          <RefreshCw size={14} />
        </button>
      </header>

      {importOpen && (
        <div className="import-panel">
          <div className="import-row">
            <input
              placeholder="Message name (optional)"
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
            />
            <button className="btn primary" disabled={busy} onClick={doImport}>
              {busy ? 'Importing…' : 'Parse & import'}
            </button>
            <button className="btn" onClick={() => setImportOpen(false)}>
              Cancel
            </button>
          </div>
          <textarea
            placeholder={'Paste the complete raw MIME message, including headers. e.g.\nFrom: a@b\nContent-Type: multipart/mixed; boundary="x"\n\n--x\n...'}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={8}
          />
          {importError && <div className="alert error">{importError}</div>}
        </div>
      )}

      <div className="message-bar">
        <label>
          Message
          <select value={messageId} onChange={(e) => setMessageId(e.target.value)}>
            {messages.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.partCount} parts{m.errorCount ? `, ${m.errorCount} errors` : ''})
              </option>
            ))}
          </select>
        </label>
        <label>
          Simulated client
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {activeProfile && (
          <div className="profile-flags">
            <Flag on={!activeProfile.textOnly} label="HTML" />
            <Flag on={activeProfile.useRelated} label="related CID" />
            <Flag on={activeProfile.inlineImages} label="inline images" />
            <Flag on={activeProfile.allowRemote} label="remote (proxied)" danger />
            <Flag on={activeProfile.lenient} label="lenient" />
          </div>
        )}
        {activeProfile && <p className="profile-desc muted">{activeProfile.description}</p>}
      </div>

      <section className="workspace">
        <aside className="pane tree-pane">
          <h3>MIME tree <span className="muted">raw hierarchy</span></h3>
          {tree ? (
            <MimeTreeView
              parts={tree.parts}
              rootId={tree.rootId}
              selectedPartId={partId}
              nodes={selection?.nodes ?? []}
              resourcePartIds={resourcePartIds}
              attachmentPartIds={attachmentPartIds}
              onSelect={setPartId}
            />
          ) : (
            <p className="muted">Parsing…</p>
          )}
          {tree && tree.errors.length > 0 && (
            <div className="alert warn tree-errors">
              <ShieldAlert size={13} /> {tree.errors.length} branch-local parse
              {tree.errors.length > 1 ? ' errors' : ' error'} — other branches still rendered.
            </div>
          )}
        </aside>

        <section className="pane preview-pane">
          <h3>Final body for this client</h3>
          {!selection ? (
            <p className="muted">Selecting displayable branch…</p>
          ) : (
            <>
              {selection.notices.length > 0 && (
                <ul className="notices">
                  {selection.notices.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
              {selection.nodes.map((node) => (
                <RenderNodeView
                  key={node.key}
                  node={node}
                  onJumpPart={setPartId}
                  rawUrlFor={(pid) => api.rawUrl(messageId, pid)}
                />
              ))}
            </>
          )}
        </section>

        <aside className="pane side-pane">
          <div className="side-block">
            <h3>Resources &amp; attachments</h3>
            {selection ? (
              <ResourcePanel
                resources={selection.resources}
                attachments={selection.attachments}
                onJumpPart={setPartId}
              />
            ) : (
              <p className="muted">Loading…</p>
            )}
          </div>
          <div className="side-block inspector-block">
            <h3>MIME part inspector</h3>
            <PartInspector
              part={part}
              loading={partLoading}
              rawUrl={part && messageId ? api.rawUrl(messageId, part.id) : null}
            />
          </div>
        </aside>
      </section>
    </main>
  );
}

function Flag({ on, label, danger }: { on: boolean; label: string; danger?: boolean }) {
  return (
    <span className={`flag ${on ? (danger ? 'flag-danger' : 'flag-on') : 'flag-off'}`}>
      {on ? '●' : '○'} {label}
    </span>
  );
}
