import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo } from 'react';
import { db } from '@/db';

/** An object URL for a blob stored in Dexie (screenshot, audio, video), revoked when it changes or unmounts. */
export function useBlobUrl(id: string | null | undefined): string | null {
  const row = useLiveQuery(() => (id ? db.blobs.get(id) : undefined), [id]);
  const url = useMemo(() => (row ? URL.createObjectURL(row.blob) : null), [row]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return url;
}
