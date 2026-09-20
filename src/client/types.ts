// Shared API shapes mirrored from the server.

export type ClientProfile = {
  id: string;
  label: string;
  description: string;
  textOnly: boolean;
  useRelated: boolean;
  inlineImages: boolean;
  allowRemote: boolean;
  lenient: boolean;
};

export type MessageSummary = {
  id: string;
  name: string;
  builtin: boolean;
  createdAt: string;
  partCount: number;
  errorCount: number;
  duplicateCids: string[];
  duplicateAttachmentNames: string[];
};

export type PartSummary = {
  id: string;
  contentType: string;
  contentTypeParams: Record<string, string>;
  disposition: string | null;
  fileName: string | null;
  cid: string | null;
  contentLocation: string | null;
  encoding: string | null;
  size: number;
  isMultipart: boolean;
  childIds: string[];
  error: { code: string; message: string } | null;
  headers: { name: string; value: string }[];
};

export type TreeResponse = {
  id: string;
  name: string;
  builtin: boolean;
  parts: PartSummary[];
  rootId: string;
  errors: { partId: string; code: string; message: string }[];
  duplicateCids: string[];
  duplicateAttachmentNames: string[];
};

export type ResourceRef = {
  raw: string;
  kind: 'cid' | 'content-location' | 'remote' | 'attachment';
  targetPartId: string | null;
  status: 'ok' | 'blocked_remote' | 'not_found' | 'cross_message' | 'duplicate_cid';
  detail: string;
};

export type AttachmentInfo = {
  partId: string;
  fileName: string;
  contentType: string;
  size: number;
  nameCollision: boolean;
  error: boolean;
};

export type RenderNode = {
  key: string;
  kind: 'html' | 'text' | 'image-inline' | 'error' | 'empty';
  partId: string;
  label: string;
  html?: string;
  text?: string;
  warning?: string;
};

export type SelectionResult = {
  profileId: string;
  nodes: RenderNode[];
  resources: ResourceRef[];
  attachments: AttachmentInfo[];
  notices: string[];
};

export type PartDetail = PartSummary & {
  rawSource: string;
  rawBody: string | null;
  decodedText: string | null;
  decodeError: { code: string; message: string } | null;
};
