import type { AttachmentInfo, RenderNode, ResourceRef } from './types';

const STATUS_META: Record<ResourceRef['status'], { label: string; cls: string }> = {
  ok: { label: 'loads', cls: 'st-ok' },
  blocked_remote: { label: 'blocked', cls: 'st-blocked' },
  not_found: { label: 'missing', cls: 'st-missing' },
  cross_message: { label: 'cross-msg blocked', cls: 'st-cross' },
  duplicate_cid: { label: 'duplicate CID', cls: 'st-dup' },
};

export function ResourcePanel({
  resources,
  attachments,
  onJumpPart,
}: {
  resources: ResourceRef[];
  attachments: AttachmentInfo[];
  onJumpPart: (id: string) => void;
}) {
  return (
    <div className="resources">
      <h4>
        Resource graph{' '}
        <span className="muted">
          ({resources.filter((r) => r.status === 'ok').length} load / {resources.length} refs)
        </span>
      </h4>
      {resources.length === 0 && <p className="muted">No resource references in the displayed branch.</p>}
      <ul className="resource-list">
        {resources.map((r) => {
          const meta = STATUS_META[r.status];
          return (
            <li key={r.raw + r.kind} className={`res-row ${meta.cls}`}>
              <div className="res-top">
                <span className={`res-kind kind-${r.kind}`}>{r.kind}</span>
                <code className="res-raw" title={r.raw}>
                  {r.raw}
                </code>
                <span className={`res-status ${meta.cls}`}>{meta.label}</span>
              </div>
              <div className="res-detail">{r.detail}</div>
              {r.targetPartId && (
                <button className="link-btn" onClick={() => onJumpPart(r.targetPartId!)}>
                  → jump to MIME part {r.targetPartId}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <h4>
        Attachments ({attachments.length})
      </h4>
      {attachments.length === 0 && <p className="muted">None.</p>}
      <ul className="resource-list">
        {attachments.map((a) => (
          <li key={a.partId} className={`res-row ${a.error ? 'st-missing' : ''}`}>
            <div className="res-top">
              <span className="res-kind kind-attachment">attachment</span>
              <code className="res-raw" title={a.fileName}>
                📎 {a.fileName}
              </code>
              <span className="muted">{a.contentType}</span>
            </div>
            {a.nameCollision && (
              <div className="res-detail warn">⚠ another attachment uses the same filename</div>
            )}
            {a.error && <div className="res-detail warn">⚠ this part failed to decode</div>}
            <button className="link-btn" onClick={() => onJumpPart(a.partId)}>
              → jump to MIME part {a.partId}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RenderNodeView({
  node,
  onJumpPart,
  rawUrlFor,
}: {
  node: RenderNode;
  onJumpPart: (id: string) => void;
  rawUrlFor: (id: string) => string;
}) {
  return (
    <section className={`render-node rn-${node.kind}`}>
      <header className="rn-head">
        <span className={`rn-kind k-${node.kind}`}>{node.kind}</span>
        <span className="rn-label">{node.label}</span>
        <button className="link-btn" onClick={() => onJumpPart(node.partId)} title="Show source MIME part">
          part {node.partId} ↩
        </button>
      </header>

      {node.warning && <div className="alert warn">{node.warning}</div>}

      {node.kind === 'html' && node.html !== undefined && (
        <iframe
          className="preview-frame"
          title="Sanitized HTML preview"
          sandbox=""
          srcDoc={node.html}
          referrerPolicy="no-referrer"
        />
      )}

      {node.kind === 'text' && (
        <pre className="text-preview">{node.text ?? ''}</pre>
      )}

      {node.kind === 'image-inline' && (
        <div className="inline-image">
          <img src={rawUrlFor(node.partId)} alt={node.label} />
          <span className="muted">{node.label}</span>
        </div>
      )}

      {node.kind === 'error' && (
        <div className="alert error">This branch could not be rendered: {node.warning}</div>
      )}

      {node.kind === 'empty' && <div className="alert muted-box">{node.warning ?? node.label}</div>}
    </section>
  );
}
