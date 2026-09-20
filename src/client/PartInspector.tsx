import type { PartDetail } from './types';

type Props = {
  part: PartDetail | null;
  loading: boolean;
  rawUrl: string | null;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export default function PartInspector({ part, loading, rawUrl }: Props) {
  if (loading) return <div className="inspector"><p className="muted">Loading part…</p></div>;
  if (!part)
    return (
      <div className="inspector">
        <p className="muted">
          Select a part in the MIME tree, or click the part id on a render node / resource.
        </p>
      </div>
    );

  return (
    <div className="inspector">
      <div className="inspector-head">
        <span className="part-id" title="MIME part id">{part.id}</span>
        <span className="tree-ctype">{part.contentType || 'unknown'}</span>
        {part.disposition && <span className="badge enc">{part.disposition}</span>}
        <span className="muted">{formatBytes(part.size)}</span>
      </div>

      {part.error && (
        <div className="alert error">
          <strong>⚠ {part.error.code}</strong>
          <div>{part.error.message}</div>
        </div>
      )}
      {part.decodeError && !part.error && (
        <div className="alert warn">
          <strong>{part.decodeError.code}</strong>
          <div>{part.decodeError.message}</div>
        </div>
      )}

      <dl className="meta-grid">
        <dt>Content-ID</dt>
        <dd>{part.cid ? <code>&lt;{part.cid}&gt;</code> : <span className="muted">—</span>}</dd>
        <dt>Content-Location</dt>
        <dd>{part.contentLocation || <span className="muted">—</span>}</dd>
        <dt>Transfer encoding</dt>
        <dd>{part.encoding || <span className="muted">7bit (default)</span>}</dd>
        <dt>File name</dt>
        <dd>{part.fileName || <span className="muted">—</span>}</dd>
      </dl>

      <h4>Raw headers (preserved order)</h4>
      <pre className="headers">
        {part.headers.map((h, i) => (
          <div key={i}>
            <span className="hname">{h.name}</span>: {h.value}
          </div>
        ))}
        {part.headers.length === 0 && <em className="muted">no parseable headers</em>}
      </pre>

      {part.decodedText !== null && (
        <>
          <h4>Decoded body (after transfer encoding + charset)</h4>
          <pre className="body-preview">{part.decodedText.slice(0, 4000)}</pre>
          {part.decodedText.length > 4000 && (
            <p className="muted">truncated ({part.decodedText.length} chars total)</p>
          )}
        </>
      )}

      {rawUrl && (
        <p className="raw-link">
          <a href={rawUrl} target="_blank" rel="noreferrer">
            Open decoded raw part in a new tab
          </a>
        </p>
      )}

      <h4>Raw source (headers + undecoded body)</h4>
      <pre className="raw-source">{part.rawSource.slice(0, 6000)}</pre>
    </div>
  );
}
