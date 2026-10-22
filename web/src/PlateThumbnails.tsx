import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { thumbnailOptions } from './query-options.js';

function Thumbnail({ uuid, id, plate }: { uuid: string; id: string; plate: number }) {
  const { data: blob } = useQuery(thumbnailOptions(uuid, id));
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!blob) return;
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url ? (
    <img src={url} alt="" />
  ) : (
    <span className="thumbnail-placeholder" aria-hidden="true">
      {plate}
    </span>
  );
}
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
          <Thumbnail uuid={uuid} id={id} plate={plate} />
          <span>プレート {plate}</span>
        </button>
      ))}
    </nav>
  );
}
