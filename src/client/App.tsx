import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AlertTriangle, FileDown, FilePlus2, Info, Link2, Mail, Paperclip, RefreshCw, Trash2} from 'lucide-react';

interface Diagnostic {level: 'error' | 'warning' | 'info'; code: string; message: string}
interface TreePart {
  id: string; contentType: string; transferEncoding: string; contentId: string | null;
  disposition: string; filename: string | null; charset: string | null; size: number;
  diagnostics: Diagnostic[]; bodyPreview: string; children: TreePart[];
}
interface Summary {id: string; name: string; createdAt: string; parts: number; diagnostics: number}
interface ClientProfile {id: string; label: string; preferHtml: boolean; loadRemote: boolean; sanitize: boolean}
interface RenderPlan {
  messageId: string; client: string; renderToken: number;
  body: {partId: string; mediaType: string; html: string; derivedFromHtml: boolean} | null;
  resources: Array<{cid: string; partId: string; status: 'ok' | 'duplicate' | 'unreferenced'; proxyUrl: string}>;
  missingResources: Array<{cid: string}>;
  attachments: Array<{partId: string; filename: string; mediaType: string; size: number; duplicateName: boolean; downloadUrl: string}>;
  externalRefs: Array<{url: string; kind: string; blocked: boolean}>;
  diagnostics: Array<Diagnostic & {partId: string | null}>;
}
interface PartDetail {
  id: string; headers: Record<string, string>; contentType: string; transferEncoding: string;
  contentId: string | null; disposition: string; filename: string | null; charset: string | null;
  diagnostics: Diagnostic[]; rawBody: string; decodedSize: number | null; decodedText: string | null;
}

function TreeNode(props: {part: TreePart; depth: number; selected: string | null; collapsed: Set<string>;
  onSelect: (id: string) => void; onToggle: (id: string) => void; registerRef: (id: string, el: HTMLButtonElement | null) => void}) {
  const {part, depth, selected, collapsed, onSelect, onToggle, registerRef} = props;
  const hasErrors = part.diagnostics.some((d) => d.level === 'error');
  const isCollapsed = collapsed.has(part.id);
  return (
    <div>
      <button
        ref={(el) => registerRef(part.id, el)}
        className={`tree-node${selected === part.id ? ' active' : ''}`}
        style={{paddingLeft: 8 + depth * 14}}
        onClick={() => {onSelect(part.id); if (part.children.length > 0) onToggle(part.id);}}
      >
        {part.children.length > 0 && <span className="twisty">{isCollapsed ? '▸' : '▾'}</span>}
        <span className="ctype">{part.contentType}</span>
        {part.filename && <span className="fname">{part.filename}</span>}
        {part.contentId && <span className="cid">cid:{part.contentId}</span>}
        <span className="enc">{part.transferEncoding}</span>
        {hasErrors && <span className="badge error">{part.diagnostics.length}</span>}
        {!hasErrors && part.diagnostics.length > 0 && <span className="badge warn">{part.diagnostics.length}</span>}
      </button>
      {!isCollapsed && part.children.map((child) => (
        <TreeNode key={child.id} part={child} depth={depth + 1} selected={selected} collapsed={collapsed}
          onSelect={onSelect} onToggle={onToggle} registerRef={registerRef}/>
      ))}
    </div>
  );
}

export default function App() {
  const [clients, setClients] = useState<ClientProfile[]>([]);
  const [clientId, setClientId] = useState('desktop');
  const [messages, setMessages] = useState<Summary[]>([]);
  const [messageId, setMessageId] = useState<string | null>(null);
  const [tree, setTree] = useState<TreePart | null>(null);
  const [plan, setPlan] = useState<RenderPlan | null>(null);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [partDetail, setPartDetail] = useState<PartDetail | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [importText, setImportText] = useState('');
  const [importName, setImportName] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Stale-response guards: a preview is applied only if it is still the latest
  // request (seq) and its server token is not older than the last applied one.
  const renderSeq = useRef(0);
  const lastAppliedToken = useRef(0);
  const partSeq = useRef(0);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());

  const loadMessages = useCallback(async () => {
    const list: Summary[] = await (await fetch('/api/messages')).json();
    setMessages(list);
    return list;
  }, []);

  useEffect(() => {
    void (async () => {
      setClients(await (await fetch('/api/clients')).json());
      const list = await loadMessages();
      if (list.length > 0) setMessageId((current) => current ?? list[0].id);
    })();
  }, [loadMessages]);

  useEffect(() => {
    if (!messageId) return;
    let cancelled = false;
    void (async () => {
      const data = await (await fetch(`/api/messages/${messageId}`)).json();
      if (cancelled) return;
      setTree(data.tree);
      setSelectedPartId(null);
      setPartDetail(null);
      setCollapsed(new Set());
      lastAppliedToken.current = 0;
    })();
    return () => {cancelled = true;};
  }, [messageId]);

  useEffect(() => {
    if (!messageId) return;
    const seq = ++renderSeq.current;
    void (async () => {
      const response = await fetch(`/api/messages/${messageId}/render`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({client: clientId}),
      });
      const next: RenderPlan = await response.json();
      if (seq !== renderSeq.current) return; // superseded by a newer request
      if (next.renderToken < lastAppliedToken.current) return; // stale server response
      lastAppliedToken.current = next.renderToken;
      setPlan(next);
    })();
  }, [messageId, clientId]);

  useEffect(() => {
    if (!messageId || !selectedPartId) {setPartDetail(null); return;}
    const seq = ++partSeq.current;
    void (async () => {
      const response = await fetch(`/api/messages/${messageId}/parts/${selectedPartId}`);
      if (!response.ok) return;
      const detail: PartDetail = await response.json();
      if (seq !== partSeq.current) return;
      setPartDetail(detail);
    })();
  }, [messageId, selectedPartId]);

  // Jump from a render node back to its MIME part: select, expand ancestors, scroll.
  const jumpToPart = useCallback((partId: string) => {
    setSelectedPartId(partId);
    setCollapsed((current) => {
      const next = new Set(current);
      const segments = partId.split('.');
      for (let i = 1; i < segments.length; i++) next.delete(segments.slice(0, i).join('.'));
      return next;
    });
    requestAnimationFrame(() => nodeRefs.current.get(partId)?.scrollIntoView({block: 'nearest'}));
  }, []);

  const registerRef = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) nodeRefs.current.set(id, el); else nodeRefs.current.delete(id);
  }, []);

  const onToggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  async function importMessage() {
    setNotice(null);
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({name: importName || undefined, raw: importText}),
    });
    const data = await response.json();
    if (!response.ok) {setNotice(data.detail ?? data.error ?? 'Import failed'); return;}
    setImportText(''); setImportName(''); setShowImport(false);
    await loadMessages();
    setMessageId(data.summary.id);
  }

  async function removeMessage(id: string) {
    await fetch(`/api/messages/${id}`, {method: 'DELETE'});
    const list = await loadMessages();
    if (messageId === id) {setMessageId(list[0]?.id ?? null); setTree(null); setPlan(null);}
  }

  const profile = useMemo(() => clients.find((c) => c.id === clientId), [clients, clientId]);

  return (
    <main className="shell">
      <header className="topbar">
        <Mail size={18}/><strong>MIME Rendering Lab</strong>
        <small>parse · select · preview — nothing is sent</small>
        <span className="spacer"/>
        {profile && <span className="pill">{profile.label}{profile.sanitize ? ' · sanitized' : ''}{profile.loadRemote ? ' · remote on' : ' · remote off'}</span>}
      </header>
      <section className="workspace">
        <aside className="pane">
          <div className="toolbar">
            <h2>Messages</h2>
            <button onClick={() => setShowImport((v) => !v)} title="Import raw MIME"><FilePlus2 size={14}/>Import</button>
          </div>
          {showImport && (
            <div className="import-box">
              <input aria-label="Message name" placeholder="Name (optional)" value={importName} onChange={(e) => setImportName(e.target.value)}/>
              <textarea aria-label="Raw MIME" placeholder="Paste raw MIME source…" value={importText} onChange={(e) => setImportText(e.target.value)} rows={8}/>
              <button className="primary" onClick={importMessage}>Parse &amp; import</button>
            </div>
          )}
          {notice && <p className="notice error-text">{notice}</p>}
          <div className="list">
            {messages.map((m) => (
              <div key={m.id} className={`msg-row${m.id === messageId ? ' active' : ''}`}>
                <button onClick={() => setMessageId(m.id)}>
                  {m.name}<br/><small>{m.parts} parts · {m.diagnostics} diagnostics</small>
                </button>
                <button className="icon" title="Delete" onClick={() => void removeMessage(m.id)}><Trash2 size={13}/></button>
              </div>
            ))}
          </div>
          <h2>Client profile</h2>
          <div className="list">
            {clients.map((c) => (
              <button key={c.id} className={`client-btn${c.id === clientId ? ' active' : ''}`} onClick={() => setClientId(c.id)}>
                {c.label}<br/><small>{c.preferHtml ? 'HTML' : 'plain'} · remote {c.loadRemote ? 'on' : 'off'}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane">
          <h2>MIME tree</h2>
          {tree
            ? <TreeNode part={tree} depth={0} selected={selectedPartId} collapsed={collapsed}
                onSelect={setSelectedPartId} onToggle={onToggle} registerRef={registerRef}/>
            : <p className="muted">No message selected.</p>}
          {partDetail && (
            <div className="part-detail">
              <h3>Part {partDetail.id} <span className="pill">{partDetail.contentType}</span></h3>
              <dl>
                <dt>Transfer-Encoding</dt><dd>{partDetail.transferEncoding}</dd>
                {partDetail.contentId && <><dt>Content-ID</dt><dd>&lt;{partDetail.contentId}&gt;</dd></>}
                {partDetail.filename && <><dt>Filename</dt><dd>{partDetail.filename}</dd></>}
                {partDetail.charset && <><dt>Charset</dt><dd>{partDetail.charset}</dd></>}
                {partDetail.decodedSize !== null && <><dt>Decoded size</dt><dd>{partDetail.decodedSize} bytes</dd></>}
              </dl>
              {partDetail.diagnostics.map((d, i) => (
                <p key={i} className={`notice ${d.level}`}><AlertTriangle size={12}/> [{d.code}] {d.message}</p>
              ))}
              {partDetail.decodedText !== null && <><h4>Decoded</h4><pre className="raw">{partDetail.decodedText}</pre></>}
              <h4>Raw body</h4>
              <pre className="raw">{partDetail.rawBody.slice(0, 2000)}</pre>
            </div>
          )}
        </section>

        <aside className="pane preview">
          <div className="toolbar">
            <h2>Preview</h2>
            {plan && <span className="muted">token #{plan.renderToken}</span>}
            <button className="icon" title="Re-render" onClick={() => setClientId((c) => c)}><RefreshCw size={13}/></button>
          </div>
          {plan?.body ? (
            <>
              <button className="chip" onClick={() => jumpToPart(plan.body!.partId)}>
                body: {plan.body.mediaType} · part {plan.body.partId}{plan.body.derivedFromHtml ? ' · text derived from HTML' : ''}
              </button>
              <iframe title="preview" sandbox="" referrerPolicy="no-referrer" srcDoc={plan.body.html}/>
            </>
          ) : (
            <p className="notice error-text">No displayable body for this client profile — see diagnostics.</p>
          )}
          {plan && plan.resources.length > 0 && (
            <>
              <h3><Link2 size={13}/> Related resources</h3>
              {plan.resources.map((r) => (
                <button key={r.partId} className={`chip ${r.status}`} onClick={() => jumpToPart(r.partId)}>
                  cid:{r.cid} → part {r.partId} · {r.status}
                </button>
              ))}
            </>
          )}
          {plan && plan.missingResources.length > 0 && (
            <p className="notice warning"><AlertTriangle size={12}/> Missing resources: {plan.missingResources.map((m) => `cid:${m.cid}`).join(', ')}</p>
          )}
          {plan && plan.attachments.length > 0 && (
            <>
              <h3><Paperclip size={13}/> Attachments</h3>
              {plan.attachments.map((a) => (
                <div key={a.partId} className="attach-row">
                  <button className="chip" onClick={() => jumpToPart(a.partId)}>
                    {a.filename}{a.duplicateName ? ` (part ${a.partId})` : ''} · {a.size} B
                  </button>
                  <a className="icon" href={a.downloadUrl} title="Download via proxy"><FileDown size={13}/></a>
                </div>
              ))}
            </>
          )}
          {plan && plan.externalRefs.length > 0 && (
            <>
              <h3>External references</h3>
              {plan.externalRefs.map((e, i) => (
                <p key={i} className="notice info"><Info size={12}/> {e.kind}: {e.url} — {e.blocked ? 'blocked' : 'allowed'}</p>
              ))}
            </>
          )}
          {plan && plan.diagnostics.length > 0 && (
            <>
              <h3>Diagnostics</h3>
              {plan.diagnostics.map((d, i) => (
                <p key={i} className={`notice ${d.level}`} onClick={() => d.partId && jumpToPart(d.partId)}>
                  <AlertTriangle size={12}/> {d.partId ? `part ${d.partId} · ` : ''}[{d.code}] {d.message}
                </p>
              ))}
            </>
          )}
        </aside>
      </section>
    </main>
  );
}
