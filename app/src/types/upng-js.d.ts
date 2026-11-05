declare module 'upng-js' {
  interface UpngImage {
    width: number;
    height: number;
    depth: number;
    ctype: number;
    frames: unknown[];
    data: ArrayBuffer;
  }
  const UPNG: {
    decode(data: ArrayBuffer | Uint8Array): UpngImage;
    toRGBA8(img: UpngImage): ArrayBuffer[];
    /** `cnum` 0 keeps every colour (lossless). */
    encode(frames: ArrayBuffer[], width: number, height: number, cnum?: number, delays?: number[]): ArrayBuffer;
  };
  export default UPNG;
}
