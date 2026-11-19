// Coordinates are thousandths of the upright page, as seen by the page model.
export const regionKinds = ['seal', 'stamp', 'handwriting'] as const;
export type RegionKind = (typeof regionKinds)[number];
export const regionLabels: Record<RegionKind, string> = {
  seal: 'Печать',
  stamp: 'Штамп',
  handwriting: 'Рукописный текст',
};
export type RegionBox = { kind: RegionKind; left: number; top: number; right: number; bottom: number };
export type Region = RegionBox & {
  id: string;
  source: 'auto' | 'manual';
  model: string;
  status: 'read' | 'partial' | 'unreadable' | 'error';
  text: string;
};
