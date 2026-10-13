import { useEffect, useRef, useState } from 'react';
import { init } from 'gcode-preview';
import { previewInput } from './preview-input.js';
import type { WebGLPreview } from 'gcode-preview';
import type { LineSegments, Material, LineBasicMaterial } from 'three';
const TRAVEL = '#526373';
function setVisibility(preview: WebGLPreview, layer: number, single: boolean, travel: boolean) {
  for (const group of preview.scene.children) {
    const match = group.name.match(/^layer(\d+)$/);
    if (!match) continue;
    const index = Number(match[1]);
    group.visible = index > 0 && (single ? index === layer : index <= layer);
    group.traverse((object) => {
      const line = object as LineSegments;
      if (line.isLineSegments) {
        const material = line.material as Material & Partial<LineBasicMaterial>;
        if (material.color?.getHexString() === TRAVEL.slice(1)) line.visible = travel;
      }
    });
  }
}
export function Viewer({ text, onReady }: { text: string; onReady: (ready: boolean) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null),
    preview = useRef<WebGLPreview | null>(null);
  const [count, setCount] = useState(0),
    [layer, setLayer] = useState(1),
    [single, setSingle] = useState(false),
    [travel, setTravel] = useState(false),
    [loading, setLoading] = useState(true),
    [progress, setProgress] = useState(0),
    [error, setError] = useState(''),
    [heights, setHeights] = useState<number[]>([]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const abort = new AbortController();
    let instance: WebGLPreview | null = null;
    let observer: ResizeObserver | undefined;
    onReady(false);
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const lines = previewInput(text).split('\n');
        if (lines.length > 250000) throw new Error('G-codeの行数がプレビュー上限を超えています。');
        instance = init({
          canvas: element,
          buildVolume: { x: 180, y: 180, z: 180 },
          backgroundColor: '#101a25',
          extrusionColor: '#4bd5bc',
          travelColor: TRAVEL,
          topLayerColor: '#ffc27a',
          renderTravel: true,
          renderTubes: false,
          startLayer: 2,
          minLayerThreshold: 0.05,
          initialCameraPosition: [250, 220, 250],
        });
        preview.current = instance;
        observer = new ResizeObserver(() => instance?.resize());
        observer.observe(element.parentElement!);
        instance.resize();
        instance.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        for (let i = 0; i < lines.length; i += 1000) {
          abort.signal.throwIfAborted();
          instance.parser.parseGCode(lines.slice(i, i + 1000));
          instance.parser.lines = [];
          setProgress(Math.round((Math.min(i + 1000, lines.length) / lines.length) * 70));
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
        }
        const layers = instance.parser.layers;
        if (!layers.length) throw new Error('表示できる押出ツールパスがありません。');
        if (layers.some((l) => l.commands.length > 20000))
          throw new Error('単一レイヤーのパスが多すぎます。ダウンロードして確認してください。');
        setCount(layers.length);
        setLayer(layers.length);
        let z = 0;
        setHeights(layers.map((layer) => (z += layer.height)));
        setProgress(85);
        await instance.renderAnimated(1);
        abort.signal.throwIfAborted();
        setVisibility(instance, layers.length, false, false);
        setProgress(100);
        setLoading(false);
        onReady(true);
      } catch (e) {
        if (!abort.signal.aborted) {
          setError(
            e instanceof Error
              ? e.message
              : '3D表示に失敗しました。WebGL対応ブラウザを使用してください。',
          );
          setLoading(false);
          onReady(false);
          instance?.dispose();
          preview.current = null;
        }
      }
    })();
    return () => {
      abort.abort();
      observer?.disconnect();
      if (instance) {
        instance.parser.layers = [];
        instance.parser.preamble.commands = [];
        instance.dispose();
      }
      preview.current = null;
    };
  }, [text, onReady]);
  useEffect(() => {
    if (preview.current && !loading) setVisibility(preview.current, layer, single, travel);
  }, [layer, single, travel, loading]);
  return (
    <section className="viewer" aria-label="3Dツールパス">
      <div className="viewport">
        <canvas ref={canvas} aria-label="マウスで回転・ズーム・移動できるG-codeプレビュー" />
        <div className="plate-label">
          A1 mini <span>180 × 180 × 180 mm</span>
        </div>
        <div className="gesture-hint">ドラッグ: 回転 · スクロール: ズーム · 右ドラッグ: 移動</div>
        {loading && (
          <div className="viewport-message" role="status">
            <span className="spinner" />
            ツールパスを準備中 {progress}%
          </div>
        )}
        {error && (
          <div className="viewport-message error" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="layer-panel">
        <div className="layer-heading">
          <strong>
            レイヤー <b>{count ? layer : '—'}</b>
            <span> / {count || '—'}</span>
          </strong>
          <span>{heights[layer - 1] ? `${heights[layer - 1]?.toFixed(2)} mm` : ''}</span>
        </div>
        <input
          aria-label="レイヤー"
          type="range"
          min="1"
          max={count || 1}
          value={layer}
          disabled={loading || !count}
          onChange={(e) => setLayer(Number(e.target.value))}
        />
        <div className="layer-options">
          <label>
            <input type="checkbox" checked={single} onChange={(e) => setSingle(e.target.checked)} />
            このレイヤーのみ
          </label>
          <label>
            <input type="checkbox" checked={travel} onChange={(e) => setTravel(e.target.checked)} />
            移動経路
          </label>
          <span className="legend">
            ● 押出 <i>● 移動</i>
          </span>
        </div>
      </div>
    </section>
  );
}
