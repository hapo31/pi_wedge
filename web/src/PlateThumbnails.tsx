import { useEffect, useState } from 'react';
import { getThumbnail } from './preview-queries.js';
export function PlateThumbnails({
  uuid,
  plates,
  selected,
  disabled,
  onSelect,
}: {
  uuid: string;
  plates: { id: string; plate: number }[];
  selected: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const [images, setImages] = useState<Record<string, string>>({});
  const key = plates.map((p) => p.id).join(',');
  useEffect(() => {
    const abort = new AbortController();
    const urls: string[] = [];
    setImages({});
    void (async () => {
      // Load one at a time to stay within the server's preview memory budget.
      for (const plate of key.split(',')) {
        try {
          const blob = await getThumbnail(uuid, plate, abort.signal);
          abort.signal.throwIfAborted();
          const url = URL.createObjectURL(blob);
          urls.push(url);
          setImages((previous) => ({ ...previous, [plate]: url }));
        } catch {
          if (abort.signal.aborted) return;
        }
      }
    })();
    return () => {
      abort.abort();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [uuid, key]);
  return (
    <nav className="plate-thumbnails" aria-label="プレート">
      {plates.map(({ id, plate }) => (
        <button
          key={id}
          type="button"
          aria-pressed={id === selected}
          disabled={disabled}
          onClick={() => onSelect(id)}
        >
          {images[id] ? (
            <img src={images[id]} alt="" />
          ) : (
            <span className="thumbnail-placeholder" aria-hidden="true">
              {plate}
            </span>
          )}
          <span>プレート {plate}</span>
        </button>
      ))}
    </nav>
  );
}
