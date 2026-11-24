export type Models = { recognition: string; chat: string; regions: string };
export const defaultRegionRetries = 2;
export const maxRegionRetries = 6;
export type RecognitionSettings = Models & { regionRetries: number };
