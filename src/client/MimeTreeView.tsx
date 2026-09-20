import type { PartSummary, RenderNode } from './types';

type Props = {
  parts: PartSummary[];
  rootId: string;
  selectedPartId: string | null;
  nodes: RenderNode[];
  resourcePartIds: Set<string>;
  attachmentPartIds: Set<string>;
  onSelect: (partId: string) => void;
};

const KIND_BADGE: Record<RenderNode['kind'], string> = {
  html: 'display html',
  text: 'display text',
  'image-inline': 'display image',
  error: 'displayed error',
  empty: 'skipped',
};

export default function MimeTreeView({
  parts,
  rootId,
  selectedPartId,
  nodes,
  resourcePartIds,
  attachmentPartIds,
  onSelect,
}: Props) {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const nodeByPart = new Map<string, RenderNode>();
  for (const n of nodes) nodeByPart.set(n.partId, n);

  function depthOf(id: string): number {
    // p0, p0.1, p0.1.2 -> segment count minus 1
    return id.split('.').length - 1;
  }

  function renderPart(part: PartSummary) {
    const node = nodeByPart.get(part.id);
    const isResource = resourcePartIds.has(part.id);
    const isAttachment = attachmentPartIds.has(part.id);
    const selected = part.id === selectedPartId;
    return (
      <div key={part.id}>
        <button
          className={`tree-row${selected ? ' selected' : ''}${part.error ? ' has-error' : ''}${
            node ? ' is-display' : ''
          }`}
          style={{ paddingLeft: 8 + depthOf(part.id) * 14 }}
          onClick={() => onSelect(part.id)}
          title={part.error?.message}
        >
          <span className="tree-ctype">{part.contentType || 'unknown'}</span>
          {part.fileName && <span className="tree-name" title={part.fileName}>📎 {part.fileName}</span>}
          {part.cid && <span className="badge cid" title={'Content-ID'}>cid:{part.cid}</span>}
          {part.encoding && <span className="badge enc" title="transfer encoding">{part.encoding}</span>}
          {node && <span className={`badge node node-${node.kind}`}>{KIND_BADGE[node.kind]}</span>}
          {!node && isResource && <span className="badge res">related</span>}
          {!node && isAttachment && <span className="badge att">attachment</span>}
          {part.error && <span className="badge err" title={part.error.message}>⚠ {part.error.code}</span>}
        </button>
        {part.childIds.map((cid) => {
          const child = byId.get(cid);
          return child ? renderPart(child) : null;
        })}
      </div>
    );
  }

  const root = byId.get(rootId);
  return <div className="tree">{root ? renderPart(root) : <em>No parts</em>}</div>;
}
