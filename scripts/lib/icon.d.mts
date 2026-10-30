export function iconPng(size: number): Buffer;
export function coverPng(width: number, height: number): Buffer;
export function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer;
