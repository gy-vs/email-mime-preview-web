import type {
  ClientProfile,
  MessageSummary,
  PartDetail,
  SelectionResult,
  TreeResponse,
} from './types';

async function asJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await response.json());
    } catch {
      /* ignore */
    }
    throw new Error(`${response.status} ${response.statusText} ${detail}`);
  }
  return (await response.json()) as T;
}

export const api = {
  async profiles(signal?: AbortSignal): Promise<ClientProfile[]> {
    return asJson(await fetch('/api/client-profiles', { signal }));
  },
  async messages(signal?: AbortSignal): Promise<MessageSummary[]> {
    return asJson(await fetch('/api/messages', { signal }));
  },
  async importMessage(raw: string, name: string): Promise<{ id: string }> {
    return asJson(
      await fetch('/api/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw, name }),
      }),
    );
  },
  async tree(id: string, signal?: AbortSignal): Promise<TreeResponse> {
    return asJson(await fetch(`/api/messages/${encodeURIComponent(id)}/tree`, { signal }));
  },
  async selection(id: string, profileId: string, signal?: AbortSignal): Promise<SelectionResult> {
    const q = new URLSearchParams({ profile: profileId });
    return asJson(
      await fetch(`/api/messages/${encodeURIComponent(id)}/selection?${q}`, { signal }),
    );
  },
  async part(id: string, partId: string, signal?: AbortSignal): Promise<PartDetail> {
    return asJson(
      await fetch(
        `/api/messages/${encodeURIComponent(id)}/parts/${encodeURIComponent(partId)}`,
        { signal },
      ),
    );
  },
  rawUrl(id: string, partId: string): string {
    return `/api/messages/${encodeURIComponent(id)}/parts/${encodeURIComponent(partId)}/raw`;
  },
};
