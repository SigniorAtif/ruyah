/**
 * Where the picture sits inside the <video> element.
 *
 * The element is `object-contain`, so the picture is letterboxed inside it and
 * the bars are not part of the film. Pointing at a spot has to be sent as a
 * fraction of the picture, not of the element, or the two of you would be
 * pointing at different things whenever your windows differ in shape.
 */
export interface FrameBox {
  /** Offset of the picture inside the element, px. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export function frameBox(video: HTMLVideoElement): FrameBox | null {
  const { videoWidth: vw, videoHeight: vh, clientWidth: cw, clientHeight: ch } = video;
  if (!vw || !vh || !cw || !ch) return null;
  const scale = Math.min(cw / vw, ch / vh);
  const width = vw * scale;
  const height = vh * scale;
  return { left: (cw - width) / 2, top: (ch - height) / 2, width, height };
}
