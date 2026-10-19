import {
  BufferGeometry,
  Box3,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Vector3,
} from 'three';
import type { WebGLPreview } from 'gcode-preview';
import { previewInput } from './preview-input.js';

const BATCH_SIZE = 1000;
const FRAME_BUDGET_MS = 8;

/** Scan the source without retaining an array containing every line. */
export function* gcodeBatches(text: string) {
  let offset = 0;
  while (offset < text.length) {
    const lines: string[] = [];
    for (let i = 0; i < BATCH_SIZE && offset < text.length; i++) {
      const newline = text.indexOf('\n', offset);
      const end = newline < 0 ? text.length : newline + 1;
      lines.push(text.slice(offset, newline < 0 ? end : newline));
      offset = end;
    }
    yield { lines, offset };
  }
}

function nextFrame(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      cancelAnimationFrame(frame);
      reject(signal.reason);
    };
    const frame = requestAnimationFrame(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    });
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function parseToolpath(
  preview: WebGLPreview,
  text: string,
  signal: AbortSignal,
  progress: (fraction: number) => void,
) {
  const input = previewInput(text);
  let frameStart = performance.now();
  for (const { lines, offset } of gcodeBatches(input)) {
    signal.throwIfAborted();
    // Statistics already come from metadata; comments/thumbnails need no render objects.
    preview.parser.parseGCode(
      lines.map((line) => line.split(';', 1)[0] ?? '').filter((line) => line.trim()),
    );
    preview.parser.lines = [];
    if (performance.now() - frameStart >= FRAME_BUDGET_MS) {
      progress(offset / input.length);
      await nextFrame(signal);
      frameStart = performance.now();
    }
  }
  progress(1);
}

/** Render every command, yielding within long layers and releasing rendered commands. */
export async function renderToolpath(
  preview: WebGLPreview,
  signal: AbortSignal,
  progress: (fraction: number) => void,
) {
  const layers = [preview.parser.preamble, ...preview.parser.layers];
  const total = layers.reduce((sum, layer) => sum + layer.commands.length, 0);
  const groups: Group[] = [];
  const materials = new Map<number, LineBasicMaterial>();
  const originalAddLine = preview.addLine;
  let group: Group;
  let completed = 0;
  let frameStart = performance.now();
  const dispose = () => {
    for (const layerGroup of groups.splice(0)) {
      preview.scene.remove(layerGroup);
      layerGroup.traverse((object) => {
        if (object instanceof LineSegments) object.geometry.dispose();
      });
    }
    for (const material of materials.values()) material.dispose();
    materials.clear();
  };
  // Use the library's motion/arc interpretation while owning bounded geometry batches.
  preview.addLine = (vertices, color) => {
    if (!vertices.length) return;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
    let material = materials.get(color);
    if (!material) {
      material = new LineBasicMaterial({ color });
      materials.set(color, material);
    }
    const line = new LineSegments(geometry, material);
    line.visible = color !== preview.travelColor.getHex();
    group.add(line);
  };
  try {
    for (const [index, layer] of layers.entries()) {
      signal.throwIfAborted();
      group = new Group();
      group.name = `layer${index}`;
      group.rotation.x = -Math.PI / 2;
      group.position.set(
        -(preview.buildVolume?.x ?? 200) / 2,
        0,
        (preview.buildVolume?.y ?? 200) / 2,
      );
      groups.push(group);
      preview.scene.add(group);
      const commands = layer.commands;
      try {
        for (let offset = 0; offset < commands.length; offset += BATCH_SIZE) {
          signal.throwIfAborted();
          layer.commands = commands.slice(offset, offset + BATCH_SIZE);
          preview.renderLayer(index);
          completed += layer.commands.length;
          if (performance.now() - frameStart >= FRAME_BUDGET_MS) {
            progress(completed / total);
            await nextFrame(signal);
            frameStart = performance.now();
          }
        }
      } finally {
        layer.commands = [];
      }
    }
    progress(1);
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  } finally {
    preview.addLine = originalAddLine;
  }
}

export function fitToolpath(
  preview: Pick<WebGLPreview, 'scene' | 'camera'> & {
    controls: Pick<WebGLPreview['controls'], 'target' | 'update'>;
  },
) {
  const bounds = new Box3();
  for (const group of preview.scene.children)
    if (/^layer\d+$/.test(group.name)) bounds.expandByObject(group);
  if (bounds.isEmpty()) return;
  const center = bounds.getCenter(new Vector3());
  const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 1);
  const halfFov = Math.atan(
    Math.tan(MathUtils.degToRad(preview.camera.fov / 2)) * Math.min(preview.camera.aspect, 1),
  );
  const distance = (radius / Math.sin(halfFov)) * 1.08;
  const direction = preview.camera.position.clone().sub(preview.controls.target).normalize();
  preview.controls.target.copy(center);
  preview.camera.position.copy(center).addScaledVector(direction, distance);
  preview.controls.update();
}
